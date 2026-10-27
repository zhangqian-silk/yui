import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRole, createRoleAgentBinding, unbindRoleAgent } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { bindGlobalRoleProviderRuntime, bindTaskRoleProviderRuntime, createRoleSessionSet, recordRoleAgentSession, updateRoleAgentSessionStatus } from "../../dist/executor/agentExecutor.js";
import { createGlobalRoleMessage, createTaskMessage } from "../../dist/message/message.js";
import { runInboxCommand } from "../../dist/commands/inboxCommands.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { applyTaskInputControl, runTaskCommand } from "../../dist/commands/taskCommands.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { pendingCompletionMessages } from "../../dist/task/completionReadiness.js";
import { deliverGlobalInputs } from "../../dist/controller/globalInputDelivery.js";
import { messageContinuationBlocker, prepareMessageContinuations } from "../../dist/message/messageContinuation.js";
import { applyGlobalInputControl } from "../../dist/commands/globalRoleCommands.js";
import { readDocument } from "../helpers/read-document.js";
import { createReviewRound, createTaskReviewRound, attachReviewRoundWorkspace, startReviewRound } from "../../dist/review/reviewRound.js";
import { createFixtureRun } from "../helpers/runFixture.mjs";
import { acceptProviderTurn, beginProviderTurn, createProviderRuntimeBinding, rejectProviderTurn } from "../../dist/runtime/providerRuntimeIdentity.js";
import { failRun } from "../../dist/agentRun/agentRun.js";
import { createProject } from "../../dist/repository/project.js";
import { stopTaskExecutionCommand, startTaskExecutionCommand } from "../../dist/commands/taskExecutionCommands.js";
import { requireManagedCaller, sessionCallerEnvironment } from "../../dist/runtime/sessionCaller.js";
import { callerDiscoveryAudience } from "../../dist/cli/callerDiscovery.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createRuntimeObservation } from "../../dist/runtime/runtimeObservation.js";
import { globalInboxRecovery } from "../../dist/message/globalInboxRecovery.js";
import { globalSessionHealth } from "../../dist/runtime/globalSessionHealth.js";
import { applyOperatorSessionControl } from "../../dist/commands/operatorCommands.js";
import { standardAgentError } from "../../dist/runtime/agentError.js";

const now = new Date("2026-10-13T00:00:00Z");
function fixture(t, name) {
  const home = mkdtempSync(join(tmpdir(), "yui-agent-inbox-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  const role = createGlobalRole(name, [createRoleAgentBinding(agent)], agent.id, home, now);
  store.createGlobalRoleIfAbsent(role);
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "global", roleName: name }, agent.id, now), {
    agentId: agent.id, adapterId: "codex", nativeSessionId: `${name}-native`,
    policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  }, now));
  const env = { YUI_SESSION_SCOPE: "global", YUI_ROLE: name, CODEX_THREAD_ID: `${name}-native` };
  const command = (...args) => runInboxCommand(args, store, env, now);
  const add = body => {
    const id = store.nextGlobalRoleMessageId();
    store.saveGlobalRoleMessage(createGlobalRoleMessage(id, name, body, "user", { type: "user" }, now,
      { inputControl: { action: "queue", requestId: id } }));
    return id;
  };
  return { store, command, add, env };
}

test("Global health distinguishes desired configuration, current native state and retained old failure", t => {
  const { store } = fixture(t, "operator");
  const role = store.getGlobalRole("operator");
  const sessions = store.getGlobalRoleSessionSet("operator");
  const drift = globalSessionHealth({ ...role, launchRevision: role.launchRevision + 1 }, sessions);
  assert.equal(drift.configurationDrift, true);
  assert.equal(drift.effectiveRevision, role.launchRevision);
  assert.equal(drift.hostObservation, "unobserved");
  const binding = rejectProviderTurn(beginProviderTurn(createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex", conversationId: "old-native",
    startedAt: now.toISOString()
  }), { attemptId: "old-attempt", authorityEpoch: 1, submittedAt: now.toISOString() }),
  { attemptId: "old-attempt", rejectedAt: now.toISOString(), reason: "old rejection" });
  const current = globalSessionHealth(role, { ...sessions, providerBinding: binding });
  assert.equal(current.historicalBinding, true);
  assert.equal(current.nativeTurn, null);
  assert.equal(current.currentFailure, null);
  assert.equal(current.retry, null);

  const oldBinding = { ...binding,
    conversations: [{ ...binding.conversations[0], conversationId: "operator-native" }],
    run: { ...binding.run, failure: { ref: "old-failure", error: standardAgentError({
      source: "provider", phase: "turn-submit", message: "Rejected before submission",
      raw: "Rejected before submission", inputDisposition: "not-accepted"
    }) } }
  };
  store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(sessions, oldBinding, now));
  assert.equal(globalSessionHealth(role, store.getGlobalRoleSessionSet("operator"))
    .currentFailure.ref, "old-failure");
  store.saveGlobalRoleSessionSet(updateRoleAgentSessionStatus(
    store.getGlobalRoleSessionSet("operator"), "codex", "ended", now, "stopped"));
  applyOperatorSessionControl({ kind: "session", action: "new", targetAgentId: "codex" }, store, now);
  new FileSchedulerStoreAdapter(store).recordLaunchedRuntimeNativeSession({
    owner: { scope: "global", roleName: "operator" }, agentId: "codex", adapterId: "codex",
    nativeSessionId: "new-native", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  }, () => {}, now);
  const replaced = store.getGlobalRoleSessionSet("operator");
  assert.equal(replaced.providerBinding.authority.epoch, 2);
  assert.deepEqual(replaced.providerBinding.run, oldBinding.run, "retain historical failure evidence");
  const newHealth = globalSessionHealth(role, replaced);
  assert.equal(newHealth.nativeSessionId, "new-native");
  assert.equal(newHealth.nativeTurn, null);
  assert.equal(newHealth.currentFailure, null);
  assert.equal(newHealth.historicalBinding, true);
  const nextBinding = beginProviderTurn(replaced.providerBinding, {
    attemptId: "new-attempt", authorityEpoch: 2, submittedAt: now.toISOString()
  });
  const nextHealth = globalSessionHealth(role, { ...replaced, providerBinding: nextBinding });
  assert.equal(nextHealth.nativeTurn.attemptId, "new-attempt");
  assert.equal(nextHealth.historicalBinding, false);
});

test("exact rejected input can retire; pending, unknown, accepted and interrupt-owned effects cannot", t => {
  const { store, command, add } = fixture(t, "operator");
  const id = add("Obsolete input");
  command("claim", id, "--request-id", "original-inspection");
  const original = command("show", id);
  store.updateGlobalRoleMessage({ ...original,
    notDelivered: { reason: "Provider rejected before submission", at: now.toISOString() } });
  let binding = beginProviderTurn(createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: "operator-native", startedAt: now.toISOString()
  }), { attemptId: `global-input:operator/${id}`, authorityEpoch: 1, submittedAt: now.toISOString() });
  const save = value => store.saveGlobalRoleSessionSet({
    ...store.getGlobalRoleSessionSet("operator"), providerBinding: value });
  const retire = () => command("retire", id, "--request-id", "obsolete-negative",
    "--reason", "Verified exact rejection; business request superseded");
  save(binding);
  assert.throws(retire, /proven-unsubmitted/);
  save({ ...binding, run: { ...binding.run, status: "delivery-unknown" } });
  assert.throws(retire, /proven-unsubmitted/);
  save(acceptProviderTurn(binding, { attemptId: binding.run.attemptId, nativeTurnId: "native",
    acceptedAt: now.toISOString() }));
  assert.throws(retire, /proven-unsubmitted/);
  binding = rejectProviderTurn(binding, { attemptId: binding.run.attemptId,
    rejectedAt: now.toISOString(), reason: "no input submitted" });
  save(binding);
  const result = retire();
  assert.equal(result.inbox.retirement.reason, "Verified exact rejection; business request superseded");
  assert.equal(result.inbox.claim.requestId, "original-inspection");
  assert.equal(store.getGlobalRoleSessionSet("operator").providerBinding.run.status, "rejected");
  assert.equal(command("show", id).notDelivered.reason, "Provider rejected before submission");
  const reserved = add("Retained interrupt continuation");
  store.updateGlobalRoleMessage({ ...command("show", reserved),
    notDelivered: { reason: "target changed", at: now.toISOString() },
    interruptThen: { requestId: "reserved-then", targetAttemptId: "old-turn",
      targetNativeSessionId: "old-session", targetAgentId: "codex",
      targetAuthorityEpoch: 1, targetAuthorityHolderId: "original-host" } });
  assert.throws(() => command("retire", reserved, "--request-id", "cannot-retire-reservation",
    "--reason", "No terminal proof"), /proven-unsubmitted/);
});

