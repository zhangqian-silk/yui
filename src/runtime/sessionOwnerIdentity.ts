import { readFileSync, readdirSync } from "node:fs";

import { requireSafeIdentity, requireText, requireTimestamp } from "./validation.js";

/** A concrete OS process identity, not an Agent launch identity. */
export function sessionOwnerProcessKey(record: Pick<SessionOwnerIdentity, "providerRoot">): string {
  return `${record.providerRoot.pid}-${record.providerRoot.startIdentity}`;
}

/**
 * Physical Host ownership, captured directly from the created tmux pane.
 * PID and Linux process start identity identify the concrete process. Task,
 * Role and native Session describe its origin, not permission to kill every
 * descendant application. The record survives Controller restarts.
 */
export type SessionOwnerIdentity = Readonly<{
  schemaVersion: 1;
  kind: "yui-session-owner";
  owner: Readonly<{
    scope: "task" | "global";
    taskId?: string;
    roleName: string;
  }>;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  tmux: Readonly<{
    serverName: string;
    socketPath: string;
    sessionName: string;
    windowName: string;
    panePid?: number;
  }>;
  providerRoot: Readonly<{
    pid: number;
    /** Linux /proc start identity (stat field 22, clock ticks). PID-reuse safe. */
    startIdentity: string;
    processGroupId?: number;
    processSessionId?: number;
    attribution: "pane-pid" | "owned-child";
  }>;
  runtimeRoot?: string;
  recordedAt: string;
}>;

export type LinuxProcessIdentity = Readonly<{
  pid: number;
  startIdentity: string;
  /** /proc state field (e.g. "R", "S", "Z"); absent on non-Linux or older callers. */
  state?: string;
  processGroupId?: number;
  processSessionId?: number;
  rssBytes: number;
}>;

export type SessionOwnerIdentityInput = Readonly<{
  owner: Readonly<{
    scope: "task" | "global";
    taskId?: string;
    roleName: string;
  }>;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  tmux: Readonly<{
    serverName: string;
    socketPath: string;
    sessionName: string;
    windowName: string;
    panePid?: number;
  }>;
  providerRoot: Readonly<{
    pid: number;
    startIdentity: string;
    processGroupId?: number;
    processSessionId?: number;
    attribution: "pane-pid" | "owned-child";
  }>;
  runtimeRoot?: string;
  recordedAt: Date;
}>;

/** Validates and freezes one physical owner record; fails closed on malformed input. */
export function createSessionOwnerIdentity(
  input: SessionOwnerIdentityInput
): SessionOwnerIdentity {
  const owner = input.owner;
  if (owner.scope !== "task" && owner.scope !== "global") {
    throw new TypeError("Session owner scope is invalid.");
  }
  if (owner.scope === "task" && owner.taskId === undefined) {
    throw new TypeError("Task session owner requires a task id.");
  }
  if (owner.scope === "global" && owner.taskId !== undefined) {
    throw new TypeError("Global session owner must not carry a task id.");
  }
  const providerRoot = input.providerRoot;
  if (!["pane-pid", "owned-child"].includes(providerRoot.attribution)) {
    throw new TypeError("Session owner process attribution is invalid.");
  }
  if (!Number.isSafeInteger(providerRoot.pid) || providerRoot.pid <= 0) {
    throw new TypeError("Session owner provider root pid is invalid.");
  }
  if (!/^[0-9]{1,32}$/u.test(providerRoot.startIdentity)) {
    throw new TypeError("Session owner provider start identity is invalid.");
  }
  if (
    providerRoot.processGroupId !== undefined
    && (!Number.isSafeInteger(providerRoot.processGroupId) || providerRoot.processGroupId <= 0)
  ) {
    throw new TypeError("Session owner process group id is invalid.");
  }
  if (
    providerRoot.processSessionId !== undefined
    && (!Number.isSafeInteger(providerRoot.processSessionId) || providerRoot.processSessionId <= 0)
  ) {
    throw new TypeError("Session owner process session id is invalid.");
  }
  const tmux = input.tmux;
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "yui-session-owner" as const,
    owner: Object.freeze({
      scope: owner.scope,
      ...(owner.taskId === undefined ? {} : { taskId: requireSafeIdentity(owner.taskId, "Task id") }),
      roleName: requireSafeIdentity(owner.roleName, "Role name")
    }),
    agentId: requireSafeIdentity(input.agentId, "Agent id"),
    adapterId: requireText(input.adapterId, "Adapter id"),
    ...(input.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: requireText(input.nativeSessionId, "Native session id") }),
    tmux: Object.freeze({
      serverName: requireText(tmux.serverName, "tmux server name"),
      socketPath: requireText(tmux.socketPath, "tmux socket path"),
      sessionName: requireText(tmux.sessionName, "tmux session name"),
      windowName: requireText(tmux.windowName, "tmux window name"),
      ...(tmux.panePid === undefined ? {} : { panePid: tmux.panePid })
    }),
    providerRoot: Object.freeze({
      pid: providerRoot.pid,
      startIdentity: providerRoot.startIdentity,
      ...(providerRoot.processGroupId === undefined
        ? {}
        : { processGroupId: providerRoot.processGroupId }),
      ...(providerRoot.processSessionId === undefined
        ? {}
        : { processSessionId: providerRoot.processSessionId }),
      attribution: providerRoot.attribution
    }),
    ...(input.runtimeRoot === undefined ? {} : { runtimeRoot: input.runtimeRoot }),
    recordedAt: requireTimestamp(input.recordedAt, "Recorded at")
  });
}

