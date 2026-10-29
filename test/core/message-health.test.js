import assert from "node:assert/strict";
import test from "node:test";
import { classifyMessageHealth, reconcileMessageHealth } from "../../dist/controller/messageHealth.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createTask } from "../../dist/task/task.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { claimPending, completeProcessing } from "../../dist/coordination/workMailbox.js";
import { createTaskWake } from "../../dist/scheduler/taskWake.js";
import { createInputRequest, answerInputRequest } from "../../dist/input/inputRequest.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createTaskMessage, createGlobalRoleMessage, markGlobalRoleMessageNotDelivered, markGlobalRoleMessageDelivered } from "../../dist/message/message.js";
import { createRoleSessionSet, recordRoleAgentSession, bindTaskRoleProviderRuntime, bindGlobalRoleProviderRuntime } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createProviderRuntimeBinding, beginProviderTurn, acceptProviderTurn } from "../../dist/runtime/providerRuntimeIdentity.js";
import { recordProviderFailure } from "../../dist/runtime/providerRetry.js";

const start = new Date("2026-10-29T00:00:00Z");
const at = minutes => new Date(+start + minutes * 60_000);
const target = { kind: "role", taskId: "task-1", roleName: "leader" };

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-message-health-"));
  let store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], start);
  store.saveConfiguredAgent(agent);
  const bindings = [createRoleAgentBinding(agent)];
  store.saveTask({ ...createTask("task-1", "Health", start), status: "active" });
  store.saveRole("task-1", createRole("task-1", "leader", bindings, "codex", home, start));
  return {
    get store() { return store; },
    operator(active = true) {
      const role = createGlobalRole("operator", bindings, "codex", home, start);
      store.createGlobalRoleIfAbsent(role);
      if (!active) return;
      const set = recordRoleAgentSession(createRoleSessionSet({ scope: "global", roleName: "operator" }, "codex", start),
        { agentId: "codex", adapterId: "codex", nativeSessionId: "operator-native", policy: "fixed", status: "active",
          effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, start);
      store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(set, createProviderRuntimeBinding({
        providerNamespace: "openai/codex", accountScope: "codex", conversationId: "operator-native",
        startedAt: start.toISOString() }), start));
    },
    global(name) { store.createGlobalRoleIfAbsent(createGlobalRole(name, bindings, "codex", home, start)); },
    accepted() {
      const role = store.getRole("task-1", "leader");
      const set = recordRoleAgentSession(createRoleSessionSet({ scope: "task", taskId: "task-1",
        roleName: "leader" }, "codex", start), { agentId: "codex", adapterId: "codex",
        nativeSessionId: "leader-native", policy: "fixed", status: "active",
        effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, start);
      let binding = beginProviderTurn(createProviderRuntimeBinding({ providerNamespace: "openai/codex",
        accountScope: "codex", conversationId: "leader-native", startedAt: start.toISOString() }),
      { attemptId: "long-turn", authorityEpoch: 1, submittedAt: start.toISOString() });
      binding = acceptProviderTurn(binding, { attemptId: "long-turn", nativeTurnId: "turn-1",
        acceptedAt: start.toISOString() });
      store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(set, binding, start));
    },
    reopen() { store.close(); store = new SqliteTaskStore(home); },
    observe(minutes) { return reconcileMessageHealth(store, at(minutes)); },
    facts() { return store.listEventsByType("task-1", ["message.health.leader"]); },
    notices() { return store.listGlobalRoleMessages("operator").filter(m => m.inputControl); }
  };
}

const now = new Date("2026-10-29T01:00:00Z");
const old = "2026-10-29T00:00:00Z";
const queued = { count: 1, oldestAt: old, processingAt: old, blocked: false, stopped: false };

