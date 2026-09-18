import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { startControllerServer } from "../../dist/core/controllerServer.js";
import { launchBrokerForHome } from "../../dist/runtime/launchBroker.js";
import { inspectAgentHost, sendAgentHostCancelControl, sendAgentHostSteerControl } from "../../dist/runtime/agentHost.js";
import { deliverGlobalInputs } from "../../dist/controller/globalInputDelivery.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { publishStructuredProviderTerminal } from "../../dist/controller/structuredProviderObservation.js";
import { createTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { enqueueOperatorEvent } from "../../dist/scheduler/operatorEvent.js";
import { processOperatorInputNotifications } from "../../dist/scheduler/operatorInputNotificationProcessor.js";
import { FileTaskController } from "../../dist/controller/controller.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";

async function globalHostFixture(t, adapterId = "codex", {
  controlled = true, roleName = "assistant", autoDeliver = false
} = {}) {
  const home = mkdtempSync(join(tmpdir(), "yui-global-host-"));
  const store = new SqliteTaskStore(home);
  let controller;
  let host;
  let schedulerRuntime;
  t.after(async () => {
    await schedulerRuntime?.shutdownAndDrain();
    if (host !== undefined) {
      host.kill("SIGTERM");
      if (host.exitCode === null && host.signalCode === null) await once(host, "exit");
    }
    await controller?.close();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const now = new Date();
  const agent = createConfiguredAgent(adapterId, adapterId, adapterId, [], [], now);
  store.saveConfiguredAgent(agent);
  const role = createGlobalRole(roleName, [createRoleAgentBinding(agent)], agent.id, home, now);
  store.createGlobalRoleIfAbsent(role);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  const planned = new FileRoleLaunchPlanner(home, store, {
    cliPath: resolve("dist/cli.js"), environment: { HOME: home, PATH: process.env.PATH }
  }).planGlobalRole({ roleName: role.name, agentId: agent.id, adapterId, mode: "new" });
  assert.equal(planned.launch.providerControl.kind, "start");
  assert.equal(planned.launch.providerControl.sessionOnly, true);
  assert.equal(planned.role.workspace, effective.workspace.root);
  const nativeSessionId = adapterId === "codex" ? "fake-thread-1" : planned.launch.providerControl.nativeSessionId;
  const scheduler = new FileSchedulerStoreAdapter(store);
  const command = args => {
    const result = runGlobalRoleCommand(args, store, { env: {}, jsonOutput: true });
    return typeof result === "string" ? JSON.parse(result) : result;
  };
  const errors = [];
  const inbox = new FileRuntimeEventInbox(home);
  const applyHost = event => {
    assert.ok(event.host, "Host must retain its raw source envelope");
    assert.equal(event.scope, "global");
    assert.equal(event.observation.fence.runId, undefined);
    const outcome = scheduler.observeAgentHostObservation(event);
    if (outcome !== "deferred") inbox.acknowledge(event.id);
    return outcome;
  };
  controller = await startControllerServer(home, (method, params) => {
    if (method === "scheduler.signal") {
      schedulerRuntime?.signal(params.key);
      return {};
    }
    if (method === "runtime.launch-redeem") return launchBrokerForHome(home).redeem(params.ticket);
    if (method === "runtime.provider-turn-begin") {
      scheduler.beginAgentHostProviderTurn({ ...params, now: new Date(params.observedAt) });
      return { recorded: true };
    }
    if (method === "runtime.provider-turn-submission-resolve") {
      scheduler.resolveAgentHostProviderTurnSubmission({ ...params, now: new Date(params.observedAt) });
      return { recorded: true };
    }
    if (method === "runtime.host-observation-apply") {
      const event = inbox.read(params.eventId);
      return { outcome: event === null ? "applied" : applyHost(event) };
    }
    if (method === "runtime.observation-apply") assert.fail("Host bypassed raw Inbox ingress");
    return {};
  }, undefined, { release: null, storageBackend: "sqlite", workerEnabled: false });
  const { ticket } = launchBrokerForHome(home).reserve({
    schemaVersion: 2, command: process.execPath,
    args: adapterId === "codex"
      ? [resolve("test/fixtures/fake-codex-app-server-proxy.mjs")]
      : [resolve("test/fixtures/fake-claude-stream.mjs"), nativeSessionId],
    cwd: planned.role.cwd ?? planned.role.workspace,
    childLifecycle: planned.launch.childLifecycle, startMode: "provider",
    environment: { ...planned.launch.env, YUI_FAKE_CONTROLLED: controlled ? "1" : "0" },
    providerControl: planned.launch.providerControl
  });
  host = spawn(process.execPath, ["--input-type=module", "-e",
    `import {runAgentHost} from ${JSON.stringify(new URL("../../dist/runtime/agentHost.js", import.meta.url).href)};
     Object.defineProperty(process.stdin, "isTTY", {value: true});
     await runAgentHost(${JSON.stringify({ home, ticket })});`], {
    cwd: home, env: { PATH: process.env.PATH, HOME: home }, stdio: ["pipe", "pipe", "pipe"]
  });
  let logs = "";
  let output = "";
  host.stdout.on("data", chunk => { output += chunk; });
  host.stderr.on("data", chunk => { logs += chunk; });
  const wait = async predicate => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      if (host.exitCode !== null) throw new Error(`Host exited ${host.exitCode}: ${logs}`);
      await delay(10);
    }
    assert.fail(`Global Host predicate timed out: ${logs}`);
  };
  await wait(async () => {
    try { return (await inspectAgentHost({ home, scope: "global", roleName: role.name })).nativeSessionId === nativeSessionId; }
    catch { return false; }
  });
  scheduler.recordLaunchedRuntimeNativeSession({
    owner: { scope: "global", roleName: role.name }, agentId: agent.id,
    adapterId, nativeSessionId, effective
  }, () => {});
  for (const event of inbox.list()) applyHost(event);
  const owners = store.listSessionOwnersForOwner({ scope: "global", roleName: role.name });
  if (adapterId === "claude") {
    assert.equal(owners.length, 1, "Controller adopts owned-process custody from the raw Global Host envelope.");
    assert.equal(owners[0].nativeSessionId, nativeSessionId);
  }
  const submitNext = () => deliverGlobalInputs(home, store, async () => {}, error => errors.push(error));
  if (autoDeliver) schedulerRuntime = new FileTaskController(scheduler, {}, {
    signalWindowMs: 1,
    globalInputDelivery: submitNext,
    runtimeEventProcessor: new FileRuntimeEventProcessor(inbox, scheduler),
    onError: error => errors.push(error)
  });
  const native = () => store.getGlobalRoleSessionSet(role.name).providerBinding.run;
  return { store, home, role, command, submitNext, native, wait, host, errors, scheduler,
    environment: planned.launch.env,
    nativeSessionId, output: () => output };
}

test("Operator natural terminals settle through Host and Inbox and automatically wake the next Global input", async t => {
  const f = await globalHostFixture(t, "codex", {
    controlled: false, roleName: "operator", autoDeliver: true
  });
  const now = new Date();
  f.store.saveTask(createTask("task-1", "Notification source", now));
  const event = createTaskEvent("event-1", "task-1", "task.completed", { summary: "Source result" }, now);
  f.store.saveEvent("task-1", event);
  enqueueOperatorEvent(f.store, event, "task-terminal", now);
  const [notice] = await processOperatorInputNotifications(f.scheduler, undefined, now);
  assert.equal(notice.status, "queued");
  const next = f.command(["message", "queue", "operator", "After the natural terminal",
    "--request-id", "after-terminal"]).message;
  await f.submitNext();
  // No second manual delivery call and no periodic full pump: only the real
  // Host's post-terminal signal can admit the queued successor here.
  await f.wait(() => f.native()?.attemptId === `global-input:operator/${next.id}`
    && f.native().status === "completed");
  assert.equal(f.store.listGlobalRoleMessages("operator")[0].delivery.via, "provider");
  await f.wait(async () => (await inspectAgentHost({
    home: f.home, scope: "global", roleName: "operator"
  })).state === "idle");
  f.host.stdin.write("Normal console conversation\n");
  await f.wait(() => f.native().attemptId.startsWith("human:") && f.native().status === "completed");
  assert.deepEqual(f.errors, []);
  assert.equal(new FileRuntimeEventInbox(f.home).list().length, 0);
});

test("Global planner, console and durable inputs traverse real Host begin, acceptance, steer, cancel and ordered then", async t => {
  const { store, home, role, command, submitNext, native, wait, host, errors, output, environment } = await globalHostFixture(t);
  const first = command(["message", "queue", role.name, "first", "--request-id", "first"]).message;
  await submitNext();
  assert.deepEqual(errors, []);
  await wait(() => native()?.status === "accepted");
  assert.equal(native().attemptId, `global-input:${role.name}/${first.id}`);
  const restore = new FileRoleLaunchPlanner(home, store, {
    cliPath: resolve("dist/cli.js"), environment: { HOME: home, PATH: process.env.PATH }
  }).planGlobalRole({ roleName: role.name, agentId: "codex", adapterId: "codex",
    mode: "resume", nativeSessionId: "fake-thread-1" });
  assert.deepEqual(restore.launch.providerControl.ownedTurn, {
    attemptId: native().attemptId, turnId: native().nativeTurnId
  });
  assert.equal(store.listGlobalRoleMessages(role.name)[0].delivery.via, "provider");
  const exactTurn = structuredClone(native());
  for (const overrides of [
    { attemptId: "old-unrelated-input" },
    { nativeTurnId: "old-native-turn" },
    { environment: { ...environment, YUI_WORKSPACE: join(home, "wrong-workspace") } }
  ]) {
    const { environment: source = environment, ...identity } = overrides;
    await publishStructuredProviderTerminal({
      home, environment: source, terminal: {
        nativeSessionId: "fake-thread-1", conversationId: "fake-thread-1",
        nativeTurnId: exactTurn.nativeTurnId, attemptId: exactTurn.attemptId,
        observedAt: new Date().toISOString(), status: "completed", clientOwned: true,
        output: "must not settle current Global input", ...identity
      }
    });
    assert.deepEqual(native(), exactTurn, "Wrong source or late input must not bind the current Global turn.");
  }
  const steer = command(["message", "steer", role.name, "steer", "--request-id", "steer",
    "--expected-target", native().nativeTurnId]);
  const steerResult = await sendAgentHostSteerControl({ home, scope: "global", roleName: role.name,
    control: { protocol: "yui-agent-host/v5", type: "steer-turn", nativeSessionId: steer.target.nativeSessionId,
      nativeTurnId: steer.target.nativeTurnId, authority: steer.target.authority,
      run: { attemptId: steer.receiptId, boundedText: steer.text } } });
  assert.equal(steerResult.outcome, "accepted", JSON.stringify(steerResult));
  await wait(() => store.listGlobalRoleMessages(role.name).find(m => m.id === steer.messageId).delivery !== undefined);
  const queue = command(["message", "queue", role.name, "Q", "--request-id", "q"]).message;
  const next = command(["message", "queue", role.name, "M", "--request-id", "m"]).message;
  const cancel = command(["interrupt", role.name, "--expected-target", native().nativeTurnId,
    "--then-message", next.id, "--request-id", "cancel"]);
  await submitNext();
  assert.equal(native().attemptId, `global-input:${role.name}/${first.id}`);
  await sendAgentHostCancelControl({ home, scope: "global", roleName: role.name,
    control: { protocol: "yui-agent-host/v5", type: "cancel", nativeOnly: true, nativeSessionId: cancel.target.nativeSessionId,
      attemptId: cancel.target.attemptId, authority: cancel.target.authority } });
  await wait(() => native().status === "cancelled");
  await submitNext();
  await wait(() => native().attemptId === `global-input:${role.name}/${next.id}` && native().status === "accepted");
  await submitNext();
  assert.equal(store.listGlobalRoleMessages(role.name).find(m => m.id === queue.id).delivery, undefined);
  const stopNext = command(["interrupt", role.name, "--expected-target", native().nativeTurnId, "--request-id", "stop-m"]);
  await sendAgentHostCancelControl({ home, scope: "global", roleName: role.name,
    control: { protocol: "yui-agent-host/v5", type: "cancel", nativeOnly: true, nativeSessionId: stopNext.target.nativeSessionId,
      attemptId: stopNext.target.attemptId, authority: stopNext.target.authority } });
  await wait(() => native().status === "cancelled");
  await submitNext();
  await wait(() => native().attemptId === `global-input:${role.name}/${queue.id}` && native().status === "accepted");
  await sendAgentHostCancelControl({ home, scope: "global", roleName: role.name,
    control: { protocol: "yui-agent-host/v5", type: "cancel", nativeOnly: true,
      nativeSessionId: "fake-thread-1", attemptId: native().attemptId,
      authority: { epoch: 1, owner: "controller", holderId: "controller" } } });
  await wait(() => native().status === "cancelled");
  host.stdin.write("A human console input\n");
  await wait(() => native().attemptId.startsWith("human:") && native().status === "accepted");
  assert.match(output(), /Host console, not the native Agent TUI/u);
  assert.equal(native().runId, undefined);
  assert.deepEqual(errors, []);
});

test("the real Host refuses public native-only interrupt on an owned-process Endpoint without terminating it", async t => {
  const { home, role, command, submitNext, native, wait, host, errors, nativeSessionId } = await globalHostFixture(t, "claude");
  command(["message", "queue", role.name, "Keep this provider live", "--request-id", "native-only"]);
  await submitNext();
  assert.deepEqual(errors, []);
  await wait(() => native()?.status === "accepted");
  const attemptId = native().attemptId;
  const result = await sendAgentHostCancelControl({ home, scope: "global", roleName: role.name,
    control: { protocol: "yui-agent-host/v5", type: "cancel", nativeOnly: true, nativeSessionId, attemptId,
      authority: { epoch: 1, owner: "controller", holderId: "controller" } } });
  assert.equal(result.outcome, "rejected");
  assert.match(result.failure.detail, /cannot natively interrupt/);
  assert.equal(native().attemptId, attemptId);
  assert.equal(native().status, "accepted");
  assert.equal(host.exitCode, null);
  assert.equal((await inspectAgentHost({ home, scope: "global", roleName: role.name })).nativeSessionId, nativeSessionId);
});
