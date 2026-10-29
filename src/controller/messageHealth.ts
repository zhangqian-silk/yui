import type { TaskStore } from "../storage/taskStore.js";
import type { TaskEvent } from "../event/taskEvent.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { createGlobalRoleMessage, type TaskMessage } from "../message/message.js";
import type { JsonValue } from "../core/protocol.js";
import type { RoleSessionSet } from "../executor/agentExecutor.js";
import type { WorkMailbox } from "../coordination/workMailbox.js";
import { hasRuntimeCleanupObligation, runtimeLifecycleTarget } from "../runtime/lifecycleReservation.js";
import { providerRetryPending } from "../runtime/providerRetry.js";
import type { ProviderTurnStatus } from "../runtime/providerRuntimeIdentity.js";
import type { TaskHostTerminalObservation } from "./taskHostTerminalRecovery.js";
import { globalInputBacklog } from "../message/globalInputBacklog.js";

// These are observation thresholds, not leases or authority to release a writer.
export const MESSAGE_HEALTH_WARNING_MS = 5 * 60_000;
export const MESSAGE_HEALTH_CRITICAL_MS = 30 * 60_000;
const HEADER = "Yui message health v1\n";
const NOTICE = "operator-notice:message-health:";
type State = "clear" | "waiting" | "busy" | "paused" | "recovering" | "warning" | "critical";
type Facts = {
  count: number; oldestAt: string | null; processingAt: string | null;
  blocked: boolean; stopped: boolean; turnStatus?: ProviderTurnStatus;
  handling?: boolean;
  retryDeadline?: string;
};

export function classifyMessageHealth(facts: Facts, now: Date) {
  const ageMs = facts.oldestAt === null ? 0 : Math.max(0, +now - Date.parse(facts.oldestAt));
  const occupancyMs = facts.processingAt === null ? 0 : Math.max(0, +now - Date.parse(facts.processingAt));
  let state: State;
  let reason: string;
  if (facts.stopped) {
    state = "paused"; reason = "explicit-stop-pause-or-lifecycle";
  } else if (facts.count === 0 && facts.handling) {
    state = "busy"; reason = "claimed-input-handling-is-not-delivery-proof";
  } else if (facts.count === 0 && facts.processingAt === null) {
    state = "clear"; reason = "no-awaiting-delivery";
  } else if (facts.turnStatus === "accepted" && !facts.blocked) {
    state = "busy"; reason = "accepted-turn-duration-is-not-a-fault";
  } else if (facts.retryDeadline !== undefined && +now <= Date.parse(facts.retryDeadline)) {
    state = "recovering"; reason = "bounded-provider-retry-owned";
  } else {
    reason = facts.retryDeadline !== undefined ? "retry-budget-expired"
      : facts.blocked ? "retained-delivery-or-processing-barrier"
      : facts.turnStatus === "delivery-unknown" ? "delivery-uncertain"
      : facts.turnStatus === "submitting" ? "submission-unsettled" : "no-delivery-progress";
    state = Math.max(ageMs, occupancyMs) >= MESSAGE_HEALTH_CRITICAL_MS ? "critical"
      : Math.max(ageMs, occupancyMs) >= MESSAGE_HEALTH_WARNING_MS ? "warning" : "waiting";
  }
  return { state, reason, ageMs, occupancyMs };
}

type Target = { taskId?: string; roleName: string };
type Observation = ReturnType<typeof classifyMessageHealth> & Facts & {
  target: Target; observedAt: string; session: string | null; agentId: string | null;
  attemptId: string | null; nativeTurnId: string | null; host: string | null;
  authority: string | null; retry: { status: string; deadline: string; attempts: number } | null;
  hostObservation: { state: string; observedAt: string | null; reconciliation: string | null };
  wakeId: string | null; batchId: string | null; processingOwner: string | null;
  deliveryEvidence: { outcome: string; detail: string | null; read: string } | null;
  pendingCount: number; processingCount: number; pendingSince: string | null;
  waitingInputs: string[];
  refs: JsonValue[]; omittedRefs: number; answeredInputs: string[];
  reads: string[]; recovery: string;
};
type Evidence = {
  phase: "warning" | "critical" | "recovered"; firstAt: string; at: string;
  initialCount: number; peakCount: number; previous: string | null;
  observation: Observation;
};
type Saved = { id: string; read: string; evidence: Evidence };
export type MessageHealthSnapshot = {
  observedAt: string; warningAfterMs: number; criticalAfterMs: number;
  total: number; omitted: number; items: Array<Observation & {
    evidence: string | null; alert: ReturnType<typeof alertStatus>;
    incident: { phase: string; firstAt: string; latestEvidenceAt: string; initialCount: number } | null;
  }>;
};

