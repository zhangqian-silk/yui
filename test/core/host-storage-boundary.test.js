import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { CURRENT_STORAGE_VERSION } from "../../dist/storage/storageVersions.js";
import { openCurrentTaskStore } from "../../dist/storage/currentTaskStore.js";
import {
  publishStructuredProviderActivity, publishStructuredProviderTerminal,
  publishStructuredProviderAccepted, publishStructuredProviderConnection,
  publishStructuredProviderStarted, publishStructuredProviderInputObserved,
  publishStructuredProviderOpened
} from "../../dist/controller/structuredProviderObservation.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { FileRuntimeEventProcessor, AsyncRuntimeEventProcessor, createAsyncRuntimeObserver } from "../../dist/controller/runtimeEventProcessor.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createGlobalRole, createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { bindTaskRoleProviderRuntime, updateTaskRoleProviderRuntime, createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { createProviderRuntimeBinding, beginProviderTurn } from "../../dist/runtime/providerRuntimeIdentity.js";
import { runTaskCommand, submitOperatorMessage } from "../../dist/commands/taskCommands.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { createRuntimeLifecycleDispatcher } from "../../dist/controller/runtime.js";
import { startControllerServer } from "../../dist/core/controllerServer.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { mkdirSync } from "node:fs";
import { renameSync } from "node:fs";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { TmuxSessionHost } from "../../dist/runtime/tmuxAdapters.js";
import { launchBrokerForHome } from "../../dist/runtime/launchBroker.js";
import { createSessionOwnerIdentity } from "../../dist/runtime/sessionOwnerIdentity.js";

function executionFixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-host-execution-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  store.saveTask(activateTask(createTask("task-1", "Original intent", now, { cwd: home }), now));
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: "task-1" }, root: home, entries: []
  }, now));
  const role = createRole("task-1", "worker", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.saveRole("task-1", role);
  const command = args => runTaskCommand(args, store, { environment: {}, now: () => new Date() });
  command(["work", "create", "task-1", "Bounded result", "--role", "worker"]);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "work-item", taskId: "task-1", workItemId: "work-item-1" },
    root: home, entries: []
  }, now));
  command(["work", "dispatch", "task-1/work-item-1"]);
  const run = store.getActiveRun("task-1", "worker");
  let sessions = recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "worker" }, agent.id, now
  ), { agentId: agent.id, adapterId: "codex", nativeSessionId: "original-session",
    policy: "fixed", status: "active", effective: run.effective }, now);
  sessions = bindTaskRoleProviderRuntime(sessions, beginProviderTurn(createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex", conversationId: "original-session",
    startedAt: now.toISOString()
  }), { attemptId: "original-attempt", runId: run.id, authorityEpoch: 1, submittedAt: now.toISOString() }), now);
  store.saveTaskRoleSessionSet(sessions);
  const environment = {
    YUI_HOME: home, YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1",
    YUI_ROLE: "worker", YUI_AGENT_ID: "codex", YUI_ADAPTER_ID: "codex",
    YUI_WORKSPACE: home, YUI_RUN_ID: run.id
  };
  const identity = {
    nativeSessionId: "original-session", conversationId: "original-session",
    nativeTurnId: "original-turn", attemptId: "original-attempt"
  };
  const scheduler = new FileSchedulerStoreAdapter(store);
  return { home, store, scheduler, environment, identity, run, command };
}

