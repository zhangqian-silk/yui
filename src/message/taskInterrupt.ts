import { createTaskEvent } from "../event/taskEvent.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { ResolvedInputTarget } from "./inputControlResolution.js";
import type { InterruptLiveReceipt } from "../runtime/agentHost.js";

/** Interrupt attempts are execution evidence, not a second message queue. */
export function findTaskInterrupt(store: TaskStore, taskId: string, requestId: string) {
  return store.listEvents(taskId).find(event =>
    event.type === "input.interrupt-requested" && event.payload.requestId === requestId);
}

export function reserveTaskInterrupt(
  store: TaskStore, taskId: string, requestId: string, fingerprint: string,
  target: ResolvedInputTarget, thenMessageId: string | undefined, now: Date
): string {
  const receiptId = `interrupt:${taskId}/${requestId}`;
  store.saveEvent(taskId, createTaskEvent(store.nextEventId(taskId), taskId,
    "input.interrupt-requested", {
      requestId, receiptId, fingerprint, roleName: target.roleName,
      nativeSessionId: target.nativeSessionId, attemptId: target.attemptId,
      target: JSON.stringify(target),
      ...(thenMessageId === undefined ? {} : { thenMessageId })
    }, now));
  return receiptId;
}

export function recordTaskInterruptResult(
  store: TaskStore, taskId: string, receiptId: string,
  receipt: InterruptLiveReceipt, now: Date = new Date()
): void {
  store.transaction(tx => {
    const requested = tx.listEvents(taskId).find(event =>
      event.type === "input.interrupt-requested" && event.payload.receiptId === receiptId);
    if (requested === undefined) throw new Error("Interrupt receipt has no original request.");
    if (tx.listEvents(taskId).some(event =>
      event.type === "input.interrupt-result" && event.payload.receiptId === receiptId)) return;
    tx.saveEvent(taskId, createTaskEvent(tx.nextEventId(taskId), taskId, "input.interrupt-result",
      { receiptId, receipt: JSON.stringify(receipt) }, now));
  });
}

export function taskInterruptReceipt(store: TaskStore, taskId: string, receiptId: string): unknown {
  const event = store.listEvents(taskId).find(entry =>
    entry.type === "input.interrupt-result" && entry.payload.receiptId === receiptId);
  return event === undefined ? { state: "interrupt-unknown", receiptId }
    : JSON.parse(event.payload.receipt!);
}

export function taskInterruptWasRejected(store: TaskStore, taskId: string, receiptId: string): boolean {
  const receipt = taskInterruptReceipt(store, taskId, receiptId) as Partial<InterruptLiveReceipt>;
  return receipt.outcome === "rejected" && receipt.state === "interrupt-unavailable";
}