function eventType(roleName: string) { return `message.health.${roleName}`; }
function prefix(target: Target) { return `${HEADER}${target.roleName}\n`; }
function noticeId(saved: Saved) { return NOTICE + encodeURIComponent(saved.id); }
function latest(store: TaskStore, target: Target): Saved | null {
  if (target.taskId !== undefined) {
    const event = store.queryContextRecords(target.taskId, { family: "task-event",
      eventTypes: [eventType(target.roleName)], descending: true, limit: 1 }).records[0]?.value as TaskEvent | undefined;
    return event ? { id: `${target.taskId}/${event.id}`,
      read: `yui task event show ${target.taskId} ${event.id}`,
      evidence: JSON.parse(event.payload.evidence!) as Evidence } : null;
  }
  const message = store.queryGlobalRoleMessages(target.roleName, {
    systemBodyPrefix: prefix(target), descending: true, limit: 1
  }).messages[0];
  return message ? { id: `${target.roleName}/${message.id}`,
    read: `yui role message show ${target.roleName} ${message.id}`,
    evidence: JSON.parse(message.body.slice(prefix(target).length)) as Evidence } : null;
}

function record(store: TaskStore, target: Target, evidence: Evidence, now: Date): Saved {
  if (target.taskId !== undefined) {
    const event = createTaskEvent(store.nextEventId(target.taskId), target.taskId,
      eventType(target.roleName), { evidence: JSON.stringify(evidence) }, now);
    store.saveEvent(target.taskId, event);
    return { id: `${target.taskId}/${event.id}`, read: `yui task event show ${target.taskId} ${event.id}`, evidence };
  }
  const message = createGlobalRoleMessage(store.nextGlobalRoleMessageId(), target.roleName,
    prefix(target) + JSON.stringify(evidence), "system", { type: "system" }, now);
  store.saveGlobalRoleMessage(message);
  return { id: `${target.roleName}/${message.id}`, read: `yui role message show ${target.roleName} ${message.id}`, evidence };
}

function alertStatus(store: TaskStore, saved: Saved | null) {
  if (!saved) return { stage: "not-generated", reason: null, messageId: null };
  const message = store.queryGlobalRoleMessages("operator", {
    requestId: noticeId(saved), limit: 1
  }).messages[0];
  if (message?.inbox?.ack) return { stage: "handled", reason: null, messageId: message.id };
  if (message?.delivery) return { stage: message.delivery.via === "provider" ? "delivered" : "transport-accepted",
    reason: message.delivery.via === "provider" ? null : "provider-acceptance-unconfirmed", messageId: message.id };
  if (message) return { stage: "saved", messageId: message.id,
    reason: message.notDelivered?.reason ?? message.control?.outcome
      ?? (store.getGlobalRole("operator")?.enabled === false ? "operator-disabled"
        : globalInputBacklog([message], store.getGlobalRoleSessionSet("operator")).reason) };
  return { stage: "generated", messageId: null,
    reason: store.getGlobalRole("operator") === null ? "operator-unconfigured"
      : operatorAvailable(store) ? "operator-notice-pending" : "operator-unavailable" };
}

function operatorAvailable(store: TaskStore) {
  const sessions = store.getGlobalRoleSessionSet("operator");
  return sessions?.sessions[sessions.activeAgentId]?.status === "active" && sessions.providerBinding != null;
}

/** Same Global Message queue and receipt contract as ordinary Operator notices.
 * No Task mailbox is involved. A busy/unavailable Operator never loses evidence.
 * At most one unsent engineering notice; original failed notices are not replayed. */