test("production launch preserves scoped startup facts before native Session adoption", async t => {
  const { home, store, scheduler, run: createdRun } = executionFixture(t);
  const run = { ...createdRun, workspace: store.getManagedWorkspace({ type: "task", taskId: "task-1" }) };
  store.saveRun(run);
  store.saveActiveRun(run);
  const role = store.getRole("task-1", "worker");
  mkdirSync(join(home, "role-default"));
  store.saveRole("task-1", { ...role, workspace: join(home, "role-default") });
  store.saveTaskRoleSessionSet(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "worker" }, "codex", new Date()
  ));
  const planner = new FileRoleLaunchPlanner(home, store, { environment: { HOME: home, PATH: process.env.PATH } });
  let payload;
  const host = new TmuxSessionHost({
    plan: input => {
      const planned = planner.plan(input);
      // Keep native process creation outside this fast regression. Everything
      // through the actual broker reservation and its launch identity is real.
      return { ...planned, launch: { ...planned.launch, deferProviderStart: true } };
    }
  }, {
    ensureRoleWindow: (_task, _role, launch) => {
      payload = launchBrokerForHome(home).redeem(launch.args.at(-1));
      return true;
    }
  });
  await host.start({
    mode: "new", owner: { scope: "task", taskId: "task-1", roleName: "worker" },
    agentId: "codex", adapterId: "codex", effective: run.effective,
    workspace: run.effective.workspace.root, runId: run.id
  });
  assert.equal(payload.environment.YUI_RUN_ID, undefined, "Never pin a Run to the native Session environment.");
  assert.notEqual(store.getRole("task-1", "worker").workspace, payload.environment.YUI_WORKSPACE);
  const startup = { home, environment: payload.environment, startupRunId: payload.startupRunId,
    nativeSessionId: "opened-before-adoption" };
  await publishStructuredProviderConnection({ ...startup,
    connection: { account: { home, codexHome: join(home, "native-account") } } });
  await publishStructuredProviderOpened({ ...startup, conversationId: startup.nativeSessionId,
    recoverability: "recoverable", observedAt: new Date().toISOString() });
  const inbox = new FileRuntimeEventInbox(home);
  const processor = new FileRuntimeEventProcessor(inbox, scheduler);
  assert.deepEqual(processor.drain(new Date()).failed, []);
  scheduler.recordLaunchedRuntimeNativeSession({
    owner: { scope: "task", taskId: "task-1", roleName: "worker" },
    agentId: "codex", adapterId: "codex", nativeSessionId: startup.nativeSessionId, effective: run.effective
  }, () => {}, new Date());
  assert.deepEqual(processor.drain(new Date()).failed, []);
  assert.equal(store.listEvents("task-1").filter(e => e.type === "runtime.native-connection-bound").length, 1,
    "Early consumption must not discard the original account/custody evidence.");
  assert.equal(store.listEvents("task-1").filter(e => e.type === "runtime.observation"
    && ["session.started", "conversation.observed"].includes(e.payload.kind)).length, 2);
  assert.equal(payload.startupRunId, run.id, "Startup identity comes from the authorized launch, not ambient active state.");
  assert.equal(inbox.list().length, 0);
  await publishStructuredProviderConnection({ ...startup, startupRunId: "another-run",
    nativeSessionId: "must-not-bind", connection: { account: { home, codexHome: join(home, "wrong-account") } } });
  assert.deepEqual(processor.drain(new Date()).failed, []);
  assert.equal(store.listEvents("task-1").filter(e => e.type === "runtime.native-connection-bound").length, 1);
});

