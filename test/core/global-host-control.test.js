import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { startControllerServer } from "../../dist/core/controllerServer.js";
import { launchBrokerForHome } from "../../dist/runtime/launchBroker.js";
import { inspectAgentHost, reconcileAgentHostTurn, sendAgentHostCancelControl, sendAgentHostSteerControl, sendAgentHostNativeControl } from "../../dist/runtime/agentHost.js";
import { deliverGlobalInputs } from "../../dist/controller/globalInputDelivery.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";
import { runInboxCommand } from "../../dist/commands/inboxCommands.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { publishStructuredProviderTerminal } from "../../dist/controller/structuredProviderObservation.js";
import { createTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { enqueueOperatorEvent } from "../../dist/scheduler/operatorEvent.js";
import { processOperatorInputNotifications } from "../../dist/scheduler/operatorInputNotificationProcessor.js";
import { FileTaskController } from "../../dist/controller/controller.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import { createRuntimeLifecycleDispatcher } from "../../dist/controller/runtime.js";
import { createProviderRetryHooks } from "../../dist/controller/providerRetryDelivery.js";

async function globalHostFixture(t, adapterId = "codex", {
  controlled = true, roleName = "assistant", autoDeliver = false, capacityFailure = false,
  omitTerminalOnce = false, direct = false
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
  const effective = resolveEffectiveLaunch({ store, role, purpose: "execution" });
  const planned = new FileRoleLaunchPlanner(home, store, {
    cliPath: resolve("dist/cli.js"), environment: { HOME: home, PATH: process.env.PATH }
  }).planGlobalRole({ roleName: role.name, agentId: agent.id, adapterId, mode: "new" });
  assert.equal(planned.launch.providerControl.kind, "start");
  assert.equal(planned.launch.providerControl.sessionOnly, true);
  assert.equal(planned.role.workspace, effective.workspace.root);
  const nativeSessionId = adapterId === "codex" ? "fake-thread-1" : planned.launch.providerControl.nativeSessionId;
  const scheduler = new FileSchedulerStoreAdapter(store);
  const lifecycle = createRuntimeLifecycleDispatcher(store, scheduler, {});
  let fakeNow;
  const command = args => {
    const result = runGlobalRoleCommand(args, store, { env: {}, jsonOutput: true });
    return result.kind === "output" ? result.data : result;
  };
  const errors = [];
  const observations = [];
  const inbox = new FileRuntimeEventInbox(home);
  const applyHost = event => {
    observations.push(event.observation);
    assert.ok(event.host, "Host must retain its raw source envelope");
    assert.equal(event.scope, "global");
    assert.equal(event.observation.fence.runId, undefined);
    // These transport/recovery scenarios model successful input handling.
    // Missing-ACK behavior is exercised separately through the same adapter.
    const input = store.getGlobalRoleSessionSet(roleName)?.providerBinding?.run?.input;
    if (event.observation.kind === "turn.completed" && input?.kind === "message") {
      const env = { CODEX_THREAD_ID: nativeSessionId };
      runInboxCommand(["show", input.messageId], store, env);
      runInboxCommand(["claim", input.messageId, "--request-id", `handled:${input.messageId}`], store, env);
      runInboxCommand(["ack", input.messageId, "--request-id", `ack:${input.messageId}`,
        "--reason", "Fixture inspected and handled the original input"], store, env);
    }
    // The Controller clock and native event clock advance together in the
    // recovery fixture; no wall-clock backoff sleep is needed.
    const timed = fakeNow === undefined ? event : { ...event,
      receivedAt: fakeNow.toISOString(),
      observation: { ...event.observation, observedAt: fakeNow.toISOString(), receivedAt: fakeNow.toISOString() }
    };
    const outcome = scheduler.observeAgentHostObservation(timed, fakeNow ?? new Date());
    if (outcome !== "deferred") inbox.acknowledge(event.id);
    return outcome;
  };
  const handleController = (method, params) => {
    if (method === "scheduler.signal") {
      schedulerRuntime?.signal(params.key);
      return {};
    }
    if (method === "runtime.launch-redeem") return launchBrokerForHome(home).redeem(params.ticket);
    if (method === "runtime.provider-turn-begin") {
      return lifecycle(method, { ...params, ...(fakeNow === undefined ? {} : { observedAt: fakeNow.toISOString() }) });
    }
    if (method === "runtime.provider-turn-submission-resolve") {
      return lifecycle(method, params);
    }
    if (method === "runtime.host-observation-apply") {
      const event = inbox.read(params.eventId);
      if (omitTerminalOnce && event?.observation.kind === "turn.completed") {
        omitTerminalOnce = false;
        inbox.acknowledge(event.id);
        return { outcome: "applied" };
      }
      return { outcome: event === null ? "applied" : applyHost(event) };
    }
    if (method === "runtime.observation-apply") assert.fail("Host bypassed raw Inbox ingress");
    return {};
  };
  const startController = async () => {
    controller = await startControllerServer(home, handleController, undefined,
      { release: null, storageBackend: "sqlite", workerEnabled: false });
  };
  await startController();
  const launchPayload = {
    schemaVersion: 1, command: process.execPath,
    args: adapterId === "codex"
      ? [resolve("test/fixtures/fake-codex-app-server-proxy.mjs")]
      : [resolve("test/fixtures/fake-claude-stream.mjs"), nativeSessionId],
    cwd: planned.role.cwd ?? planned.role.workspace,
    childLifecycle: planned.launch.childLifecycle, startMode: "provider",
    environment: { ...planned.launch.env, YUI_FAKE_CONTROLLED: controlled ? "1" : "0",
      ...(direct ? { YUI_FAKE_DIRECT_PORT_FILE: join(home, "direct.port") } : {}),
      ...(capacityFailure ? { YUI_FAKE_CAPACITY_FAILURE: "1" } : {}) },
    providerControl: planned.launch.providerControl
  };
  const startHost = providerControl => {
    const { ticket } = launchBrokerForHome(home).reserve({ ...launchPayload, providerControl });
    host = spawn(process.execPath, ["--input-type=module", "-e",
    `import {runAgentHost} from ${JSON.stringify(new URL("../../dist/runtime/agentHost.js", import.meta.url).href)};
     Object.defineProperty(process.stdin, "isTTY", {value: true});
     await runAgentHost(${JSON.stringify({ home, ticket })});`], {
    cwd: home, env: { PATH: process.env.PATH, HOME: home }, stdio: ["pipe", "pipe", "pipe"]
  });
    host.stdout.on("data", chunk => { output += chunk; });
    host.stderr.on("data", chunk => { logs += chunk; });
  };
  let logs = "";
  let output = "";
  startHost(planned.launch.providerControl);
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
  return { store, home, role, command, submitNext, native, wait, host, errors, observations, scheduler,
    restartQuiescentFixtureHost: async () => {
      assert.equal((await inspectAgentHost({ home, scope: "global", roleName: role.name })).state, "idle");
      host.kill("SIGTERM");
      await once(host, "exit");
      startHost({ ...planned.launch.providerControl, kind: "restore", mode: "resume", nativeSessionId,
        endpointImplementation: { id: `yui.agent-endpoint.${adapterId}`, generation: "previous-compatible-build" } });
      await wait(async () => {
        try { return (await inspectAgentHost({ home, scope: "global", roleName: role.name })).state === "idle"; }
        catch { return false; }
      });
    },
    stopController: async () => { await controller.close(); },
    startController,
    direct: events => new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1",
        port: Number(readFileSync(join(home, "direct.port"), "utf8")) });
      socket.once("error", reject);
      socket.once("connect", () => socket.write(`${JSON.stringify(events)}\n`));
      socket.once("data", () => { socket.end(); resolve(); });
    }),
    environment: planned.launch.env,
    advanceTo: at => { fakeNow = new Date(at); },
    nativeSessionId, output: () => output };
}

