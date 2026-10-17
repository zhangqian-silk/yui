import type { InboxActor, InboxReceipt } from "./inboxReceipt.js";
import { globalInboxDeliveryState } from "./inboxReceipt.js";
import type { GlobalRoleMessage, TaskMessage } from "./message.js";
import type { TaskWake } from "../scheduler/taskWake.js";
import type { ProviderTurn } from "../runtime/providerRuntimeIdentity.js";

export type InboxEntry = GlobalRoleMessage | TaskMessage | TaskWake;
export const INBOX_CHECK_PREFIX = "inbox-check:";
export const INBOX_CHECK_REASON = "inbox-handling-missing";
export const isInboxWake = (entry: InboxEntry): entry is TaskWake => "fromCursor" in entry;
export const isHandlingReminder = (entry: InboxEntry): boolean => isInboxWake(entry)
  ? entry.reasons.every(reason => reason === INBOX_CHECK_REASON)
  : entry.kind === "system" && entry.inputControl?.requestId.startsWith(INBOX_CHECK_PREFIX) === true;

/** Correlation uses existing input identities, not timestamps, output text or
 * Task state. Active consumption adds only the exact attempt to its claim. */
export function belongsToInboxTurn(entry: InboxEntry, actor: InboxActor, turn: ProviderTurn | null | undefined): boolean {
  if (!turn) return false;
  const claim = entry.inbox?.claim.actor;
  if (claim?.attemptId === turn.attemptId && claim.scope === actor.scope && claim.taskId === actor.taskId
    && claim.roleName === actor.roleName && claim.agentId === actor.agentId
    && claim.nativeSessionId === actor.nativeSessionId) return true;
  if (isInboxWake(entry)) return actor.scope === "task" && actor.roleName === "leader"
    && entry.taskId === actor.taskId && (turn.input?.kind === "wake" && turn.input.wakeId === entry.id
      && turn.input.taskId === entry.taskId
      || turn.attemptId.startsWith(`notification:${entry.taskId}/${entry.id}/`));
  if ("roleName" in entry) {
    if (actor.scope !== "global" || entry.roleName !== actor.roleName) return false;
    if (entry.deliveryTarget && (entry.deliveryTarget.agentId !== actor.agentId
      || entry.deliveryTarget.nativeSessionId !== actor.nativeSessionId)) return false;
    if (turn.input?.kind === "message" && turn.input.roleName === actor.roleName
      && turn.input.messageId === entry.id || turn.attemptId === `global-input:${actor.roleName}/${entry.id}`) return true;
  } else {
    if (actor.scope !== "task" || entry.taskId !== actor.taskId) return false;
    if (turn.runId !== undefined && entry.recipient?.roleName === actor.roleName
      && entry.continuation?.runId === turn.runId) return true;
  }
  const target = entry.control?.target;
  return entry.control?.outcome === "accepted" && target?.agentId === actor.agentId
    && target.nativeSessionId === actor.nativeSessionId && target.attemptId === turn.attemptId;
}

/** Historical absence of ACK is not fresh work. Current unsubmitted input
 * remains discoverable, but never steals an unsettled transport owner. */
export function inboxEntryCategory(entry: InboxEntry, actor: InboxActor, turn: ProviderTurn | null | undefined):
  "current" | "available" | "history" {
  if (belongsToInboxTurn(entry, actor, turn)) return "current";
  if (entry.inbox !== undefined) return "history";
  if (isInboxWake(entry)) return "history";
  if ("roleName" in entry) {
    if (entry.delivery !== undefined || entry.notDelivered !== undefined
      || entry.deliveryTarget && (entry.deliveryTarget.agentId !== actor.agentId
        || entry.deliveryTarget.nativeSessionId !== actor.nativeSessionId)) return "history";
  } else if (entry.continuation?.runId !== undefined) return "history";
  if (entry.inputControl?.expectedSessionId !== undefined
    && entry.inputControl.expectedSessionId !== actor.nativeSessionId) return "history";
  if (entry.control?.outcome === "accepted") return "history";
  return "available";
}

export function inboxSettled(receipt: InboxReceipt | undefined): boolean {
  return receipt?.ack !== undefined || receipt?.retirement !== undefined;
}

export function missingTurnHandling(entries: readonly InboxEntry[], actor: InboxActor, turn: ProviderTurn) {
  return entries.filter(entry => !inboxSettled(entry.inbox) && !isHandlingReminder(entry)
    && belongsToInboxTurn(entry, actor, turn));
}

/** Accepted historical input and explicit nondelivery do not impose an input
 * order on independent new messages. Unknown delivery still does. */
export function blocksInboxOrder(entry: InboxEntry, actor: InboxActor, turn: ProviderTurn | null | undefined): boolean {
  if (isInboxWake(entry) || inboxSettled(entry.inbox)) return false;
  if ("roleName" in entry && (globalInboxDeliveryState(entry) === "accepted" || entry.notDelivered !== undefined)) return false;
  if (entry.control?.outcome === "accepted") return false;
  return inboxEntryCategory(entry, actor, turn) !== "history"
    || entry.control !== undefined && ["pending", "delivery-unknown"].includes(entry.control.outcome);
}
