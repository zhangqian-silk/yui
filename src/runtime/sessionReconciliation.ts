import type { SessionOwnerIdentity } from "./sessionOwnerIdentity.js";

/** Durable projection of one Role runtime Session, read by reconciliation. */
export type DurableSessionFact = Readonly<{
  scope: "task" | "global";
  taskId?: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  status: "active" | "ended";
  inHistory: boolean;
}>;

export type SessionPhysicalObservation = Readonly<{
  alive: boolean;
  /** True when the PID exists but its start identity changed (PID reuse). */
  identityConflict: boolean;
  pid: number;
  startIdentity: string;
  rssBytes: number;
  ageMs: number;
  childCount: number;
}>;

export type SessionReconciliationMismatch =
  | "durable-terminal-physical-live"
  | "durable-live-physical-absent"
  | "identity-conflict";

export type SessionReconciliationEntry = Readonly<{
  owner: Readonly<{ scope: "task" | "global"; taskId?: string; roleName: string }>;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  taskStatus?: "draft" | "active" | "completed" | "cancelled" | "archived";
  durableStatus: "active" | "ended" | "absent";
  tmuxPane?: Readonly<{ target: string; dead: boolean }>;
  physical?: SessionPhysicalObservation;
  lastStopOutcome?: string;
  mismatch?: SessionReconciliationMismatch;
  archiveBlocked: boolean;
  verificationGap?: string;
}>;

export type SessionReconciliationReport = Readonly<{
  schemaVersion: 1;
  observedAt: string;
  entries: readonly SessionReconciliationEntry[];
  summary: Readonly<{
    owners: number;
    livePhysicalRoots: number;
    archiveBlockers: number;
    verificationGaps: number;
  }>;
}>;

export type SessionReconciliationInput = Readonly<{
  records: readonly SessionOwnerIdentity[];
  durable: readonly DurableSessionFact[];
  taskStatus: (taskId: string) => "draft" | "active" | "completed" | "cancelled" | "archived" | undefined;
  observe: (record: SessionOwnerIdentity) => SessionPhysicalObservation | undefined;
  inspectPane: (
    taskId: string | undefined,
    roleName: string
  ) => Readonly<{ target: string; dead: boolean }> | undefined;
  lastStopOutcome: (
    taskId: string | undefined,
    roleName: string
  ) => string | undefined;
  now: Date;
}>;

/**
 * Bidirectional durable <-> physical reconciliation for Runtime Sessions.
 *
 * Durable -> physical: every owner record's Provider root must be absent once
 * its durable Session is terminal; a live root with a terminal durable state
 * is the exact leak the audit found. Physical -> durable: the owner registry
 * stays enumerable after the durable Session map or history is cleared, so a
 * live Session can always be re-attributed and reported.
 *
 * Pure: all I/O is injected. Unknown owners are reported, never cleaned.
 * An entry blocks ordinary archive / workspace cleanup when a terminal Task
 * still owns a live or unverified physical root, regardless of Session status.
 */
export function reconcileSessionOwners(
  input: SessionReconciliationInput
): SessionReconciliationReport {
  const entries = input.records.map((record) => reconcileOne(record, input));
  const summary = {
    owners: entries.length,
    livePhysicalRoots: entries.filter(
      (entry) => entry.physical?.alive === true
    ).length,
    archiveBlockers: entries.filter((entry) => entry.archiveBlocked).length,
    verificationGaps: entries.filter(
      (entry) => entry.verificationGap !== undefined
    ).length
  };
  return {
    schemaVersion: 1,
    observedAt: input.now.toISOString(),
    entries,
    summary
  };
}

function reconcileOne(
  record: SessionOwnerIdentity,
  input: SessionReconciliationInput
): SessionReconciliationEntry {
  const durable = matchDurable(record, input.durable);
  const physical = input.observe(record);
  const owner = record.owner;
  const taskStatus = owner.scope === "task" && owner.taskId !== undefined
    ? input.taskStatus(owner.taskId)
    : undefined;
  const tmuxPane = input.inspectPane(owner.taskId, owner.roleName);
  const lastStopOutcome = input.lastStopOutcome(
    owner.taskId,
    owner.roleName
  );

  let mismatch: SessionReconciliationMismatch | undefined;
  let verificationGap: string | undefined;
  if (physical?.identityConflict === true) {
    mismatch = "identity-conflict";
  } else if (physical?.alive === true) {
    if (durable === undefined || durable.status === "ended") {
      mismatch = "durable-terminal-physical-live";
    }
  } else if (physical === undefined) {
    verificationGap = "/proc identity unavailable";
  } else if (durable !== undefined && durable.status === "active") {
    mismatch = "durable-live-physical-absent";
  }

  const terminalTask = taskStatus === "completed"
    || taskStatus === "cancelled"
    || taskStatus === "archived";
  const archiveBlocked = terminalTask && (physical === undefined
    || physical.alive || physical.identityConflict);

  return {
    owner: {
      scope: owner.scope,
      ...(owner.taskId === undefined ? {} : { taskId: owner.taskId }),
      roleName: owner.roleName
    },
    agentId: record.agentId,
    adapterId: record.adapterId,
    ...(record.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: record.nativeSessionId }),
    ...(taskStatus === undefined ? {} : { taskStatus }),
    durableStatus: durable?.status ?? "absent",
    ...(tmuxPane === undefined ? {} : { tmuxPane }),
    ...(physical === undefined ? {} : { physical }),
    ...(lastStopOutcome === undefined ? {} : { lastStopOutcome }),
    ...(mismatch === undefined ? {} : { mismatch }),
    archiveBlocked,
    ...(verificationGap === undefined ? {} : { verificationGap })
  };
}

function matchDurable(
  record: SessionOwnerIdentity,
  durable: readonly DurableSessionFact[]
): DurableSessionFact | undefined {
  const candidates = durable.filter((fact) => (
    fact.scope === record.owner.scope
    && fact.roleName === record.owner.roleName
    && (record.owner.scope === "global" || fact.taskId === record.owner.taskId)
    && fact.agentId === record.agentId
  ));
  const byNative = candidates.find(
    (fact) => fact.nativeSessionId !== undefined
      && record.nativeSessionId !== undefined
      && fact.nativeSessionId === record.nativeSessionId
  );
  return byNative;
}
