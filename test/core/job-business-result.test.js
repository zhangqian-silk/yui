import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createJobDefinitionControl, authorizeGlobalJobStart } from "../../dist/controller/jobDefinitionControl.js";
import { DurableJobSupervisor, createFileArtifactPort } from "../../dist/controller/jobSupervisor.js";
import { createScheduleControl } from "../../dist/controller/scheduleControl.js";
import { startFileTaskController } from "../../dist/controller/controller.js";
import { runDurableJobCommand } from "../../dist/commands/durableJobCommands.js";
import { startDurableJob, completeDurableJob } from "../../dist/job/durableJob.js";
import { applySqliteMinorUpgrades } from "../../dist/storage/sqliteSchema.js";
import Database from "../../dist/sqlite/driver.js";

test("public controlled Runs need no Session: exact admission, business results and collection without replay", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-business-run-"));
  const store = new SqliteTaskStore(home);
  let controller;
  t.after(async () => { await controller?.close(); store.close(); rmSync(home, { recursive: true, force: true }); });
  const control = createJobDefinitionControl(store, home);
  const base = { scope: { kind: "global" }, caller: { scope: "user" }, id: "probe" };
  const call = (op, input = {}) => control({ ...base, op, ...input }, new Date());
  call("define", { title: "Local probe", configuration: { kind: "builtin", action: "system.noop", input: {} } });
  assert.throws(() => call("run", { caller: { scope: "user", nativeSessionId: "forged" },
    trigger: { source: "manual", key: "bad" } }), /user|public/i);
  assert.throws(() => call("list", { scope: { kind: "task", taskId: "task-1" } }), /Session|scope|Task/i);
  assert.deepEqual(createScheduleControl(store, home)({ ...base, op: "list" }, new Date()), []);
  assert.throws(() => createScheduleControl(store, home)({ ...base, op: "create", jobId: base.id,
    rule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } }, new Date()), /explicit authorization/i);
  let starts = 0;
  const adapter = new FileSchedulerStoreAdapter(store);
  let failCollection = false;
  const supervisor = new DurableJobSupervisor({
    store: { listActiveDurableJobs: () => adapter.listActiveDurableJobs(),
      transitionDurableJob(...args) {
        if (failCollection && args[4]) throw new Error("fixture result persistence failure");
        return adapter.transitionDurableJob(...args);
      } },
    artifacts: createFileArtifactPort(home),
    authorizeStart: run => authorizeGlobalJobStart(store, run),
    onError: error => { throw error; },
    process: {
      spawnJobRunner(specPath) {
        starts++;
        const child = spawnSync(process.execPath,
          [fileURLToPath(new URL("../../dist/job/jobRunner.js", import.meta.url)), specPath],
          { timeout: 4000, encoding: "utf8" });
        assert.equal(child.status, 0, child.stderr);
        return JSON.parse(readFileSync(join(specPath, "..", "ready.json"), "utf8"));
      },
      processStartIdentity: () => undefined, isProcessAlive: () => false,
      signalIfOwned: () => assert.fail("fixture runner already stopped")
    }
  });
  const first = call("run", { trigger: { source: "manual", key: "one" } }).run;
  assert.equal(call("run", { trigger: { source: "manual", key: "one" } }).run.id, first.id);
  assert.equal(call("run", { trigger: { source: "manual", key: "other" } }).reason, "overlap");
  supervisor.reconcile(new Date());
  failCollection = true;
  assert.throws(() => supervisor.reconcile(new Date()), /persistence failure/);
  assert.equal(store.getGlobalJobRun(first.id).status, "running");
  assert.equal(starts, 1);
  failCollection = false;
  rmSync(join(home, first.artifactsLocator, "exit.json"));
  controller = await startFileTaskController(home, adapter, {}, undefined, {
    jobDefinitions: control, jobSupervisor: supervisor, signalWindowMs: 60_000, intervalMs: 60_000
  });
  const command = async op => JSON.parse(await runDurableJobCommand(
    [op, "--global", "--job", "probe", "--run", first.id], { home, environment: {} }));
  assert.equal((await command("run-confirm")).status, "succeeded");
  const result = await command("run-result");
  assert.equal(result.result.outcome, "succeeded");
  assert.equal(result.result.data.action, "system.noop");
  assert.deepEqual(result.result.sourceRun, { scope: { kind: "global" }, runId: first.id });
  assert.equal(result.result.evidence[0].sourceRun.runId, first.id);
  assert.equal(call("run-evidence", { runId: first.id }).processResult.exitCode, 0);
  assert.equal(call("run-evidence", { runId: first.id }).processResult.evidenceSource, "checkpoint");
  supervisor.confirmResult("global", first.id, new Date());
  assert.equal(starts, 1);
  const next = call("run", { trigger: { source: "manual", key: "two" } }).run;
  assert.notEqual(next.id, first.id);
  call("run-cancel", { runId: next.id });
  supervisor.reconcile(new Date());
  assert.equal(call("run-result", { runId: next.id }).result.outcome, "cancelled");
  assert.equal(starts, 1);
  assert.equal(store.listTasks().length, 0);
  assert.equal(store.getGlobalRoleSessionSet("operator"), null);
  assert.equal(store.getWorkMailbox({ kind: "operator" }), null, "public execution must not request an Agent wake");
});

test("1.14 migration adds sourced business results without rewriting original evidence or identities", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-business-migration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let store = new SqliteTaskStore(home);
  const now = new Date();
  const control = createJobDefinitionControl(store, home);
  const base = { scope: { kind: "global" }, caller: { scope: "user" }, id: "probe" };
  control({ ...base, op: "define", title: "Probe", configuration: { kind: "builtin", action: "system.noop", input: {} } }, now);
  const run = control({ ...base, op: "run", trigger: { source: "manual", key: "history" } }, now).run;
  const terminal = completeDurableJob(startDurableJob(run, { pid: 123, startIdentity: "original" }, now),
    { outcome: "succeeded", exitCode: 0, signal: null, steps: [], evidenceSource: "exit-artifact" }, now);
  const { businessResult, ...old } = terminal;
  // A valid previous-version admission came from Operator, never public user.
  old.operation = { ...old.operation, actorId: "global:operator", authorityRef: "historical-session-binding" };
  store.close();
  const bytes = JSON.stringify(old);
  const db = new Database(join(home, "yui.db"));
  try {
    db.prepare("UPDATE global_job_runs SET payload=?,status=? WHERE run_id=?").run(bytes, old.status, old.id);
    db.prepare("UPDATE storage_schema SET minor=14").run();
    applySqliteMinorUpgrades(db, home);
    assert.equal(db.prepare("SELECT minor FROM storage_schema").get().minor, 17);
    assert.equal(db.prepare("SELECT payload FROM storage_migration_archive WHERE migration_version=15 AND record_key=?")
      .get(`global/${old.id}`).payload, bytes);
  } finally { db.close(); }
  store = new SqliteTaskStore(home);
  try {
    const current = store.getGlobalJobRun(old.id);
    const { businessResult: migrated, ...preserved } = current;
    assert.deepEqual(preserved, old);
    assert.equal(migrated.outcome, "succeeded");
    assert.equal(migrated.data, undefined, "migration must not invent business data from log output");
    assert.equal(migrated.sourceRun.runId, old.id);
    const read = createJobDefinitionControl(store, home)({ ...base, op: "run-evidence", runId: old.id }, now);
    assert.deepEqual(read.processResult, old.result);
    assert.equal(read.process.startIdentity, "original");
  } finally { store.close(); }
});