test("automatic Global delivery checks missing handling at exact terminal without acknowledging or replaying effects", t => {
  const { store, command, add } = fixture(t, "operator");
  store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(store.getGlobalRoleSessionSet("operator"),
    createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
      conversationId: "operator-native", startedAt: now.toISOString() }), now));
  const adapter = new FileSchedulerStoreAdapter(store);
  const id = add("Delegate implementation; Task remains running");
  const original = command("show", id);
  store.updateGlobalRoleMessage({ ...original,
    deliveryTarget: { agentId: "codex", nativeSessionId: "operator-native" } });
  const attemptId = `global-input:operator/${id}`;
  adapter.beginAgentHostProviderTurn({ roleName: "operator", agentId: "codex", nativeSessionId: "operator-native",
    attemptId, authorityEpoch: 1, authorityOwner: "controller", holderId: "controller", now });
  const observe = kind => adapter.observeRuntimeObservation(createRuntimeObservation({
    schemaVersion: 1, eventId: `original-${kind}`, semanticKey: `original-${kind}`, kind,
    authority: "provider-structured", receivedAt: now.toISOString(), observedAt: now.toISOString(),
    payload: kind === "turn.completed" ? { output: "Delegated successfully" } : {},
    fence: { roleName: "operator", agentId: "codex", driverId: "openai/codex",
      nativeSessionId: "operator-native", conversationId: "operator-native", receiptId: attemptId,
      nativeTurnId: "original-turn" }
  }), now);
  observe("turn.accepted");
  assert.equal(command("list").items[0].id, id);
  observe("turn.completed");
  assert.equal(command("show", id).inbox, undefined, "successful final is not semantic ACK");
  const reminders = store.listGlobalRoleMessages("operator").filter(m =>
    m.inputControl?.requestId.startsWith("inbox-check:"));
  assert.equal(reminders.length, 1, "terminal records one bounded handling reminder on the normal path");
  observe("turn.completed");
  assert.equal(store.listGlobalRoleMessages("operator").filter(m =>
    m.inputControl?.requestId.startsWith("inbox-check:")).length, 1);
  command("claim", id, "--request-id", "reconcile");
  store.saveTask(activateTask(createTask("task-1", "Delegated implementation", now,
    { cwd: store.rootDirectory() }), now));
  const ack = command("ack", id, "--request-id", "delegated", "--reason", "Verified existing Task delegation; no effect replay");
  assert.equal(store.getTask("task-1").status, "active", "routing ACK does not wait for downstream Task completion");
  assert.deepEqual(command("ack", id, "--request-id", "delegated", "--reason",
    "Verified existing Task delegation; no effect replay"), ack, "lost ACK response retries only the receipt");
  assert.deepEqual(command("show", id).delivery, { deliveredAt: now.toISOString(), via: "provider" });
  const reminder = reminders[0];
  const reminderAttempt = `global-input:operator/${reminder.id}`;
  adapter.beginAgentHostProviderTurn({ roleName: "operator", agentId: "codex", nativeSessionId: "operator-native",
    attemptId: reminderAttempt, authorityEpoch: 1, authorityOwner: "controller", holderId: "controller", now });
  for (const kind of ["turn.accepted", "turn.completed"]) adapter.observeRuntimeObservation(createRuntimeObservation({
    schemaVersion: 1, eventId: `reminder-${kind}`, semanticKey: `reminder-${kind}`, kind,
    authority: "provider-structured", receivedAt: now.toISOString(), observedAt: now.toISOString(),
    payload: kind === "turn.completed" ? { output: "Forgot reminder ACK too" } : {},
    fence: { roleName: "operator", agentId: "codex", driverId: "openai/codex",
      nativeSessionId: "operator-native", conversationId: "operator-native", receiptId: reminderAttempt,
      nativeTurnId: "reminder-turn" }
  }), now);
  assert.equal(store.listGlobalRoleMessages("operator").length, 2, "reminders cannot create an infinite self-wake chain");
  assert.equal(command("show", reminder.id).inbox, undefined, "bounded fallback never fabricates ACK");
});

test("historical receipts cannot crowd or fence new input; obsolete targets retire explicitly without retargeting", t => {
  const { store, command, add } = fixture(t, "operator");
  store.transaction(() => {
    for (let i = 0; i < 140; i++) {
      add(`Historical ${i}`);
      const message = store.listGlobalRoleMessages("operator").at(-1);
      store.updateGlobalRoleMessage({ ...message, delivery: { via: "provider", deliveredAt: now.toISOString() },
        deliveryTarget: { agentId: "codex", nativeSessionId: "old-session" } });
    }
  });
  const old = add("Old selected notification");
  store.updateGlobalRoleMessage({ ...command("show", old),
    deliveryTarget: { agentId: "codex", nativeSessionId: "old-session" } });
  const fresh = add("Independent current input");
  const page = command("list", "--view", "current", "--limit", "1");
  assert.deepEqual(page.items.map(entry => entry.id), [fresh]);
  assert.equal(page.historyCount, 141);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 4096);
  command("claim", fresh, "--request-id", "new-input");
  command("ack", fresh, "--request-id", "new-handled", "--reason", "Handled independent request");
  assert.throws(() => command("claim", old, "--request-id", "no-retarget"), /session/i);
  const retired = command("retire", old, "--request-id", "obsolete", "--reason", "Read original; superseded notification has no remaining action");
  assert.equal(retired.inbox.ack, undefined);
  assert.equal(command("show", old).deliveryTarget.nativeSessionId, "old-session");
  assert.deepEqual(command("retire", old, "--request-id", "obsolete", "--reason",
    "Read original; superseded notification has no remaining action"), retired);
  assert.equal(command("list", "--view", "history").total, 140);
  assert.throws(() => command("retire", store.listGlobalRoleMessages("operator")[0].id, "--request-id", "cannot-retire-accepted",
    "--reason", "Must inspect accepted effects"), /proven-unsubmitted/);
});

test("active Global consumption survives cancellation and checks the exact claim, not unrelated historical debt", t => {
  const { store, command, add } = fixture(t, "assistant");
  let binding = createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: "assistant-native", startedAt: now.toISOString() });
  binding = beginProviderTurn(binding, { attemptId: "direct:consumer", authorityEpoch: 1, submittedAt: now.toISOString() });
  binding = acceptProviderTurn(binding, { attemptId: "direct:consumer", nativeTurnId: "active", acceptedAt: now.toISOString() });
  store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(store.getGlobalRoleSessionSet("assistant"), binding, now));
  const id = add("Consumed during direct turn");
  command("claim", id, "--request-id", "claim-active");
  assert.equal(command("show", id).inbox.claim.actor.attemptId, "direct:consumer");
  const adapter = new FileSchedulerStoreAdapter(store);
  adapter.observeRuntimeObservation(createRuntimeObservation({
    schemaVersion: 1, eventId: "cancelled-consumer", semanticKey: "cancelled-consumer", kind: "turn.cancelled",
    authority: "provider-structured", receivedAt: now.toISOString(), observedAt: now.toISOString(), payload: {},
    fence: { roleName: "assistant", agentId: "codex", driverId: "openai/codex",
      nativeSessionId: "assistant-native", conversationId: "assistant-native", receiptId: "direct:consumer",
      nativeTurnId: "active" }
  }), now);
  assert.equal(command("show", id).inbox.ack, undefined);
  const reminder = store.listGlobalRoleMessages("assistant").find(m => m.inputControl?.requestId.startsWith("inbox-check:"));
  assert.ok(reminder.body.includes(id));
  const next = add("Independent input after cancelled consumer");
  store.updateGlobalRoleMessage({ ...command("show", next),
    deliveryTarget: { agentId: "codex", nativeSessionId: "assistant-native" } });
  assert.doesNotThrow(() => adapter.beginAgentHostProviderTurn({ roleName: "assistant", agentId: "codex",
    nativeSessionId: "assistant-native", attemptId: `global-input:assistant/${next}`, authorityEpoch: 1,
    authorityOwner: "controller", holderId: "controller", now }));
  assert.equal(command("show", id).delivery, undefined);
});

for (const role of ["operator", "assistant"]) test(`${role} own inbox reads, claims and acknowledges without delivery fabrication`, t => {
  const { store, command, add, env } = fixture(t, role);
  const id = add("Complete original");
  const revision = store.getStateRevision();
  assert.equal(command("list").items[0].id, id);
  assert.equal(command("show", id).body, "Complete original");
  assert.equal(runInboxCommand(["show", id], store, { CODEX_THREAD_ID: env.CODEX_THREAD_ID }).body, "Complete original");
  assert.equal(store.getStateRevision(), revision);
  assert.throws(() => command("ack", id, "--request-id", "read-is-not-handled", "--reason", "handled"), /claim/i);
  const claimed = command("claim", id, "--request-id", "claim-one");
  assert.deepEqual(command("claim", id, "--request-id", "claim-one"), claimed);
  const next = add("Later input must survive");
  const ack = command("ack", id, "--request-id", "ack-one", "--reason", "Processed original");
  assert.deepEqual(command("ack", id, "--request-id", "ack-one", "--reason", "Processed original"), ack);
  assert.deepEqual(command("list").items.map(item => item.id), [next]);
  const original = command("show", id);
  assert.equal(original.delivery, undefined);
  assert.equal(original.inbox.ack.reason, "Processed original");
  assert.equal(original.body, "Complete original");
  assert.throws(() => store.updateGlobalRoleMessage({ ...original, body: "Different input" }), /exact original/);
  assert.throws(() => runInboxCommand(["list"], store, { ...env, CODEX_THREAD_ID: "replaced" }), /Session/);
  assert.throws(() => runInboxCommand(["list"], store, {}), /managed/i);
});

