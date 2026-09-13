import type { TaskRoleSessionSet } from "../executor/agentExecutor.js";
import type { TaskEvent } from "../event/taskEvent.js";
import { builtinDriverIdForAdapter } from "../runtime/builtinAgentDrivers.js";
import { runtimeObservationFromTaskEvent } from "../runtime/runtimeObservation.js";
import { projectRuntimeTaskEvents, classifyRuntimeHealth } from "../runtime/runtimeProjection.js";
import { DEFAULT_RUNTIME_HEALTH_POLICY, type RuntimeHealthPolicy } from "../runtime/runtimeHealthPolicy.js";
import { providerRetryProjection } from "../runtime/providerRetry.js";

export type WebSessionGroup = "active" | "waiting" | "quiet" | "diagnostic" | "unknown" | "stopped" | "idle" | "background";
export type WebSession = Readonly<{
  taskId: string; roleName: string; agentId: string; nativeSessionId: string | null;
  attemptId: string | null; nativeTurnId: string | null; runId: string | null;
  group: WebSessionGroup; reason: string; layer: string | null;
  lastActivityAt: string | null; semanticProgressAt: string | null;
  sourceUpdatedAt: string; waitingReason: string | null; operations: readonly string[];
  background: readonly Readonly<{ id: string; execution: string }>[];
}>;

/** Read-only presentation of the selected native connections, never an AgentRun
 * count. Foreground facts are fenced to the exact input; retained continuations
 * stay attached to their original input and are not counted as extra Sessions.
 * No live probe, timers, persistence or recovery actions are introduced here. */
