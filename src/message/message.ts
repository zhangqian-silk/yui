import { validateTaskRecordReference } from "../task/taskRecordReference.js";
import type { AgentRun } from "../agentRun/agentRun.js";

export const TASK_MESSAGE_KINDS = ["user", "operator", "role-result", "system"] as const;

export type TaskMessageKind = typeof TASK_MESSAGE_KINDS[number];

/**
 * How a user/operator submission asks its Task to react (task-32 Requirement A).
 *
 * - `record`: save only. No Leader wake, no planning, no activation.
 * - `discuss`: save and route to planning (the default when a submission omits
 *   an intent, so an old client keeps its existing Leader-waking behaviour).
 * - `develop`: save the requirement and its activation intent; an unplanned
 *   Draft records an activation request and queues only activation processing.
 *
 * The intent is never inferred from body text and is only meaningful on a
 * user/operator submission: a role-result or system Message can never carry one,
 * so an internal Agent report cannot acquire develop authority.
 */
export const TASK_SUBMISSION_INTENTS = ["record", "discuss", "develop"] as const;

export type TaskSubmissionIntent = typeof TASK_SUBMISSION_INTENTS[number];

export type TaskMessageAuthor =
  | Readonly<{ type: "user" }>
  | Readonly<{ type: "operator" }>
  | Readonly<{ type: "role"; roleName: string }>
  | Readonly<{ type: "system" }>;

/** Logical ownership is frozen at send time, never inferred from the latest
 * native process occupying a Role. The referenced Run supplies the Assignment. */
export type TaskMessageRecipient = Readonly<{
  roleName: string;
  /** Absent for a scoped Leader notification, which is not an Assignment. */
  ownerRunId?: string;
  workItemId?: string;
  reviewRoundId?: string;
}>;

export type TaskMessage = {
  schemaVersion: 3;
  id: string;
  taskId: string;
  kind: TaskMessageKind;
  author: TaskMessageAuthor;
  body: string;
  /**
   * Machine-readable wake policy for user/operator messages (Issue 05).
   * - `leader`: the message is a directive that should wake the Leader.
   * - `none`: the message is informational context only; it must not wake
   *   the Leader or create a Leader AgentRun.
   * Absent on older messages and on role-result/system messages, which keep
   * their existing routing.
   */
  wakePolicy?: "leader" | "none";
  /**
   * The submission intent this user/operator Message carried (task-32 A). Absent
   * on role-result/system Messages, and on historical Messages saved before the
   * intent existed — a reader treats that absence as `discuss`, never as
   * `develop`. Persisted so the routing a submission received stays auditable
   * after the fact, independent of the Task's current phase.
   */
  intent?: TaskSubmissionIntent;
  /**
   * The client-chosen idempotency key for a user/operator submission (task-32
   * §2.3): the narrow persistent fact that lets a retry replay its original
   * outcome. Absent on role-result/system Messages and on keyless submissions, so
   * an old client keeps its existing non-idempotent behaviour.
   */
  submissionKey?: string;
  runId?: string;
  resultRef?: Readonly<{ type: "agent-run-result"; runId: string }>;
  workItemId?: string;
  recipient?: TaskMessageRecipient;
  continuation?: Readonly<{
    runId?: string;
    notDeliveredReason?: string;
  }>;
  handovers?: readonly Readonly<{ from: TaskMessageRecipient; at: string }>[];
  createdAt: string;
};

export type TaskMessageContext = Readonly<{
  runId?: string;
  resultRef?: Readonly<{ type: "agent-run-result"; runId: string }>;
  workItemId?: string;
  wakePolicy?: "leader" | "none";
  intent?: TaskSubmissionIntent;
  submissionKey?: string;
  recipient?: TaskMessageRecipient;
}>;

export type TaskMessageDraftUpdate = Readonly<{
  body: string;
  wakePolicy?: "leader" | "none";
}>;