test("partial batches, long originals, restart and unknown delivery preserve each exact input", async t => {
  const { store, command, add, env } = fixture(t, "operator");
  const long = "完整😀".repeat(9000);
  const first = add(long);
  const second = add("not handled");
  assert.throws(() => command("claim", second, "--request-id", "skip"), /Earlier/);
  const original = readDocument(cursor => command("show", first, ...(cursor ? ["--cursor", cursor] : [])));
  assert.equal(original.body, long);
  const page = command("list", "--limit", "1");
  assert.equal(command("list", "--cursor", page.nextCursor).items[0].id, second);
  assert.throws(() => command("list", "--role", "assistant"), /option/);
  command("claim", first, "--request-id", "c");
  let ensured = false;
  await deliverGlobalInputs(store.rootDirectory(), store, async () => { ensured = true; }, error => { throw error; });
  assert.equal(ensured, true, "independent later input remains eligible; the claimed original itself never submits");
  assert.equal(command("show", first).delivery, undefined);
  const partial = command("ack", first, second, "--request-id", "a", "--reason", "Handled only the claimed item");
  assert.deepEqual(partial.results.map(result => result.ok), [true, false]);
  assert.equal(command("show", second).inbox, undefined);
  const unknown = store.listGlobalRoleMessages("operator").find(m => m.id === second);
  store.updateGlobalRoleMessage({ ...unknown, control: { requestId: second,
    receiptId: `global-input:operator/${second}`, outcome: "delivery-unknown", observedAt: now.toISOString() } });
  assert.throws(() => command("claim", second, "--request-id", "unknown"), /unknown/);
  assert.equal(command("show", second).control.outcome, "delivery-unknown");
  const reopened = new SqliteTaskStore(store.rootDirectory());
  t.after(() => reopened.close());
  const saved = readDocument(cursor => runInboxCommand(["show", first, ...(cursor ? ["--cursor", cursor] : [])], reopened, env));
  assert.equal(saved.inbox.ack.reason, "Handled only the claimed item");
  assert.equal(saved.delivery, undefined);
  store.transaction(() => { for (let i = 0; i < 128; i++) add(`Pending ${i}: ${"正文".repeat(300)}`); });
  let cursor;
  const seen = [];
  do {
    const page = command("list", "--limit", "37", ...(cursor ? ["--cursor", cursor] : []));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32768);
    seen.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(new Set(seen).size, 129);
  assert.equal(command("show", second).inbox, undefined, "reading every page still does not consume input");
});

test("accepted automatic input stays visible until explicit handling; unknown effects never become replayable", t => {
  const { store, command, add, env } = fixture(t, "operator");
  const id = add("Automatically delivered original");
  const original = store.listGlobalRoleMessages("operator")[0];
  store.updateGlobalRoleMessage({ ...original,
    deliveryTarget: { agentId: "codex", nativeSessionId: env.CODEX_THREAD_ID },
    delivery: { deliveredAt: now.toISOString(), via: "provider" },
    control: { requestId: id, receiptId: `global-input:operator/${id}`, outcome: "accepted", observedAt: now.toISOString() }
  });
  assert.equal(command("list").items[0].id, id, "native acceptance is not semantic handling");
  const delivery = command("show", id).delivery;
  command("claim", id, "--request-id", "received");
  command("ack", id, "--request-id", "processed", "--reason", "Verified original and completed its effects");
  assert.deepEqual(command("show", id).delivery, delivery);
  assert.equal(command("list").items.length, 0);
  const later = add("Accepted before an interruption");
  store.updateGlobalRoleMessage({ ...store.listGlobalRoleMessages("operator")[1],
    deliveryTarget: { agentId: "codex", nativeSessionId: env.CODEX_THREAD_ID },
    delivery: { deliveredAt: now.toISOString(), via: "provider" }
  });
  const set = updateRoleAgentSessionStatus(store.getGlobalRoleSessionSet("operator"), "codex", "ended", now, "stopped");
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(set, { ...set.sessions.codex,
    status: "active", endReason: undefined, nativeSessionId: "successor" }, new Date(now.getTime() + 1000)));
  const successor = (...args) => runInboxCommand(args, store, { CODEX_THREAD_ID: "successor" }, now);
  successor("claim", later, "--request-id", "inspect-previous-effects");
  successor("ack", later, "--request-id", "settle-previous", "--reason", "Inspected original delivery and external effect receipt; no replay needed");
  assert.equal(successor("show", later).deliveryTarget.nativeSessionId, "operator-native");
  assert.equal(successor("show", later).inbox.ack.actor.nativeSessionId, "successor");
});

test("native admission and active consumption arbitrate atomically on the original Global Message", t => {
  const { store, command, add } = fixture(t, "assistant");
  store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(store.getGlobalRoleSessionSet("assistant"),
    createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
      conversationId: "assistant-native", startedAt: now.toISOString() }), now));
  const adapter = new FileSchedulerStoreAdapter(store);
  const input = id => ({ roleName: "assistant", agentId: "codex", nativeSessionId: "assistant-native",
    attemptId: `global-input:assistant/${id}`, authorityEpoch: 1, authorityOwner: "controller",
    holderId: "controller", now, boundedText: "Original" });
  const first = add("Manual wins");
  const original = store.listGlobalRoleMessages("assistant")[0];
  store.updateGlobalRoleMessage({ ...original, deliveryTarget: { agentId: "codex", nativeSessionId: "assistant-native" } });
  command("claim", first, "--request-id", "manual");
  assert.throws(() => store.updateGlobalRoleMessage({ ...original,
    deliveryTarget: { agentId: "codex", nativeSessionId: "assistant-native" } }), /ownership changed/);
  assert.throws(() => adapter.beginAgentHostProviderTurn(input(first)), /settled|unconfirmed/);
  assert.equal(store.getGlobalRoleSessionSet("assistant").providerBinding.run, null);
  command("ack", first, "--request-id", "handled", "--reason", "Processed");
  assert.throws(() => adapter.beginAgentHostProviderTurn(input(first)), /settled|unconfirmed/);
  const second = add("Automatic wins");
  store.updateGlobalRoleMessage({ ...store.listGlobalRoleMessages("assistant")[1],
    deliveryTarget: { agentId: "codex", nativeSessionId: "assistant-native" } });
  adapter.beginAgentHostProviderTurn(input(second));
  assert.throws(() => command("claim", second, "--request-id", "cannot-take-over"), /pending|native-attempt/);
  assert.equal(command("show", second).inbox, undefined);
  assert.equal(command("show", second).control.outcome, "pending");
});

for (const targeted of [false, true]) test(`a successor can settle retained handling (Session target: ${targeted}) without retargeting`, t => {
  const { store, command, add, env } = fixture(t, "operator");
  const id = add("Preserve across an interrupted handler");
  if (targeted) {
    const original = store.listGlobalRoleMessages("operator")[0];
    store.updateGlobalRoleMessage({ ...original, inputControl: {
      ...original.inputControl, expectedSessionId: "operator-native"
    } });
  }
  command("claim", id, "--request-id", "old-claim");
  const set = updateRoleAgentSessionStatus(store.getGlobalRoleSessionSet("operator"), "codex", "ended", now, "stopped");
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(set, { ...set.sessions.codex,
    status: "active", endReason: undefined, nativeSessionId: "successor" }, new Date(now.getTime() + 1000)));
  assert.throws(() => command("ack", id, "--request-id", "old", "--reason", "old session"), /Session/);
  const successor = { ...env, CODEX_THREAD_ID: "successor" };
  assert.equal(runInboxCommand(["list"], store, successor).items[0].blocked, "claimed-by-previous-session");
  const ack = runInboxCommand(["ack", id, "--request-id", "successor-done",
    "--reason", "Read original and verified prior effects, completed handling"], store, successor);
  assert.equal(ack.inbox.claim.actor.nativeSessionId, "operator-native");
  assert.equal(ack.inbox.ack.actor.nativeSessionId, "successor");
  assert.equal(runInboxCommand(["show", id], store, successor).inputControl.expectedSessionId,
    targeted ? "operator-native" : undefined);
  const next = add("Later input");
  runInboxCommand(["claim", next, "--request-id", "next"], store, successor);
});

test("Global successor initialization uses one pinned notice while original claims and new inputs stay separate", t => {
  const { store, command, add } = fixture(t, "assistant");
  const id = add("An already performed effect with no ACK");
  const original = command("claim", id, "--request-id", "old-claim");
  assert.equal(globalInboxRecovery(store, "assistant", now), undefined, "never launch a substitute for the current handler");
  const ended = updateRoleAgentSessionStatus(store.getGlobalRoleSessionSet("assistant"), "codex", "ended", now, "stopped");
  const successor = recordRoleAgentSession(ended, { ...ended.sessions.codex,
    status: "active", endReason: undefined, nativeSessionId: "successor" }, now);
  const binding = createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: "successor", startedAt: now.toISOString() });
  store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(successor, binding, now));
  const next = add("New independent input");
  const notice = globalInboxRecovery(store, "assistant", now);
  assert.ok(notice);
  assert.equal(notice.deliveryTarget.nativeSessionId, "successor");
  assert.deepEqual(globalInboxRecovery(store, "assistant", now), notice, "restart/reconcile reuse the same Message");
  const adapter = new FileSchedulerStoreAdapter(store);
  const input = message => ({ roleName: "assistant", agentId: "codex", nativeSessionId: "successor",
    attemptId: `global-input:assistant/${message}`, authorityEpoch: 1, authorityOwner: "controller",
    holderId: "controller", now, boundedText: "Read retained inbox, do not replay" });
  assert.throws(() => adapter.beginAgentHostProviderTurn(input(id)), /settled|unconfirmed/);
  adapter.beginAgentHostProviderTurn(input(notice.id));
  assert.throws(() => adapter.beginAgentHostProviderTurn(input(next)), /unsettled/);
  assert.equal(store.getGlobalRoleSessionSet("assistant").providerBinding.run.attemptId, input(notice.id).attemptId);
  assert.deepEqual(commandSafe(store, id).inbox, original.inbox);
  assert.equal(commandSafe(store, id).delivery, undefined);
  assert.equal(commandSafe(store, next).control, undefined);
  assert.equal(globalInboxRecovery(store, "assistant", now), undefined, "an unsettled writer cannot admit another notice");
  function commandSafe(store, message) {
    return runInboxCommand(["show", message], store, { CODEX_THREAD_ID: "successor" }, now);
  }
});

