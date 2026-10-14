import type { TaskStore } from "../storage/taskStore.js";
import { requireManagedCaller } from "../runtime/sessionCaller.js";
import { boundedDocument, readDigest, readOptions, recordPage } from "../output/boundedRead.js";
import { claimPending, completeProcessing } from "../coordination/workMailbox.js";
import { createTaskWake, latestTaskWake, type TaskWake } from "../scheduler/taskWake.js";
import { expandTaskMessageResult, type GlobalRoleMessage, type TaskMessage } from "../message/message.js";
import { messageAssignmentBlocker } from "../message/messageContinuation.js";
import { globalInboxDeliveryState, inboxHandlingState, isGlobalInboxMessage, pendingGlobalInboxMessages, type InboxActor, type InboxReceipt } from "../message/inboxReceipt.js";
import { deliveredMessageWake, isLeaderSteer, pinMessageRevisions, taskMessageInboxReceipt, unfinishedLeaderInbox } from "../message/taskInboxOwnership.js";
import { hasRuntimeCleanupObligation, runtimeLifecycleTarget } from "../runtime/lifecycleReservation.js";
import { isTaskRecordRetired, retiredTaskRecordIds } from "../task/taskRecordRetirement.js";

type Entry = GlobalRoleMessage | TaskMessage | TaskWake;
type Address = InboxActor;
const target = (address: Address) => ({ kind: "role" as const, taskId: address.taskId!, roleName: address.roleName });
const source = (address: Address) => `inbox:${address.scope}:${address.taskId ?? ""}:${address.roleName}`;
const pendingId = (pending: unknown) => `pending-${readDigest(pending)}`;
const sameSession = (a: InboxActor, b: InboxActor) => a.scope === b.scope && a.taskId === b.taskId
  && a.roleName === b.roleName && a.agentId === b.agentId && a.nativeSessionId === b.nativeSessionId;

function addressOf(store: TaskStore, env: NodeJS.ProcessEnv): Address {
  const caller = requireManagedCaller(store, env);
  if (caller.scope === "global") {
    return { scope: "global", roleName: caller.roleName, agentId: caller.agentId, nativeSessionId: caller.nativeSessionId };
  }
  if (caller.roleName !== "leader" && caller.currentRunId === undefined) {
    throw new Error("An Assignment inbox requires its current active AgentRun.");
  }
  return { scope: "task", taskId: caller.taskId, roleName: caller.roleName,
    agentId: caller.agentId, nativeSessionId: caller.nativeSessionId,
    ...(caller.currentRunId === undefined ? {} : { runId: caller.currentRunId }) };
}

function ownsMessage(store: TaskStore, address: Address, message: TaskMessage): boolean {
  if (address.roleName === "leader" && message.taskId === address.taskId && isLeaderSteer(message)) return true;
  if (address.runId === undefined || message.taskId !== address.taskId
    || message.recipient?.roleName !== address.roleName) return false;
  const current = store.getRun(address.taskId!, address.runId!);
  const owner = message.recipient.ownerRunId === undefined ? null
    : store.getRun(address.taskId!, message.recipient.ownerRunId);
  return current !== null && owner !== null && current.roleName === owner.roleName
    && owner.workItemId === message.recipient.workItemId && owner.reviewRoundId === message.recipient.reviewRoundId
    && current.workItemId === owner.workItemId && current.reviewRoundId === owner.reviewRoundId
    && (owner.id === current.id || messageAssignmentBlocker(store, message) === undefined);
}

function entries(store: TaskStore, address: Address): Entry[] {
  if (address.scope === "global") return store.listGlobalRoleMessages(address.roleName)
    .filter(isGlobalInboxMessage);
  const messages = store.listMessages(address.taskId!).filter(message => ownsMessage(store, address, message));
  return address.roleName === "leader" ? [...store.listTaskWakes(address.taskId!), ...messages] : messages;
}

function getEntry(store: TaskStore, address: Address, id: string): Entry {
  const entry = entries(store, address).find(entry => entry.id === id);
  if (entry === undefined) throw new Error("Inbox entry is not in this Agent's current authorized receiving scope.");
  return entry;
}