export function createTaskMessage(
  id: string,
  taskId: string,
  body: string,
  kind: TaskMessageKind,
  author: TaskMessageAuthor,
  now: Date,
  context: TaskMessageContext = {}
): TaskMessage {
  validateKindAndAuthor(kind, author);
  const message: TaskMessage = {
    schemaVersion: 3,
    id: requireSafeIdentity(id, "Message id"),
    taskId: requireSafeIdentity(taskId, "Message Task id"),
    kind,
    author: normalizeAuthor(author),
    body: requireBody(body),
    ...(context.wakePolicy === undefined
      ? {}
      : { wakePolicy: context.wakePolicy }),
    ...(context.intent === undefined
      ? {}
      : { intent: context.intent }),
    ...(context.submissionKey === undefined
      ? {}
      : { submissionKey: requireText(context.submissionKey, "Message submission key") }),
    ...(context.runId === undefined
      ? {}
      : { runId: requireSafeIdentity(context.runId, "Message AgentRun id") }),
    ...(context.resultRef === undefined ? {} : { resultRef: { ...context.resultRef } }),
    ...(context.workItemId === undefined
      ? {}
      : { workItemId: requireSafeIdentity(context.workItemId, "Message Work item id") }),
    ...(context.recipient === undefined ? {} : { recipient: { ...context.recipient },
      ...(context.recipient.ownerRunId === undefined ? {} : { continuation: {} }) }),
    createdAt: now.toISOString()
  };
  validateTaskMessage(message);
  return message;
}

export function taskMessageAuthorLabel(author: TaskMessageAuthor): string {
  return author.type === "role" ? author.roleName : author.type;
}

/** A role-result reference never duplicates the execution's report body. */
export function expandTaskMessageResult(
  message: TaskMessage,
  getRun: (taskId: string, runId: string) => AgentRun | null
) {
  if (message.resultRef === undefined) return message;
  const run = getRun(message.taskId, message.resultRef.runId);
  if (run === null || run.taskId !== message.taskId
    || message.author.type !== "role" || run.roleName !== message.author.roleName
    || run.status === "active" || run.result === undefined) {
    throw new Error(`Result Message has no matching terminal execution: ${message.id}.`);
  }
  return { ...message, result: run.result };
}

/** Replace only the mutable content of a Draft user/operator Message. */
export function updateDraftTaskMessage(
  message: TaskMessage,
  update: TaskMessageDraftUpdate
): TaskMessage {
  validateTaskMessage(message);
  if (message.kind !== "user" && message.kind !== "operator") {
    throw new Error(`Only user/operator Task Messages can be updated: ${message.id}.`);
  }
  const updated: TaskMessage = {
    ...message,
    body: requireBody(update.body),
    ...(update.wakePolicy === undefined
      ? {}
      : { wakePolicy: update.wakePolicy })
  };
  validateTaskMessage(updated);
  return updated;
}