test("an unsubmitted Global steer can be explicitly handled without replay or blocking later input", t => {
  const { store, command, add } = fixture(t, "operator");
  const result = applyGlobalInputControl("operator", { action: "steer", body: "Old correction",
    requestId: "no-turn", expectedTarget: "absent-turn", to: "operator" }, store, { env: {} });
  assert.equal(result.data.steer.code, "NO_ACTIVE_TURN");
  const original = store.listGlobalRoleMessages("operator")[0];
  const later = add("Later ordinary input");
  assert.throws(() => command("claim", later, "--request-id", "skip-old"), /Earlier/);
  command("claim", original.id, "--request-id", "handle-old");
  // A delayed control writer read before the claim cannot admit a native steer.
  assert.throws(() => store.updateGlobalRoleMessage({ ...original, control: {
    requestId: "no-turn", receiptId: `steer:operator/${original.id}`,
    outcome: "pending", observedAt: now.toISOString()
  } }), /ownership changed/);
  command("ack", original.id, "--request-id", "old-done", "--reason", "Read original; no action remains");
  command("claim", later, "--request-id", "handle-later");
  const retained = command("show", original.id);
  assert.equal(retained.inputControl.action, "steer", "explicit handling never downgrades steer to queue");
  assert.equal(retained.control, undefined);
  assert.equal(retained.delivery, undefined);
});

function taskFixture(t, draft = false) {
  const f = fixture(t, "operator");
  const { store } = f;
  const home = store.rootDirectory();
  const taskRecord = createTask("task-1", "Own inbox", now, draft ? {} : { cwd: home });
  store.saveTask(draft ? taskRecord : activateTask(taskRecord, now));
  if (!draft) store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: "task-1" }, root: home, entries: []
  }, now));
  for (const name of ["leader", "worker", "reviewer"]) {
    const role = createRole("task-1", name, [createRoleAgentBinding(store.getConfiguredAgent("codex"))], "codex", home, now);
    store.saveRole("task-1", role);
    if (name === "leader") store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
      { scope: "task", taskId: "task-1", roleName: name }, "codex", now), {
      agentId: "codex", adapterId: "codex", nativeSessionId: `${name}-native`,
      policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
    }, now));
  }
  const envFor = role => ({ YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1", YUI_ROLE: role,
    CODEX_THREAD_ID: `${role}-native` });
  const inbox = (role, ...args) => runInboxCommand(args, store, envFor(role), now);
  const task = args => runTaskCommand(args, store, { now: () => now, environment: {} });
  return { ...f, task, inbox, envFor };
}

for (const mode of ["automatic", "active", "reminder"]) test(`Leader terminal checks ${mode} consumption and preserves later input`, t => {
  const automatic = mode === "automatic";
  const reminder = mode === "reminder";
  const { store, task, inbox } = taskFixture(t);
  const adapter = new FileSchedulerStoreAdapter(store);
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(store.getTaskRoleSessionSet("task-1", "leader"),
    createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
      conversationId: "leader-native", startedAt: now.toISOString() }), now));
  if (reminder) enqueueWork(store, { kind: "role", taskId: "task-1", roleName: "leader" }, "inbox-handling-missing", now);
  else task(["message", "queue", "task-1", "Handle this requirement", "--request-id", "original"]);
  const notification = automatic ? adapter.claimLeaderNotification("task-1", now) : undefined;
  const attemptId = notification?.attemptId ?? "direct:active-consumer";
  adapter.beginAgentHostProviderTurn({ taskId: "task-1", roleName: "leader", agentId: "codex",
    nativeSessionId: "leader-native", attemptId, authorityEpoch: 1, authorityOwner: "controller",
    holderId: "controller", now });
  adapter.observeRuntimeObservation(createRuntimeObservation({
    schemaVersion: 1, eventId: "accepted", semanticKey: "accepted", kind: "turn.accepted",
    authority: "provider-structured", receivedAt: now.toISOString(), observedAt: now.toISOString(), payload: {},
    fence: { taskId: "task-1", roleName: "leader", agentId: "codex", driverId: "openai/codex",
      nativeSessionId: "leader-native", conversationId: "leader-native", receiptId: attemptId, nativeTurnId: "turn" }
  }), now);
  if (automatic) adapter.settleLeaderNotification("task-1", attemptId, "accepted", now);
  const entry = inbox("leader", "list", "--view", "current").items[0];
  const wakeId = automatic ? notification.wakeId
    : inbox("leader", "claim", entry.id, "--request-id", "active").id;
  if (!automatic) assert.equal(store.getTaskWake("task-1", wakeId).inbox.claim.actor.attemptId, attemptId);
  task(["message", "queue", "task-1", "Later independent requirement", "--request-id", "later"]);
  const terminal = { taskId: "task-1", roleName: "leader", agentId: "codex", adapterId: "codex",
    nativeSessionId: "leader-native", nativeTurnId: "turn", attemptId, providerStatus: "completed",
    outcome: { status: "completed", output: "Handled but forgot ACK" } };
  adapter.observeRuntimeRunTerminal(terminal, now);
  assert.equal(store.getTaskWake("task-1", wakeId).inbox?.ack, undefined);
  assert.equal(store.listEvents("task-1").filter(event => event.type === "inbox-handling-missing").length, reminder ? 0 : 1);
  adapter.observeRuntimeRunTerminal(terminal, now);
  assert.equal(store.listEvents("task-1").filter(event => event.type === "inbox-handling-missing").length, reminder ? 0 : 1);
  const next = adapter.claimLeaderNotification("task-1", now);
  assert.ok(next, "missing ACK does not block a later independent notification after exact terminal");
  assert.equal(store.getTaskWake("task-1", next.wakeId).refs.some(ref => ref.id === (reminder ? "message-1" : "message-2")), true);
  assert.equal(store.getTask("task-1").status, "active");
});

test("automatic Assignment continuation missing ACK reaches Leader without replaying the Worker", t => {
  const { store, task } = taskFixture(t);
  task(["work", "create", "task-1", "Bounded work", "--role", "worker"]);
  task(["work", "dispatch", "task-1/work-item-1"]);
  const initial = store.getActiveRun("task-1", "worker");
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "worker" }, "codex", now), {
    agentId: "codex", adapterId: "codex", nativeSessionId: "worker-native",
    policy: "fixed", status: "active", effective: initial.effective
  }, now));
  task(["message", "queue", "task-1", "Original continuation", "--to", "worker",
    "--work-item", "work-item-1", "--request-id", "continue"]);
  store.saveRun(failRun(initial, "runtime-failed", "Original exact terminal", now, {
    providerNamespace: "openai/codex", accountScope: "codex", conversationId: "worker-native",
    nativeTurnId: "previous", status: "failed"
  }));
  store.clearActiveRun("task-1", "worker");
  prepareMessageContinuations(store, "task-1", now, "worker");
  const continuation = store.getActiveRun("task-1", "worker");
  assert.ok(continuation);
  let sessions = recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "worker" }, "codex", now), {
    agentId: "codex", adapterId: "codex", nativeSessionId: "worker-native",
    policy: "fixed", status: "active", effective: continuation.effective
  }, now);
  let binding = createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: "worker-native", startedAt: now.toISOString() });
  binding = beginProviderTurn(binding, { attemptId: "continuation", runId: continuation.id, authorityEpoch: 1,
    submittedAt: now.toISOString() });
  binding = acceptProviderTurn(binding, { attemptId: "continuation", nativeTurnId: "continued", acceptedAt: now.toISOString() });
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(sessions, binding, now));
  new FileSchedulerStoreAdapter(store).observeRuntimeRunTerminal({
    taskId: "task-1", roleName: "worker", agentId: "codex", adapterId: "codex", runId: continuation.id,
    nativeSessionId: "worker-native", nativeTurnId: "continued", attemptId: "continuation",
    providerStatus: "completed", outcome: { status: "completed", output: "Implemented clarification; forgot ACK" }
  }, now);
  const check = store.listEvents("task-1").find(event => event.type === "inbox-handling-missing");
  assert.equal(check.payload.roleName, "worker");
  assert.equal(check.payload.entries, "message-1");
  assert.equal(store.listMessages("task-1")[0].inbox, undefined);
  prepareMessageContinuations(store, "task-1", now, "worker");
  assert.equal(store.getActiveRun("task-1", "worker"), null, "the check notifies Leader, never resubmits original work");
  assert.equal(store.listRuns("task-1").length, 2);
});