test("a stopped fixture Host resumes the same native Session across a compatible build without replay", async t => {
  const f = await globalHostFixture(t, "codex", { controlled: false });
  const message = f.command(["message", "queue", f.role.name, "Original input", "--request-id", "before-refresh"]).message;
  await f.submitNext();
  await f.wait(() => f.native()?.status === "completed");
  const before = structuredClone(f.store.getGlobalRoleSessionSet(f.role.name));
  const role = structuredClone(f.store.getGlobalRole(f.role.name));
  const target = { home: f.home, scope: "global", roleName: f.role.name };
  await f.wait(async () => (await inspectAgentHost(target)).state === "idle");
  await f.restartQuiescentFixtureHost();
  const after = await inspectAgentHost(target);
  assert.equal(after.nativeSessionId, before.sessions[before.activeAgentId].nativeSessionId);
  assert.notEqual(after.endpointImplementation.generation, "previous-compatible-build");
  assert.equal(after.hostImplementation.id, "yui.agent-host");
  assert.ok(after.controlCapabilities.includes("reconcile-turn"));
  assert.deepEqual(f.store.getGlobalRole(f.role.name), role, "No model, account, permissions or workspace change.");
  assert.deepEqual(f.native(), before.providerBinding.run, "Host resume cannot execute the accepted input again.");
  assert.ok(f.store.listGlobalRoleMessages(f.role.name).find(m => m.id === message.id).delivery);
});

