import { requireKnownFields, requireText, requireTimestamp } from "../domain/validation.js";
import { isDeepStrictEqual } from "node:util";
import type { GlobalRoleMessage } from "./message.js";

/** Agent handling evidence on the original record, never a transport receipt.
 * Claims have no timeout: a crash cannot prove that handling did not happen. */
export type InboxActor = Readonly<{
  scope: "global" | "task";
  taskId?: string;
  roleName: string;
  agentId: string;
  nativeSessionId: string;
  runId?: string;
  /** Exact locally owned native attempt, when observed at claim time. */
  attemptId?: string;
}>;
export type InboxReceipt = Readonly<{
  claim: Readonly<{ requestId: string; actor: InboxActor; at: string }>;
  ack?: Readonly<{ requestId: string; actor: InboxActor; at: string; reason: string }>;
  /** Explicit disposal of obsolete, proven-unsubmitted Global input. Not ACK. */
  retirement?: Readonly<{ requestId: string; actor: InboxActor; at: string; reason: string }>;
}>;

/** Semantic handling and transport delivery are independent facts. Projections
 * must not infer handling from delivery, a native terminal, or an empty queue. */
export function inboxHandlingState(receipt: InboxReceipt | undefined): "unclaimed" | "claimed-unacknowledged" | "handled" | "retired" {
  return receipt?.retirement !== undefined ? "retired" : receipt?.ack !== undefined ? "handled"
    : receipt !== undefined ? "claimed-unacknowledged" : "unclaimed";
}

export function isGlobalInboxMessage(message: GlobalRoleMessage): boolean {
  return message.inputControl !== undefined || message.interruptThen !== undefined;
}

/** Unhandled own-role input, including accepted and unknown delivery. This is
 * NOT the scheduler's deliverable queue; selecting it never authorizes replay. */
export function pendingGlobalInboxMessages(messages: readonly GlobalRoleMessage[]): GlobalRoleMessage[] {
  return messages.filter(message => isGlobalInboxMessage(message)
    && !["handled", "retired"].includes(inboxHandlingState(message.inbox)));
}

/** Original message evidence only. A missing receipt is not proof of
 * non-submission; admission additionally inspects the exact native attempt. */
export function globalInboxDeliveryState(message: GlobalRoleMessage):
  "unobserved" | "pending" | "accepted" | "rejected" | "delivery-unknown" {
  return message.control?.outcome ?? (message.delivery?.via === "provider" ? "accepted"
    : message.delivery === undefined ? "unobserved" : "delivery-unknown");
}

export function validateInboxReceipt(receipt: InboxReceipt | undefined): void {
  if (receipt === undefined) return;
  requireKnownFields(receipt, ["claim", "ack", "retirement"], "Inbox receipt");
  if (receipt.ack && receipt.retirement) throw new Error("Inbox disposition cannot be both acknowledgement and retirement.");
  for (const [kind, entry] of Object.entries(receipt)) {
    requireKnownFields(entry, kind === "claim" ? ["requestId", "actor", "at"]
      : ["requestId", "actor", "at", "reason"], "Inbox action");
    requireText(entry.requestId, "Inbox request id");
    requireTimestamp(entry.at, "Inbox timestamp");
    const actor = entry.actor as InboxActor;
    requireKnownFields(actor, ["scope", "taskId", "roleName", "agentId", "nativeSessionId", "runId", "attemptId"], "Inbox actor");
    if (!["task", "global"].includes(actor.scope)
      || (actor.scope === "task") !== (actor.taskId !== undefined)) throw new Error("Inbox actor scope is invalid.");
    for (const value of Object.values(actor)) requireText(value, "Inbox actor identity");
    if (kind !== "claim") requireText((entry as NonNullable<InboxReceipt["ack"]>).reason, "Inbox disposition");
  }
  if (!receipt.claim) throw new Error("Inbox receipt requires its original claim.");
}

/** A stale automatic writer cannot erase an active claim between its read and
 * Host admission. The original claim and any ack are immutable audit facts. */
export function assertInboxReceiptPreserved(previous: InboxReceipt | undefined, next: InboxReceipt | undefined): void {
  if (previous !== undefined && (!isDeepStrictEqual(previous.claim, next?.claim)
    || previous.ack !== undefined && !isDeepStrictEqual(previous.ack, next?.ack)
    || previous.retirement !== undefined && !isDeepStrictEqual(previous.retirement, next?.retirement))) {
    throw new Error("Inbox handling ownership changed; reread the original instead of overwriting its receipt.");
  }
}

/** A receipt cannot silently acknowledge different content under the same ID.
 * Operational delivery/Assignment fields may evolve with their existing
 * guards, but handled originals must be submitted as new Messages to change.
 */
export function assertInboxOriginalPreserved(
  previous: { inbox?: InboxReceipt; body: string; author: unknown; kind: string; inputControl?: unknown; control?: { target?: unknown } } | undefined,
  next: { inbox?: InboxReceipt; body: string; author: unknown; kind: string; inputControl?: unknown; control?: { target?: unknown } }
): void {
  assertInboxReceiptPreserved(previous?.inbox, next.inbox);
  if (previous?.control?.target !== undefined && !isDeepStrictEqual(previous.control.target, next.control?.target)) {
    throw new Error("The exact admitted control target cannot be replaced or erased.");
  }
  if (previous?.inbox !== undefined && (previous.body !== next.body || previous.kind !== next.kind
    || !isDeepStrictEqual(previous.author, next.author) || !isDeepStrictEqual(previous.inputControl, next.inputControl))) {
    throw new Error("Inbox receipt binds the exact original Message; submit changed content as a new Message.");
  }
}