test("native-only callers resolve their current role without borrowing hints, Home or child identity", t => {
  const { store, envFor, inbox } = taskFixture(t);
  assert.deepEqual(sessionCallerEnvironment(store, {}), {}, "a plain user remains explicitly unbound");
  const ordinary = { CODEX_THREAD_ID: "ordinary-thread" };
  assert.deepEqual(sessionCallerEnvironment(store, ordinary), ordinary,
    "an unknown provider thread is not itself a managed identity");
  assert.equal(callerDiscoveryAudience(store.rootDirectory(), ordinary), "public");
  const uninitialized = join(store.rootDirectory(), "not-initialized");
  assert.equal(callerDiscoveryAudience(uninitialized, ordinary), "public");
  assert.equal(existsSync(uninitialized), false, "discovery never initializes a Home");
  assert.equal(callerDiscoveryAudience(uninitialized, { YUI_ROLE: "leader", ...ordinary }), "unbound");
  assert.equal(callerDiscoveryAudience(store.rootDirectory(), { CODEX_THREAD_ID: "leader-native" }), "leader");
  assert.equal(callerDiscoveryAudience(store.rootDirectory(), { CODEX_THREAD_ID: "operator-native" }), "operator");
  for (const key of ["YUI_ROLE", "YUI_TASK_ID", "YUI_SESSION_MANIFEST", "YUI_ADAPTER_ID", "YUI_WORKSPACE"]) {
    assert.throws(() => sessionCallerEnvironment(store, { ...ordinary, [key]: "partial" }), /not registered/);
  }
  assert.equal(requireManagedCaller(store, { CODEX_THREAD_ID: "operator-native" }).scope, "global");
  assert.equal(requireManagedCaller(store, { CODEX_THREAD_ID: "leader-native" }).roleName, "leader");
  assert.equal(requireManagedCaller(store, { YUI_NATIVE_SESSION_ID: "leader-native" }).taskId, "task-1");
  const globalSet = store.getGlobalRoleSessionSet("operator");
  store.saveGlobalRoleSessionSet({ ...globalSet, sessions: { codex: { ...globalSet.sessions.codex,
    nativeSessionId: "leader-native" } } });
  assert.throws(() => requireManagedCaller(store, { CODEX_THREAD_ID: "leader-native" }), /ambiguous/);
  store.saveGlobalRoleSessionSet(globalSet);
  for (const hints of [
    { YUI_ROLE: "operator" }, { YUI_TASK_ID: "foreign" }, { YUI_AGENT_ID: "foreign" },
    { YUI_ADAPTER_ID: "claude" }, { YUI_WORKSPACE: "/foreign" }
  ]) assert.throws(() => requireManagedCaller(store, { CODEX_THREAD_ID: "leader-native", ...hints }), /conflict/);
  assert.throws(() => requireManagedCaller(store, { ...envFor("leader"), CODEX_THREAD_ID: "native-child",
    YUI_NATIVE_SESSION_ID: "leader-native" }), /not registered/);
  assert.throws(() => requireManagedCaller(store, { YUI_ROLE: "operator" }), /no native/);
  assert.throws(() => requireManagedCaller(store, { CODEX_THREAD_ID: "" }), /invalid/);
  const other = fixture(t, "other");
  assert.throws(() => sessionCallerEnvironment(other.store, envFor("leader")), /YUI_HOME/);
  store.saveEvent("task-1", createTaskEvent(store.nextEventId("task-1"), "task-1", "role.agent-bound", {
    role: "leader", revokedNativeSessionId: "leader-native"
  }, now));
  assert.throws(() => inbox("leader", "list"), /revoked/);
  const leaderSet = store.getTaskRoleSessionSet("task-1", "leader");
  const ended = updateRoleAgentSessionStatus(leaderSet, leaderSet.activeAgentId, "ended", now, "stopped");
  store.saveTaskRoleSessionSet(ended);
  assert.throws(() => sessionCallerEnvironment(store, { CODEX_THREAD_ID: "leader-native" }), /no longer current/);
  assert.equal(callerDiscoveryAudience(store.rootDirectory(), { CODEX_THREAD_ID: "leader-native" }), "unbound");
  store.saveTaskRoleSessionSet(recordRoleAgentSession(ended, {
    ...leaderSet.sessions[leaderSet.activeAgentId], nativeSessionId: "replacement", status: "active"
  }, now));
  assert.throws(() => sessionCallerEnvironment(store, { CODEX_THREAD_ID: "leader-native" }), /no longer current/);
});

