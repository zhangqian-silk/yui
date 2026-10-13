import { requireKnownFields, requireText, requireTimestamp } from "../domain/validation.js";
import { isDeepStrictEqual } from "node:util";

/** Agent handling evidence on the original record, never a transport receipt.
 * Claims have no timeout: a crash cannot prove that handling did not happen. */
export type InboxActor = Readonly<{
  scope: "global" | "task";
  taskId?: string;
  roleName: string;
  agentId: string;
  nativeSessionId: string;
  runId?: string;
}>;
export type InboxReceipt = Readonly<{
  claim: Readonly<{ requestId: string; actor: InboxActor; at: string }>;
  ack?: Readonly<{ requestId: string; actor: InboxActor; at: string; reason: string }>;
}>;

export function validateInboxReceipt(receipt: InboxReceipt | undefined): void {
  if (receipt === undefined) return;
  requireKnownFields(receipt, ["claim", "ack"], "Inbox receipt");
  for (const [kind, entry] of Object.entries(receipt)) {
    requireKnownFields(entry, kind === "claim" ? ["requestId", "actor", "at"]
      : ["requestId", "actor", "at", "reason"], "Inbox action");
    requireText(entry.requestId, "Inbox request id");
    requireTimestamp(entry.at, "Inbox timestamp");
    const actor = entry.actor as InboxActor;
    requireKnownFields(actor, ["scope", "taskId", "roleName", "agentId", "nativeSessionId", "runId"], "Inbox actor");
    if (!["task", "global"].includes(actor.scope)
      || (actor.scope === "task") !== (actor.taskId !== undefined)) throw new Error("Inbox actor scope is invalid.");
    for (const value of Object.values(actor)) requireText(value, "Inbox actor identity");
    if (kind === "ack") requireText((entry as NonNullable<InboxReceipt["ack"]>).reason, "Inbox disposition");
  }
  if (!receipt.claim) throw new Error("Inbox receipt requires its original claim.");
}

/** A stale automatic writer cannot erase an active claim between its read and
 * Host admission. The original claim and any ack are immutable audit facts. */
export function assertInboxReceiptPreserved(previous: InboxReceipt | undefined, next: InboxReceipt | undefined): void {
  if (previous !== undefined && (!isDeepStrictEqual(previous.claim, next?.claim)
    || previous.ack !== undefined && !isDeepStrictEqual(previous.ack, next?.ack))) {
    throw new Error("Inbox handling ownership changed; reread the original instead of overwriting its receipt.");
  }
}