function isWake(entry: Entry): entry is TaskWake { return "fromCursor" in entry; }
function acceptedInput(entry: Entry): boolean {
  return isWake(entry) ? entry.status === "consumed" : "roleName" in entry
    ? globalInboxDeliveryState(entry) === "accepted" : entry.control?.outcome === "accepted";
}
function assertSelectedTarget(address: Address, message: TaskMessage | GlobalRoleMessage): void {
  const selected = message.inputControl?.expectedSessionId;
  const globalTarget = "roleName" in message ? message.deliveryTarget : undefined;
  if (selected !== undefined && selected !== address.nativeSessionId
    || globalTarget !== undefined && (globalTarget.agentId !== address.agentId
      || globalTarget.nativeSessionId !== address.nativeSessionId)) {
    throw new Error("The original input explicitly targets another native Session; inbox handling cannot retarget it.");
  }
}
function save(store: TaskStore, address: Address, entry: Entry): void {
  if (isWake(entry)) store.saveTaskWake(address.taskId!, entry);
  else if (address.scope === "global") store.updateGlobalRoleMessage(entry as GlobalRoleMessage);
  else store.updateMessage(address.taskId!, entry as TaskMessage);
}

/** The same durable claim is checked at automatic delivery admission. No lease
 * expires, and neither a receipt nor a cursor gives a caller identity. */
function blocker(store: TaskStore, address: Address, entry: Entry): string | undefined {
  if (!isWake(entry) && address.scope === "task"
    && isTaskRecordRetired(store.listEvents(address.taskId!), "message", entry.id)) return "message-retired";
  if (entry.inbox?.ack !== undefined) return "acknowledged";
  if (entry.inbox !== undefined) {
    return sameSession(entry.inbox.claim.actor, address) ? undefined : "claimed-by-previous-session";
  }
  if (isWake(entry)) {
    // Native acceptance releases transport ownership, not semantic handling.
    // The current Leader may explicitly claim the fixed delivered window.
    if (entry.status === "consumed") return undefined;
    return "automatic-notification-owns-window";
  }
  if (address.scope === "task" && taskMessageInboxReceipt(store, entry as TaskMessage) !== undefined) {
    return "claimed-by-notification-window";
  }
  if (entry.control !== undefined && ["pending", "delivery-unknown"].includes(entry.control.outcome)) {
    return `delivery-${entry.control.outcome}`;
  }
  const accepted = acceptedInput(entry);
  if (entry.interruptThen !== undefined && !accepted
    && !(address.scope === "task" && (entry as TaskMessage).continuation?.runId === address.runId
      && address.runId !== undefined)) return "explicit-interrupt-handoff";
  // Both steer paths reserve pending control before submission and arbitrate
  // with inbox claims. No control is unsubmitted, not an unknown delivery.
  if (address.scope === "global") {
    const message = entry as GlobalRoleMessage;
    if (message.delivery !== undefined && !accepted) return `already-delivered-${message.delivery.via}`;
    // Explicitly settling delivered input is not a new submission or target
    // selection. A current rightful successor retains the original target.
    if (accepted) return undefined;
    if (message.deliveryTarget !== undefined && (message.deliveryTarget.nativeSessionId !== address.nativeSessionId
      || message.deliveryTarget.agentId !== address.agentId)) return "selected-native-session-changed";
    if (message.inputControl?.expectedSessionId !== undefined
      && message.inputControl.expectedSessionId !== address.nativeSessionId) return "selected-native-session-changed";
    const turn = store.getGlobalRoleSessionSet(address.roleName)?.providerBinding?.run;
    if (turn?.attemptId === `global-input:${address.roleName}/${entry.id}`) return `native-attempt-${turn.status}`;
  } else {
    const message = entry as TaskMessage;
    if (message.continuation?.runId !== undefined && message.continuation.runId !== address.runId) {
      return "continuation-already-dispatched";
    }
    if (!accepted && message.inputControl?.expectedSessionId !== undefined
      && message.inputControl.expectedSessionId !== address.nativeSessionId) return "selected-native-session-changed";
    return address.roleName === "leader" && isLeaderSteer(message) ? undefined : messageAssignmentBlocker(store, message);
  }
  return undefined;
}

