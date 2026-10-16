import { enqueueWork, type WorkMailboxQueueStore } from "../coordination/workMailboxQueue.js";
import { createTaskEvent, type TaskEvent, type TaskEventPayload } from "../event/taskEvent.js";
import { claimPending, type ClaimOptions, type WorkMailbox } from "../coordination/workMailbox.js";

export const LEADER_ATTENTION_REQUIRED_EVENT = "leader.attention-required";

/** Bound each Operator pass, retaining the exact unclaimed sequence suffix. */
export function claimOperatorAttention(mailbox: WorkMailbox, options: ClaimOptions): WorkMailbox {
  const pending = mailbox.pending;
  if (pending === null || pending.requestCount <= 64) return claimPending(mailbox, options);
  // Operator producers append one unique source ref per signal. Mailbox merge
  // preserves insertion order for refs and keys, including the supported
  // default sequence keys used by Provider retry attention. Preserve those
  // keys verbatim; they are valid current data, not a migration or repair.
  if (pending.requestCount !== pending.dedupeKeys.length
    || pending.refs.length !== pending.requestCount
    || pending.toSequence - pending.fromSequence + 1 !== pending.requestCount
    || pending.dedupeKeys.some((key, index) => {
      const ref = pending.refs[index]!;
      if (ref.type === "global-job-run") return key !== `operator-global-job-run:${ref.id}`;
      return (ref.type !== "event" && ref.type !== "input")
        || key !== `operator-${ref.type}:${ref.taskId}:${ref.id}`
          && key !== `sequence:${pending.fromSequence + index}`;
    })) {
    throw new Error("Operator attention batch cannot be safely partitioned; inspect its source refs and sequence before retrying.");
  }
  const prefixKeys = pending.dedupeKeys.slice(0, 64);
  const suffixKeys = pending.dedupeKeys.slice(64);
  const through = pending.fromSequence + 63;
  const prefix = { ...pending, toSequence: through, requestCount: 64,
    dedupeKeys: prefixKeys, refs: pending.refs.slice(0, 64) };
  const claimed = claimPending({ ...mailbox, pending: prefix }, {
    ...options, batchId: `operator:${prefix.fromSequence}-${prefix.toSequence}`
  });
  return { ...claimed, pending: { ...pending, fromSequence: through + 1,
    requestCount: pending.requestCount - 64, dedupeKeys: suffixKeys,
    refs: pending.refs.slice(64) } };
}

type OperatorEventStore = WorkMailboxQueueStore & Readonly<{
  nextEventId(taskId: string): string;
  saveEvent(taskId: string, event: TaskEvent): void;
}>;

type RoleEventStore = WorkMailboxQueueStore;

/**
 * Fixed source admission at the durable event write, in the same transaction.
 * The existing mailbox is the incremental restart cursor: periodic scheduling
 * reads only outstanding refs, never re-scans or replays historical events.
 * Context, idle observations and ordinary progress are deliberately absent.
 */
export function enqueueDurableOperatorFact(store: WorkMailboxQueueStore, event: TaskEvent): void {
  const now = new Date(event.createdAt);
  if (event.type === "input.requested" && typeof event.payload.requestId === "string") {
    enqueueWork(store, { kind: "operator" }, "input-requested", now,
      [{ type: "input", taskId: event.taskId, id: event.payload.requestId }],
      { source: "input-request", dedupeKey: `operator-input:${event.taskId}:${event.payload.requestId}` });
  } else if (["task.completed", "task.cancelled", "task.retired", "publication.recorded",
    "publication.candidate-adopted", LEADER_ATTENTION_REQUIRED_EVENT].includes(event.type)) {
    enqueueOperatorEvent(store, event, event.type.startsWith("task.") ? "task-terminal" : event.type, now);
  }
}

/** One event, one supervisor signal; the Leader wake is this mailbox's projection. */
export function enqueueSupervisorEvent(
  store: WorkMailboxQueueStore, event: TaskEvent,
  recipient: "leader" | "operator", reason: string, now: Date
): void {
  if (store.getTask(event.taskId)?.status === "archived") return;
  const target = recipient === "operator" ? { kind: "operator" } as const
    : { kind: "role", taskId: event.taskId, roleName: "leader" } as const;
  enqueueWork(store, target, reason, now, [
    { type: "event", taskId: event.taskId, id: event.id }
  ], { source: "task-event", dedupeKey: `${recipient}-event:${event.taskId}:${event.id}` });
}

/** The sole Task-event boundary into the global Operator mailbox. */
export function enqueueOperatorEvent(
  store: WorkMailboxQueueStore,
  event: TaskEvent,
  reason: string,
  now: Date
): void {
  enqueueSupervisorEvent(store, event, "operator", reason, now);
}

/** Routes one Role fact to its supervisor without exposing Provider details to Operator code. */
export function routeRoleEvent(
  store: RoleEventStore,
  event: TaskEvent,
  roleName: string,
  reason: string,
  now: Date
): void {
  enqueueSupervisorEvent(store, event, roleName === "leader" ? "operator" : "leader", reason, now);
}

/** Records the semantic boundary used when a Leader can no longer continue. */
export function recordLeaderAttentionRequired(
  store: OperatorEventStore,
  input: Readonly<{
    taskId: string;
    reason: string;
    payload?: TaskEventPayload;
    now: Date;
  }>
): TaskEvent {
  const event = createTaskEvent(
    store.nextEventId(input.taskId),
    input.taskId,
    LEADER_ATTENTION_REQUIRED_EVENT,
    { ...(input.payload ?? {}), reason: input.reason },
    input.now
  );
  store.saveEvent(input.taskId, event);
  enqueueOperatorEvent(
    store,
    event,
    "leader-attention-required",
    input.now
  );
  return event;
}