test("unbinding an Agent and removing its Role cannot erase managed identity into public authority", t => {
  const { store } = fixture(t, "custom");
  const original = store.getGlobalRole("custom");
  const backup = createConfiguredAgent("backup", "codex", "false", [], [], now);
  const role = createGlobalRole("custom", [...Object.values(original.agentBindings),
    createRoleAgentBinding(backup)], backup.id, store.rootDirectory(), now);
  let set = updateRoleAgentSessionStatus(store.getGlobalRoleSessionSet("custom"), "codex", "ended", now, "stopped");
  set = recordRoleAgentSession(set, { ...set.sessions.codex, agentId: backup.id,
    nativeSessionId: "backup-native", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, now);
  const unbound = unbindRoleAgent(role, set, "codex", now);
  store.saveGlobalRoleWithSessionSet(unbound.role, unbound.sessions);
  assert.throws(() => sessionCallerEnvironment(store, { CODEX_THREAD_ID: "custom-native" }), /no longer current/);
  assert.throws(() => store.saveGlobalRoleWithSessionSet(unbound.role, null), /discard recorded Session/);
  assert.throws(() => store.removeGlobalRole("custom"), /Stop the Role/);
  store.saveGlobalRoleSessionSet(updateRoleAgentSessionStatus(unbound.sessions, backup.id, "ended", now, "stopped"));
  store.removeGlobalRole("custom");
  assert.throws(() => sessionCallerEnvironment(store, { CODEX_THREAD_ID: "backup-native" }), /no longer current/);
  assert.equal(store.getGlobalRole("custom"), null);
  assert.deepEqual(store.listRuntimeSessionCandidates(), []);

  const f = taskFixture(t);
  const leader = f.store.getTaskRoleSessionSet("task-1", "leader");
  const taskRole = createRole("task-1", "leader", [...Object.values(f.store.getRole("task-1", "leader").agentBindings),
    createRoleAgentBinding(backup)], backup.id, f.store.rootDirectory(), now);
  const taskSet = recordRoleAgentSession(updateRoleAgentSessionStatus(leader, "codex", "ended", now, "stopped"), {
    ...leader.sessions.codex, agentId: backup.id, nativeSessionId: "task-backup", status: "active",
    effective: resolveEffectiveLaunch({ role: taskRole, purpose: "execution" })
  }, now);
  const taskUnbound = unbindRoleAgent(taskRole, taskSet, "codex", now);
  f.store.saveTaskRoleWithSessionSet(taskUnbound.role, taskUnbound.sessions);
  assert.throws(() => sessionCallerEnvironment(f.store, { CODEX_THREAD_ID: "leader-native" }), /no longer current/);
  assert.throws(() => f.store.removeTaskRole("task-1", "leader"), /Stop the Role/);
  f.store.saveTaskRoleSessionSet(updateRoleAgentSessionStatus(taskUnbound.sessions, backup.id, "ended", now, "stopped"));
  // Exercise storage retention directly; the public command separately forbids removing a Leader.
  f.store.removeTaskRole("task-1", "leader");
  assert.throws(() => sessionCallerEnvironment(f.store, { CODEX_THREAD_ID: "task-backup" }), /no longer current/);
});

test("automatic windows pin same-tick revisions and require explicit acknowledgement independently of native acceptance", t => {
  const { store, task, inbox } = taskFixture(t, true);
  task(["message", "send", "task-1", "A", "--intent", "discuss"]);
  task(["message", "update", "task-1/message-1", "B"]);
  const adapter = new FileSchedulerStoreAdapter(store);
  const first = adapter.claimLeaderNotification("task-1", now);
  adapter.settleLeaderNotification("task-1", first.attemptId, "accepted", now);
  enqueueWork(store, { kind: "role", taskId: "task-1", roleName: "leader" }, "user-message", now,
    [{ type: "message", taskId: "task-1", id: "message-1" }]);
  assert.equal(adapter.claimLeaderNotification("task-1", now), null, "duplicate notification cannot replay a delivered revision");
  assert.equal(pendingCompletionMessages(store, "task-1").length, 1);
  assert.equal(inbox("leader", "list").items[0].id, first.wakeId);
  inbox("leader", "claim", first.wakeId, "--request-id", "automatic-B");
  task(["message", "update", "task-1/message-1", "C"]);
  inbox("leader", "ack", first.wakeId, "--request-id", "B-handled", "--reason", "Handled B; C is later input");
  assert.equal(pendingCompletionMessages(store, "task-1").length, 1, "old acknowledgement cannot handle new revision");
  const second = adapter.claimLeaderNotification("task-1", now);
  adapter.settleLeaderNotification("task-1", second.attemptId, "accepted", now);
  inbox("leader", "claim", second.wakeId, "--request-id", "automatic-C");
  inbox("leader", "ack", second.wakeId, "--request-id", "C-handled", "--reason", "Handled C");
  assert.equal(pendingCompletionMessages(store, "task-1").length, 0);
  assert.throws(() => store.saveTaskWake("task-1", { ...store.getTaskWake("task-1", first.wakeId), refs: [] }), /immutable/);
});

test("Draft edits have distinct inbox ownership even under the same clock", t => {
  const { store, task, inbox } = taskFixture(t, true);
  task(["message", "send", "task-1", "A", "--intent", "discuss"]);
  const claim = request => inbox("leader", "claim",
    inbox("leader", "list").items.find(item => item.id.startsWith("pending-")).id, "--request-id", request);
  const first = claim("A");
  inbox("leader", "ack", first.id, "--request-id", "A-done", "--reason", "Handled A");
  task(["message", "update", "task-1/message-1", "B"]);
  assert.deepEqual(pendingCompletionMessages(store, "task-1").map(message => message.id), ["message-1"]);
  const second = claim("B");
  assert.notEqual(second.id, first.id);
  inbox("leader", "ack", second.id, "--request-id", "B-done", "--reason", "Handled B");
  task(["message", "update", "task-1/message-1", "C"]);
  const next = new FileSchedulerStoreAdapter(store).claimLeaderNotification("task-1", now);
  assert.equal(next.disposition, "submit");
  assert.equal(store.listMessages("task-1")[0].body, "C");
  assert.equal(store.getTaskWake("task-1", first.id).inbox.ack.reason, "Handled A");
});

test("retired Leader steer claim preserves audit without blocking new input", t => {
  const { store, task, inbox } = taskFixture(t);
  task(["message", "steer", "task-1", "Old", "--to", "leader", "--expected-target", "missing", "--request-id", "old"]);
  inbox("leader", "claim", "message-1", "--request-id", "old-claim");
  task(["message", "retire", "task-1/message-1", "--reason", "Inspected; obsolete"]);
  task(["message", "queue", "task-1", "New", "--request-id", "new"]);
  const pending = inbox("leader", "list").items[0];
  assert.equal(pending.blocked, null);
  const next = inbox("leader", "claim", pending.id, "--request-id", "new-claim");
  inbox("leader", "ack", next.id, "--request-id", "new-done", "--reason", "Handled new");
  task(["message", "queue", "task-1", "Later", "--request-id", "later"]);
  assert.equal(new FileSchedulerStoreAdapter(store).claimLeaderNotification("task-1", now).disposition, "submit");
  assert.equal(store.listMessages("task-1")[0].inbox.ack, undefined);
});

test("a successor Leader settles an exact-Session window without replaying its originals", t => {
  const { store, inbox, envFor, task } = taskFixture(t);
  const target = { kind: "role", taskId: "task-1", roleName: "leader" };
  store.saveMessage("task-1", createTaskMessage("message-1", "task-1", "Old request", "user",
    { type: "user" }, now, { inputControl: {
      action: "queue", requestId: "original", expectedSessionId: "leader-native"
    } }));
  enqueueWork(store, target, "user-message", now, [{ type: "message", taskId: "task-1", id: "message-1" }]);
  const pending = inbox("leader", "list").items[0].id;
  const claimed = inbox("leader", "claim", pending, "--request-id", "old-window");
  const options = { environment: {}, now: () => now };
  stopTaskExecutionCommand({ taskId: "task-1", reason: "Pause execution" }, store, options);
  startTaskExecutionCommand("task-1", store, options);
  assert.deepEqual(pendingCompletionMessages(store, "task-1").map(message => message.id), ["message-1"]);
  assert.equal(new FileSchedulerStoreAdapter(store).claimLeaderNotification("task-1", now), null);
  const ended = updateRoleAgentSessionStatus(store.getTaskRoleSessionSet("task-1", "leader"), "codex", "ended", now, "stopped");
  store.saveTaskRoleSessionSet(recordRoleAgentSession(ended, { ...ended.sessions.codex,
    status: "active", endReason: undefined, nativeSessionId: "successor" }, new Date(now.getTime() + 1000)));
  const successor = (...args) => runInboxCommand(args, store, { ...envFor("leader"), CODEX_THREAD_ID: "successor" }, now);
  task(["message", "retire", "task-1/message-1", "--reason", "Inspected effects; obsolete"]);
  successor("ack", claimed.id, "--request-id", "settle", "--reason", "Original and prior effects inspected; no action remains");
  assert.equal(store.getTaskWake("task-1", claimed.id).inbox.claim.actor.nativeSessionId, "leader-native");
  assert.equal(store.listMessages("task-1")[0].inputControl.expectedSessionId, "leader-native");
  assert.equal(store.getWorkMailbox(target).processing, null);
  task(["message", "queue", "task-1", "Next request", "--request-id", "next"]);
  const next = successor("list").items[0].id;
  successor("claim", next, "--request-id", "next-window");
});

for (const activeClaim of [false, true]) test(`replacement bootstraps before retained handling (active window: ${activeClaim})`, t => {
  const { store, inbox, task, envFor } = taskFixture(t);
  const adapter = new FileSchedulerStoreAdapter(store);
  task(["message", "queue", "task-1", "Already processed effect; ACK was interrupted", "--request-id", "original"]);
  let id;
  if (activeClaim) id = inbox("leader", "claim", inbox("leader", "list").items[0].id, "--request-id", "old").id;
  else {
    const notification = adapter.claimLeaderNotification("task-1", now);
    adapter.settleLeaderNotification("task-1", notification.attemptId, "accepted", now);
    id = inbox("leader", "claim", notification.wakeId, "--request-id", "old").id;
  }
  const original = store.getTaskWake("task-1", id);
  task(["role", "session", "new", "task-1", "leader", "--reason", "Interrupted handler"]);
  task(["message", "queue", "task-1", "New input during replacement", "--request-id", "new"]);
  const oldProcessing = store.getWorkMailbox({ kind: "role", taskId: "task-1", roleName: "leader" }).processing;
  assert.equal(adapter.claimLeaderNotification("task-1", now), null, "cleanup must establish quiescence first");
  const runtime = { kind: "role-runtime", taskId: "task-1", roleName: "leader" };
  assert.equal(adapter.completeRuntimeCleanup(runtime, now), true);
  assert.equal(adapter.completeRuntimeCleanup(runtime, now), false, "reconcile is idempotent");
  if (activeClaim) {
    const mailbox = store.getWorkMailbox({ kind: "role", taskId: "task-1", roleName: "leader" });
    store.saveWorkMailbox({ ...mailbox, processing: oldProcessing,
      recentDedupeKeys: mailbox.recentDedupeKeys.filter(key => !oldProcessing.batch.dedupeKeys.includes(key)) });
  }
  // Reopen the store to exercise persisted state, not cached recovery state.
  const reopened = new SqliteTaskStore(store.rootDirectory());
  t.after(() => reopened.close());
  const scheduler = new FileSchedulerStoreAdapter(reopened);
  const recovery = scheduler.claimLeaderNotification("task-1", now);
  assert.equal(recovery?.disposition, "submit", "a retained claim must not prevent successor initialization");
  const wake = store.getTaskWake("task-1", recovery.wakeId);
  assert.ok(wake.refs.every(ref => ref.type === "event"), "bootstrap does not resubmit old or new business");
  assert.match(recovery.presentation, /inbox list/);
  assert.deepEqual(store.getTaskWake("task-1", id), original);
  scheduler.settleLeaderNotification("task-1", recovery.attemptId, "accepted", now);
  assert.equal(scheduler.claimLeaderNotification("task-1", now), null, "no infinite recovery turns");
  const set = store.getTaskRoleSessionSet("task-1", "leader");
  store.saveTaskRoleSessionSet(recordRoleAgentSession(set, {
    agentId: "codex", adapterId: "codex", nativeSessionId: "successor", status: "active", policy: "fixed",
    effective: resolveEffectiveLaunch({ role: store.getRole("task-1", "leader"), purpose: "execution" })
  }, now));
  task(["role", "session", "new", "task-1", "leader", "--reason", "Another deliberate replacement before settlement"]);
  scheduler.completeRuntimeCleanup(runtime, now);
  const secondRecovery = scheduler.claimLeaderNotification("task-1", now);
  assert.equal(secondRecovery.disposition, "submit");
  scheduler.settleLeaderNotification("task-1", secondRecovery.attemptId, "accepted", now);
  assert.deepEqual(store.getTaskWake("task-1", id), original, "repeated replacement never rewrites the original claim");
  const current = store.getTaskRoleSessionSet("task-1", "leader");
  store.saveTaskRoleSessionSet(recordRoleAgentSession(current, {
    agentId: "codex", adapterId: "codex", nativeSessionId: "second-successor", status: "active", policy: "fixed",
    effective: resolveEffectiveLaunch({ role: store.getRole("task-1", "leader"), purpose: "execution" })
  }, now));
  const successor = (...args) => runInboxCommand(args, store, { ...envFor("leader"), CODEX_THREAD_ID: "second-successor" }, now);
  successor("ack", id, "--request-id", "verified", "--reason", "Inspected original and effect receipt; no replay");
  const next = scheduler.claimLeaderNotification("task-1", now);
  assert.ok(store.getTaskWake("task-1", next.wakeId).refs.some(ref => ref.id === "message-2"));
  assert.ok(!store.getTaskWake("task-1", next.wakeId).refs.some(ref => ref.id === "message-1"));
  assert.equal(successor("show", id).inbox.claim.actor.nativeSessionId, "leader-native");
});

test("replacement releases uncertain transport for inspection, never for automatic business replay", t => {
  const { store, task, inbox } = taskFixture(t);
  const scheduler = new FileSchedulerStoreAdapter(store);
  applyTaskInputControl("task-1", { action: "queue", body: "Verify the external effect before doing anything",
    requestId: "uncertain", expectedSessionId: "leader-native" }, store, { now: () => now, environment: {} });
  const notification = scheduler.claimLeaderNotification("task-1", now);
  scheduler.settleLeaderNotification("task-1", notification.attemptId, "unknown", now);
  assert.throws(() => inbox("leader", "claim", notification.wakeId, "--request-id", "too-early"), /automatic/);
  task(["role", "session", "new", "task-1", "leader", "--reason", "Inspect uncertainty in a successor"]);
  scheduler.completeRuntimeCleanup({ kind: "role-runtime", taskId: "task-1", roleName: "leader" }, now);
  const bootstrap = scheduler.claimLeaderNotification("task-1", now);
  assert.ok(store.getTaskWake("task-1", bootstrap.wakeId).refs.every(ref => ref.type === "event"));
  scheduler.settleLeaderNotification("task-1", bootstrap.attemptId, "accepted", now);
  assert.equal(scheduler.claimLeaderNotification("task-1", now), null);
  const set = store.getTaskRoleSessionSet("task-1", "leader");
  store.saveTaskRoleSessionSet(recordRoleAgentSession(set, {
    agentId: "codex", adapterId: "codex", nativeSessionId: "successor", status: "active", policy: "fixed",
    effective: resolveEffectiveLaunch({ role: store.getRole("task-1", "leader"), purpose: "execution" })
  }, now));
  const successor = (...args) => runInboxCommand(args, store, { CODEX_THREAD_ID: "successor" }, now);
  assert.equal(successor("list").items.find(item => item.id === notification.wakeId).blocked, null);
  successor("claim", notification.wakeId, "--request-id", "inspect-only");
  successor("ack", notification.wakeId, "--request-id", "verified-effect", "--reason", "Original external receipt verified; no replay");
  assert.equal(store.getTaskWake("task-1", notification.wakeId).status, "dispatched", "inspection cannot fabricate acceptance");
  assert.equal(store.listMessages("task-1")[0].inputControl.expectedSessionId, "leader-native");
  assert.equal(pendingCompletionMessages(store, "task-1").length, 0);
});

for (const roleName of ["worker", "leader"]) test(`${roleName} unsubmitted steer is explicitly consumable and arbitrates against live admission`, t => {
  const { store, task, inbox } = taskFixture(t);
  let run;
  if (roleName === "worker") {
    task(["work", "create", "task-1", "Bounded work", "--role", roleName]);
    task(["work", "dispatch", "task-1/work-item-1"]);
    run = store.getActiveRun("task-1", roleName);
    store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
      { scope: "task", taskId: "task-1", roleName }, "codex", now), {
      agentId: "codex", adapterId: "codex", nativeSessionId: `${roleName}-native`,
      policy: "fixed", status: "active", effective: run.effective
    }, now));
  }
  let binding = createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: `${roleName}-native`, startedAt: now.toISOString() });
  binding = beginProviderTurn(binding, { ...(run ? { runId: run.id } : {}), attemptId: "active",
    authorityEpoch: 1, submittedAt: now.toISOString() });
  binding = acceptProviderTurn(binding, { attemptId: "active", nativeTurnId: "current", acceptedAt: now.toISOString() });
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(store.getTaskRoleSessionSet("task-1", roleName), binding, now));
  const scope = roleName === "worker" ? ["--to", roleName, "--work-item", "work-item-1"] : ["--to", roleName];
  const steer = (request, expected) => task(["message", "steer", "task-1", "Correction", ...scope,
    "--request-id", request, "--expected-target", expected]);
  const claim = request => {
    const id = inbox(roleName, "list").items[0].id;
    return inbox(roleName, "claim", id, "--request-id", request);
  };
  assert.equal(steer("missed", "absent").data.steer.code, "TARGET_CHANGED");
  const old = claim("old");
  inbox(roleName, "ack", old.id, "--request-id", "old-done", "--reason", "Inspected missed correction");
  // Interleave a real claim after persistence, before live-control admission.
  const originalRead = store.getTaskRoleSessionSet.bind(store);
  let interleaved;
  store.getTaskRoleSessionSet = (...args) => {
    const result = originalRead(...args);
    if (!interleaved && store.listMessages("task-1").some(message => message.inputControl?.requestId === "racing")) {
      interleaved = true;
      const claimed = claim("race-winner");
      inbox(roleName, "ack", claimed.id, "--request-id", "race-done", "--reason", "Handled before steer submission");
    }
    return result;
  };
  const racing = steer("racing", "current");
  store.getTaskRoleSessionSet = originalRead;
  assert.equal(racing.kind, "output", "no live steer intent after manual handling won");
  assert.equal(racing.data.steer.code, "TARGET_CHANGED");
  assert.equal(store.listMessages("task-1").at(-1).control, undefined);
  assert.equal(steer("native-wins", "current").kind, "input-steer");
  assert.throws(() => claim("too-late"), /delivery-pending|existing.*delivery owner/);
});