test("message health distinguishes a slow accepted writer from retained uncertainty and an idle single input", () => {
  assert.equal(classifyMessageHealth({ ...queued, turnStatus: "accepted" }, now).state, "busy");
  assert.equal(classifyMessageHealth({ ...queued, turnStatus: "rejected", blocked: true }, now).state, "critical");
  assert.equal(classifyMessageHealth({ ...queued, turnStatus: "delivery-unknown" }, now).state, "critical");
  assert.equal(classifyMessageHealth({ ...queued, turnStatus: "completed" }, now).state, "critical");
  assert.equal(classifyMessageHealth({ ...queued, stopped: true }, now).state, "paused");
  assert.equal(classifyMessageHealth({ ...queued, retryDeadline: "2026-10-29T02:00:00Z" }, now).state, "recovering");
  assert.equal(classifyMessageHealth({ ...queued, retryDeadline: old }, now).state, "critical");
  assert.equal(classifyMessageHealth({ ...queued, count: 0, processingAt: null }, now).state, "clear");
  assert.equal(classifyMessageHealth({ ...queued, oldestAt: "2026-10-29T00:56:00Z", processingAt: null }, now).state, "waiting");
});

test("retained unknown then rejected wake alerts outside its queue; restart, growth and recovery never mutate business input", t => {
  const f = fixture(t);
  const wake = createTaskWake({ id: "wake-1", taskId: "task-1", reasons: ["input"],
    fromCursor: start.toISOString(), toCursor: start.toISOString(), now: start });
  f.store.saveTaskWake("task-1", wake);
  const pending = enqueueWork(f.store, target, "input", start, [{ type: "message", taskId: "task-1", id: "message-1" }]);
  f.store.saveWorkMailbox(claimPending(pending, { batchId: "attempt-1", owner: "leader-notification:wake-1",
    startedAt: start.toISOString() }));
  for (const outcome of ["unknown", "rejected"]) f.store.saveEvent("task-1",
    createTaskEvent(f.store.nextEventId("task-1"), "task-1", "notification.delivery",
      { attemptId: "attempt-1", outcome }, start));
  const input = answerInputRequest(createInputRequest("input-1", "task-1",
    { taskId: "task-1", roleName: "leader", agentId: "codex", nativeSessionId: "leader-native" },
    { question: "Decision", choices: [], blockedRefs: [] }, start), { text: "Continue" }, "operator", at(1));
  f.store.saveInputRequest("task-1", input);
  enqueueWork(f.store, target, "input-answered:input-1", at(1), [{ type: "input", taskId: "task-1", id: "input-1" }]);
  const original = f.store.getWorkMailbox(target);
  assert.equal(f.observe(4).items[0].state, "waiting");
  let result = f.observe(5).items[0];
  assert.equal(result.state, "warning");
  assert.deepEqual(result.answeredInputs, ["task-1/input-1"]);
  assert.equal(result.batchId, "attempt-1");
  assert.equal(result.alert.reason, "operator-unconfigured");
  assert.match(result.recovery, /wake retry task-1 wake-1/);
  assert.doesNotMatch(result.recovery, /wake resolve task-1 wake-1/);
  assert.equal(f.facts().length, 1);
  f.reopen();
  f.operator(false);
  assert.equal(f.observe(6).items[0].alert.reason, "operator-unavailable");
  assert.equal(f.notices().length, 0, "Diagnostics cannot implicitly start an unavailable Operator.");
  f.operator();
  result = f.observe(6).items[0];
  assert.equal(result.alert.stage, "saved", "The retained evidence queues once the Operator is available.");
  assert.equal(f.notices().length, 1);
  assert.match(f.notices()[0].body, /wake retry task-1 wake-1/);
  assert.match(f.notices()[0].body, /Operator/);
  assert.deepEqual(f.store.getWorkMailbox(target), original, "Monitoring never releases the retained claim or pending suffix.");
  for (let i = 0; i < 10; i++) enqueueWork(f.store, target, `arrival-${i}`, at(7));
  f.observe(15);
  assert.equal(JSON.parse(f.facts()[1].payload.evidence).phase, "critical");
  assert.equal(f.notices().length, 1, "Busy Operator coalesces escalation behind the one unsent notice.");
  f.reopen();
  f.observe(40);
  assert.equal(f.facts().length, 2, "One bounded escalation, no repeated effects after restart.");
  const firstNotice = f.notices()[0];
  f.store.updateGlobalRoleMessage(markGlobalRoleMessageNotDelivered(firstNotice, "host-unavailable", at(40)));
  f.observe(41);
  assert.equal(f.notices().length, 2);
  assert.equal(f.notices()[0].notDelivered.reason, "host-unavailable", "Failed notice remains inspectable; never replayed.");
  // Explicit fixture-owned recovery, not the monitor: settle only old processing.
  const current = f.store.getWorkMailbox(target);
  f.store.saveWorkMailbox(completeProcessing(current, "attempt-1"));
  f.observe(42);
  assert.equal(f.facts().length, 2, "Releasing the old claim alone is not queue recovery.");
  f.store.saveWorkMailbox({ ...f.store.getWorkMailbox(target), pending: null });
  result = f.observe(43).items.find(item => item.target.taskId === "task-1");
  assert.equal(result.state, "clear");
  assert.doesNotMatch(result.recovery, /session stop|session new|wake retry|wake resolve/);
  assert.equal(JSON.parse(f.facts()[2].payload.evidence).phase, "recovered");
  assert.deepEqual(f.store.getTaskWake("task-1", "wake-1"), wake, "No fabricated delivery or ACK.");
  assert.deepEqual(f.store.getInputRequest("task-1", "input-1"), input);
  f.reopen();
  f.observe(44);
  assert.equal(f.facts().length, 3);
});

