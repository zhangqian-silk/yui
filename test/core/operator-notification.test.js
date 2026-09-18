import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  bindGlobalRoleProviderRuntime, createRoleSessionSet, recordRoleAgentSession,
  updateRoleAgentSessionStatus
} from "../../dist/executor/agentExecutor.js";
import { createProviderRuntimeBinding } from "../../dist/runtime/providerRuntimeIdentity.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { queueOperatorNotification } from "../../dist/controller/operatorNotification.js";
import { processOperatorInputNotifications } from "../../dist/scheduler/operatorInputNotificationProcessor.js";
import { createTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { enqueueOperatorEvent } from "../../dist/scheduler/operatorEvent.js";
import { markGlobalRoleMessageNotDelivered } from "../../dist/message/message.js";
import { createOperatorBatchPresentation } from "../../dist/interaction/operatorPresentation.js";
import { createRuntimeObservation } from "../../dist/runtime/runtimeObservation.js";
import { deliverGlobalInputs } from "../../dist/controller/globalInputDelivery.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";
import { AGENT_HOST_CONTROL_PROTOCOL, openAgentHostControl } from "../../dist/runtime/agentHost.js";
import { FileTaskController } from "../../dist/controller/controller.js";
import { createInputRequest } from "../../dist/input/inputRequest.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";

const now = new Date("2026-09-18T00:00:00Z");

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-operator-notification-"));
  let store = new SqliteTaskStore(home);
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  const role = createGlobalRole("operator", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.createGlobalRoleIfAbsent(role);
  const sessions = recordRoleAgentSession(createRoleSessionSet(
    { scope: "global", roleName: role.name }, role.activeAgentId, now
  ), {
    agentId: agent.id, adapterId: "codex", nativeSessionId: "operator-native",
    policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  }, now);
  store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(sessions,
    createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
      conversationId: "operator-native", startedAt: now.toISOString() }), now));
  store.saveTask(createTask("task-1", "Notification sources", now));
  let sequence = 0;
  const f = {
    home, cleanup,
    get store() { return store; },
    reopen() { store.close(); store = new SqliteTaskStore(home); },
    user(body) {
      const result = runGlobalRoleCommand(["message", "queue", "operator", body,
        "--request-id", body], store, { env: {}, jsonOutput: true });
      return (typeof result === "string" ? JSON.parse(result) : result).message;
    },
    observe(kind) {
      const sessions = store.getGlobalRoleSessionSet("operator");
      const run = sessions.providerBinding.run;
      const eventId = `provider-${++sequence}`;
      assert.equal(new FileSchedulerStoreAdapter(store).observeRuntimeObservation(createRuntimeObservation({
        schemaVersion: 4, eventId, semanticKey: eventId, kind, authority: "provider-structured",
        receivedAt: now.toISOString(), observedAt: now.toISOString(),
        payload: kind === "turn.completed" ? { output: "Fixture complete" } : {},
        fence: { roleName: "operator", agentId: "codex", driverId: "openai/codex",
          nativeSessionId: sessions.sessions.codex.nativeSessionId,
          conversationId: sessions.sessions.codex.nativeSessionId,
          nativeTurnId: run.nativeTurnId ?? `turn-${run.attemptId}`, receiptId: run.attemptId }
      }), now), "applied");
    },
    deliver() {
      return deliverGlobalInputs(home, store, async () => {}, error => { throw error; });
    },
    async provider() {
      const attempts = [];
      let outcome = "accepted";
      const snapshot = state => ({ schemaVersion: 2, state, updatedAt: now.toISOString() });
      let host;
      cleanup.push(async () => { await host?.close(); });
      host = await openAgentHostControl(home, {
        environment: { YUI_SESSION_SCOPE: "global", YUI_ROLE: "operator" }
      }, () => snapshot("ready"), async control => {
        assert.equal(control.type, "submit-turn");
        attempts.push(control.run.attemptId);
        const adapter = new FileSchedulerStoreAdapter(store);
        adapter.beginAgentHostProviderTurn({ roleName: "operator", agentId: "codex",
          nativeSessionId: control.nativeSessionId, attemptId: control.run.attemptId,
          authorityEpoch: control.authority.epoch, authorityOwner: control.authority.owner,
          holderId: control.authority.holderId, now });
        if (outcome === "accepted") f.observe("turn.accepted");
        else adapter.resolveAgentHostProviderTurnSubmission({ roleName: "operator",
          attemptId: control.run.attemptId, status: outcome, reason: `fixture-${outcome}`,
          raw: `fixture-${outcome}`, now });
        return { protocol: AGENT_HOST_CONTROL_PROTOCOL,
          outcome: outcome === "accepted" ? "accepted" : "rejected",
          snapshot: snapshot(outcome === "accepted" ? "busy" : outcome) };
      });
      return { attempts, set outcome(value) { outcome = value; } };
    },
    enqueue() {
      const event = createTaskEvent(store.nextEventId("task-1"), "task-1", "task.completed",
        { summary: "Source fact only" }, now);
      store.saveEvent("task-1", event);
      enqueueOperatorEvent(store, event, "task-terminal", now);
      return event;
    },
    process() {
      return processOperatorInputNotifications(new FileSchedulerStoreAdapter(store), undefined, now);
    }
  };
  return f;
}