test("Leader interrupt-then cannot reuse a claimed or acknowledged window original", t => {
  const { store, task, inbox } = taskFixture(t);
  task(["message", "queue", "task-1", "Original", "--request-id", "original"]);
  const claimed = inbox("leader", "claim", inbox("leader", "list").items[0].id, "--request-id", "window");
  let binding = createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: "leader-native", startedAt: now.toISOString() });
  binding = beginProviderTurn(binding, { attemptId: "active", authorityEpoch: 1, submittedAt: now.toISOString() });
  binding = acceptProviderTurn(binding, { attemptId: "active", nativeTurnId: "current", acceptedAt: now.toISOString() });
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(store.getTaskRoleSessionSet("task-1", "leader"), binding, now));
  const interrupt = request => task(["role", "interrupt", "task-1", "leader",
    "--expected-target", "current", "--then-message", "task-1/message-1", "--request-id", request]);
  assert.equal(interrupt("claimed").data.interrupt.code, "TARGET_CHANGED");
  inbox("leader", "ack", claimed.id, "--request-id", "done", "--reason", "Handled original");
  assert.equal(interrupt("acknowledged").data.interrupt.code, "TARGET_CHANGED");
  assert.equal(store.listMessages("task-1")[0].interruptThen, undefined);
});

test("Leader claims one fixed window without accepting results, consuming later input, or fabricating native delivery", t => {
  const { store, inbox } = taskFixture(t);
  const target = { kind: "role", taskId: "task-1", roleName: "leader" };
  const message = createTaskMessage("message-1", "task-1", "First user input", "user", { type: "user" }, now);
  store.saveMessage("task-1", message);
  enqueueWork(store, target, "user-message", now, [{ type: "message", taskId: "task-1", id: message.id }]);
  const id = inbox("leader", "list").items[0].id;
  const before = store.getWorkMailbox(target);
  assert.equal(inbox("leader", "show", id).refs[0].id, message.id);
  assert.deepEqual(store.getWorkMailbox(target), before);
  const claimed = inbox("leader", "claim", id, "--request-id", "window");
  assert.deepEqual(inbox("leader", "claim", id, "--request-id", "window"), claimed);
  assert.equal(pendingCompletionMessages(store, "task-1").length, 1);
  assert.equal(new FileSchedulerStoreAdapter(store).claimLeaderNotification("task-1", now), null);
  const next = createTaskMessage("message-2", "task-1", "Later user input", "user", { type: "user" }, now);
  store.saveMessage("task-1", next);
  enqueueWork(store, target, "user-message", now, [{ type: "message", taskId: "task-1", id: next.id }]);
  const beforeFailure = store.getWorkMailbox(target);
  const saveWake = store.saveTaskWake.bind(store);
  store.saveTaskWake = () => { throw new Error("injected receipt persistence failure"); };
  assert.throws(() => inbox("leader", "ack", claimed.id, "--request-id", "done", "--reason",
    "Read the original and implemented the request"), /injected/);
  store.saveTaskWake = saveWake;
  assert.deepEqual(store.getWorkMailbox(target), beforeFailure);
  assert.equal(store.getTaskWake("task-1", claimed.id).inbox.ack, undefined);
  inbox("leader", "ack", claimed.id, "--request-id", "done", "--reason", "Read the original and implemented the request");
  assert.deepEqual(pendingCompletionMessages(store, "task-1").map(m => m.id), [next.id]);
  assert.deepEqual(store.getWorkMailbox(target).pending.refs.map(r => r.id), [next.id]);
  assert.equal(store.getTaskWake("task-1", claimed.id).consumedAt, undefined);
  assert.equal(store.getTask("task-1").status, "active");
  assert.deepEqual(store.listEvents("task-1").filter(e => e.type === "notification.delivery"), []);
  assert.throws(() => inbox("worker", "show", claimed.id), /Assignment|Session/);
  // Winning automatic ownership is just as exclusive, even when rejected/unknown.
  const pending = inbox("leader", "list").items[0].id;
  const automatic = new FileSchedulerStoreAdapter(store).claimLeaderNotification("task-1", now);
  assert.ok(automatic);
  assert.throws(() => inbox("leader", "claim", pending, "--request-id", "too-late"), /changed|earlier/);
  assert.throws(() => inbox("leader", "claim", automatic.wakeId, "--request-id", "steal"), /automatic/);
});

for (const roleName of ["worker", "leader"]) test(`${roleName} own Assignment inbox excludes Task-wide, foreign-role and foreign-Assignment input`, t => {
  const { store, inbox, task, envFor } = taskFixture(t);
  const ownInbox = (...args) => inbox(roleName, ...args);
  task(["work", "create", "task-1", "Bounded work", "--role", roleName]);
  task(["work", "dispatch", "task-1/work-item-1"]);
  const run = store.getActiveRun("task-1", roleName);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName }, "codex", now), {
    agentId: "codex", adapterId: "codex", nativeSessionId: `${roleName}-native`,
    policy: "fixed", status: "active", effective: run.effective
  }, now));
  task(["message", "queue", "task-1", "Worker correction", "--to", roleName,
    "--work-item", "work-item-1", "--request-id", "worker-input"]);
  const id = ownInbox("list").items.find(item => item.kind === "message").id;
  store.saveMessage("task-1", createTaskMessage("message-2", "task-1", "Leader only", "user", { type: "user" }, now));
  assert.throws(() => ownInbox("show", "message-2"), /scope/);
  assert.equal(ownInbox("show", id).body, "Worker correction");
  assert.equal(runInboxCommand(["show", id], store, { CODEX_THREAD_ID: `${roleName}-native` }).body, "Worker correction");
  ownInbox("claim", id, "--request-id", "worker-claim");
  prepareMessageContinuations(store, "task-1", now, roleName);
  assert.equal(store.listRuns("task-1").length, 1);
  ownInbox("ack", id, "--request-id", "worker-done", "--reason", "Applied to the bounded assignment");
  assert.equal(store.getWorkItem("task-1", "work-item-1").status, "open");
  assert.equal(store.getRun("task-1", run.id).status, "active");
  assert.equal(store.listMessages("task-1")[0].continuation.runId, undefined);
  assert.throws(() => runInboxCommand(["show", id], store, { ...envFor(roleName), YUI_TASK_ID: "task-2" }), /exists|current|conflict/);
  assert.throws(() => runInboxCommand(["ack", id, "--request-id", "old", "--reason", "bad"], store,
    { ...envFor(roleName), CODEX_THREAD_ID: "old" }), /Session/);
  task(["message", "queue", "task-1", "Interrupted clarification", "--to", roleName,
    "--work-item", "work-item-1", "--request-id", "interrupted"]);
  const interrupted = ownInbox("list").items.find(item => item.kind === "message").id;
  ownInbox("claim", interrupted, "--request-id", "before-interruption");
  assert.throws(() => task(["message", "handoff", `task-1/${interrupted}`, "--to", roleName]), /stopped|terminal|pending/i);
  const failed = failRun(run, "runtime-failed", "Interrupted while handling", now, {
    providerNamespace: "openai/codex", accountScope: "codex", conversationId: `${roleName}-native`,
    nativeTurnId: "worker-turn", status: "failed"
  });
  store.saveRun(failed);
  store.clearActiveRun("task-1", roleName);
  task(["work", "dispatch", "task-1/work-item-1"]);
  assert.throws(() => ownInbox("show", interrupted), /scope/);
  task(["message", "handoff", `task-1/${interrupted}`, "--to", roleName]);
  const retained = ownInbox("show", interrupted);
  assert.equal(retained.inbox.claim.actor.runId, run.id, "handoff preserves the interrupted handler's audit");
  assert.throws(() => task(["message", "handoff", `task-1/${interrupted}`, "--to", roleName]), /stopped/);
  prepareMessageContinuations(store, "task-1", now, roleName);
  assert.equal(store.listRuns("task-1").length, 2, "handoff does not replay a claimed message");
  ownInbox("ack", interrupted, "--request-id", "after-interruption",
    "--reason", "Read prior handling evidence and finished the clarification");
  assert.equal(ownInbox("show", interrupted).inbox.ack.actor.runId, store.getActiveRun("task-1", roleName).id);
});

