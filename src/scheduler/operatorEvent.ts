import { enqueueWork, type WorkMailboxQueueStore } from "../coordination/workMailboxQueue.js";
import { createTaskEvent, type TaskEvent, type TaskEventPayload } from "../event/taskEvent.js";

export const LEADER_ATTENTION_REQUIRED_EVENT = "leader.attention-required";

type OperatorEventStore = WorkMailboxQueueStore & Readonly<{
  nextEventId(taskId: string): string;
  saveEvent(taskId: string, event: TaskEvent): void;
}>;

type RoleEventStore = WorkMailboxQueueStore;

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
