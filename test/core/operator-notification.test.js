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
import { createGlobalRoleMessage, markGlobalRoleMessageNotDelivered } from "../../dist/message/message.js";
import { globalInputBacklog } from "../../dist/message/globalInputBacklog.js";
import { createOperatorBatchPresentation } from "../../dist/interaction/operatorPresentation.js";
import { createRuntimeObservation } from "../../dist/runtime/runtimeObservation.js";
import { deliverGlobalInputs } from "../../dist/controller/globalInputDelivery.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";
import { AGENT_HOST_CONTROL_PROTOCOL, openAgentHostControl } from "../../dist/runtime/agentHost.js";
import { FileTaskController } from "../../dist/controller/controller.js";
import { createInputRequest } from "../../dist/input/inputRequest.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import {
  publishStructuredProviderAccepted, publishStructuredProviderTerminal
} from "../../dist/controller/structuredProviderObservation.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import Database from "../../dist/sqlite/driver.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { checkSessionSkills } from "../../dist/context/sessionBootstrapManifest.js";

const now = new Date("2026-09-18T00:00:00Z");

test("important facts atomically queue attention without a producer wake, and restart stays quiet after handoff", async t => {
  const f = fixture(t);
  const event = createTaskEvent("event-1", "task-1", "publication.recorded",
    { publicationId: "publication-1", state: "merged", verification: "verified" }, now);
  const saveMailbox = f.store.saveWorkMailbox;
  f.store.saveWorkMailbox = () => { throw new Error("injected source admission failure"); };
  assert.throws(() => f.store.saveEvent("task-1", event), /source admission failure/);
  assert.deepEqual(f.store.listEvents("task-1"), [], "Fact and incremental attention commit together.");
  f.store.saveWorkMailbox = saveMailbox;
  f.store.saveEvent("task-1", event);
  f.reopen();
  const results = await f.process();
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "queued");
  assert.match(f.store.listGlobalRoleMessages("operator")[0].body, /task-1 event-1/);
  f.reopen();
  assert.deepEqual(await f.process(), []);
  assert.equal(f.store.listGlobalRoleMessages("operator").length, 1);
});

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
    async upgradeFrom14() {
      store.close();
      const db = new Database(join(home, "yui.db"));
      // These records use the valid 1.4 shape: no optional frozen Skill evidence.
      // The historical 1.4/1.5 transition has the same physical SQL schema.
      db.prepare("UPDATE storage_schema SET minor=4 WHERE id=1").run();
      db.close();
      assert.equal((await runStorageUpgrade({ home, mode: "execute" })).outcome, "upgraded");
      store = new SqliteTaskStore(home);
    },
    user(body) {
      const result = runGlobalRoleCommand(["message", "queue", "operator", body,
        "--request-id", body], store, { env: {}, jsonOutput: true });
      return result.data.message;
    },
    observe(kind) {
      const sessions = store.getGlobalRoleSessionSet("operator");
      const run = sessions.providerBinding.run;
      const eventId = `provider-${++sequence}`;
      assert.equal(new FileSchedulerStoreAdapter(store).observeRuntimeObservation(createRuntimeObservation({
        schemaVersion: 1, eventId, semanticKey: eventId, kind, authority: "provider-structured",
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
      const snapshot = state => ({ schemaVersion: 1, state, updatedAt: now.toISOString() });
      let host;
      cleanup.push(async () => { await host?.close(); });
      host = await openAgentHostControl(home, {
        environment: { YUI_SESSION_SCOPE: "global", YUI_ROLE: "operator" }
      }, () => snapshot("ready"), async control => {
        if (control.type === "status") return {
          protocol: AGENT_HOST_CONTROL_PROTOCOL, outcome: "status", snapshot: snapshot("ready")
        };
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

test("pre-1.5 Operator resumes after upgrade and drains original backlog without fabricating Skill or delivery evidence", async t => {
  const f = fixture(t);
  const inputs = [f.user("First original"), f.user("Second original")];
  const original = f.store.listGlobalRoleMessages("operator");
  const sessions = f.store.getGlobalRoleSessionSet("operator");
  assert.equal(sessions.sessions.codex.effective.skillPackages, undefined);
  await f.upgradeFrom14();
  assert.deepEqual(f.store.getGlobalRoleSessionSet("operator"), sessions);
  assert.deepEqual(f.store.listGlobalRoleMessages("operator"), original);
  let checks = 0;
  const ensure = async () => {
    const planned = new FileRoleLaunchPlanner(f.home, f.store, {
      environment: { HOME: f.home, PATH: process.env.PATH }
    }).planGlobalRole({ roleName: "operator", agentId: "codex", adapterId: "codex",
      mode: "resume", nativeSessionId: "operator-native" });
    assert.deepEqual(checkSessionSkills(f.home, planned.launch.env.YUI_SESSION_MANIFEST).skills.map(s => s.id),
      ["yui-runtime", "yui-operator"]);
    checks++;
  };
  const deliver = () => deliverGlobalInputs(f.home, f.store, ensure, error => { throw error; });
  const provider = await f.provider();
  await deliver();
  assert.equal(checks, 1);
  inputs.push(f.user("New input after the old window"));
  f.reopen();
  await deliver();
  assert.equal(checks, 1, "Accepted in-flight input cannot be replayed across restart.");
  for (const input of inputs.slice(1)) {
    f.observe("turn.completed");
    await deliver();
    assert.equal(provider.attempts.at(-1), `global-input:operator/${input.id}`);
  }
  f.observe("turn.completed");
  await deliver();
  assert.equal(checks, 3);
  assert.deepEqual(provider.attempts, inputs.map(m => `global-input:operator/${m.id}`));
  for (const before of original) {
    const { delivery, control, ...after } = f.store.listGlobalRoleMessages("operator").find(m => m.id === before.id);
    assert.equal(delivery.via, "provider");
    assert.deepEqual(after, before);
  }
  assert.equal(f.user("First original").id, inputs[0].id);
  assert.equal(f.store.getGlobalRoleSessionSet("operator").sessions.codex.effective.skillPackages, undefined);
});

test("Operator notices coalesce while busy and hand off once after Provider acceptance", async t => {
  const f = fixture(t);
  const first = f.enqueue();
  const queued = await f.process();
  assert.equal(queued[0].status, "queued");
  f.reopen();
  f.store.saveTask(createTask("task-2", "Another notification source", now));
  const second = createTaskEvent("event-1", "task-2", "task.completed", { summary: "Independent fact" }, now);
  f.store.saveEvent("task-2", second);
  enqueueOperatorEvent(f.store, second, "task-terminal", now);
  const input = createInputRequest("input-1", "task-1",
    { taskId: "task-1", roleName: "leader", agentId: "codex", nativeSessionId: "leader-native" },
    { question: "Keep this authorization request open", choices: [], blockedRefs: [] }, now);
  f.store.saveInputRequest("task-1", input);
  enqueueWork(f.store, { kind: "operator" }, "input-request", now,
    [{ type: "input", taskId: "task-1", id: input.id }]);
  assert.equal((await f.process())[0].reason, "notice-pending");
  assert.equal(f.store.listGlobalRoleMessages("operator").length, 1);
  const provider = await f.provider();
  await f.deliver();
  await f.process();
  const messages = f.store.listGlobalRoleMessages("operator");
  assert.equal(messages.length, 2);
  assert.match(messages[0].body, new RegExp(`task-1/${first.id}\\b`));
  assert.doesNotMatch(messages[1].body, new RegExp(`task-1/${first.id}\\b`));
  assert.match(messages[1].body, new RegExp(`task-2/${second.id}\\b`));
  assert.match(messages[1].body, /yui task input show task-1\/input-1/u);
  assert.deepEqual(f.store.getInputRequest("task-1", input.id), input, "Queuing attention cannot answer or cancel an authorization request.");
  assert.equal(messages[0].delivery.via, "provider");
  assert.equal(messages[1].delivery, undefined);
  assert.equal(provider.attempts.length, 1);
  assert.equal(f.store.getWorkMailbox({ kind: "operator" }).pending, null);
  f.observe("turn.completed");
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
  await f.provider();
  await f.deliver();
  await f.process();
  const messages = f.store.listGlobalRoleMessages("operator");
  assert.equal(messages.length, 2);
  assert.doesNotMatch(messages[1].body, new RegExp(`task-1/${first.id}\\b`));
  f.observe("turn.completed");
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
  assert.equal(f.store.listGlobalRoleMessages("operator").length, 2);
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
  assert.equal((await f.process())[0].reason, "notice-pending");
  f.observe("turn.accepted");
  f.observe("turn.completed");
  await f.process();
  const laterUser = f.user("Later user input");
  const messages = f.store.listGlobalRoleMessages("operator").filter(m =>
    m.inputControl && !/^runtime-(attention|recovery):/.test(m.inputControl.requestId));
  assert.equal(messages.length, 4);
  provider.outcome = "rejected";
  await f.deliver();
  const rejected = f.store.listGlobalRoleMessages("operator").find(m => m.id === messages[2].id);
  assert.equal(rejected.notDelivered.reason, "fixture-rejected");
  f.reopen();
  provider.outcome = "accepted";
  await f.deliver();
  assert.deepEqual(provider.attempts, messages.map(message => `global-input:operator/${message.id}`));
  assert.equal(f.store.listGlobalRoleMessages("operator").find(m => m.id === laterUser.id).body, "Later user input");
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
  const preserved = f.store.listGlobalRoleMessages("operator").slice(0, messages.length);
  assert.ok(preserved.every(message => message.notDelivered.reason === "native-session-changed"));
  assert.deepEqual(preserved.map(message => message.body), messages.map(message => message.body));
  f.observe("turn.completed");
});

test("mixed-source backlog survives deferred release, restart and bounded claims without losing facts", async t => {
  const f = fixture(t);
  await f.provider();
  f.enqueue();
  await f.process();
  const events = [];
  for (let i = 0; i < 65; i++) {
    if (i === 32 || i === 64) {
      const event = createTaskEvent(f.store.nextEventId("task-1"), "task-1",
        "provider.retry-unconfirmed", { roleName: "leader" }, now);
      f.store.saveEvent("task-1", event);
      // Existing supported retry producers used the mailbox's sequence key.
      enqueueWork(f.store, { kind: "operator" }, "provider-retry-needs-attention",
        now, [{ type: "event", taskId: "task-1", id: event.id }]);
      events.push(event);
    } else events.push(f.enqueue());
  }
  const before = f.store.getWorkMailbox({ kind: "operator" }).pending;
  assert.equal((await f.process()).length, 64);
  assert.deepEqual(f.store.getWorkMailbox({ kind: "operator" }).pending, before,
    "Deferred release retains the original sequence keys, refs and ordering.");
  events.push(f.enqueue());
  f.reopen();
  await f.deliver();
  f.observe("turn.completed");
  const first = await f.process();
  assert.equal(first.length, 64);
  await f.deliver();
  f.observe("turn.completed");
  const rest = await f.process();
  assert.deepEqual([...first, ...rest].map(item => item.sourceId), events.map(event => event.id));
  await f.deliver();
  f.observe("turn.completed");
  assert.deepEqual(await f.process(), []);
  assert.equal(f.store.listGlobalRoleMessages("operator").length, 3);
});

test("large backlogs use bounded source batches and message pages, preserving unknown fences and diagnostics", async t => {
  const f = fixture(t);
  const provider = await f.provider();
  for (let i = 0; i < 140; i++) f.enqueue();
  const adapter = new FileSchedulerStoreAdapter(f.store);
  adapter.listEvents = () => assert.fail("Operator reconciliation must not deserialize Task history");
  const first = await processOperatorInputNotifications(adapter, undefined, now);
  assert.equal(first.length, 64);
  assert.equal(f.store.getWorkMailbox({ kind: "operator" }).pending.requestCount, 76);
  await f.deliver();
  f.observe("turn.completed");
  f.reopen();
  assert.equal((await f.process()).length, 64);
  await f.deliver();
  f.observe("turn.completed");
  assert.equal((await f.process()).length, 12);
  await f.deliver();
  f.observe("turn.completed");
  assert.equal(provider.attempts.length, 3);
  assert.deepEqual(await f.process(), []);
  for (let i = 0; i < 129; i++) {
    f.store.saveGlobalRoleMessage({
      ...createGlobalRoleMessage(f.store.nextGlobalRoleMessageId(), "operator", `original-${i}`,
        "system", { type: "system" }, now,
        { inputControl: { action: "queue", requestId: `historical-${i}` } }),
      deliveryTarget: { agentId: "codex", nativeSessionId: "old-native" }
    });
  }
  const user = f.user("User input after the old backlog");
  const pending = f.store.queryGlobalRoleMessages("operator", { pending: true, limit: 64 });
  assert.equal(pending.count, 130);
  assert.equal(pending.messages.length, 64);
  const diagnostic = globalInputBacklog(
    f.store.listGlobalRoleMessages("operator").filter(m => !m.delivery && !m.notDelivered),
    f.store.getGlobalRoleSessionSet("operator"), new Date(now.getTime() + 60_000));
  assert.equal(diagnostic.reason, "stale-target");
  assert.equal(diagnostic.pendingCount, 130);
  assert.equal(diagnostic.oldestAgeMs, 60_000);
  assert.equal(diagnostic.messages.length, 8);
  await f.deliver();
  assert.equal(f.store.queryGlobalRoleMessages("operator", { pending: true, limit: 0 }).count, 66);
  await f.deliver();
  await f.deliver();
  assert.equal(provider.attempts.at(-1), `global-input:operator/${user.id}`);
  assert.equal(f.store.listGlobalRoleMessages("operator").filter(m => m.notDelivered).length, 129);
  f.observe("turn.completed");
});

test("unobservable Global Host emits one durable diagnosis, never replays or steals an unknown writer", async t => {
  const f = fixture(t);
  const provider = await f.provider();
  f.user("Owned input");
  await f.deliver();
  f.user("Must wait");
  const before = structuredClone(f.store.getGlobalRoleSessionSet("operator"));
  // Fixture Host intentionally implements submit/status only: a current Controller
  // cannot manufacture the missing observation capability of an older Host.
  await deliverGlobalInputs(f.home, f.store, async () => assert.fail("Do not restore a busy Host"),
    error => { throw error; }, { reconcile: true, now });
  await deliverGlobalInputs(f.home, f.store, async () => assert.fail("Do not restore a busy Host"),
    error => { throw error; }, { reconcile: true, now });
  assert.deepEqual(f.store.getGlobalRoleSessionSet("operator"), before);
  assert.equal(provider.attempts.length, 1);
  const evidence = f.store.listGlobalRoleMessages("operator").filter(m => m.inputControl?.requestId.startsWith("runtime-attention:"));
  assert.equal(evidence.length, 1);
  assert.match(evidence[0].body, /host-terminal-unobservable/);
  assert.match(evidence[0].body, /host-control-unsupported/);
  assert.ok(evidence[0].notDelivered);
  const queued = f.store.queryGlobalRoleMessages("operator", { pending: true, limit: 64 }).messages;
  assert.equal(globalInputBacklog(queued, before, now).reason, "in-flight-or-unobserved-terminal");
  const external = { ...before, providerBinding: { ...before.providerBinding,
    authority: { ...before.providerBinding.authority, owner: "human" } } };
  f.store.saveGlobalRoleSessionSet(external);
  assert.equal(globalInputBacklog(queued, external, now).reason, "external-or-unknown-writer");
  await deliverGlobalInputs(f.home, f.store, async () => assert.fail("No takeover"),
    error => { throw error; }, { reconcile: true, now });
  assert.equal(provider.attempts.length, 1);
});

test("Global entry omits large Profile bodies and keeps live backlog age separate", t => {
  const f = fixture(t);
  f.user("Pending original");
  f.store.saveGlobalRole({ ...f.store.getGlobalRole("operator"), description: "context ".repeat(3000) });
  const read = cursor => runGlobalRoleCommand(["context", "operator", ...(cursor ? ["--cursor", cursor] : [])],
    f.store, { env: {}, jsonOutput: true }).data;
  t.mock.timers.enable({ apis: ["Date"],
    now: Date.parse(f.store.listGlobalRoleMessages("operator")[0].createdAt) + 60_000 });
  const page = read();
  assert.equal(page.contentPage, undefined);
  assert.ok(page.backlogObservation.oldestAgeMs >= 0);
  assert.equal(page.profile.description, undefined);
  assert.equal(page.backlog.pendingCount, 1);
  assert.equal(page.pending.items.length, 1);
  const { backlogObservation: first, ...facts } = page;
  t.mock.timers.tick(1000);
  const { backlogObservation: second, ...laterFacts } = read();
  assert.deepEqual(facts, laterFacts);
  assert.equal(second.oldestAgeMs, first.oldestAgeMs + 1000);
  assert.equal(f.store.listGlobalRoleMessages("operator")[0].delivery, undefined);
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

test("Global native terminal survives a Controller outage and releases queued input only after exact Inbox replay", async t => {
  const f = fixture(t);
  f.enqueue();
  const [notice] = await f.process();
  const attemptId = `global-input:operator/${notice.messageId}`;
  new FileSchedulerStoreAdapter(f.store).beginAgentHostProviderTurn({
    roleName: "operator", agentId: "codex", nativeSessionId: "operator-native", attemptId,
    authorityEpoch: 1, authorityOwner: "controller", holderId: "controller", now
  });
  const environment = { YUI_HOME: f.home, YUI_SESSION_SCOPE: "global", YUI_ROLE: "operator",
    YUI_AGENT_ID: "codex", YUI_ADAPTER_ID: "codex", YUI_WORKSPACE: f.home };
  const identity = { nativeSessionId: "operator-native", conversationId: "operator-native",
    nativeTurnId: "exact-offline-turn", attemptId };
  // There is deliberately no Controller socket: native completion is not yet
  // Yui settlement, and must not unlock a second native writer.
  await publishStructuredProviderAccepted({ home: f.home, environment,
    receipt: { ...identity, acceptedAt: now.toISOString(), acceptance: "provider" } });
  await publishStructuredProviderTerminal({ home: f.home, environment,
    terminal: { ...identity, observedAt: now.toISOString(), clientOwned: true,
      status: "completed", output: "Original natural result" } });
  const next = f.user("Wait for the original terminal fact");
  assert.equal(f.store.getGlobalRoleSessionSet("operator").providerBinding.run.status, "submitting");
  await f.deliver();
  assert.equal(f.store.listGlobalRoleMessages("operator").find(m => m.id === next.id).delivery, undefined);
  f.reopen();
  const inbox = new FileRuntimeEventInbox(f.home);
  assert.equal(inbox.list().filter(event => event.observation.kind === "turn.completed").length, 1);
  const processor = new FileRuntimeEventProcessor(inbox, new FileSchedulerStoreAdapter(f.store));
  const result = processor.drain(new Date());
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.deferred, []);
  assert.equal(f.store.getGlobalRoleSessionSet("operator").providerBinding.run.status, "completed");
  assert.equal(inbox.list().length, 0);
  const provider = await f.provider();
  await f.deliver();
  assert.deepEqual(provider.attempts, [`global-input:operator/${next.id}`]);
  f.observe("turn.completed");
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
