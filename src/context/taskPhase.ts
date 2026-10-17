import type { TaskStore } from "../storage/taskStore.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { Task } from "../task/task.js";
import { contextContentDigest } from "./contextSnapshot.js";
import type { MailboxEntityRef } from "../coordination/workMailbox.js";

/** Existing immutable event payloads carry provenance, not a second authority
 * record. No body or historical aggregate is copied into the current view. */
export function activationSourceEvent(store: TaskStore, task: Task): TaskEvent | undefined {
  const requestId = task.activationRequest?.operation.requestId;
  if (requestId === undefined) return undefined;
  return store.queryContextRecords(task.id, {
    family: "task-event", eventTypes: ["task.activation-requested"], eventRequestId: requestId,
    descending: true, limit: 1
  }).records[0]?.value as TaskEvent | undefined;
}

export function taskPhase(store: TaskStore, task: Task) {
  const request = task.activationRequest;
  const event = activationSourceEvent(store, task);
  const messageId = event?.payload.sourceMessageId;
  const message = messageId === undefined ? undefined : store.queryContextRecords(task.id, {
    family: "task-message", ids: [messageId], limit: 1
  }).records[0];
  const body = (message?.value as { body?: string } | undefined)?.body;
  const status = event?.payload.sourceText !== undefined ? "available"
    : messageId === undefined ? "missing"
      : body === undefined ? "unavailable"
        : contextContentDigest(body) === event?.payload.sourceBodyDigest ? "available" : "changed";
  return {
    status: task.status,
    executionGate: task.executionGate.state,
    brief: taskBriefFreshness(store, task),
    activation: request === undefined ? null : {
      requestId: request.operation.requestId, disposition: request.disposition,
      actor: request.operation.actorId, effect: request.operation.effect,
      ...(request.afterPlanningRun === undefined ? {} : { afterPlanningRun: request.afterPlanningRun }),
      source: {
        status,
        ...(event === undefined ? {} : {
          ref: { store: "task-event", refId: event.id, digest: contextContentDigest(event) },
          read: `task event show ${task.id} ${event.id}`,
          attribution: event.payload.sourceKind ?? "unspecified",
          ...(event.payload.priorMessageId === undefined ? {} : { priorMessageId: event.payload.priorMessageId }),
          ...(messageId === undefined ? {} : {
            messageId, messageRead: `task message show ${task.id}/${messageId}`
          })
        }),
        ...(status === "available" ? {} : {
          recovery: "Read the exact activation event and original input; missing provenance is not a new prohibition or permission."
        })
      }
    }
  };
}

export function activationWakeRefs(store: TaskStore, task: Task): MailboxEntityRef[] {
  const event = activationSourceEvent(store, task);
  if (event === undefined) return [];
  return [
    { type: "event", taskId: task.id, id: event.id },
    ...(event.payload.sourceMessageId === undefined ? [] : [
      { type: "message" as const, taskId: task.id, id: event.payload.sourceMessageId }
    ])
  ];
}

const BRIEF_RELEVANT_EVENTS = [
  "message.sent", "message.updated", "message.native-user-input", "brief.updated",
  "decision.recorded", "decision.superseded", "input.requested", "input.answered", "input.cancelled", "input.auto-answered",
  "run.completed", "run.failed", "run.cancelled", "job.state-changed", "work.accepted",
  "work.updated", "work.edited", "work.scope-updated", "work.rejected", "work.retired",
  "review.completed", "review.failed", "integration.updated", "integration.completed", "integration.failed",
  "milestone.added",
  "task.activation-requested", "task.activation-adopted", "task.activated",
  "task.execution-started", "task.execution-stopped", "task.reopened", "task.updated"
];

function latestBriefChange(store: TaskStore, taskId: string) {
  return store.queryContextRecords(taskId, {
    family: "task-event", eventTypes: BRIEF_RELEVANT_EVENTS, descending: true, limit: 1
  }).records[0]?.value as TaskEvent | undefined;
}

function taskBriefFreshness(store: TaskStore, task: Task) {
  const brief = store.getTaskBrief(task.id);
  const last = latestBriefChange(store, task.id);
  return {
    status: brief === null ? "missing" : last === undefined ? "unverified"
      : last.type === "brief.updated" ? "current-at-last-semantic-write" : "refresh-needed",
    ...(last === undefined ? {} : { changedBy: { store: "task-event", refId: last.id, type: last.type } }),
    read: `task brief show ${task.id}`,
    note: "Leader-maintained summary; lifecycle, gate and Session authority are separate live facts."
  };
}

/** Optimistic guard for semantic edits, independent of wall clocks and noisy
 * runtime heartbeats. New input/result/decision/progress invalidates an old
 * writer even when its Brief text itself has not changed. */
export function taskBriefGuard(store: TaskStore, task: Task): string {
  const latest = latestBriefChange(store, task.id)?.id;
  return contextContentDigest({
    taskId: task.id, status: task.status, gate: task.executionGate,
    title: task.title, description: task.description, activation: task.activationRequest,
    brief: store.getTaskBrief(task.id), latest
  });
}