function notify(store: TaskStore, saved: Saved, now: Date): void {
  if (store.getGlobalRole("operator") === null
    || !operatorAvailable(store)
    || store.queryGlobalRoleMessages("operator", { requestId: noticeId(saved), limit: 1 }).count
    || store.queryGlobalRoleMessages("operator", { pending: true, operatorNotice: true, limit: 1 }).count) return;
  const { phase, observation } = saved.evidence;
  const sessions = store.getGlobalRoleSessionSet("operator")!;
  const session = sessions.sessions[sessions.activeAgentId]!;
  const message = createGlobalRoleMessage(store.nextGlobalRoleMessageId(), "operator", [
    `Yui-Summary: Message delivery ${phase}: ${observation.target.taskId ?? "global"}/${observation.target.roleName}.`,
    `Inspect: ${saved.read}`,
    "Independent diagnostics: yui controller status --verbose --json",
    "Read current facts before acting. Alert acknowledgement is not recovery.",
    "Do not ACK business inputs, release unknown writers, replay input, replace Sessions or change models automatically."
  ].join("\n"), "system", { type: "system" }, now,
  { inputControl: { action: "queue", requestId: noticeId(saved) } });
  store.saveGlobalRoleMessage({ ...message,
    deliveryTarget: { agentId: session.agentId, nativeSessionId: session.nativeSessionId } });
}

function oldest(times: Array<string | null | undefined>) {
  return times.filter((time): time is string => time != null).sort()[0] ?? null;
}