export function projectWebSessions(input: Readonly<{
  taskId: string; sessionSets: readonly TaskRoleSessionSet[]; events: readonly TaskEvent[];
  now: Date; semanticProgressAt?: string; policy?: RuntimeHealthPolicy;
}>) {
  const policy = input.policy ?? DEFAULT_RUNTIME_HEALTH_POLICY;
  const sessions: WebSession[] = [];
  const seen = new Map<string, number>();
  const observations = input.events.map(event => ({ event, observation: runtimeObservationFromTaskEvent(event) }))
    .filter(entry => entry.observation !== null);
  for (const set of input.sessionSets) {
    const session = set.sessions[set.activeAgentId];
    const binding = set.providerBinding;
    const conversation = binding?.conversations.find(c =>
      c.epoch === binding.currentConversationEpoch && c.status === "current");
    const nativeSessionId = session?.nativeSessionId ?? conversation?.conversationId ?? null;
    const identity = JSON.stringify([binding?.providerNamespace ?? session?.adapterId,
      binding?.accountScope ?? set.activeAgentId, nativeSessionId ?? set.owner.roleName]);
    const prior = seen.get(identity);
    if (prior !== undefined) {
      if (sessions[prior]!.roleName !== set.owner.roleName) sessions[prior] = {
        ...sessions[prior]!, group: "unknown", reason: "Multiple Roles name this native Session; inspect ownership."
      };
      continue;
    }
    seen.set(identity, sessions.length);
    const turn = binding?.run;
    const row: WebSession = {
      taskId: input.taskId, roleName: set.owner.roleName, agentId: set.activeAgentId,
      nativeSessionId, attemptId: turn?.attemptId ?? null, nativeTurnId: turn?.nativeTurnId ?? null,
      runId: turn?.runId ?? null, group: "unknown", reason: "Current native input is not observable.",
      layer: null, lastActivityAt: null, semanticProgressAt: input.semanticProgressAt ?? null,
      sourceUpdatedAt: turn?.updatedAt ?? session?.updatedAt ?? set.updatedAt,
      waitingReason: null, operations: [], background: []
    };
    if (!session || !binding || !conversation || conversation.conversationId !== session.nativeSessionId) {
      sessions.push(row);
      continue;
    }
    let driverId: string;
    try { driverId = builtinDriverIdForAdapter(session.adapterId); }
    catch { sessions.push(row); continue; }
    const fence = { taskId: input.taskId, roleName: set.owner.roleName,
      agentId: session.agentId, driverId, nativeSessionId: session.nativeSessionId };
    const sessionFacts = observations.filter(({ observation }) => Object.entries(fence).every(([key, value]) =>
      observation!.fence[key as keyof typeof fence] === value));
    // Each Run's continuation fold has its own authority. Foreground operations
    // from older inputs must not make the current input look active.
    const groups = new Map<string | undefined, TaskEvent[]>();
    for (const { event, observation } of sessionFacts) {
      const runId = observation!.fence.runId;
      const group = groups.get(runId) ?? [];
      group.push(event);
      groups.set(runId, group);
    }
    const background = [...groups].flatMap(([runId, events]) => {
      const projection = projectRuntimeTaskEvents({ ...fence, ...(runId ? { runId } : {}) },
        session.createdAt, events);
      const children = Object.entries(projection.continuations)
        .filter(([, c]) => c.execution !== "quiescent" || c.identityConflict)
        .map(([id, c]) => ({ id: `${runId ?? "native"}/${id}`, execution: c.execution }));
      return [...children, ...Object.entries(projection.operations)
        .filter(([, operation]) => operation.kind === "subagent")
        .map(([id]) => ({ id: `${runId ?? "native"}/operation:${id}`, execution: "unsettled" }))];
    });
    if (!turn) {
      sessions.push({ ...row, background, ...(background.length ? {
        group: "background", reason: "Retained background execution is not settled."
      } : {}) });
      continue;
    }
    const exactEvents = sessionFacts.filter(({ observation }) => {
      const observed = observation!;
      const f = observed.fence;
      if (f.continuationId !== undefined || f.runId !== turn.runId) return false;
      if (f.receiptId === undefined && f.nativeTurnId === undefined
        && ["host.observed", "session.ended", "session.failed", "observer.health"].includes(observed.kind)) {
        return observed.receivedAt >= turn.submittedAt;
      }
      if (f.receiptId !== undefined && f.receiptId !== turn.attemptId) return false;
      if (f.nativeTurnId !== undefined && f.nativeTurnId !== turn.nativeTurnId) return false;
      return f.receiptId === turn.attemptId
        || (turn.nativeTurnId !== undefined && f.nativeTurnId === turn.nativeTurnId);
    }).map(entry => entry.event);
    const projection = projectRuntimeTaskEvents({
      ...fence, ...(turn.runId ? { runId: turn.runId } : {}),
      receiptId: turn.attemptId, ...(turn.nativeTurnId ? { nativeTurnId: turn.nativeTurnId } : {})
    }, turn.submittedAt, exactEvents);
    const health = classifyRuntimeHealth({ projection, now: input.now, policy,
      semanticProgressAt: input.semanticProgressAt ?? turn.submittedAt });
    const retry = providerRetryProjection(binding);
    let group: WebSessionGroup;
    let reason = health.reason;
    if (turn.status === "delivery-unknown") {
      group = "unknown"; reason = "Original input delivery is unknown; do not replay it.";
    } else if (session.status === "ended") {
      group = background.length ? "background" : "stopped";
      reason = "The selected Session ended; Task acceptance and retained background execution are separate.";
    } else if (retry?.status === "waiting") {
      group = "waiting";
      reason = `Controller-owned Provider retry waiting (${retry.attempts}/${retry.limit}); next eligible ${retry.nextEligibleAt}. Existing work is preserved.`;
    } else if (["failed", "cancelled", "rejected"].includes(turn.status)) {
      group = background.length ? "background" : "stopped";
      reason = turn.terminalReason ?? "The selected native execution stopped; Task acceptance is separate.";
    } else if (turn.status === "completed") {
      group = background.length ? "background" : "idle";
      reason = background.length ? "Main Turn ended; background execution remains unsettled."
        : "The native Turn ended; this is not Task completion.";
    } else if (turn.status !== "accepted") {
      group = "waiting"; reason = "Waiting for native input acceptance.";
    } else if (projection.run === "waiting") {
      group = "waiting";
    } else if (["broken", "stopped"].includes(health.layer)) {
      group = "stopped";
    } else if (["completed", "failed", "cancelled"].includes(projection.run)) {
      group = "unknown"; reason = "Native terminal and current input binding disagree; inspect the exact original input.";
    } else if (projection.observer.status === "unavailable") {
      group = "unknown";
    } else if (health.layer === "diagnostic-needed") {
      group = "diagnostic";
    } else if (health.runtimeIdleMs < policy.quietAfterMs && projection.activity.kind !== "provider") {
      group = "active";
    } else {
      group = "quiet";
      reason = "Accepted input has no recent structured activity; silence is not a proven deadlock.";
    }
    sessions.push({ ...row, group, reason, layer: health.layer, background,
      lastActivityAt: projection.lastRuntimeActivityAt ?? null,
      waitingReason: projection.waitingReason ?? null, operations: health.activeOperations });
  }
  const counts: Record<WebSessionGroup, number> = {
    active: 0, waiting: 0, quiet: 0, diagnostic: 0, unknown: 0, stopped: 0, idle: 0, background: 0
  };
  for (const session of sessions) counts[session.group]++;
  return { scope: "task-selected-native-sessions" as const, taskId: input.taskId,
    readAt: input.now.toISOString(), counts, sessions,
    coverage: "Recorded selected Sessions only; not a live process or historical resource inventory." };
}