test("Desktop direct terminal recovery uses the original observer, across Roles and Controller restart", async t => {
  for (const roleName of ["operator", "assistant"]) {
    const f = await globalHostFixture(t, "codex", {
      controlled: false, roleName, direct: true, omitTerminalOnce: true
    });
    const target = { home: f.home, scope: "global", roleName };
    const event = (method, id, status) => ({ method, params: {
      threadId: f.nativeSessionId, turn: { id, status,
        items: [{ id: "direct-output", type: "agentMessage", text: "Original direct output" }] }
    } });
    await f.direct([event("turn/started", "desktop-1", "inProgress")]);
    await f.wait(() => f.native()?.attemptId === "direct:desktop-1");
    const message = f.command(["message", "queue", roleName, "Queued after Desktop",
      "--request-id", "after-direct"]).message;
    await f.submitNext();
    assert.equal(f.native().attemptId, "direct:desktop-1", "A busy direct writer stays fenced.");
    await f.direct([event("turn/completed", "desktop-1", "completed")]);
    await f.wait(async () => (await inspectAgentHost(target)).state === "idle");
    assert.equal(f.native().status, "accepted", "The original Host observed a terminal omitted from canonical state.");
    const authority = f.store.getGlobalRoleSessionSet(roleName).providerBinding.authority;
    const staleAuthority = await reconcileAgentHostTurn({ ...target, control: {
      protocol: "yui-agent-host-control/v1", type: "reconcile-turn",
      nativeSessionId: f.nativeSessionId, attemptId: "direct:desktop-1", nativeTurnId: "desktop-1",
      authority: { ...authority, epoch: authority.epoch + 1 }
    } });
    assert.equal(staleAuthority.outcome, "rejected");
    for (const identity of [
      { attemptId: "direct:another", nativeTurnId: "desktop-1" },
      { attemptId: "direct:desktop-1", nativeTurnId: "another" },
      { attemptId: "direct:desktop-1" }
    ]) {
      const result = await reconcileAgentHostTurn({ ...target, control: {
        protocol: "yui-agent-host-control/v1", type: "reconcile-turn",
        nativeSessionId: f.nativeSessionId, authority, ...identity
      } });
      assert.equal(result.reconciliation, "unobserved");
      assert.equal(f.native().status, "accepted");
    }
    if (roleName === "operator") {
      // Desktop is not gated by Yui's queue. A newer direct start must not
      // erase the only recovery evidence for the previous accepted Turn.
      await f.direct([event("turn/started", "desktop-successor", "inProgress")]);
      await f.wait(() => f.native()?.attemptId === "direct:desktop-successor");
      await deliverGlobalInputs(f.home, f.store, async () => {}, error => f.errors.push(error),
        { reconcile: true });
      assert.equal(f.native().status, "accepted", "Recovery of A cannot release B's native occupancy.");
      assert.equal(f.store.listGlobalRoleMessages(roleName).find(m => m.id === message.id).delivery, undefined);
      await f.direct([event("turn/completed", "desktop-successor", "completed")]);
      await f.wait(() => f.native().status === "completed");
    }
    await deliverGlobalInputs(f.home, f.store, async () => {}, error => f.errors.push(error),
      { reconcile: true });
    await f.wait(() => f.native()?.attemptId === `global-input:${roleName}/${message.id}`
      && f.native().status === "completed");
    assert.equal(f.native().nativeTurnId, "fake-turn-1", "Direct recovery never submits another native input.");
    assert.ok(f.observations.some(observation => observation.kind === "turn.completed"
      && observation.fence.nativeTurnId === "desktop-1"
      && observation.payload.output === "Original direct output"));
    await f.wait(async () => (await inspectAgentHost(target)).state === "idle");

    // The Host survives a Controller outage. Its immutable Inbox, not a new
    // client or a guessed idle observation, carries the exact direct terminal.
    await f.direct([event("turn/started", "desktop-2", "inProgress")]);
    await f.wait(() => f.native()?.attemptId === "direct:desktop-2");
    const next = f.command(["message", "queue", roleName, "After Controller restart",
      "--request-id", "after-restart"]).message;
    await f.stopController();
    await f.direct([event("turn/completed", "desktop-2", "completed")]);
    await f.wait(async () => (await inspectAgentHost(target)).state === "idle");
    assert.equal(f.native().status, "accepted");
    await f.startController();
    const controller = new FileTaskController(f.scheduler, {}, {
      runtimeEventProcessor: new FileRuntimeEventProcessor(new FileRuntimeEventInbox(f.home), f.scheduler),
      globalInputDelivery: options => deliverGlobalInputs(f.home, f.store, async () => {},
        error => f.errors.push(error), options)
    });
    try {
      await controller.pump();
      await f.wait(() => f.native()?.attemptId === `global-input:${roleName}/${next.id}`
        && f.native().status === "completed");
      assert.equal(f.native().nativeTurnId, "fake-turn-2");
      assert.equal(f.store.listGlobalRoleMessages(roleName).filter(m => m.delivery).length, 2);
      assert.deepEqual(f.errors, []);
    } finally { await controller.shutdownAndDrain(); }
  }
});