function observe(store: TaskStore, target: Target, now: Date, hosts: TaskHostTerminalObservation[]): Observation {
  const { taskId, roleName } = target;
  const owner = taskId === undefined ? { scope: "global", roleName } as const
    : { scope: "task", taskId, roleName } as const;
  const task = taskId === undefined ? null : store.getTask(taskId);
  const role = taskId === undefined ? store.getGlobalRole(roleName) : store.getRole(taskId, roleName);
  const sessions: RoleSessionSet | null = taskId === undefined ? store.getGlobalRoleSessionSet(roleName)
    : store.getTaskRoleSessionSet(taskId, roleName);
  const session = sessions?.sessions[sessions.activeAgentId];
  const binding = sessions?.providerBinding;
  const currentBinding = binding != null && session !== undefined
    && binding.conversations.some(conversation => conversation.status === "current"
      && conversation.epoch === binding.currentConversationEpoch && conversation.conversationId === session.nativeSessionId);
  const turn = currentBinding && binding?.run?.authorityEpoch === binding.authority.epoch ? binding.run : null;
  const mailbox: WorkMailbox | null = taskId === undefined
    ? roleName === "operator" ? store.getWorkMailbox({ kind: "operator" }) : null
    : store.getWorkMailbox({ kind: "role", taskId, roleName });
  const handlingOnly = mailbox?.processing?.owner.startsWith("agent-inbox:") ?? false;
  const batches = [mailbox?.pending, handlingOnly ? null : mailbox?.processing?.batch].filter(batch => batch != null);
  const refs = batches.flatMap(batch => [...batch.refs]);
  const wakeId = mailbox?.processing?.owner.startsWith("leader-notification:")
    ? mailbox.processing.owner.slice("leader-notification:".length) : null;
  const wake = wakeId && taskId ? store.getTaskWake(taskId, wakeId) : null;
  const delivery = taskId && mailbox?.processing ? store.queryContextRecords(taskId, {
    family: "task-event", eventTypes: ["notification.delivery"],
    eventAttemptId: mailbox.processing.batchId, descending: true, limit: 1
  }).records[0]?.value as TaskEvent | undefined : undefined;
  // Delivery failures stay visible even when ordinary pending excludes notDelivered.
  // Handling-only historical receipts never become new queue work.
  const globalPage = taskId === undefined ? store.queryGlobalRoleMessages(roleName, {
    awaitingDelivery: true, unclaimed: true, excludeHealthNotices: true, limit: 8
  }) : null;
  const handling = handlingOnly || taskId === undefined && store.queryGlobalRoleMessages(roleName, {
    awaitingDelivery: true, handling: true, excludeHealthNotices: true, limit: 1
  }).count > 0;
  const messages = globalPage?.messages ?? [];
  const taskPage = taskId === undefined ? null : store.queryContextRecords(taskId, {
    family: "task-message", queuedForRole: roleName, unhandledMessages: true, limit: 8
  });
  const taskMessages = taskPage?.records.map(record => record.value as TaskMessage) ?? [];
  const host = hosts.find(item => item.taskId === taskId && item.roleName === roleName
    && item.attemptId === turn?.attemptId && item.nativeSessionId === session?.nativeSessionId);
  let hostObservation: Observation["hostObservation"] = host
    ? { state: host.state, observedAt: host.observedAt, reconciliation: host.reconciliation }
    : { state: "unobserved", observedAt: null, reconciliation: null };
  if (taskId === undefined && turn?.status === "accepted") {
    // Reuse existing Global Host failure evidence, never probe a second time.
    const failure = store.queryGlobalRoleMessages(roleName, {
      systemBodyPrefix: "Yui Global failure evidence ", descending: true, limit: 1
    }).messages[0];
    if (failure) {
      const facts = JSON.parse(failure.body.slice(failure.body.indexOf("\n") + 1));
      if (facts.reason === "host-terminal-unobservable" && facts.attemptId === turn.attemptId
        && facts.nativeSessionId === session?.nativeSessionId && failure.createdAt >= turn.updatedAt) {
        hostObservation = { state: typeof facts.hostState === "string" ? facts.hostState : "unobservable",
          observedAt: failure.createdAt, reconciliation: facts.cause ?? null };
      }
    }
  }
  const count = batches.reduce((n, batch) => n + batch.requestCount, 0)
    + (globalPage?.count ?? 0) + (taskPage?.count ?? 0);
  const answeredInputs = refs.flatMap(ref => {
    if (ref.type !== "input") return [];
    return store.getInputRequest(ref.taskId, ref.id)?.status === "answered" ? [`${ref.taskId}/${ref.id}`] : [];
  });
  // Only explicit matching blocked refs constitute a user wait. An unrelated
  // open InputRequest must not hide an answered input stuck in the same Task.
  const waitingInputs = taskId === undefined || roleName === "leader" ? [] :
    store.listOpenInputRequests([taskId]).filter(request => request.blockedRefs.some(ref =>
      ref.type === "run" && refs.some(queued => queued.type === "run" && queued.id === ref.id)
      || ref.type === "work-item" && taskMessages.some(message => message.recipient?.workItemId === ref.id)))
      .map(request => request.id);
  const facts: Facts = {
    count, handling, oldestAt: oldest([...batches.map(batch => batch.firstQueuedAt), globalPage?.oldestCreatedAt,
      taskMessages[0]?.createdAt]),
    processingAt: handlingOnly && count === 0 ? null : mailbox?.processing?.startedAt ?? null,
    blocked: mailbox?.processing != null && wake?.status !== "consumed"
      && turn?.status !== "accepted"
      || messages.some(message => message.notDelivered !== undefined
        || message.control?.outcome === "delivery-unknown" || message.control?.outcome === "pending")
      || taskMessages.some(message => message.continuation?.notDeliveredReason !== undefined)
      || ["idle", "failed", "exited", "unobservable"].includes(hostObservation.state)
        && hostObservation.reconciliation !== "terminal-republished",
    stopped: role?.enabled === false || session?.endReason === "stopped"
      || task !== null && (!["active", "draft"].includes(task.status) || task.executionGate.state !== "enabled")
      || binding?.authority.owner === "human" || binding?.goal?.status === "paused"
      || waitingInputs.length > 0
      || hasRuntimeCleanupObligation(store.getWorkMailbox(runtimeLifecycleTarget(owner))),
    turnStatus: turn?.status,
    ...(currentBinding && providerRetryPending(binding)
      && binding!.retry!.nativeSessionId === session!.nativeSessionId
      && binding!.retry!.authorityEpoch === binding!.authority.epoch ? { retryDeadline: binding!.retry!.deadline } : {})
  };
  const classification = classifyMessageHealth(facts, now);
  const readBase = taskId ? `yui task role session inspect ${taskId} ${roleName}`
    : `yui config role show ${roleName}`;
  return {
    ...facts, ...classification, target, observedAt: now.toISOString(),
    session: session?.nativeSessionId ?? null, agentId: session?.agentId ?? null, hostObservation,
    attemptId: turn?.attemptId ?? null, nativeTurnId: turn?.nativeTurnId ?? null,
    host: binding?.authority.holderId ?? null, authority: binding?.authority.owner ?? null,
    retry: binding?.retry ? { status: binding.retry.status, deadline: binding.retry.deadline,
      attempts: binding.retry.attempts } : null,
    wakeId, batchId: mailbox?.processing?.batchId ?? null, processingOwner: mailbox?.processing?.owner ?? null,
    deliveryEvidence: delivery ? { outcome: delivery.payload.outcome ?? "unreported",
      detail: delivery.payload.detail ?? null,
      read: `yui task event show ${taskId} ${delivery.id}` } : null,
    pendingCount: (mailbox?.pending?.requestCount ?? 0) + (globalPage?.count ?? 0) + (taskPage?.count ?? 0),
    processingCount: mailbox?.processing?.batch.requestCount ?? 0,
    pendingSince: mailbox?.pending?.firstQueuedAt ?? globalPage?.oldestCreatedAt ?? taskMessages[0]?.createdAt ?? null,
    waitingInputs,
    refs: [...refs.slice(0, 8), ...messages.map(message => ({
      messageId: message.id, control: message.control ?? null, notDelivered: message.notDelivered ?? null
    })), ...taskMessages.map(message => ({
      messageId: message.id, recipient: message.recipient!, continuation: message.continuation ?? null
    }))], omittedRefs: Math.max(0, refs.length - 8) + Math.max(0, (globalPage?.count ?? 0) - messages.length)
      + Math.max(0, (taskPage?.count ?? 0) - taskMessages.length),
    answeredInputs: answeredInputs.slice(0, 8),
    reads: [readBase, ...(wakeId && taskId ? [`yui task wake show ${taskId} ${wakeId}`] : []),
      ...messages.map(message => `yui role message show ${roleName} ${message.id}`),
      ...taskMessages.map(message => `yui task message show ${taskId}/${message.id}`)],
    recovery: classification.state === "recovering" ? "Existing bounded retry owns recovery; do not start another attempt."
      : wakeId && taskId ? `Inspect the exact wake/attempt and Host terminal first. Only proven quiescence permits yui task wake resolve ${taskId} ${wakeId}; corrected rejection may permit yui task wake retry ${taskId} ${wakeId}. Neither action is performed by monitoring.`
      : "Inspect Session, original input/control and Host evidence. No timeout proves quiescence or permits replay. An empty queue proves only delivery backlog clearance, not handling or business recovery."
  };
}