function checkMutation(store: TaskStore, address: Address): void {
  const owner = address.scope === "global" ? { scope: "global" as const, roleName: address.roleName }
    : { scope: "task" as const, taskId: address.taskId!, roleName: address.roleName };
  if (hasRuntimeCleanupObligation(store.getWorkMailbox(runtimeLifecycleTarget(owner)))) {
    throw new Error("Inbox cannot change while this runtime is being released.");
  }
  if (address.scope === "task") {
    const task = store.getTask(address.taskId!);
    if (!task || !["active", "draft"].includes(task.status) || task.executionGate.state !== "enabled") {
      throw new Error("Inbox handling requires an open Task with execution enabled.");
    }
  }
}

function summary(store: TaskStore, address: Address, entry: Entry) {
  return { id: entry.id, kind: isWake(entry) ? "notification-window" : "message",
    createdAt: entry.createdAt, summary: isWake(entry) ? entry.reasons.join(", ").slice(0, 240) : entry.body.slice(0, 240),
    blocked: blocker(store, address, entry) ?? null, inbox: entry.inbox ?? null,
    handling: inboxHandlingState(entry.inbox),
    delivery: isWake(entry) ? entry.status : {
      control: entry.control ?? null,
      ...(address.scope === "global" ? { receipt: (entry as GlobalRoleMessage).delivery ?? null,
        state: globalInboxDeliveryState(entry as GlobalRoleMessage) }
        : { continuation: (entry as TaskMessage).continuation ?? null })
    },
    read: `yui inbox show ${entry.id}`, ...(isWake(entry)
      ? { originals: `yui task wake show ${entry.taskId} ${entry.id} --json` } : {}) };
}

function receipt(entry: Entry) {
  return { id: entry.id, inbox: entry.inbox,
    ...(isWake(entry) ? { originals: `yui task wake show ${entry.taskId} ${entry.id} --json` } : {}) };
}

/** Own-address command: there is deliberately no --role, --task or --session.
 * Reads do not claim. Exact claim precedes semantic handling; exact ack follows
 * full original reads and actual handling. A batch is independent per item. */