test("exact Host evidence distinguishes idle-but-owned from a long accepted Turn; pause and missing ACK are not recovery", t => {
  const f = fixture(t);
  f.accepted();
  const pending = enqueueWork(f.store, target, "queued-result", start);
  assert.equal(f.observe(120).items[0].state, "busy");
  assert.equal(f.facts().length, 0);
  const host = { taskId: "task-1", roleName: "leader", nativeSessionId: "leader-native",
    attemptId: "old-attempt", state: "idle", reconciliation: "unavailable",
    outcome: "rejected", observedAt: at(120).toISOString() };
  assert.equal(reconcileMessageHealth(f.store, at(120), [host]).items[0].state, "busy",
    "Evidence from another attempt cannot condemn the current Turn.");
  assert.equal(reconcileMessageHealth(f.store, at(120), [{ ...host, attemptId: "long-turn" }]).items[0].state,
    "critical");
  f.store.saveRole("task-1", { ...f.store.getRole("task-1", "leader"), enabled: false });
  const paused = f.observe(121).items[0];
  assert.equal(paused.state, "paused");
  assert.doesNotMatch(paused.recovery, /session stop|session new|wake retry|wake resolve/);
  assert.equal(f.facts().length, 1, "An intentional pause is not a recovery observation.");
  assert.deepEqual(f.store.getWorkMailbox(target), pending);
  f.store.saveRole("task-1", { ...f.store.getRole("task-1", "leader"), enabled: true });
  const set = f.store.getTaskRoleSessionSet("task-1", "leader");
  const failed = { ...set.providerBinding, run: { ...set.providerBinding.run, status: "failed",
    retrySupported: true, input: { kind: "wake", taskId: "task-1", wakeId: "wake-1" } } };
  const binding = recordProviderFailure(failed, { at: +at(121), random: () => 0, failureRef: "failed-host",
    error: { source: "provider", phase: "turn-execute", category: "availability", code: "provider.model-capacity",
      message: "Capacity", raw: "fixture-capacity", inputDisposition: "accepted", sessionDisposition: "recoverable", retryable: true } });
  f.store.saveTaskRoleSessionSet({ ...set, providerBinding: binding });
  const recovering = f.observe(122).items[0];
  assert.equal(recovering.state, "recovering");
  assert.match(recovering.recovery, /bounded retry owns recovery/);
  assert.doesNotMatch(recovering.recovery, /session stop|session new|wake retry|wake resolve/);
});