test("capacity recovery traverses Controller, real Host and Codex adapter on the same systemError Session", async t => {
  const f = await globalHostFixture(t, "codex", { controlled: false, capacityFailure: true });
  const original = f.command(["message", "queue", f.role.name, "Preserve existing work",
    "--request-id", "capacity-recovery"]).message;
  const binding = () => f.store.getGlobalRoleSessionSet(f.role.name).providerBinding;
  await f.submitNext();
  await f.wait(() => binding().retry?.status === "waiting");
  assert.equal(f.native().status, "failed");
  const failed = structuredClone(binding().retry);
  assert.equal(failed.error.retryable, true);
  assert.equal(JSON.parse(failed.error.raw).codexErrorInfo, "serverOverloaded");
  const now = new Date(failed.nextEligibleAt);
  f.advanceTo(now);
  const hooks = createProviderRetryHooks(f.home, f.store, { now: () => now, monotonicNow: () => 0 });
  await hooks.reconcile();
  await f.wait(() => binding().retry?.status === "recovered").catch(error => {
    throw new Error(JSON.stringify(binding()), { cause: error });
  });
  await hooks.reconcile();
  assert.equal(f.native().nativeTurnId, "fake-turn-2");
  assert.equal(binding().retry.attempts, 1);
  assert.equal(binding().retry.failedNativeTurnId, "fake-turn-1");
  assert.equal(binding().retry.nativeSessionId, f.nativeSessionId);
  assert.deepEqual(binding().retry.input, { kind: "message", roleName: f.role.name, messageId: original.id });
  assert.deepEqual(f.errors, []);
});