/**
 * Reads one Linux process identity from /proc. Returns undefined when /proc is
 * unavailable, unreadable, or the platform does not expose it — the caller
 * must treat that as a verification gap, never as proof of absence.
 */
export function readLinuxProcessIdentity(pid: number): LinuxProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closing = stat.lastIndexOf(")");
    if (closing < 0) return undefined;
    const fields = stat.slice(closing + 1).trim().split(/\s+/u);
    const state = fields[0];
    const processGroupId = Number(fields[2]);
    const processSessionId = Number(fields[3]);
    const startIdentity = fields[19];
    if (startIdentity === undefined || !/^[0-9]{1,32}$/u.test(startIdentity)) {
      return undefined;
    }
    const rssBytes = readLinuxProcessRssBytes(pid) ?? 0;
    return {
      pid,
      startIdentity,
      ...(typeof state === "string" && state.length > 0 ? { state } : {}),
      ...(Number.isSafeInteger(processGroupId) && processGroupId > 0
        ? { processGroupId }
        : {}),
      ...(Number.isSafeInteger(processSessionId) && processSessionId > 0
        ? { processSessionId }
        : {}),
      rssBytes
    };
  } catch {
    return undefined;
  }
}

function readLinuxProcessRssBytes(pid: number): number | undefined {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    for (const line of status.split("\n")) {
      if (line.startsWith("VmRSS:")) {
        const value = Number(line.slice("VmRSS:".length).trim().split(/\s+/u)[0]);
        if (Number.isFinite(value) && value >= 0) return Math.round(value) * 1024;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * True only when /proc still holds the exact process identity. A reused PID
 * with a different start identity is absent, not live.
 */
export function isLinuxProcessLive(
  pid: number,
  startIdentity: string
): boolean {
  const current = readLinuxProcessIdentity(pid);
  if (current === undefined) return false;
  // A zombie has already exited; only the task struct remains for the parent
  // to reap. It cannot execute or hold resources, so it is not live.
  if (current.state === "Z") return false;
  return current.startIdentity === startIdentity;
}

/**
 * Lists the process tree owned by one Provider root: the root itself plus
 * descendants proven by process-group membership or an ancestor chain. A
 * process that merely shares a name or cwd is never included.
 */
export function listOwnedProcessTree(
  rootPid: number,
  rootProcessGroupId: number | undefined
): readonly LinuxProcessIdentity[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc", { encoding: "utf8" });
  } catch {
    return [];
  }
  const processes = new Map<number, { ppid: number; identity: LinuxProcessIdentity }>();
  for (const entry of entries) {
    if (!/^[0-9]+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closing = stat.lastIndexOf(")");
      if (closing < 0) continue;
      const fields = stat.slice(closing + 1).trim().split(/\s+/u);
      const ppid = Number(fields[1]);
      const processGroupId = Number(fields[2]);
      const startIdentity = fields[19];
      if (
        !Number.isSafeInteger(ppid)
        || ppid < 0
        || startIdentity === undefined
        || !/^[0-9]{1,32}$/u.test(startIdentity)
      ) {
        continue;
      }
      if (
        rootProcessGroupId !== undefined
        && Number.isSafeInteger(processGroupId)
        && processGroupId === rootProcessGroupId
      ) {
        const identity = readLinuxProcessIdentity(pid);
        if (identity !== undefined) {
          processes.set(pid, { ppid, identity });
        }
        continue;
      }
      processes.set(pid, {
        ppid,
        identity: {
          pid,
          startIdentity,
          ...(Number.isSafeInteger(processGroupId) && processGroupId > 0
            ? { processGroupId }
            : {}),
          rssBytes: readLinuxProcessRssBytes(pid) ?? 0
        }
      });
    } catch {
      // A process exiting mid-scan is simply omitted from this point-in-time
      // tree; the termination guard re-verifies the root identity afterwards.
    }
  }
  const owned = new Map<number, LinuxProcessIdentity>();
  const root = processes.get(rootPid);
  if (root === undefined) return [];
  owned.set(rootPid, root.identity);
  // Ancestry walk: any process whose parent chain reaches the root is owned.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, process] of processes) {
      if (owned.has(pid)) continue;
      if (owned.has(process.ppid)) {
        owned.set(pid, process.identity);
        grew = true;
      }
    }
  }
  return [...owned.values()];
}