/** Low-rate Controller observation, not an Agent loop. All decisions use current
 * records inside each short transaction; evidence + queue admission are atomic.
 * Open Event/Message content carries audit facts; no new storage envelope/index
 * or independently writable scheduler state is introduced. */
export function reconcileMessageHealth(
  store: TaskStore, now = new Date(), hosts: TaskHostTerminalObservation[] = []
): MessageHealthSnapshot {
  const targets: Target[] = store.listTasks().filter(task => task.status !== "archived").flatMap(task =>
    store.listRoles(task.id).map(role => ({ taskId: task.id, roleName: role.name })));
  targets.push(...store.listGlobalRoles().map(role => ({ roleName: role.name })));
  const items: MessageHealthSnapshot["items"] = [];
  for (const target of targets) {
    store.transaction(tx => {
      const observation = observe(tx, target, now, hosts);
      let saved = latest(tx, target);
      const previous = saved?.evidence;
      const active = previous !== undefined && previous.phase !== "recovered";
      const growing = active && observation.state === "warning" && observation.ageMs >= 15 * 60_000
        && observation.count >= Math.max(8, previous.initialCount * 2);
      const desired = growing ? "critical" : observation.state;
      const phase = desired === "warning" || desired === "critical"
        ? (!active || desired === "critical" && previous.phase === "warning" ? desired : null)
        : desired === "clear" && active ? "recovered" : null;
      if (phase !== null) {
        saved = record(tx, target, {
          phase, firstAt: active ? previous.firstAt : now.toISOString(), at: now.toISOString(),
          initialCount: active ? previous.initialCount : observation.count,
          peakCount: Math.max(active ? previous.peakCount : 0, observation.count),
          previous: saved?.id ?? null, observation
        }, now);
      }
      if (saved !== null) notify(tx, saved, now);
      if (observation.count > 0 || observation.processingAt !== null || saved !== null) {
        items.push({ ...observation, evidence: saved?.read ?? null, alert: alertStatus(tx, saved),
          incident: saved ? { phase: saved.evidence.phase, firstAt: saved.evidence.firstAt,
            latestEvidenceAt: saved.evidence.at, initialCount: saved.evidence.initialCount } : null });
      }
    });
  }
  // Status is an O(1) cached bounded view; exact originals remain independently readable.
  const priority = (state: State) => state === "critical" ? 0 : state === "warning" ? 1 : state === "clear" ? 3 : 2;
  items.sort((a, b) => priority(a.state) - priority(b.state) || b.ageMs - a.ageMs);
  return { observedAt: now.toISOString(), warningAfterMs: MESSAGE_HEALTH_WARNING_MS,
    criticalAfterMs: MESSAGE_HEALTH_CRITICAL_MS, total: items.length, omitted: Math.max(0, items.length - 64),
    items: items.slice(0, 64) };
}