test("Operator notices hand off once without overlapping new events before Provider acceptance", async t => {
  const f = fixture(t);
  const first = f.enqueue();
  const queued = await f.process();
  assert.equal(queued[0].status, "queued");
  f.reopen();
  const second = f.enqueue();
  const input = createInputRequest("input-1", "task-1",
    { taskId: "task-1", roleName: "leader", agentId: "codex", nativeSessionId: "leader-native" },
    { question: "Keep this authorization request open", choices: [], blockedRefs: [] }, now);
  f.store.saveInputRequest("task-1", input);
  enqueueWork(f.store, { kind: "operator" }, "input-request", now,
    [{ type: "input", taskId: "task-1", id: input.id }]);
  await f.process();
  const messages = f.store.listGlobalRoleMessages("operator");
  assert.equal(messages.length, 2);
  assert.match(messages[0].body, new RegExp(`task-1/${first.id}\\b`));
  assert.doesNotMatch(messages[1].body, new RegExp(`task-1/${first.id}\\b`));
  assert.match(messages[1].body, new RegExp(`task-1/${second.id}\\b`));
  assert.match(messages[1].body, /yui task input show task-1\/input-1/u);
  assert.deepEqual(f.store.getInputRequest("task-1", input.id), input, "Queuing attention cannot answer or cancel an authorization request.");
  assert.ok(messages.every(message => message.delivery === undefined));
  assert.equal(f.store.getWorkMailbox({ kind: "operator" }).pending, null);
});

test("Operator handoff rolls back both writes and preserves a newer pending suffix across reopen", async t => {
  const f = fixture(t);
  const first = f.enqueue();
  const adapter = new FileSchedulerStoreAdapter(f.store);
  const batchId = "operator:1-1";
  adapter.claimWorkMailbox({ target: { kind: "operator" }, batchId, owner: "controller", now });
  const second = f.enqueue();
  const input = { batchId, ...createOperatorBatchPresentation(batchId, [{ kind: "task-event", event: first }]) };
  const save = f.store.saveWorkMailbox;
  f.store.saveWorkMailbox = function(mailbox) {
    if (mailbox.processing === null) throw new Error("injected failure after Global Message save");
    return save.call(this, mailbox);
  };
  assert.throws(() => queueOperatorNotification(f.store, input, now), /injected failure/);
  f.store.saveWorkMailbox = save;
  assert.equal(f.store.listGlobalRoleMessages("operator").length, 0);
  assert.equal(f.store.getWorkMailbox({ kind: "operator" }).processing.batchId, batchId);
  f.reopen();
  const result = await f.process();
  assert.equal(result[0].status, "queued");
  assert.deepEqual(f.store.getWorkMailbox({ kind: "operator" }).pending.refs,
    [{ type: "event", taskId: "task-1", id: second.id }]);
  const replay = queueOperatorNotification(f.store, input, now);
  assert.deepEqual(replay, { status: "already-queued", messageId: result[0].messageId });
  assert.deepEqual(f.store.getWorkMailbox({ kind: "operator" }).pending.refs,
    [{ type: "event", taskId: "task-1", id: second.id }], "Old receipt cannot consume a later batch.");
  await f.process();
  const messages = f.store.listGlobalRoleMessages("operator");
  assert.equal(messages.length, 2);
  assert.doesNotMatch(messages[1].body, new RegExp(`task-1/${first.id}\\b`));
});

test("unavailable Operator retains attention; definitively undelivered notices retain evidence without replay", async t => {
  const f = fixture(t);
  const active = f.store.getGlobalRoleSessionSet("operator");
  f.store.saveGlobalRoleSessionSet(updateRoleAgentSessionStatus(active, "codex", "ended", now, "stopped"));
  f.enqueue();
  assert.equal((await f.process())[0].reason, "operator-unavailable");
  assert.equal(f.store.listGlobalRoleMessages("operator").length, 0);
  assert.notEqual(f.store.getWorkMailbox({ kind: "operator" }).pending, null);
  f.store.saveGlobalRoleSessionSet(active);
  await f.process();
  const message = f.store.listGlobalRoleMessages("operator")[0];
  const notDelivered = markGlobalRoleMessageNotDelivered(message, "native-session-changed", now);
  f.store.updateGlobalRoleMessage(notDelivered);
  f.reopen();
  await f.process();
  assert.deepEqual(queueOperatorNotification(f.store, {
    batchId: "operator:1-1", receiptId: "operator-batch:operator:1-1", text: message.body
  }, now), { status: "already-queued", messageId: message.id });
  assert.deepEqual(f.store.listGlobalRoleMessages("operator")[0], notDelivered);
  assert.equal(f.store.listGlobalRoleMessages("operator").length, 1, "Never replay under another key.");
  assert.equal(f.store.getWorkMailbox({ kind: "operator" }).pending, null);
});

