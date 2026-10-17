import type { TaskStore } from "../storage/taskStore.js";
import type { TaskMessage } from "./message.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";
import type { MailboxEntityRef } from "../coordination/workMailbox.js";

/** Pin mutable originals by their existing event identity, not wall-clock time.
 * Both automatic notification and active consumption use the same fixed refs. */
export function pinMessageRevisions(store: TaskStore, taskId: string, refs: readonly MailboxEntityRef[]): MailboxEntityRef[] {
  const pinned = [...refs];
  for (const ref of refs) {
    if (ref.type !== "message" || ref.taskId !== taskId) continue;
    const message = store.listMessages(taskId).find(message => message.id === ref.id);
    const revision = message === undefined ? undefined : latestMessageUpdate(store, message);
    if (revision !== undefined && !pinned.some(ref => ref.type === "event" && ref.id === revision.id)) {
      pinned.push({ type: "event", taskId, id: revision.id });
    }
  }
  return pinned;
}

export function latestMessageUpdate(store: TaskStore, message: TaskMessage) {
  return store.listEvents(message.taskId).filter(event =>
    event.type === "message.updated" && event.payload.messageId === message.id).at(-1);
}

/** Leader steer has no Assignment recipient; ordinary Task records are not
 * private inbox messages. Queued Leader inputs remain fixed wake windows. */
export function isLeaderSteer(message: TaskMessage): boolean {
  return message.recipient === undefined && message.inputControl?.action === "steer";
}

/** Derive ownership from original receipts, never from disposable mailboxes. */
export function taskMessageInboxReceipt(store: TaskStore, message: TaskMessage) {
  return message.inbox ?? messageRevisionWakes(store, message).find(wake => wake.inbox !== undefined)?.inbox;
}

/** Delivery suppresses repeat notification of that revision, but remains
 * distinct from handling. The original fixed window stays in the own inbox. */
export function deliveredMessageWake(store: TaskStore, message: TaskMessage) {
  return messageRevisionWakes(store, message).find(wake => wake.status === "consumed");
}

function messageRevisionWakes(store: TaskStore, message: TaskMessage) {
  const revision = latestMessageUpdate(store, message);
  return store.listTaskWakes(message.taskId).filter(wake =>
    (revision === undefined || wake.refs?.some(ref =>
      ref.type === "event" && ref.taskId === message.taskId && ref.id === revision.id))
    && wake.refs?.some(ref => ref.type === "message" && ref.taskId === message.taskId && ref.id === message.id));
}

export function unfinishedLeaderInbox(store: TaskStore, taskId: string): boolean {
  const sessions = store.getTaskRoleSessionSet(taskId, "leader");
  const binding = sessions?.providerBinding;
  const turn = binding?.run;
  const nativeSessionId = binding?.conversations.find(c => c.epoch === binding.currentConversationEpoch)?.conversationId;
  const active = (receipt: TaskMessage["inbox"]) => receipt !== undefined && receipt.ack === undefined
    && (receipt.claim.actor.attemptId === undefined || turn?.attemptId === receipt.claim.actor.attemptId
      && receipt.claim.actor.agentId === sessions?.activeAgentId
      && receipt.claim.actor.nativeSessionId === nativeSessionId
      && ["submitting", "accepted", "delivery-unknown"].includes(turn.status));
  return store.listTaskWakes(taskId).some(wake => active(wake.inbox))
    || operationalTaskRecords(store.listMessages(taskId), store.listEvents(taskId), "message").some(message => isLeaderSteer(message)
      && active(message.inbox));
}
