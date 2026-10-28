import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControllerDiagnosticJournal } from "../../dist/controller/diagnosticJournal.js";
import { startFileTaskControllerRuntime } from "../../dist/controller/runtime.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { callController } from "../../dist/core/controllerClient.js";
import { createProject } from "../../dist/repository/project.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { bindGlobalRoleProviderRuntime, createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { createProviderRuntimeBinding } from "../../dist/runtime/providerRuntimeIdentity.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";

test("production scheduler maintenance waits for a write lock without blocking status", async t => {
  const home = await mkdtemp(join(tmpdir(), "yui-scheduler-lock-"));
  const held = new Int32Array(new SharedArrayBuffer(4));
  let running, holder, pump;
  t.after(async () => {
    holder?.postMessage("release");
    await pump?.catch(() => undefined);
    await holder?.terminate();
    await running?.close();
    await rm(home, { recursive: true, force: true });
  });
  running = await startFileTaskControllerRuntime(home, {
    environment: { ...process.env, YUI_STORE_WORKER: "1" }, intervalMs: 60_000,
    now: () => new Date("2026-10-28T01:00:00Z")
  });
  await running.runtime.pump();
  running.store.saveProject(createProject("project-1", "Isolated", join(home, "projects/project-1"),
    { stable: "main", development: "main" }, new Date("2026-10-28T01:00:00Z"),
    { ownership: "managed", remoteUrl: "/nonexistent-local-fixture.git" }));
  const now = new Date("2026-10-28T01:00:00Z");
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  running.store.saveConfiguredAgent(agent);
  for (const name of ["operator", "assistant"]) {
    const role = createGlobalRole(name, [createRoleAgentBinding(agent)], agent.id, home, now);
    running.store.createGlobalRoleIfAbsent(role);
    const sessions = recordRoleAgentSession(createRoleSessionSet(
      { scope: "global", roleName: name }, agent.id, now), {
      agentId: agent.id, adapterId: "codex", nativeSessionId: `${name}-idle`,
      policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
    }, now);
    running.store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(sessions,
      createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
        conversationId: `${name}-idle`, startedAt: now.toISOString() }), now));
  }
  holder = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const {default: Database} = await import(workerData.driver);
      const db = new Database(workerData.file);
      const held = new Int32Array(workerData.held);
      db.exec("BEGIN IMMEDIATE");
      Atomics.store(held, 0, 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        db.exec("ROLLBACK");
        Atomics.store(held, 0, 0);
        db.close();
      };
      parentPort.on("message", release);
      parentPort.postMessage("locked");
    })();
  `, { eval: true, workerData: {
    driver: new URL("../../dist/sqlite/driver.js", import.meta.url).href,
    file: join(home, "yui.db"), held: held.buffer
  } });
  await once(holder, "message");
  const started = performance.now();
  let settled = false;
  pump = running.runtime.pump().finally(() => { settled = true; });
  void pump.catch(() => undefined); // failure is asserted below/awaited; teardown releases the lock
  // Wait for the real maintenance RPC, not a timer racing a pass that has not
  // reached the write boundary. The other connection releases on our command.
  const deadline = performance.now() + 2000;
  while (!settled && performance.now() < deadline &&
    !running.runtime.runtimeMetrics().persistence.worker.roundTrips.active
      .some(entry => entry.phase === "store-observer")) await yieldLoop();
  assert.equal(settled, false, "maintenance must still be waiting for the held lock");
  await callController(home, "controller.status", {}, { timeoutMs: 2000 });
  assert.ok(performance.now() - started < 2000,
    "idle Global recovery must not block the event loop before status can even start");
  assert.equal(Atomics.load(held, 0), 1, "status responds before the independent writer releases");
  holder.postMessage("release");
  await pump;
  const schedule = running.store.getSchedule({ kind: "global" }, "project-sync-project-1");
  assert.ok(schedule, "the original transaction still commits after lock release");
  await running.runtime.pump();
  assert.deepEqual(running.store.getSchedule({ kind: "global" }, schedule.id), schedule,
    "another pass does not rewrite the unchanged schedule");
});

test("Controller diagnostics survive restart, rotate, redact and isolate filesystem failure", async t => {
  const home = await mkdtemp(join(tmpdir(), "yui-diagnostic-journal-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const journal = new ControllerDiagnosticJournal(home, { maxBytes: 1800 });
  const secret = "private prompt token=do-not-record /home/private";
  journal.error(Object.assign(new Error(secret), { code: "SQLITE_BUSY" }));
  journal.sample({ commands: { observations: { completed: 1, recent: [{
    phase: "controller.status", target: "0123456789abcdef", elapsedMs: 5200, failed: false
  }] } }, arbitrary: secret }, 1500);
  await journal.flush();
  const file = join(home, "runtime", "controller-diagnostics.jsonl");
  const original = await readFile(file, "utf8");
  assert.doesNotMatch(original, /private|do-not-record/);
  const records = original.trim().split("\n").map(JSON.parse);
  assert.equal(records[0].error.code, "SQLITE_BUSY");
  assert.equal(records[1].snapshot.commands.observations.recent[0].target, "0123456789abcdef");
  assert.equal(records[1].lagMs, 1500);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  for (let i = 0; i < 12; i++) { journal.error(new Error(`sample-${i}`)); await journal.flush(); }
  await journal.close();
  assert.deepEqual((await readdir(join(home, "runtime"))).sort(),
    ["controller-diagnostics.jsonl", "controller-diagnostics.jsonl.1", "controller-diagnostics.jsonl.2"]);
  for (const name of await readdir(join(home, "runtime"))) {
    assert.ok((await stat(join(home, "runtime", name))).size <= 1800);
  }
  const successor = new ControllerDiagnosticJournal(home, { maxBytes: 1800 });
  successor.error(new Error("successor"));
  await successor.close();
  assert.notEqual(JSON.parse((await readFile(file, "utf8")).trim().split("\n").at(-1)).instance,
    records[0].instance);
  // Not a database, and an unwritable/invalid path must never fail business work.
  const broken = new ControllerDiagnosticJournal(file);
  broken.error(new Error(secret));
  await broken.close();
  assert.equal(broken.metrics().writeFailures, 1);
  await rm(file);
  const outside = join(home, "untouched");
  await writeFile(outside, "not-a-log");
  await symlink(outside, file);
  const symlinked = new ControllerDiagnosticJournal(home);
  symlinked.error(new Error("must not follow"));
  await symlinked.close();
  assert.equal(symlinked.metrics().writeFailures, 1);
  assert.equal(await readFile(outside, "utf8"), "not-a-log");
});

test("diagnostics bound admission and persist new failures without waiting for a status request", async t => {
  const home = await mkdtemp(join(tmpdir(), "yui-diagnostic-admission-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const journal = new ControllerDiagnosticJournal(home);
  for (let i = 0; i < 100; i++) journal.error(new Error("same"));
  assert.ok(journal.metrics().pending <= 32);
  assert.ok(journal.metrics().dropped > 0);
  await journal.flush();
  const before = journal.metrics().written;
  const snapshot = { persistence: { database: { lock: { latest: {
    startedAtMs: 1, elapsedMs: 1300, phase: "write-lock", target: null, failed: false
  } } } } };
  journal.observe(snapshot, 0);
  await journal.flush();
  assert.equal(journal.metrics().written, before + 1);
  journal.observe(snapshot, 0);
  await journal.close();
  assert.equal(journal.metrics().written, before + 1, "do not repeatedly log an old maximum");
});

test("production runtime records scheduler errors and closes its diagnostic writer", async t => {
  const home = await mkdtemp(join(tmpdir(), "yui-diagnostic-runtime-"));
  let store, running;
  t.after(async () => { await running?.close(); store?.close(); await rm(home, { recursive: true, force: true }); });
  store = new SqliteTaskStore(home);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const failure = new Error("private fixture scheduler error");
  schedulerStore.listActiveTaskIds = () => { throw failure; };
  running = await startFileTaskControllerRuntime(home, {
    store, schedulerStore, environment: { ...process.env, YUI_STORE_WORKER: "0" },
    intervalMs: 60_000
  });
  await running.runtime.pump().catch(() => undefined);
  await running.close();
  const records = (await readFile(join(home, "runtime", "controller-diagnostics.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.ok(records.some(record => record.error?.fingerprint ===
    createHash("sha256").update(failure.message).digest("hex")));
  assert.ok(running.runtime.runtimeMetrics().diagnostics.written > 0);
  assert.equal(running.runtime.runtimeMetrics().diagnostics.writeFailures, 0);
});