for (const scope of ["work-item", "task"]) test(`Reviewer reads only its frozen ${scope} ReviewRound mailbox; handling does not finish the Review`, t => {
  const { store, inbox, task } = taskFixture(t);
  task(["work", "create", "task-1", "Reviewable result"]);
  task(["work", "update", "task-1/work-item-1", "running"]);
  task(["work", "update", "task-1/work-item-1", "done", "--summary", "Evidence"]);
  const candidate = store.getWorkItem("task-1", "work-item-1").candidates.at(-1);
  let round = createReviewRound("review-round-1", "task-1", "work-item-1", candidate.id,
    "reviewer", "leader", "b".repeat(40), now);
  if (scope === "task") {
    store.saveProject(createProject("project-1", "Fixture", join(store.rootDirectory(), "project"),
      { stable: "main", development: "main" }, now));
    store.saveTask({ ...store.getTask("task-1"), projectBindings: [{
      projectId: "project-1", directory: "project", baseRef: "main",
      baseCommit: "b".repeat(40), currentCommit: "b".repeat(40)
    }] });
    round = createTaskReviewRound("review-round-1", "task-1", "reviewer", "leader", {
      schemaVersion: 1, projects: [{ projectId: "project-1", commit: "b".repeat(40) }]
    }, now);
  }
  const workspace = createManagedWorkspace({ owner: { type: "review-round", taskId: "task-1", reviewRoundId: round.id },
    root: join(store.rootDirectory(), "review"), entries: [{
      projectId: "project-1", directory: "project", access: "write",
      path: join(store.rootDirectory(), "review", "project"), branch: "fixture-review",
      baseRef: "b".repeat(40), baseCommit: "b".repeat(40)
    }] }, now);
  const effective = resolveEffectiveLaunch({ role: store.getRole("task-1", "reviewer"),
    purpose: "review", workspace, reviewRoundId: round.id, reviewBaseCommit: round.reviewBaseCommit });
  store.saveManagedWorkspace(workspace);
  const run = createFixtureRun(store, store.nextRunId("task-1"), "task-1", "reviewer", "new",
    { source: { type: "yui", channel: "workitem-dispatch" }, deltaRefIds: [] }, now,
    { purpose: "review", ...(scope === "task" ? {} : { workItemId: "work-item-1" }),
      reviewRoundId: round.id, workspace, effective });
  round = startReviewRound(attachReviewRoundWorkspace(round, workspace), run.id);
  store.saveReviewRound("task-1", round);
  store.saveRun(run);
  store.saveActiveRun(run);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "reviewer" }, "codex", now), {
    agentId: "codex", adapterId: "codex", nativeSessionId: "reviewer-native",
    policy: "fixed", status: "active", effective
  }, now));
  task(["message", "queue", "task-1", "Review clarification", "--to", "reviewer",
    "--review-round", round.id, "--request-id", "review-input"]);
  const id = inbox("reviewer", "list").items[0].id;
  assert.equal(inbox("reviewer", "show", id).body, "Review clarification");
  assert.equal(runInboxCommand(["show", id], store, { CODEX_THREAD_ID: "reviewer-native" }).body, "Review clarification");
  inbox("reviewer", "claim", id, "--request-id", "review-claim");
  if (scope === "task") {
    store.saveTask({ ...store.getTask("task-1"), projectBindings: store.getTask("task-1").projectBindings
      .map(binding => ({ ...binding, currentCommit: "c".repeat(40) })) });
    assert.equal(messageContinuationBlocker(store, store.listMessages("task-1")[0]), "review-candidate-stale",
      "a new continuation still needs a current candidate");
  }
  inbox("reviewer", "ack", id, "--request-id", "review-handled", "--reason", "Included in the review analysis");
  if (scope === "task") {
    task(["message", "queue", "task-1", "Later frozen clarification", "--to", "reviewer",
      "--review-round", round.id, "--request-id", "later-review-input"]);
    const later = store.listMessages("task-1").at(-1).id;
    inbox("reviewer", "claim", later, "--request-id", "later-review-claim");
    const saved = store.getReviewRoundWorkspace("task-1", round.id);
    store.saveManagedWorkspace({ ...saved, entries: saved.entries.map(entry => ({
      ...entry, baseRef: "d".repeat(40), baseCommit: "d".repeat(40)
    })) });
    assert.throws(() => inbox("reviewer", "ack", later, "--request-id", "drift",
      "--reason", "Must not authorize changed workspace"), /review-workspace-drift/);
    store.saveManagedWorkspace(saved);
    inbox("reviewer", "ack", later, "--request-id", "later-review-done", "--reason", "Reviewed frozen clarification");
  }
  assert.equal(store.getReviewRound("task-1", round.id).status, "running");
  assert.equal(store.getWorkItem("task-1", "work-item-1").status, "open");
  store.saveMessage("task-1", createTaskMessage("message-3", "task-1", "Another assignment",
    "system", { type: "system" }, now, { recipient: { roleName: "reviewer",
      ownerRunId: run.id, reviewRoundId: "review-round-2", workItemId: "work-item-1" } }));
  assert.throws(() => inbox("reviewer", "show", "message-3"), /scope/);
});

test("retained claims fence only their Assignment, with explicit retirement preserving original evidence", t => {
  const { store, inbox, task } = taskFixture(t);
  const dispatch = title => {
    task(["work", "create", "task-1", title, "--role", "worker"]);
    const work = store.listWorkItems("task-1").at(-1);
    task(["work", "dispatch", `task-1/${work.id}`]);
    const run = store.getActiveRun("task-1", "worker");
    store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
      { scope: "task", taskId: "task-1", roleName: "worker" }, "codex", now), {
      agentId: "codex", adapterId: "codex", nativeSessionId: "worker-native",
      policy: "fixed", status: "active", effective: run.effective
    }, now));
    task(["message", "queue", "task-1", title, "--to", "worker",
      "--work-item", work.id, "--request-id", work.id]);
    return { run, work, message: store.listMessages("task-1").at(-1) };
  };
  const stop = run => {
    store.saveRun(failRun(run, "runtime-failed", "Exact native terminal", now, {
      providerNamespace: "openai/codex", accountScope: "codex", conversationId: "worker-native",
      nativeTurnId: `turn-${run.id}`, status: "failed"
    }));
    store.clearActiveRun("task-1", "worker");
  };
  const old = dispatch("Old assignment");
  inbox("worker", "claim", old.message.id, "--request-id", "old-claim");
  stop(old.run);
  task(["work", "retire", `task-1/${old.work.id}`, "--summary", "No further implementation"]);
  const next = dispatch("Independent assignment");
  stop(next.run);
  prepareMessageContinuations(store, "task-1", now, "worker");
  assert.equal(store.listMessages("task-1").find(m => m.id === next.message.id).continuation.runId, "run-3");
  assert.throws(() => inbox("worker", "show", old.message.id), /scope/);
  assert.throws(() => inbox("worker", "ack", old.message.id, "--request-id", "foreign",
    "--reason", "Other assignment cannot settle it"), /scope/);
  task(["message", "retire", `task-1/${old.message.id}`, "--reason", "Reviewed original and effects; assignment obsolete"]);
  const retained = store.listMessages("task-1").find(m => m.id === old.message.id);
  assert.equal(retained.body, old.message.body);
  assert.equal(retained.inbox.claim.actor.runId, old.run.id);
  assert.equal(retained.inbox.ack, undefined, "retirement is not fabricated Agent acknowledgement");
  const continuation = store.getActiveRun("task-1", "worker");
  inbox("worker", "claim", next.message.id, "--request-id", "received-continuation");
  inbox("worker", "ack", next.message.id, "--request-id", "handled-continuation",
    "--reason", "Inspected and handled the automatically dispatched continuation");
  task(["message", "queue", "task-1", "Interrupted current handling", "--to", "worker",
    "--work-item", next.work.id, "--request-id", "current-claim"]);
  const current = store.listMessages("task-1").at(-1);
  inbox("worker", "claim", current.id, "--request-id", "current");
  task(["message", "queue", "task-1", "Later same-assignment input", "--to", "worker",
    "--work-item", next.work.id, "--request-id", "later"]);
  const later = store.listMessages("task-1").at(-1);
  stop(continuation);
  prepareMessageContinuations(store, "task-1", now, "worker");
  assert.equal(store.getActiveRun("task-1", "worker"), null, "unfinished claim still fences its own Assignment");
  task(["message", "retire", `task-1/${current.id}`, "--reason", "Original and effects inspected; no action remains"]);
  prepareMessageContinuations(store, "task-1", now, "worker");
  assert.equal(store.listMessages("task-1").find(m => m.id === later.id).continuation.runId, "run-4");
  assert.equal(store.listMessages("task-1").find(m => m.id === current.id).continuation.runId, undefined,
    "explicit retirement unblocks later input without replaying the retired claim");
});