export function validateTaskMessage(message: TaskMessage): void {
  if (message.schemaVersion !== 3) throw new Error("Task Message must use schemaVersion 3.");
  validateTaskRecordReference({ taskId: message.taskId, localId: message.id }, "message");
  requireText(message.body, "Message body");
  validateKindAndAuthor(message.kind, message.author);
  normalizeAuthor(message.author);
  if (message.wakePolicy !== undefined
    && message.wakePolicy !== "leader"
    && message.wakePolicy !== "none") {
    throw new Error(`Message wakePolicy is invalid: ${String(message.wakePolicy)}.`);
  }
  if (message.wakePolicy !== undefined
    && message.kind !== "user"
    && message.kind !== "operator") {
    throw new Error("Message wakePolicy is only valid for user/operator messages.");
  }
  if (message.intent !== undefined
    && !TASK_SUBMISSION_INTENTS.includes(message.intent)) {
    throw new Error(`Message intent is invalid: ${String(message.intent)}.`);
  }
  if (message.intent !== undefined
    && message.kind !== "user"
    && message.kind !== "operator") {
    throw new Error("Message intent is only valid for user/operator messages.");
  }
  if (message.submissionKey !== undefined) {
    requireText(message.submissionKey, "Message submission key");
    if (message.kind !== "user" && message.kind !== "operator") {
      throw new Error("Message submission key is only valid for user/operator messages.");
    }
  }
  if (message.runId !== undefined) requireSafeIdentity(message.runId, "Message AgentRun id");
  if (message.recipient !== undefined) {
    requireSafeIdentity(message.recipient.roleName, "Recipient Role");
    if (message.recipient.ownerRunId !== undefined) {
      validateTaskRecordReference({ taskId: message.taskId, localId: message.recipient.ownerRunId }, "run");
    } else if (message.recipient.roleName !== "leader") {
      throw new Error("An execution recipient requires an owner Assignment.");
    }
    if (message.recipient.workItemId !== undefined) {
      validateTaskRecordReference({ taskId: message.taskId, localId: message.recipient.workItemId }, "workItem");
    }
    if (message.recipient.reviewRoundId !== undefined) {
      requireSafeIdentity(message.recipient.reviewRoundId, "Recipient ReviewRound");
    }
    if (message.recipient.workItemId === undefined && message.recipient.reviewRoundId === undefined) {
      throw new Error("A recipient requires an exact WorkItem or ReviewRound.");
    }
  }
  if (message.continuation !== undefined && message.recipient?.ownerRunId === undefined) {
    throw new Error("Message continuation requires an owner Assignment.");
  }
  if (message.continuation?.runId !== undefined) {
    validateTaskRecordReference({ taskId: message.taskId, localId: message.continuation.runId }, "run");
  }
  if (message.continuation?.notDeliveredReason !== undefined) {
    requireText(message.continuation.notDeliveredReason, "Message nondelivery reason");
    if (message.continuation.runId !== undefined) throw new Error("Assigned Message delivery is observed from its AgentRun.");
  }
  for (const handover of message.handovers ?? []) {
    requireSafeIdentity(handover.from.roleName, "Previous Message Role");
    requireSafeIdentity(handover.from.ownerRunId!, "Previous Message Assignment");
    if (Number.isNaN(Date.parse(handover.at))) throw new Error("Message handover timestamp is invalid.");
  }
  if (message.resultRef !== undefined) {
    if (message.kind !== "role-result" || message.resultRef.type !== "agent-run-result") {
      throw new Error("Execution result references require a role-result Message.");
    }
    validateTaskRecordReference({ taskId: message.taskId, localId: message.resultRef.runId }, "run");
  }
  if (message.workItemId !== undefined) {
    validateTaskRecordReference({
      taskId: message.taskId,
      localId: message.workItemId
    }, "workItem");
  }
  if (message.runId !== undefined) {
    validateTaskRecordReference({ taskId: message.taskId, localId: message.runId }, "run");
  }
  if (typeof message.createdAt !== "string" || Number.isNaN(Date.parse(message.createdAt))) {
    throw new Error("Message createdAt is invalid.");
  }
}

function validateKindAndAuthor(kind: TaskMessageKind, author: TaskMessageAuthor): void {
  if (!TASK_MESSAGE_KINDS.includes(kind)) throw new Error(`Message kind is invalid: ${String(kind)}.`);
  const expectedType = kind === "role-result" ? "role" : kind;
  if (author?.type !== expectedType) {
    const label = kind === "role-result" ? "Role result" : `Message kind ${kind}`;
    throw new Error(`${label} requires a ${expectedType} author.`);
  }
}

function normalizeAuthor(author: TaskMessageAuthor): TaskMessageAuthor {
  return author.type === "role"
    ? { type: "role", roleName: requireSafeIdentity(author.roleName, "Message Role name") }
    : { type: author.type };
}

function requireSafeIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}

function requireBody(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Message body is invalid.");
  }
  if (value.trim().length === 0) throw new Error("Message body is required.");
  return value;
}