test("Global delivery keeps busy and unknown notices fenced, then advances to original user input after exact settlement", async t => {
  const f = fixture(t);
  const provider = await f.provider();
  const user = f.user("Original user input");
  await f.deliver();
  f.enqueue();
  await f.process();
  f.enqueue();
  await f.process();
  const laterUser = f.user("Later user input");
  const messages = f.store.listGlobalRoleMessages("operator");
  assert.equal(messages.length, 4);
  await f.deliver();
  assert.deepEqual(provider.attempts, [`global-input:operator/${user.id}`]);
  f.observe("turn.completed");
  provider.outcome = "delivery-unknown";
  await f.deliver();
  const originalUnknown = f.store.listGlobalRoleMessages("operator")[1];
  assert.equal(originalUnknown.control.outcome, "delivery-unknown");
  f.reopen();
  await f.deliver();
  assert.equal(provider.attempts.length, 2);
  assert.deepEqual(f.store.listGlobalRoleMessages("operator")[1], originalUnknown);
  assert.deepEqual(await f.process(), []);
  f.observe("turn.accepted");
  f.observe("turn.completed");
  provider.outcome = "rejected";
  await f.deliver();
  const rejected = f.store.listGlobalRoleMessages("operator")[2];
  assert.equal(rejected.notDelivered.reason, "fixture-rejected");
  f.reopen();
  provider.outcome = "accepted";
  await f.deliver();
  assert.deepEqual(provider.attempts, messages.map(message => `global-input:operator/${message.id}`));
  assert.equal(f.store.listGlobalRoleMessages("operator").find(m => m.id === laterUser.id).body, laterUser.body);
  assert.equal(f.store.listGlobalRoleMessages("operator").find(m => m.id === laterUser.id).delivery.via, "provider");
  assert.deepEqual(await f.process(), [], "Neither rejection nor acceptance recreates source attention.");
  f.observe("turn.completed");
});

test("one Global pass exposes stale unsent notices and reaches the successor's user input", async t => {
  const f = fixture(t);
  const provider = await f.provider();
  f.enqueue();
  await f.process();
  f.enqueue();
  await f.process();
  const messages = f.store.listGlobalRoleMessages("operator");
  const sessions = f.store.getGlobalRoleSessionSet("operator");
  f.store.saveGlobalRoleSessionSet({ ...sessions,
    sessions: { ...sessions.sessions, codex: { ...sessions.sessions.codex, nativeSessionId: "successor-native" } },
    providerBinding: createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
      conversationId: "successor-native", startedAt: now.toISOString() })
  });
  const user = f.user("Successor user input");
  await f.deliver();
  assert.deepEqual(provider.attempts, [`global-input:operator/${user.id}`]);
  const preserved = f.store.listGlobalRoleMessages("operator").slice(0, 2);
  assert.ok(preserved.every(message => message.notDelivered.reason === "native-session-changed"));
  assert.deepEqual(preserved.map(message => message.body), messages.map(message => message.body));
  f.observe("turn.completed");
});

test("a stale target does not let successor input bypass an uncertain original Message", async t => {
  const f = fixture(t);
  f.enqueue();
  await f.process();
  const message = f.store.listGlobalRoleMessages("operator")[0];
  const unknown = { ...message, control: { requestId: message.inputControl.requestId,
    receiptId: `global-input:operator/${message.id}`, outcome: "delivery-unknown", observedAt: now.toISOString() } };
  f.store.updateGlobalRoleMessage(unknown);
  const sessions = f.store.getGlobalRoleSessionSet("operator");
  f.store.saveGlobalRoleSessionSet({ ...sessions,
    sessions: { ...sessions.sessions, codex: { ...sessions.sessions.codex, nativeSessionId: "successor-native" } },
    providerBinding: createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
      conversationId: "successor-native", startedAt: now.toISOString() })
  });
  f.user("Do not infer permission to bypass unknown input");
  let ensured = false;
  await deliverGlobalInputs(f.home, f.store, async () => { ensured = true; }, error => { throw error; });
  assert.equal(ensured, false);
  assert.deepEqual(f.store.listGlobalRoleMessages("operator")[0], unknown);
});

test("Controller handoff signals the existing Global queue without waiting for a full reconciliation", async t => {
  const f = fixture(t);
  const provider = await f.provider();
  const errors = [];
  let delivered;
  const nextDelivery = new Promise(resolve => { delivered = resolve; });
  const controller = new FileTaskController(new FileSchedulerStoreAdapter(f.store), {}, {
    signalWindowMs: 1, now: () => now, onError: error => errors.push(error),
    globalInputDelivery: async () => {
      await f.deliver();
      if (provider.attempts.length > 0) delivered();
    }
  });
  f.cleanup.push(() => controller.shutdownAndDrain());
  f.enqueue();
  controller.signal("operator");
  // Keep this one timer referenced: the production scheduler's timers are unref'ed.
  const timeout = setTimeout(() => delivered(), 2000);
  try { await nextDelivery; } finally { clearTimeout(timeout); }
  assert.deepEqual(errors, []);
  assert.equal(provider.attempts.length, 1);
  assert.equal(f.store.getWorkMailbox({ kind: "operator" }).pending, null);
  f.observe("turn.completed");
});