test("pending transferred to a new deferred processing owner is not recovery even with an idle completed Turn", t => {
  const f = fixture(t);
  f.operator();
  f.accepted();
  const set = f.store.getTaskRoleSessionSet("task-1", "leader");
  f.store.saveTaskRoleSessionSet({ ...set, providerBinding: { ...set.providerBinding,
    run: { ...set.providerBinding.run, status: "completed", updatedAt: at(1).toISOString() } } });
  const pending = enqueueWork(f.store, target, "original-input", start);
  f.store.saveWorkMailbox(claimPending(pending, { batchId: "original-attempt",
    owner: "leader-notification:wake-1", startedAt: start.toISOString() }));
  assert.equal(f.observe(5).items[0].state, "warning");
  // The explicit recovery path changes ownership, but still has no accepted delivery.
  f.store.saveWorkMailbox(completeProcessing(f.store.getWorkMailbox(target), "original-attempt"));
  const retry = enqueueWork(f.store, target, "explicit-retry", at(6));
  f.store.saveWorkMailbox(claimPending(retry, { batchId: "retry-attempt",
    owner: "leader-notification:wake-2", startedAt: at(6).toISOString() }));
  const detail = "Agent Host still owns an unsettled Provider Turn";
  f.store.saveEvent("task-1", createTaskEvent(f.store.nextEventId("task-1"), "task-1",
    "notification.delivery", { attemptId: "retry-attempt", outcome: "deferred", detail }, at(6)));
  const retained = f.store.getWorkMailbox(target);
  f.reopen();
  const result = f.observe(12).items[0];
  assert.equal(result.pendingCount, 0);
  assert.equal(result.processingCount, 1);
  assert.equal(result.wakeId, "wake-2");
  assert.equal(result.batchId, "retry-attempt");
  assert.equal(result.turnStatus, "completed");
  assert.equal(result.state, "warning");
  assert.equal(result.deliveryEvidence.outcome, "deferred");
  assert.equal(result.deliveryEvidence.detail, detail);
  assert.match(result.recovery, /task role session stop task-1 leader/);
  assert.doesNotMatch(result.recovery, /wake (retry|resolve) task-1 wake-2/);
  assert.match(result.recovery, /physical stop/);
  assert.match(result.recovery, /not.*Goal/);
  assert.equal(f.facts().length, 1, "Changing processing owner must not recover or duplicate the open incident.");
  assert.deepEqual(f.store.getWorkMailbox(target), retained);
});

test("unknown guidance preserves uncertainty; delayed notice uses current busy state instead of old intervention", t => {
  const f = fixture(t);
  const pending = enqueueWork(f.store, target, "unknown-input", start);
  f.store.saveWorkMailbox(claimPending(pending, { batchId: "unknown-attempt",
    owner: "leader-notification:wake-1", startedAt: start.toISOString() }));
  f.store.saveEvent("task-1", createTaskEvent(f.store.nextEventId("task-1"), "task-1",
    "notification.delivery", { attemptId: "unknown-attempt", outcome: "unknown" }, start));
  const warning = f.observe(5).items[0];
  assert.match(warning.recovery, /wake resolve task-1 wake-1/);
  assert.match(warning.recovery, /quiescence/);
  assert.doesNotMatch(warning.recovery, /wake retry/);
  f.accepted();
  f.operator();
  const busy = f.observe(6).items[0];
  assert.equal(busy.state, "busy");
  const notice = f.notices()[0];
  assert.match(notice.body, /Current state: busy/);
  assert.match(notice.body, /2026-10-29T00:06:00.000Z/);
  assert.doesNotMatch(notice.body, /wake resolve|session stop|session new/);
  f.reopen();
  f.observe(7);
  assert.equal(f.notices().length, 1, "Fresh guidance does not create another notification protocol.");
});

test("historical handling alone does not alert; a pending suffix behind an idle claim is observable", t => {
  const f = fixture(t);
  const pending = enqueueWork(f.store, target, "already-handled", start);
  f.store.saveWorkMailbox(claimPending(pending, { batchId: "old-claim", owner: "agent-inbox:wake-1",
    startedAt: start.toISOString() }));
  assert.equal(f.observe(120).items.length, 0);
  assert.equal(f.facts().length, 0);
  enqueueWork(f.store, target, "new-input", at(121));
  assert.equal(f.observe(127).items[0].state, "critical");
  assert.equal(f.store.getWorkMailbox(target).processing.batchId, "old-claim");
});