test("restoring an authorized Draft planning Session retains Host custody without a new Run", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-host-planning-restore-"));
  const home = join(root, "home");
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const now = new Date();
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  store.saveGlobalRole(createGlobalRole("leader", [createRoleAgentBinding(agent)], agent.id, home, now));
  store.saveConfig({ ...store.getConfig(), defaultAgent: agent.id, defaultWorkspace: home });
  submitOperatorMessage("Discuss the result before activation.", undefined, store, { now: () => now });
  const scheduler = new FileSchedulerStoreAdapter(store);
  assert.equal(scheduler.prepareDraftPlanning("task-1", now), true);
  const run = store.getActiveRun("task-1", "leader");
  const owner = { scope: "task", taskId: "task-1", roleName: "leader" };
  const identity = { owner, agentId: agent.id, adapterId: "codex",
    nativeSessionId: "planning-session", effective: run.effective };
  scheduler.recordLaunchedRuntimeNativeSession(identity, () => {}, now);
  store.transaction(tx => terminalizeExactTaskRun(tx, {
    taskId: "task-1", roleName: "leader", agentId: agent.id, runId: run.id,
    outcome: { status: "completed", output: "Proposal saved; await discussion." }
  }, now));
  assert.equal(store.getActiveRun("task-1", "leader"), null);
  const planner = new FileRoleLaunchPlanner(home, store, { environment: { HOME: home, PATH: process.env.PATH } });
  let payload;
  const host = new TmuxSessionHost({
    plan: input => {
      const planned = planner.plan(input);
      return { ...planned, launch: { ...planned.launch, deferProviderStart: true } };
    }
  }, {
    ensureRoleWindow: (_task, _role, launch) => {
      payload = launchBrokerForHome(home).redeem(launch.args.at(-1));
      return true;
    }
  });
  await host.restore({ mode: "resume", ...identity, workspace: run.effective.workspace.root });
  assert.equal(payload.startupRunId, undefined);
  assert.equal(payload.environment.YUI_RUN_ID, undefined);
  const processOwner = createSessionOwnerIdentity({
    owner, agentId: agent.id, adapterId: "codex", nativeSessionId: identity.nativeSessionId,
    tmux: { serverName: "isolated", socketPath: join(home, "tmux.sock"),
      sessionName: "task-1", windowName: "leader" },
    providerRoot: { pid: 12345, startIdentity: "1", attribution: "owned-child" }, recordedAt: now
  });
  const connection = { processOwner, account: { home, codexHome: join(home, "native-account") } };
  const publish = overrides => publishStructuredProviderConnection({
    home, environment: payload.environment, nativeSessionId: identity.nativeSessionId,
    connection, ...overrides
  });
  await publish({});
  scheduler.recordLaunchedRuntimeNativeSession(identity, () => {}, new Date());
  const inbox = new FileRuntimeEventInbox(home);
  const processor = new FileRuntimeEventProcessor(inbox, scheduler);
  assert.deepEqual(processor.drain(new Date()).failed, []);
  const connections = () => store.listEvents("task-1").filter(e => e.type === "runtime.native-connection-bound");
  assert.equal(connections().length, 1, "A completed planning Run cannot erase restored Session evidence.");
  assert.deepEqual(store.listSessionOwnersForOwner(owner), [processOwner]);
  assert.equal(inbox.list().length, 0);

  // The runless planning allowance still requires the exact live Session,
  // its workspace, planning authority and an enabled Task.
  const accepted = store.getTaskRoleSessionSet("task-1", "leader");
  const session = accepted.sessions.codex;
  const rejected = async (overrides = {}) => {
    await publish(overrides);
    const [event] = inbox.list();
    assert.equal(scheduler.observeAgentHostObservation(event, new Date()), "obsolete");
    assert.deepEqual(processor.drain(new Date()).failed, []);
    assert.equal(connections().length, 1);
    assert.deepEqual(store.listSessionOwnersForOwner(owner), [processOwner]);
  };
  await rejected({ nativeSessionId: "other-session" });
  await rejected({ environment: { ...payload.environment, YUI_WORKSPACE: join(home, "wrong-workspace") } });
  store.saveTaskRoleSessionSet({ ...accepted, sessions: { codex: {
    ...session, effective: { ...session.effective, executionAuthority: "delivery" }
  } } });
  await rejected();
  store.saveTaskRoleSessionSet(accepted);
  store.saveTask({ ...store.getTask("task-1"), executionGate: { state: "stopped" } });
  await rejected();
  assert.equal(store.getTask("task-1").status, "draft");
  assert.equal(store.listRuns("task-1").length, 1, "Restoration must not manufacture a managed Run.");
  assert.equal(store.getRun("task-1", run.id).effective.executionAuthority, "planning");
});

