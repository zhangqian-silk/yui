import { completeProcessing } from "../coordination/workMailbox.js";
import { createGlobalRoleMessage } from "../message/message.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { OperatorNotificationQueueResult } from "../scheduler/ports.js";

/**
 * Transfer one exact attention claim to the Global Message queue atomically.
 * Queue ownership is not Provider acceptance or Agent acknowledgement. A failed
 * or uncertain Message retains its identity/evidence; it is never reissued here.
 */
export function queueOperatorNotification(
  store: TaskStore,
  input: Readonly<{ batchId: string; receiptId: string; text: string }>,
  now = new Date()
): OperatorNotificationQueueResult {
  return store.transaction(tx => {
    const requestId = `operator-notice:${encodeURIComponent(input.receiptId)}`;
    const previous = tx.listGlobalRoleMessages("operator").find(entry =>
      (entry.inputControl ?? entry.interruptThen?.reusedInput)?.requestId === requestId);
    const mailbox = tx.getWorkMailbox({ kind: "operator" });
    const claimed = mailbox?.processing?.batchId === input.batchId;
    if (previous !== undefined) {
      if (claimed) tx.saveWorkMailbox(completeProcessing(mailbox!, input.batchId));
      return { status: "already-queued", messageId: previous.id };
    }
    if (!claimed) throw new Error(`Operator notification claim changed: ${input.batchId}`);
    const sessions = tx.getGlobalRoleSessionSet("operator");
    const session = sessions?.sessions[sessions.activeAgentId];
    if (session?.status !== "active" || sessions?.providerBinding == null) return { status: "unavailable" };
    const created = { ...createGlobalRoleMessage(tx.nextGlobalRoleMessageId(), "operator", input.text,
      "system", { type: "system" }, now, { inputControl: { action: "queue", requestId } }),
      deliveryTarget: { agentId: session.agentId, nativeSessionId: session.nativeSessionId } };
    tx.saveGlobalRoleMessage(created);
    tx.saveWorkMailbox(completeProcessing(mailbox!, input.batchId));
    return { status: "queued", messageId: created.id };
  });
}