test("periodic Global recovery republishes only the original Host's exact missing terminal", async t => {
  const f = await globalHostFixture(t, "codex", {
    controlled: false, roleName: "operator", omitTerminalOnce: true
  });
  const first = f.command(["message", "queue", "operator", "first", "--request-id", "missing-terminal"]).message;
  await f.submitNext();
  await f.wait(async () => (await inspectAgentHost({
    home: f.home, scope: "global", roleName: "operator"
  })).state === "idle");
  assert.equal(f.native().status, "accepted", "Host finished but the canonical terminal is missing.");
  const original = structuredClone(f.native());
  const authority = f.store.getGlobalRoleSessionSet("operator").providerBinding.authority;
  const stale = await reconcileAgentHostTurn({
    home: f.home, scope: "global", roleName: "operator",
    control: { protocol: "yui-agent-host-control/v1", type: "reconcile-turn",
      nativeSessionId: f.nativeSessionId, attemptId: original.attemptId,
      nativeTurnId: "another-native-turn", authority }
  });
  assert.equal(stale.reconciliation, "unobserved");
  assert.deepEqual(f.native(), original);
  const wrongAuthority = await reconcileAgentHostTurn({
    home: f.home, scope: "global", roleName: "operator",
    control: { protocol: "yui-agent-host-control/v1", type: "reconcile-turn",
      nativeSessionId: f.nativeSessionId, attemptId: original.attemptId,
      nativeTurnId: original.nativeTurnId, authority: { ...authority, epoch: authority.epoch + 1 } }
  });
  assert.equal(wrongAuthority.outcome, "rejected");
  assert.deepEqual(f.native(), original);
  await deliverGlobalInputs(f.home, f.store, async () => assert.fail("Recovery must not launch"),
    error => f.errors.push(error), { reconcile: true });
  assert.equal(f.native().status, "completed", "The final Turn recovers even without queued successor input.");
  assert.equal(f.native().nativeTurnId, original.nativeTurnId);
  const next = f.command(["message", "queue", "operator", "next", "--request-id", "next"]).message;
  const controller = new FileTaskController(f.scheduler, {}, {
    globalInputDelivery: options => deliverGlobalInputs(f.home, f.store, async () => {},
      error => f.errors.push(error), options)
  });
  try {
    await controller.pump();
    await f.wait(() => f.native()?.attemptId === `global-input:operator/${next.id}` && f.native().status === "completed");
    await controller.pump();
    assert.equal(f.native().nativeTurnId, "fake-turn-2", "Reconciliation is not another model turn.");
    assert.ok(f.store.listGlobalRoleMessages("operator").find(m => m.id === first.id).delivery);
    assert.deepEqual(f.errors, []);
  } finally { await controller.shutdownAndDrain(); }
});

test("Host retains full direct terminals through persistence failure and does not release a newer writer", async t => {
  const f = await globalHostFixture(t, "codex", { roleName: "operator", direct: true });
  const target = { home: f.home, scope: "global", roleName: f.role.name };
  const event = (method, id) => ({ method, params: { threadId: f.nativeSessionId,
    turn: { id, status: method === "turn/started" ? "inProgress" : "completed",
      items: [{ id: `output-${id}`, type: "agentMessage", text: `Full result ${id}\n中文` }] } } });
  await f.direct([event("turn/started", "disk-a")]);
  await f.wait(() => f.native()?.attemptId === "direct:disk-a");
  const authority = f.store.getGlobalRoleSessionSet(f.role.name).providerBinding.authority;
  await f.stopController();
  const inboxPath = join(f.home, "runtime", "inbox");
  renameSync(inboxPath, `${inboxPath}-saved`);
  writeFileSync(inboxPath, "fixture: persistence unavailable");
  await f.direct([event("turn/completed", "disk-a")]);
  await f.wait(async () => (await inspectAgentHost(target)).eventDelivery?.failure?.stage === "persistence");
  await f.direct([event("turn/started", "disk-b"), event("turn/completed", "disk-b"),
    event("turn/started", "disk-c")]);
  await f.wait(async () => (await inspectAgentHost(target)).nativeTurnId === "disk-c");
  rmSync(inboxPath);
  renameSync(`${inboxPath}-saved`, inboxPath);
  await f.startController();
  const result = await reconcileAgentHostTurn({ ...target, control: {
    protocol: "yui-agent-host-control/v1", type: "reconcile-turn",
    nativeSessionId: f.nativeSessionId, attemptId: "direct:disk-a", nativeTurnId: "disk-a", authority
  } });
  assert.notEqual(result.outcome, "rejected");
  const processor = new FileRuntimeEventProcessor(new FileRuntimeEventInbox(f.home), f.scheduler);
  assert.deepEqual(processor.drain(new Date()).failed, []);
  for (const id of ["disk-a", "disk-b"]) {
    assert.ok(f.observations.some(observation => observation.kind === "turn.completed"
      && observation.fence.nativeTurnId === id && observation.payload.output === `Full result ${id}\n中文`),
    `Full terminal ${id} must survive the next native turn.`);
  }
  assert.equal(f.native().attemptId, "direct:disk-c");
  assert.equal(f.native().status, "accepted");
  const recovered = await inspectAgentHost(target);
  assert.equal(recovered.state, "busy");
  assert.equal(recovered.eventDelivery.failure, undefined, "A repaired persistence path must stop reporting the old failure.");
});