test("Host saves exact provider facts without opening Controller-owned storage", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-host-storage-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  new SqliteTaskStore(home).close();
  // An unavailable database must not prevent the Host from preserving facts
  // for the Controller to resolve. This is not a cross-version runtime test.
  renameSync(join(home, "yui.db"), join(home, "unavailable.db"));
  assert.throws(() => openCurrentTaskStore(home), /supported storage contract/);
  const environment = {
    YUI_HOME: home, YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1",
    YUI_ROLE: "worker", YUI_AGENT_ID: "codex", YUI_ADAPTER_ID: "codex",
    YUI_WORKSPACE: home, YUI_RUN_ID: "launch-run-must-not-own-late-events"
  };
  const identity = {
    nativeSessionId: "original-session", conversationId: "original-session",
    nativeTurnId: "original-turn", attemptId: "original-attempt",
    observedAt: new Date().toISOString()
  };
  await publishStructuredProviderConnection({
    home, environment, nativeSessionId: identity.nativeSessionId,
    connection: { account: { home, codexHome: join(home, ".codex") } }
  });
  await publishStructuredProviderActivity({
    home, environment, activity: { ...identity, phase: "model", id: "model-item" }
  });
  await publishStructuredProviderTerminal({
    home, environment,
    terminal: { ...identity, clientOwned: true, status: "completed", output: "Full original report\n第二行" }
  });
  const entries = new FileRuntimeEventInbox(home).list();
  assert.equal(entries.length, 3);
  assert.equal(entries.find(e => e.observation.kind === "host.observed").observation.authority, "host");
  const terminal = entries.find(e => e.observation?.kind === "turn.completed");
  assert.equal(terminal.observation.payload.output, "Full original report\n第二行");
  assert.equal(terminal.observation.fence.receiptId, "original-attempt");
  assert.equal(terminal.observation.fence.runId, undefined, "Only Controller resolves the durable Run.");
  assert.equal(terminal.host.startupRunId, undefined, "A late terminal must not borrow the launch identity.");
  const { YUI_TASK_ID, ...globalEnvironment } = environment;
  await publishStructuredProviderConnection({
    home, environment: { ...globalEnvironment, YUI_SESSION_SCOPE: "global" },
    nativeSessionId: identity.nativeSessionId,
    connection: { account: { home, codexHome: join(home, ".codex") } }
  });
  await publishStructuredProviderTerminal({
    home, environment: { ...globalEnvironment, YUI_SESSION_SCOPE: "global" },
    terminal: { ...identity, clientOwned: true, status: "completed", output: "Global original report" }
  });
  const globalEvents = new FileRuntimeEventInbox(home).list().filter(event => event.scope === "global");
  assert.equal(globalEvents.length, 2, "Global Host must also enqueue without opening the store.");
  assert.ok(globalEvents.every(event => event.host && event.observation.fence.taskId === undefined
    && event.observation.fence.runId === undefined));
});

