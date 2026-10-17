import type { TaskStore } from "../storage/taskStore.js";
import type { InboxActor } from "../message/inboxReceipt.js";
import type { ProviderTurn } from "../runtime/providerRuntimeIdentity.js";
import { createGlobalRoleMessage } from "../message/message.js";
import { INBOX_CHECK_PREFIX, INBOX_CHECK_REASON, missingTurnHandling } from "../message/inboxTurn.js";
import { readDigest } from "../output/boundedRead.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { enqueueWork } from "../coordination/workMailboxQueue.js";
import { retiredTaskRecordIds } from "../task/taskRecordRetirement.js";
import { completeProcessing } from "../coordination/workMailbox.js";

/** Called inside exact-terminal persistence's transaction. A terminal checks
 * receipts; it cannot infer a disposition. One existing notification per exact
 * turn, no timer, retry queue, automatic ACK or reminder-of-reminder loop. */
export function checkInboxTurn(store: TaskStore, actor: InboxActor, turn: ProviderTurn | null | undefined, now: Date): void {
  if (!turn || !["completed", "failed", "cancelled"].includes(turn.status)) return;
  const retired = actor.scope === "task" ? retiredTaskRecordIds(store.listEvents(actor.taskId!), "message") : new Set();
  const entries = actor.scope === "global" ? store.listGlobalRoleMessages(actor.roleName)
    : [...(actor.roleName === "leader" ? store.listTaskWakes(actor.taskId!) : []),
      ...store.listMessages(actor.taskId!).filter(message => !retired.has(message.id))];
  const missing = missingTurnHandling(entries, actor, turn);
  if (actor.scope === "task" && actor.roleName === "leader") {
    const mailbox = store.getWorkMailbox({ kind: "role", taskId: actor.taskId!, roleName: "leader" });
    // End the exact active-consumption notification reservation only. Its
    // original claim remains unfinished and discoverable; no writer is freed
    // here (the caller already persisted an exact native terminal).
    if (mailbox?.processing && entries.some(entry => entry.inbox?.claim.actor.attemptId === turn.attemptId
      && entry.inbox.claim.actor.nativeSessionId === actor.nativeSessionId
      && entry.inbox.claim.actor.agentId === actor.agentId
      && mailbox.processing?.owner === `agent-inbox:${entry.id}`
      && mailbox.processing.batchId === `inbox:${entry.id}`)) {
      store.saveWorkMailbox(completeProcessing(mailbox, mailbox.processing.batchId));
    }
  }
  if (!missing.length) return;
  const requestId = INBOX_CHECK_PREFIX + readDigest([actor.scope, actor.taskId, actor.roleName,
    actor.agentId, actor.nativeSessionId, turn.attemptId]);
  const facts = {
    roleName: actor.roleName, nativeSessionId: actor.nativeSessionId, attemptId: turn.attemptId,
    status: turn.status, count: String(missing.length), entries: missing.slice(0, 16).map(entry => entry.id).join(","),
    read: actor.scope === "global" || actor.roleName === "leader" ? "yui inbox list --view history --json"
      : `yui task message show ${actor.taskId}/${missing[0]!.id} --json`,
    disposition: "Missing handling evidence, not unexecuted work. Read originals and prior effects; explicitly ack or retire within authority. Never replay external effects."
  };
  if (actor.scope === "global") {
    if (store.queryGlobalRoleMessages(actor.roleName, { requestId, limit: 1 }).count) return;
    const notice = createGlobalRoleMessage(store.nextGlobalRoleMessageId(), actor.roleName,
      `Yui-Summary: ${missing.length} input(s) lack handling receipts after an exact native terminal.\n`
        + JSON.stringify(facts), "system", { type: "system" }, now,
      { inputControl: { action: "queue", requestId } });
    // Retain the original target: replacing a Session is not permission to
    // replay this reminder elsewhere. Successors can inspect history explicitly.
    store.saveGlobalRoleMessage({ ...notice,
      deliveryTarget: { agentId: actor.agentId, nativeSessionId: actor.nativeSessionId } });
  } else {
    if (store.listEvents(actor.taskId!).some(event => event.type === INBOX_CHECK_REASON
      && event.payload.requestId === requestId)) return;
    const event = createTaskEvent(store.nextEventId(actor.taskId!), actor.taskId!, INBOX_CHECK_REASON,
      { ...facts, requestId }, now);
    store.saveEvent(actor.taskId!, event);
    const task = store.getTask(actor.taskId!);
    if (task && ["active", "draft"].includes(task.status) && task.executionGate.state === "enabled") {
      enqueueWork(store, { kind: "role", taskId: actor.taskId!, roleName: "leader" }, INBOX_CHECK_REASON, now,
        [{ type: "event", taskId: actor.taskId!, id: event.id }], { source: "inbox-check", dedupeKey: requestId });
    }
  }
}
