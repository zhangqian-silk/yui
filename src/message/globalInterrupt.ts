import type { TaskStore } from "../storage/taskStore.js";
import type { InterruptLiveReceipt, SteerLiveReceipt } from "../runtime/agentHost.js";
import { markGlobalRoleMessageDelivered } from "./message.js";

export function recordGlobalSteerResult(
  store: TaskStore, roleName: string, messageId: string, receipt: SteerLiveReceipt
): void {
  store.transaction(tx => {
    const message = tx.listGlobalRoleMessages(roleName).find(entry => entry.id === messageId);
    const source = message?.inputControl ?? message?.interruptThen?.reusedInput;
    if (message === undefined || source?.action !== "steer") throw new Error("Global steer has no original Message.");
    // Conclusive native evidence outranks a lost/late transport acknowledgement.
    if (message.control?.outcome === "accepted" || message.control?.outcome === "rejected") return;
    const now = new Date();
    const outcome = receipt.state === "steered" ? "accepted"
      : receipt.state === "steer-unknown" ? "delivery-unknown" : "rejected";
    const updated = { ...message, control: {
      requestId: source.requestId, receiptId: `steer:${roleName}/${messageId}`,
      outcome, observedAt: now.toISOString()
    } } as typeof message;
    tx.updateGlobalRoleMessage(outcome === "accepted" ? markGlobalRoleMessageDelivered(updated, now) : updated);
  });
}

export function recordGlobalInterruptResult(
  store: TaskStore, roleName: string, receiptId: string, receipt: InterruptLiveReceipt
): void {
  store.transaction(tx => {
    const sessions = tx.getGlobalRoleSessionSet(roleName);
    const entry = Object.entries(sessions?.interrupts ?? {}).find(([, value]) => value.receiptId === receiptId);
    if (sessions == null || entry === undefined) throw new Error("Global interrupt has no original request.");
    if (entry[1].receipt !== undefined) return;
    tx.saveGlobalRoleSessionSet({ ...sessions, interrupts: { ...sessions.interrupts,
      [entry[0]]: { ...entry[1], receipt }
    } });
  });
}
