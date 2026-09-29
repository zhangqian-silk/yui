import type { RuntimeOwner } from "./runtimeOwner.js";
import type { LinuxProcessIdentity, SessionOwnerIdentity } from "./sessionOwnerIdentity.js";

export type SessionTerminationStage =
  | "stop-requested" | "graceful-stop" | "forced-stop" | "stop-confirmed" | "stop-blocked";
export type SessionTerminationEvent = Readonly<{
  stage: SessionTerminationStage;
  owner: RuntimeOwner;
  nativeSessionId?: string;
  detail?: string;
  at: Date;
}>;
export type SessionTerminationPorts = Readonly<{
  gracefulStop(owner: RuntimeOwner): Promise<boolean>;
  processIdentity(pid: number): LinuxProcessIdentity | undefined;
  procEntryExists(pid: number): boolean;
  signalProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  sleep(milliseconds: number): Promise<void>;
  emit(event: SessionTerminationEvent): void;
  now(): Date;
}>;
export type SessionTerminationResult = Readonly<{
  outcome: "stop-confirmed" | "stop-blocked";
  owner: RuntimeOwner;
  confirmed: readonly SessionOwnerIdentity[];
  remaining: readonly Readonly<{ record: SessionOwnerIdentity; detail: string }>[];
  verificationGap?: string;
}>;
export type SessionTerminationOptions = Readonly<{
  gracefulGraceMs?: number;
  forcedGraceMs?: number;
  pollMs?: number;
  /** A pane exit alone cannot confirm custody when this platform lacks a Host record. */
  requireProcessRecord?: boolean;
}>;
export const DEFAULT_GRACEFUL_GRACE_MS = 3_000;
export const DEFAULT_FORCED_GRACE_MS = 2_000;
export const DEFAULT_TERMINATION_POLL_MS = 100;

/**
 * Stop only recorded Host roots. Descendants remain observable resources;
 * neither a shared environment nor a process group authorizes killing them.
 */
export async function terminateSessionOwners(
  owner: RuntimeOwner,
  records: readonly SessionOwnerIdentity[],
  ports: SessionTerminationPorts,
  options: SessionTerminationOptions = {}
): Promise<SessionTerminationResult> {
  const emit = (stage: SessionTerminationStage, detail?: string) => {
    try { ports.emit({ stage, owner, at: ports.now(), ...(detail ? { detail } : {}) }); }
    catch { /* Audit failure never broadens process authority. */ }
  };
  const state = (record: SessionOwnerIdentity): "live" | "absent" | "unknown" => {
    const { pid, startIdentity } = record.providerRoot;
    const observed = ports.processIdentity(pid);
    if (observed === undefined) return ports.procEntryExists(pid) ? "unknown" : "absent";
    return observed.startIdentity !== startIdentity || observed.state === "Z"
      ? "absent" : "live";
  };
  for (const record of records) {
    if (record.owner.scope !== owner.scope || record.owner.roleName !== owner.roleName
      || (owner.scope === "task" && record.owner.taskId !== owner.taskId)) {
      throw new Error("Process record does not belong to the requested Role.");
    }
  }
  emit("stop-requested");
  if (records.length === 0) {
    // Without a recorded root only the exact Role pane can be stopped.
    const stopped = await ports.gracefulStop(owner);
    const outcome = stopped && options.requireProcessRecord !== true
      ? "stop-confirmed" : "stop-blocked";
    emit(outcome);
    return {
      outcome, owner, confirmed: [], remaining: [],
      ...(outcome === "stop-confirmed" ? {} : {
        verificationGap: stopped
          ? "No recorded Host process identity; pane exit cannot prove physical exit."
          : "Role pane stop is unconfirmed."
      })
    };
  }
  const pollMs = duration(options.pollMs, DEFAULT_TERMINATION_POLL_MS);
  for (const [signal, grace] of [
    ["SIGTERM", duration(options.gracefulGraceMs, DEFAULT_GRACEFUL_GRACE_MS)],
    ["SIGKILL", duration(options.forcedGraceMs, DEFAULT_FORCED_GRACE_MS)]
  ] as const) {
    for (const record of records) {
      // The dedicated execution supervisor reaps its descendants before exit.
      // Killing the supervisor would discard that custody proof.
      if (signal === "SIGKILL" && record.providerRoot.attribution === "owned-child") continue;
      if (state(record) !== "live") continue;
      try { ports.signalProcess(record.providerRoot.pid, signal); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          emit("stop-blocked", error instanceof Error ? error.message : String(error));
        }
      }
    }
    emit(signal === "SIGTERM" ? "graceful-stop" : "forced-stop");
    const deadline = Date.now() + grace;
    // A process can be briefly unreadable while exiting. Wait for absence,
    // not merely for the first unverified observation.
    while (records.some((record) => state(record) !== "absent") && Date.now() < deadline) {
      await ports.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
    if (records.every((record) => state(record) === "absent")) break;
  }
  const confirmed: SessionOwnerIdentity[] = [];
  const remaining: Array<{ record: SessionOwnerIdentity; detail: string }> = [];
  for (const record of records) {
    const observed = state(record);
    if (observed === "absent") confirmed.push(record);
    else remaining.push({
      record,
      detail: observed === "unknown" ? "Host process identity is unreadable." : "Host process is still live."
    });
  }
  const outcome = remaining.length === 0 ? "stop-confirmed" : "stop-blocked";
  emit(outcome);
  return { outcome, owner, confirmed, remaining };
}

function duration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new Error("Stop duration must be non-negative.");
  return value;
}
