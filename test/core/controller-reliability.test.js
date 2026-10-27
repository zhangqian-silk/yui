import assert from "node:assert/strict";
import test from "node:test";
import { ControllerCommandObserver, ControllerWorkObserver } from "../../dist/core/controllerTelemetry.js";
import { parseControllerRuntimeSnapshot } from "../../dist/commands/controllerCommands.js";
import { FileTaskWorkflowRuntime } from "../../dist/controller/clientRuntime.js";
import { createWorkMailbox, enqueueSignal } from "../../dist/coordination/workMailbox.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { FileTaskController } from "../../dist/controller/controller.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";

test("request accounting keeps the oldest exact request through out-of-order completion", () => {
  let clock = 0;
  const observer = new ControllerCommandObserver(() => clock);
  const first = observer.start();
  clock = 10;
  const second = observer.start();
  clock = 20;
  second.complete("builtin", "success");
  assert.equal(observer.snapshot().oldestInFlightAgeMs, 20);
  const snapshot = parseControllerRuntimeSnapshot({ runtime: { commands: {
    routes: observer.snapshot(), dispatcher: { inFlight: 1 }
  } } }, 0);
  assert.equal(snapshot.queueDepth, 1, "dispatcher requests are already counted by routes");
  first.complete("dispatched", "success");
  first.complete("dispatched", "success");
  assert.equal(observer.snapshot().inFlight, 0);
  assert.equal(observer.snapshot().oldestInFlightAgeMs, null);
});

test("local stop observes its cleanup while an unrelated full scan remains blocked", async () => {
  const target = { kind: "global-role-runtime", roleName: "operator" };
  let mailbox = createWorkMailbox(target);
  let session = { nativeSessionId: "original", status: "active" };
  let release;
  const unrelated = new Promise(resolve => { release = resolve; });
  const calls = [];
  const runtime = new FileTaskWorkflowRuntime("/nonexistent-yui-reliability-fixture", {
    getGlobalRole: () => ({}),
    getWorkMailbox: () => mailbox,
    getGlobalRoleSessionSet: () => ({ activeAgentId: "codex", sessions: { codex: session } })
  }, {
    enqueueRuntimeCleanup: () => {
      mailbox = enqueueSignal(mailbox, { reason: "runtime-cleanup-required", refs: [],
        occurredAt: new Date().toISOString() });
      return target;
    }
  }, null, null, undefined, { pollIntervalMs: 1, requestTimeoutMs: 20,
    call: async (_home, method) => {
      calls.push(method);
      mailbox = { ...mailbox, pending: null, processing: null };
      session = { ...session, status: "ended" };
      if (method === "scheduler.scan") await unrelated;
      return { accepted: true };
    }
  });
  try {
    const stop = runtime.stopGlobalRoleSession("operator");
    const outcome = await Promise.race([stop.then(() => "stopped"),
      new Promise(resolve => setImmediate(() => setImmediate(() => resolve("blocked"))))]);
    assert.equal(outcome, "stopped");
    assert.deepEqual(calls, ["scheduler.signal"]);
  } finally { release(); }
});

test("unconfirmed cleanup blocks replacement and retains the obligation", async () => {
  const target = { kind: "global-role-runtime", roleName: "operator" };
  const mailbox = enqueueSignal(createWorkMailbox(target), { reason: "runtime-cleanup-required",
    refs: [], occurredAt: new Date().toISOString() });
  const runtime = new FileTaskWorkflowRuntime("/nonexistent-yui-reliability-fixture", {
    getGlobalRole: () => ({}), getWorkMailbox: () => mailbox
  }, { enqueueRuntimeCleanup: () => target }, null, null, undefined,
  { requestTimeoutMs: 1, pollIntervalMs: 1, call: async () => ({ accepted: true }) });
  await assert.rejects(runtime.stopGlobalRoleSession("operator"),
    /stop remains unconfirmed.*cleanup obligation retained.*No replacement/s);
  assert.equal(mailbox.pending.reasons[0], "runtime-cleanup-required");
});

test("real scheduler cleanup commits before unrelated maintenance drains, without a second stop", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-local-stop-"));
  let controller, store, release;
  const blocked = new Promise(resolve => { release = resolve; });
  t.after(async () => {
    release();
    await controller?.shutdownAndDrain();
    store?.close();
    rmSync(home, { recursive: true, force: true });
  });
  store = new SqliteTaskStore(home);
  const now = new Date();
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  const role = createGlobalRole("operator", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.createGlobalRoleIfAbsent(role);
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "global", roleName: "operator" }, agent.id, now), {
    agentId: agent.id, adapterId: "codex", nativeSessionId: "original",
    policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  }, now));
  const scheduler = new FileSchedulerStoreAdapter(store);
  let stops = 0, maintenanceStarted;
  const maintenance = new Promise(resolve => { maintenanceStarted = resolve; });
  controller = new FileTaskController(scheduler, {}, {
    signalWindowMs: 1,
    lifecycleHost: { stopOwner: async () => { stops++; return true; } },
    resourceAutoGc: async () => { maintenanceStarted(); await blocked; return { skipped: true }; }
  });
  const client = new FileTaskWorkflowRuntime(home, store, scheduler, null, null, undefined,
    { requestTimeoutMs: 1000, pollIntervalMs: 1, call: async (_home, method, params) => {
      assert.equal(method, "scheduler.signal");
      controller.signal(params.key);
      return { accepted: true };
    } });
  const stopping = client.stopGlobalRoleSession("operator");
  const scanning = controller.pump();
  await maintenance;
  // New full-pass demand cannot extend this already-completed stop.
  const laterScan = controller.pump();
  await stopping;
  assert.equal(stops, 1);
  assert.equal(store.getGlobalRoleSessionSet("operator").sessions.codex.status, "ended");
  assert.equal(controller.runtimeMetrics().phases.active.some(p => p.phase === "resource-gc"), true);
  release();
  await Promise.all([scanning, laterScan]);
  assert.equal(stops, 1);
});

test("stage telemetry bounds retained samples and hides raw target data", async () => {
  let clock = 0;
  const observer = new ControllerWorkObserver(() => clock);
  for (let i = 0; i < 40; i++) await observer.observe("projection", "secret-path", () => { clock += 2; });
  const finish = observer.start("host-stop", "session-id");
  clock += 7;
  const snapshot = observer.snapshot();
  assert.equal(snapshot.recent.length, 16);
  assert.equal(snapshot.completed, 40);
  assert.equal(snapshot.active[0].ageMs, 7);
  assert.equal(JSON.stringify(snapshot).includes("secret-path"), false);
  finish(true);
  assert.equal(observer.snapshot().slowest.failed, true);
  assert.equal(observer.snapshot().slowest.phase, "host-stop");
});
