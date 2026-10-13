import type { TaskStore } from "../storage/taskStore.js";
import type { TaskMessage } from "./message.js";

/** Leader steer has no Assignment recipient; ordinary Task records are not
 * private inbox messages. Queued Leader inputs remain fixed wake windows. */
export function isLeaderSteer(message: TaskMessage): boolean {
  return message.recipient === undefined && message.inputControl?.action === "steer";
}

/** Derive ownership from original receipts, never from disposable mailboxes. */
export function taskMessageInboxReceipt(store: TaskStore, message: TaskMessage) {
  return message.inbox ?? store.listTaskWakes(message.taskId).find(wake =>
    wake.inbox !== undefined && wake.refs?.some(ref =>
      ref.type === "message" && ref.taskId === message.taskId && ref.id === message.id))?.inbox;
}

export function unfinishedLeaderInbox(store: TaskStore, taskId: string): boolean {
  return store.listTaskWakes(taskId).some(wake => wake.inbox !== undefined && wake.inbox.ack === undefined)
    || store.listMessages(taskId).some(message => isLeaderSteer(message)
      && message.inbox !== undefined && message.inbox.ack === undefined);
}