export function runInboxCommand(
  args: readonly string[], store: TaskStore, env: NodeJS.ProcessEnv, now = new Date()
): any {
  const [action, ...tail] = args;
  const address = addressOf(store, env);
  if (action === "list") {
    const parsed = readOptions(tail);
    if (parsed.positionals.length) throw new Error("Inbox list accepts only --limit and --cursor.");
    const retired = address.scope === "task" ? retiredTaskRecordIds(store.listEvents(address.taskId!), "message") : new Set();
    const selected = address.scope === "global" ? pendingGlobalInboxMessages(store.listGlobalRoleMessages(address.roleName))
      : entries(store, address).filter(entry => (isWake(entry) || !retired.has(entry.id))
        && inboxHandlingState(entry.inbox) !== "handled");
    const items: object[] = selected.map(entry => summary(store, address, entry));
    if (address.scope === "task" && address.roleName === "leader") {
      const mailbox = store.getWorkMailbox(target(address));
      if (mailbox?.pending != null) items.push({ id: pendingId(mailbox.pending), kind: "notification-window",
        summary: mailbox.pending.reasons.join(", ").slice(0, 240),
        blocked: mailbox.processing === null && !unfinishedLeaderInbox(store, address.taskId!) ? null : "earlier-window-owned",
        read: `yui inbox show ${pendingId(mailbox.pending)}` });
    }
    return { ...recordPage(items, source(address), parsed), identity: address };
  }
  if (action === "show") {
    const parsed = readOptions(tail, ["--cursor"]);
    if (parsed.positionals.length !== 1) throw new Error("Inbox show requires one exact entry.");
    const id = parsed.positionals[0]!;
    if (id.startsWith("pending-") && address.scope === "task" && address.roleName === "leader") {
      const pending = store.getWorkMailbox(target(address))?.pending;
      if (!pending || id !== pendingId(pending)) throw new Error("Pending window changed; list the inbox again.");
      return boundedDocument({ id, ...pending,
        note: "Claim this exact window before processing; claim returns its durable wake and original-read command." },
      `${source(address)}/${id}`, parsed.cursor);
    }
    const entry = getEntry(store, address, id);
    const value = !isWake(entry) && address.scope === "task"
      ? expandTaskMessageResult(entry as TaskMessage, (task, run) => store.getRun(task, run)) : entry;
    return boundedDocument(value, `${source(address)}/${id}`, parsed.cursor);
  }
  if (action !== "claim" && action !== "ack") throw new Error("Inbox commands: list, show, claim, ack.");
  const parsed = readOptions(tail, ["--request-id", "--reason"]);
  const ids = parsed.positionals;
  const requestId = parsed.values.get("--request-id");
  const reason = parsed.values.get("--reason");
  if (!requestId || requestId.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(requestId)) {
    throw new Error("Inbox mutation requires a stable --request-id (1..128 safe characters).");
  }
  if (!ids.length || ids.length > 16 || new Set(ids).size !== ids.length) {
    throw new Error("Select 1..16 distinct exact inbox entries; no wildcard acknowledgement.");
  }
  if (action === "ack" && (!reason?.trim() || Buffer.byteLength(reason) > 2048)) {
    throw new Error("Acknowledgement requires --reason describing handling or why no action remains (up to 2048 bytes).");
  }
  if (action === "claim" && reason !== undefined) throw new Error("Claim does not record a disposition; use ack after handling.");
  const apply = (id: string) => store.transaction(tx => {
    const current = addressOf(tx, env);
    checkMutation(tx, current);
    let entry: Entry;
    if (id.startsWith("pending-") && current.scope === "task" && current.roleName === "leader" && action === "claim") {
      // Retry the exact logical operation even after its pending batch moved.
      const existing = tx.listTaskWakes(current.taskId!).find(wake =>
        wake.inbox?.claim.requestId === requestId && sameSession(wake.inbox.claim.actor, current));
      if (existing) {
        if (existing.inboxPendingId !== id) {
          throw new Error("Inbox request id was reused for a different window.");
        }
        return receipt(existing);
      }
      const mailbox = tx.getWorkMailbox(target(current));
      if (!mailbox?.pending || pendingId(mailbox.pending) !== id) throw new Error("Pending window changed; list the inbox again.");
      if (mailbox.processing !== null || unfinishedLeaderInbox(tx, current.taskId!)) {
        throw new Error("An earlier automatic or active inbox claim owns the notification window.");
      }
      // A pending Leader input with an exact transport/interrupt owner cannot be
      // hidden inside an actively consumed window.
      for (const ref of mailbox.pending.refs) {
        if (ref.type !== "message") continue;
        const message = tx.listMessages(current.taskId!).find(message => message.id === ref.id);
        if (message !== undefined && (taskMessageInboxReceipt(tx, message) !== undefined
          || deliveredMessageWake(tx, message) !== undefined)
          || message?.interruptThen !== undefined
          || message?.control !== undefined && message.control.outcome !== "rejected"
          || message?.inputControl?.expectedSessionId !== undefined
            && message.inputControl.expectedSessionId !== current.nativeSessionId) {
          throw new Error("Window contains an input with an existing or foreign delivery owner; inspect its original receipt.");
        }
      }
      const latest = latestTaskWake(tx.listTaskWakes(current.taskId!));
      // Pin each mutable Draft original's existing update event, not a clock
      // comparison. A later edit is distinct input even within the same tick.
      const refs = pinMessageRevisions(tx, current.taskId!, mailbox.pending.refs);
      const wake = createTaskWake({ id: tx.nextTaskWakeId(current.taskId!), taskId: current.taskId!,
        reasons: mailbox.pending.reasons, refs,
        fromCursor: latest?.toCursor ?? tx.getTask(current.taskId!)!.createdAt,
        toCursor: new Date(Math.max(now.getTime(), Date.parse(mailbox.pending.lastQueuedAt))).toISOString(), now });
      entry = { ...wake, inbox: { claim: { requestId, actor: current, at: now.toISOString() } },
        inboxPendingId: id };
      tx.saveWorkMailbox(claimPending(mailbox, { batchId: `inbox:${wake.id}`,
        owner: `agent-inbox:${wake.id}`, startedAt: now.toISOString() }));
    } else {
      entry = getEntry(tx, current, id);
      if (action === "claim") {
        if (entry.inbox !== undefined) {
          if (!sameSession(entry.inbox.claim.actor, current)) throw new Error("Claim belongs to a previous Session; read the original and prior effects, then explicitly acknowledge only after finishing its handling.");
          if (entry.inbox.claim.requestId !== requestId) throw new Error("Entry already claimed; retain the original request id.");
          return receipt(entry);
        }
        const blocked = blocker(tx, current, entry);
        if (blocked !== undefined) throw new Error(`Inbox entry cannot be claimed: ${blocked}.`);
        if (isWake(entry) && !acceptedInput(entry)) {
          for (const ref of entry.refs ?? []) {
            if (ref.type !== "message") continue;
            const message = tx.listMessages(current.taskId!).find(message => message.id === ref.id);
            if (message !== undefined) assertSelectedTarget(current, message);
          }
        } else if (!isWake(entry) && !acceptedInput(entry)) assertSelectedTarget(current, entry);
        for (const previous of entries(tx, current)) {
          if (previous.id === entry.id) break;
          if (isWake(previous) || previous.inbox?.ack !== undefined) continue;
          if (current.scope === "task"
            && isTaskRecordRetired(tx.listEvents(current.taskId!), "message", previous.id)) continue;
          if (current.scope === "global" && (previous as GlobalRoleMessage).notDelivered !== undefined) continue;
          if (previous.inbox !== undefined && sameSession(previous.inbox.claim.actor, current)) continue;
          throw new Error(`Earlier inbox entry ${previous.id} must be handled first; input order is preserved.`);
        }
        entry = { ...entry, inbox: { claim: { requestId, actor: current, at: now.toISOString() } } };
      } else {
        if (!entry.inbox) throw new Error("Claim the exact entry before handling and acknowledgement.");
        // Ack settles already-owned handling; it never submits or retargets
        // the original. The current rightful successor may settle a claim
        // acquired by the exact selected Session, retaining both identities.
        const claimant = entry.inbox.claim.actor;
        if (isWake(entry) && !acceptedInput(entry)) {
          const messageIds = new Set(entry.refs?.filter(ref => ref.type === "message").map(ref => ref.id));
          for (const message of tx.listMessages(current.taskId!)) {
            if (messageIds.has(message.id)) assertSelectedTarget(claimant, message);
          }
        } else if (!isWake(entry) && !acceptedInput(entry)) assertSelectedTarget(claimant, entry);
        if (!isWake(entry) && current.scope === "task"
          && !(current.roleName === "leader" && isLeaderSteer(entry as TaskMessage))) {
          const invalid = messageAssignmentBlocker(tx, entry as TaskMessage);
          if (invalid !== undefined) throw new Error(`Assignment no longer authorizes this inbox disposition: ${invalid}.`);
        }
        // Current rightful successor may settle a prior Session's unfinished
        // claim explicitly; this never replays input or discards prior evidence.
        if (entry.inbox.ack) {
          if (entry.inbox.ack.requestId !== requestId || entry.inbox.ack.reason !== reason
            || !sameSession(entry.inbox.ack.actor, current)) throw new Error("Conflicting acknowledgement; original disposition retained.");
          return receipt(entry);
        }
        const inbox: InboxReceipt = { ...entry.inbox,
          ack: { requestId, actor: current, at: now.toISOString(), reason: reason! } };
        if (isWake(entry)) {
          const mailbox = tx.getWorkMailbox(target(current));
          // stop/start removes operational mailboxes, not durable claim
          // ownership. Settle that receipt without touching a later batch.
          if (mailbox?.processing?.owner === `agent-inbox:${entry.id}`
            && mailbox.processing.batchId === `inbox:${entry.id}`) {
            tx.saveWorkMailbox(completeProcessing(mailbox, mailbox.processing.batchId));
          }
        }
        entry = { ...entry, inbox };
      }
    }
    save(tx, current, entry);
    return receipt(entry);
  });
  if (ids.length === 1) return apply(ids[0]!);
  return { results: ids.map(id => {
    try { return { id, ok: true, result: apply(id) }; }
    catch (error) { return { id, ok: false, reason: error instanceof Error ? error.message : String(error) }; }
  }) };
}