test("Operator natural terminals settle through Host and Inbox and automatically wake the next Global input", async t => {
  const f = await globalHostFixture(t, "codex", {
    controlled: false, roleName: "operator", autoDeliver: true, direct: true
  });
  await f.direct([{ method: "turn/started", params: {
    threadId: f.nativeSessionId, turn: { id: "desktop-normal", status: "inProgress" }
  } }]);
  await f.wait(() => f.native()?.attemptId === "direct:desktop-normal");
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
  assert.equal(f.native().attemptId, "direct:desktop-normal");
  await f.direct([{ method: "turn/completed", params: {
    threadId: f.nativeSessionId, turn: { id: "desktop-normal", status: "completed", items: [] }
  } }]);
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

test("real Host adopts a model on the same idle Operator Thread and refuses active or stale targets", async t => {
  const f = await globalHostFixture(t, "codex", { roleName: "operator" });
  const set = (id, model) => sendAgentHostNativeControl({
    home: f.home, scope: "global", roleName: "operator",
    control: { protocol: "yui-agent-host-control/v1", type: "native-model", nativeSessionId: id, model }
  });
  assert.equal((await set("stale-thread", "fixture-new")).outcome, "rejected");
  const changed = await set(f.nativeSessionId, "fixture-new");
  assert.equal(changed.outcome, "accepted", JSON.stringify(changed));
  assert.equal(changed.snapshot.nativeSessionId, f.nativeSessionId);
  assert.equal(changed.snapshot.runConfiguration.axes[0].current.value, "fixture-new");
  f.command(["message", "queue", "operator", "ordinary input after adoption", "--request-id", "model-input"]);
  await f.submitNext();
  await f.wait(() => f.native()?.status === "accepted");
  assert.equal((await set(f.nativeSessionId, "fixture-too-late")).outcome, "rejected");
  const observed = await inspectAgentHost({ home: f.home, scope: "global", roleName: "operator" });
  assert.equal(observed.runConfiguration.axes[0].current.value, "fixture-new");
  assert.equal(f.native().nativeTurnId, observed.nativeTurnId);
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
    control: { protocol: "yui-agent-host-control/v1", type: "steer-turn", nativeSessionId: steer.target.nativeSessionId,
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
    control: { protocol: "yui-agent-host-control/v1", type: "cancel", nativeOnly: true, nativeSessionId: cancel.target.nativeSessionId,
      attemptId: cancel.target.attemptId, authority: cancel.target.authority } });
  await wait(() => native().status === "cancelled");
  await submitNext();
  await wait(() => native().attemptId === `global-input:${role.name}/${next.id}` && native().status === "accepted");
  await submitNext();
  assert.equal(store.listGlobalRoleMessages(role.name).find(m => m.id === queue.id).delivery, undefined);
  const stopNext = command(["interrupt", role.name, "--expected-target", native().nativeTurnId, "--request-id", "stop-m"]);
  await sendAgentHostCancelControl({ home, scope: "global", roleName: role.name,
    control: { protocol: "yui-agent-host-control/v1", type: "cancel", nativeOnly: true, nativeSessionId: stopNext.target.nativeSessionId,
      attemptId: stopNext.target.attemptId, authority: stopNext.target.authority } });
  await wait(() => native().status === "cancelled");
  await submitNext();
  await wait(() => native().attemptId === `global-input:${role.name}/${queue.id}` && native().status === "accepted");
  await sendAgentHostCancelControl({ home, scope: "global", roleName: role.name,
    control: { protocol: "yui-agent-host-control/v1", type: "cancel", nativeOnly: true,
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
    control: { protocol: "yui-agent-host-control/v1", type: "cancel", nativeOnly: true, nativeSessionId, attemptId,
      authority: { epoch: 1, owner: "controller", holderId: "controller" } } });
  assert.equal(result.outcome, "rejected");
  assert.match(result.failure.detail, /cannot natively interrupt/);
  assert.equal(native().attemptId, attemptId);
  assert.equal(native().status, "accepted");
  assert.equal(host.exitCode, null);
  assert.equal((await inspectAgentHost({ home, scope: "global", roleName: role.name })).nativeSessionId, nativeSessionId);
});