test("Assignment continuations expose blocked input without counting an already dispatched continuation", t => {
  const f = fixture(t);
  const leader = f.store.getRole("task-1", "leader");
  f.store.saveRole("task-1", { ...leader, name: "worker" });
  const message = createTaskMessage("message-1", "task-1", "Continue original work", "operator",
    { type: "operator" }, start, {
      recipient: { roleName: "worker", ownerRunId: "run-1", workItemId: "work-item-1" }
    });
  f.store.saveMessage("task-1", message);
  f.store.saveMessage("task-1", { ...message, id: "message-2", continuation: { runId: "run-2" } });
  let observed = f.observe(6).items.find(item => item.target.roleName === "worker");
  assert.equal(observed.count, 1);
  assert.equal(observed.state, "warning");
  assert.equal(observed.refs[0].messageId, "message-1");
  assert.match(observed.recovery, /authorized Task Leader, or Operator/);
  assert.match(observed.recovery, /not established/);
  assert.doesNotMatch(observed.recovery, /yui task role session stop/);
  const request = createInputRequest("input-1", "task-1",
    { taskId: "task-1", roleName: "leader", agentId: "codex", nativeSessionId: "leader-native" },
    { question: "Required decision", choices: [], blockedRefs: [
      { type: "work-item", taskId: "task-1", id: "work-item-1" }
    ] }, at(6));
  f.store.saveInputRequest("task-1", request);
  observed = f.observe(7).items.find(item => item.target.roleName === "worker");
  assert.equal(observed.state, "paused");
  assert.deepEqual(observed.waitingInputs, ["input-1"]);
  assert.equal(observed.incident.phase, "warning", "A legitimate decision wait is not delivery recovery.");
});

test("Global failed input is retained and alerts once; delivery evidence is separate from handling and monitor notices cannot recurse", t => {
  const f = fixture(t);
  f.operator();
  f.global("assistant");
  f.store.saveGlobalRoleMessage(createGlobalRoleMessage(f.store.nextGlobalRoleMessageId(), "assistant",
    "Yui message health v1\nassistant\nnot-json", "user", { type: "user" }, start));
  let message = createGlobalRoleMessage(f.store.nextGlobalRoleMessageId(), "assistant", "Original", "user",
    { type: "user" }, start, { inputControl: { action: "queue", requestId: "original" } });
  f.store.saveGlobalRoleMessage(message);
  message = markGlobalRoleMessageNotDelivered(message, "delivery-rejected", at(1));
  f.store.updateGlobalRoleMessage(message);
  let observed = f.observe(5);
  assert.equal(observed.items.find(i => i.target.roleName === "assistant").state, "warning");
  assert.match(observed.items.find(i => i.target.roleName === "assistant").recovery, /No per-GlobalRole Host-stop command/);
  assert.doesNotMatch(f.notices()[0].body, /yui task role session stop|yui session stop/);
  assert.equal(f.notices().length, 1);
  f.reopen();
  f.observe(6);
  assert.equal(f.notices().length, 1);
  const notice = f.notices()[0];
  f.store.updateGlobalRoleMessage(markGlobalRoleMessageDelivered(notice, at(6)));
  observed = f.observe(7);
  assert.equal(observed.items.find(i => i.target.roleName === "assistant").alert.stage, "delivered");
  assert.equal(observed.items.some(i => i.target.roleName === "operator"), false, "Monitor output never creates a self-alert loop.");
  assert.equal(f.store.queryGlobalRoleMessages("assistant", { id: message.id, limit: 1 }).messages[0].notDelivered.reason,
    "delivery-rejected");
  const actor = { scope: "global", roleName: "operator", agentId: "codex", nativeSessionId: "operator-native" };
  const delivered = f.store.queryGlobalRoleMessages("operator", { id: notice.id, limit: 1 }).messages[0];
  f.store.updateGlobalRoleMessage({ ...delivered, inbox: {
    claim: { requestId: "inspect-alert", actor, at: at(7).toISOString() },
    ack: { requestId: "read-alert", actor, at: at(7).toISOString(), reason: "Investigated; original remains blocked" }
  } });
  observed = f.observe(8).items.find(i => i.target.roleName === "assistant");
  assert.equal(observed.alert.stage, "handled");
  assert.equal(observed.state, "warning", "Reading an alert never closes the source anomaly.");
  f.store.updateGlobalRoleMessage({ ...message, inbox: { claim: { requestId: "inspect-original",
    actor: { ...actor, roleName: "assistant", nativeSessionId: "assistant-native" }, at: at(8).toISOString() } } });
  observed = f.observe(9).items.find(i => i.target.roleName === "assistant");
  assert.equal(observed.state, "busy");
  assert.equal(observed.incident.phase, "warning", "Claiming original input is not delivery or recovery.");
});
