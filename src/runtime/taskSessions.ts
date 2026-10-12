import type { TaskRoleSessionSet } from "../executor/agentExecutor.js";
import type { TaskEvent } from "../event/taskEvent.js";
import { builtinDriverIdForAdapter } from "../runtime/builtinAgentDrivers.js";
import { runtimeObservationFromTaskEvent, type RuntimeObservationFence } from "../runtime/runtimeObservation.js";
import { projectRuntimeTaskEvents, classifyRuntimeHealth } from "../runtime/runtimeProjection.js";
import { DEFAULT_RUNTIME_HEALTH_POLICY, type RuntimeHealthPolicy } from "../runtime/runtimeHealthPolicy.js";
import { providerRetryProjection } from "../runtime/providerRetry.js";

export type WebSessionGroup = "active" | "waiting" | "quiet" | "diagnostic" | "unknown" | "stopped" | "idle" | "background";
export type WebSession = Readonly<{
  taskId: string; roleName: string; agentId: string; nativeSessionId: string | null;
  driverId: string | null;
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
export function projectTaskSessions(input: Readonly<{
  taskId: string; sessionSets: readonly TaskRoleSessionSet[]; events: readonly TaskEvent[];
  now: Date; semanticProgressAt?: string; policy?: RuntimeHealthPolicy;
}>) {
  const policy = input.policy ?? DEFAULT_RUNTIME_HEALTH_POLICY;
  const sessions: WebSession[] = [];
  const seen = new Map<string, number>();
  const selectedIdentities = new Set<string>();
  const observationIdentity = (fence: { roleName?: string; agentId?: string; driverId?: string; nativeSessionId?: string }) =>
    JSON.stringify([fence.roleName, fence.agentId, fence.driverId, fence.nativeSessionId]);
  const observations = input.events.map(event => ({ event, observation: runtimeObservationFromTaskEvent(event) }))
    .filter(entry => entry.event.taskId === input.taskId && entry.observation?.fence.taskId === input.taskId);
  for (const set of input.sessionSets) {
    if (set.owner.scope !== "task" || set.owner.taskId !== input.taskId) continue;
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
    let driverId: string | null = null;
    if (session) {
      try { driverId = builtinDriverIdForAdapter(session.adapterId); }
      catch { /* Unsupported native observation remains explicitly unknown. */ }
    }
    const row: WebSession = {
      taskId: input.taskId, roleName: set.owner.roleName, agentId: set.activeAgentId,
      driverId,
      nativeSessionId, attemptId: turn?.attemptId ?? null, nativeTurnId: turn?.nativeTurnId ?? null,
      runId: turn?.runId ?? null, group: "unknown", reason: "Current native input is not observable.",
      layer: null, lastActivityAt: null, semanticProgressAt: input.semanticProgressAt ?? null,
      sourceUpdatedAt: turn?.updatedAt ?? session?.updatedAt ?? set.updatedAt,
      waitingReason: null, operations: [], background: []
    };
    if (!session || driverId === null) {
      sessions.push(row);
      continue;
    }
    const fence = { taskId: input.taskId, roleName: set.owner.roleName,
      agentId: session.agentId, driverId, nativeSessionId: session.nativeSessionId };
    selectedIdentities.add(observationIdentity(fence));
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
    const background = backgroundForRuns(fence, session.createdAt, groups);
    if (!binding || !conversation || conversation.conversationId !== session.nativeSessionId) {
      sessions.push({ ...row, background });
      continue;
    }
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
  // Retained, exactly fenced child observations can outlive a selected Session.
  // Do not revive old foreground Turns or enumerate historical Sessions: only
  // identities with still-unsettled child facts enter this current projection.
  const retained = new Map<string, typeof observations>();
  for (const entry of observations) {
    const fence = entry.observation!.fence;
    const key = observationIdentity(fence);
    if (!fence.nativeSessionId || selectedIdentities.has(key)) continue;
    const group = retained.get(key) ?? [];
    group.push(entry);
    retained.set(key, group);
  }
  for (const group of retained.values()) {
    const first = group[0]!.observation!;
    const fence = first.fence;
    const runs = new Map<string | undefined, TaskEvent[]>();
    for (const entry of group) {
      const runId = entry.observation!.fence.runId;
      const events = runs.get(runId) ?? [];
      events.push(entry.event);
      runs.set(runId, events);
    }
    const background = backgroundForRuns({
      taskId: input.taskId, roleName: fence.roleName, agentId: fence.agentId,
      driverId: fence.driverId, nativeSessionId: fence.nativeSessionId
    }, first.receivedAt, runs);
    if (!background.length) continue;
    sessions.push({
      taskId: input.taskId, roleName: fence.roleName, agentId: fence.agentId,
      driverId: fence.driverId,
      nativeSessionId: fence.nativeSessionId!, attemptId: null, nativeTurnId: null, runId: null,
      group: "background", reason: "Retained child observations from a non-selected native Session; foreground execution is not inferred.",
      layer: null, lastActivityAt: group.at(-1)!.observation!.receivedAt,
      semanticProgressAt: null, sourceUpdatedAt: group.at(-1)!.observation!.receivedAt,
      waitingReason: null, operations: [], background
    });
  }
  const counts: Record<WebSessionGroup, number> = {
    active: 0, waiting: 0, quiet: 0, diagnostic: 0, unknown: 0, stopped: 0, idle: 0, background: 0
  };
  for (const session of sessions) counts[session.group]++;
  return { scope: "task-recorded-native-activity" as const, taskId: input.taskId,
    readAt: input.now.toISOString(), counts, sessions,
    coverage: "Selected Sessions and retained, exactly fenced child observations only; not a live process or complete historical Session inventory." };
}

function backgroundForRuns(fence: RuntimeObservationFence, since: string, groups: Map<string | undefined, TaskEvent[]>) {
  return [...groups].flatMap(([runId, events]) => {
    const projection = projectRuntimeTaskEvents({ ...fence, ...(runId === undefined ? {} : { runId }) }, since, events);
    return [
      ...Object.entries(projection.continuations)
        .filter(([, child]) => child.execution !== "quiescent" || child.identityConflict)
        .map(([id, child]) => ({ id: `${runId ?? "native"}/${id}`,
          execution: child.identityConflict ? "unknown" : child.execution })),
      ...Object.entries(projection.operations).filter(([, operation]) => operation.kind === "subagent")
        .map(([id]) => ({ id: `${runId ?? "native"}/operation:${id}`, execution: "unsettled" }))
    ];
  });
}