test("Controller resolves Host facts, retains ACK-loss replay and rejects wrong/old identities", async t => {
  const f = executionFixture(t);
  const { home, store, scheduler, environment, identity, run } = f;
  const inbox = new FileRuntimeEventInbox(home);
  const dispatcher = createRuntimeLifecycleDispatcher(store, scheduler, {});
  let eager = 0;
  const controller = await startControllerServer(home, async (method, params) => {
    if (method !== "runtime.host-observation-apply") return {};
    eager += 1;
    await dispatcher(method, params);
    // Lose the first acknowledgement AFTER its authoritative commit.
    return eager === 1 ? new Promise(() => {}) : { outcome: "applied" };
  }, undefined, { release: null, storageBackend: "sqlite", workerEnabled: false });
  await publishStructuredProviderAccepted({
    home, environment, receipt: { ...identity, acceptance: "provider", acceptedAt: new Date().toISOString() }
  });
  assert.equal(eager, 1);
  assert.equal(store.getTaskRoleSessionSet("task-1", "worker").providerBinding.run.status, "accepted");
  assert.equal(inbox.list().length, 1, "The lost ACK still has its original Inbox identity.");
  await controller.close();
  await publishStructuredProviderActivity({
    home, environment, activity: { ...identity, observedAt: new Date().toISOString(), phase: "model", id: "working" }
  });
  await publishStructuredProviderTerminal({
    home, environment, terminal: { ...identity, clientOwned: true, status: "completed",
      output: "Full original result\n中文证据", observedAt: new Date().toISOString() }
  });
  const saved = inbox.list();
  const processor = new FileRuntimeEventProcessor(inbox, scheduler);
  const drained = processor.drain(new Date());
  assert.deepEqual(drained.failed, []);
  assert.deepEqual(drained.deferred, []);
  assert.equal(store.getRun("task-1", run.id).status, "completed");
  assert.equal(store.getRun("task-1", run.id).result.output, "Full original result\n中文证据");
  assert.equal(store.getWorkItem("task-1", "work-item-1").status, "open", "Result is evidence, not business acceptance.");
  const count = store.listMessages("task-1").length;
  // Re-deliver byte-identical facts after an ACK is lost at the inbox boundary.
  for (const event of saved) inbox.enqueueObservation(event.observation, event.host);
  const asyncProcessor = new AsyncRuntimeEventProcessor(inbox, createAsyncRuntimeObserver(
    async (method, args) => scheduler[method](...args)
  ));
  const replayed = await asyncProcessor.drainAsync(new Date());
  assert.deepEqual(replayed.failed, []);
  assert.equal(store.listMessages("task-1").length, count);
  assert.equal(inbox.list().length, 0);
  // Ordinary native chat is not a managed assignment and an observed user
  // input must not be misreported as a Host reporting fault.
  const direct = { ...identity, nativeTurnId: "direct-chat", attemptId: undefined };
  await publishStructuredProviderStarted({
    home, environment, started: { ...direct, clientOwned: false, observedAt: new Date().toISOString() }
  });
  assert.deepEqual(processor.drain(new Date()).failed, []);
  await publishStructuredProviderInputObserved({
    home, environment, observed: { ...direct, inputId: "visible-user-input", input: "Ordinary conversation",
      observedAt: new Date().toISOString() }
  });
  const visibleInput = inbox.list()[0];
  assert.equal(scheduler.observeAgentHostObservation(visibleInput, new Date()), "applied");
  assert.deepEqual(processor.drain(new Date()).failed, []);
  await publishStructuredProviderTerminal({
    home, environment, terminal: { ...direct, clientOwned: false, status: "completed",
      output: "Ordinary reply", observedAt: new Date().toISOString() }
  });
  assert.deepEqual(processor.drain(new Date()).failed, []);
  assert.equal(store.listRuns("task-1").length, 1, "Ordinary conversation must not create an assignment.");
  f.command(["work", "dispatch", "task-1/work-item-1"]);
  const successor = store.getActiveRun("task-1", "worker");
  assert.notEqual(successor.id, run.id);
  const sessions = store.getTaskRoleSessionSet("task-1", "worker");
  store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(sessions, beginProviderTurn(sessions.providerBinding, {
    attemptId: "successor-attempt", runId: successor.id, authorityEpoch: 1, submittedAt: new Date().toISOString()
  }), new Date()));
  await publishStructuredProviderTerminal({
    home, environment: { ...environment, YUI_RUN_ID: successor.id },
    terminal: { ...identity, clientOwned: true, status: "completed",
      output: "Full original result\n中文证据", observedAt: new Date().toISOString() }
  });
  assert.deepEqual(processor.drain(new Date()).failed, []);
  assert.equal(store.getActiveRun("task-1", "worker").id, successor.id);
  // A forged old attempt cannot borrow even this Session's known native Turn.
  await publishStructuredProviderTerminal({
    home, environment: { ...environment, YUI_RUN_ID: "a-successor-launch" },
    terminal: { ...identity, attemptId: "wrong-attempt", clientOwned: true, status: "completed",
      output: "Must not replace result", observedAt: new Date().toISOString() }
  });
  const rejected = processor.drain(new Date());
  assert.deepEqual(rejected.failed, []);
  assert.equal(store.getRun("task-1", run.id).result.output, "Full original result\n中文证据");
  assert.equal(store.getActiveRun("task-1", "worker").id, successor.id);
  assert.ok(store.listEvents("task-1").some(e => JSON.stringify(e.payload).includes("conflicting durable")));
  const progress = saved.find(e => e.observation.kind === "activity.observed");
  inbox.enqueueObservation({
    ...progress.observation, authority: "controller", eventId: "forged-authority", semanticKey: "forged-authority"
  }, progress.host);
  inbox.enqueueObservation({
    ...progress.observation, eventId: "wrong-workspace", semanticKey: "wrong-workspace"
  }, { ...progress.host, workspace: join(home, "another-workspace") });
  assert.deepEqual(processor.drain(new Date()).failed, []);
  assert.equal(store.getActiveRun("task-1", "worker").id, successor.id);
  assert.ok(store.listEvents("task-1").some(e => JSON.stringify(e.payload).includes("exceeds its event authority")));
  assert.ok(store.listEvents("task-1").some(e => JSON.stringify(e.payload).includes("workspace does not match")));
  const status = runTaskCommand(["role", "status", "task-1", "worker"], store, {
    environment: {}, liveHostObservations: { worker: { snapshot: {
      schemaVersion: 1, state: "failed", adapterId: "codex", nativeSessionId: identity.nativeSessionId,
      detail: "This Home does not use a supported storage contract.", updatedAt: new Date().toISOString()
    } } }
  });
  assert.equal(status.data.role.health, "needs-attention");
  assert.equal(status.data.role.activeRun.id, successor.id);
  assert.equal(store.getRun("task-1", successor.id).status, "active", "A reporting failure is not a model or business terminal.");
  assert.match(status.output, /supported storage contract/);
});
