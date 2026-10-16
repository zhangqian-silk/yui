import assert from "node:assert/strict";
import test from "node:test";
import { createJobDefinition, reviseJobDefinition } from "../../dist/job/jobDefinition.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createJobDefinitionControl, authorizeGlobalJobStart } from "../../dist/controller/jobDefinitionControl.js";
import { DurableJobSupervisor, createFileArtifactPort } from "../../dist/controller/jobSupervisor.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createTask } from "../../dist/task/task.js";
import { createDurableJob, startDurableJob, completeDurableJob } from "../../dist/job/durableJob.js";
import { applySqliteMinorUpgrades } from "../../dist/storage/sqliteSchema.js";
import Database from "../../dist/sqlite/driver.js";
import { usePre19Layout } from "../helpers/pre19Storage.mjs";
import { processOperatorInputNotifications } from "../../dist/scheduler/operatorInputNotificationProcessor.js";
import { startFileTaskController } from "../../dist/controller/controller.js";
import { runDurableJobCommand } from "../../dist/commands/durableJobCommands.js";

test("Job configuration revisions preserve ownership and previous snapshots", () => {
  const at = new Date("2026-10-16T00:00:00Z");
  const job = createJobDefinition({
    id: "definition-1", scope: { kind: "global" }, title: "Probe",
    configuration: { kind: "builtin", action: "system.noop", input: {} }
  }, at);
  const next = reviseJobDefinition(job, { title: "Second probe",
    configuration: { kind: "builtin", action: "system.noop", input: {} } }, at);
  assert.equal(next.id, job.id);
  assert.equal(next.revision, 2);
  assert.equal(job.revision, 1);
  assert.equal(job.title, "Probe");
  assert.deepEqual(next.scope, { kind: "global" });
  assert.throws(() => createJobDefinition({ ...job,
    configuration: { kind: "shell", steps: [{ name: "unsafe", command: "true" }] }
  }, at), /global.*builtin/i);
});

test("global Runs reuse the runner, retain independent results, reject Task callers and never replay uncertainty", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-global-job-"));
  const store = new SqliteTaskStore(home);
  let controller;
  t.after(async () => { await controller?.close(); store.close(); rmSync(home, { recursive: true, force: true }); });
  const at = new Date();
  const agent = createConfiguredAgent("codex", "codex", "false", [], [], at);
  store.saveConfiguredAgent(agent);
  const role = createGlobalRole("operator", [createRoleAgentBinding(agent)], agent.id, home, at);
  store.createGlobalRoleIfAbsent(role);
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "global", roleName: "operator" }, agent.id, at
  ), { agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: "operator-test",
    status: "active", policy: "fixed", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, at));
  const caller = { scope: "global", role: "operator", nativeSessionId: "operator-test" };
  const control = createJobDefinitionControl(store, home);
  const base = { scope: { kind: "global" }, id: "noop", caller };
  controller = await startFileTaskController(home, new FileSchedulerStoreAdapter(store), {}, undefined, {
    jobDefinitions: control, signalWindowMs: 60_000, intervalMs: 60_000
  });
  const command = async (op, ...args) => JSON.parse(await runDurableJobCommand(
    [op, "--global", "--job", base.id, ...args], {
      home, environment: { YUI_SESSION_SCOPE: "global", YUI_ROLE: "operator", YUI_NATIVE_SESSION_ID: "operator-test" }
    }));
  assert.equal((await command("define", "--title", "Probe", "--input",
    JSON.stringify({ kind: "builtin", action: "system.noop", input: {} }))).id, base.id);
  assert.equal((await command("show")).revision, 1);
  for (const bad of [{ scope: "task", taskId: "task-1", role: "leader" }, { scope: "user" },
    { ...caller, nativeSessionId: "revoked" }]) {
    assert.throws(() => control({ ...base, op: "run", caller: bad, trigger: { source: "manual", key: "deny" } }, at));
  }
  assert.equal(store.listGlobalJobRuns().length, 0);
  let starts = 0;
  const supervisor = () => new DurableJobSupervisor({
    store: new FileSchedulerStoreAdapter(store), artifacts: createFileArtifactPort(home),
    authorizeStart: run => authorizeGlobalJobStart(store, run),
    onError: error => { throw error; },
    process: {
      spawnJobRunner(specPath) {
        starts++;
        const result = spawnSync(process.execPath,
          [fileURLToPath(new URL("../../dist/job/jobRunner.js", import.meta.url)), specPath],
          { timeout: 4000, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr || String(result.error));
        return JSON.parse(readFileSync(join(specPath, "..", "ready.json"), "utf8"));
      },
      processStartIdentity: () => undefined, isProcessAlive: () => false,
      signalIfOwned: () => { throw new Error("No process remains after synchronous fixture execution."); }
    }
  });
  const first = await command("run", "--request-id", "one");
  assert.equal(first.created, true);
  assert.equal("taskId" in first.run, false);
  assert.equal((await command("runs"))[0].id, first.run.id);
  await controller.close();
  controller = undefined;
  assert.equal(control({ ...base, op: "run", trigger: { source: "manual", key: "two" } }, at).reason, "overlap");
  supervisor().reconcile(new Date());
  // A replacement supervisor recovers exactly the original process/result.
  supervisor().reconcile(new Date());
  const original = control({ ...base, op: "run-get", runId: first.run.id }, at);
  assert.equal(original.status, "succeeded");
  assert.equal(original.result.evidenceSource, "exit-artifact");
  assert.match(control({ ...base, op: "logs", runId: first.run.id }, at)[0].text, /completed/);
  const second = control({ ...base, op: "run", trigger: { source: "manual", key: "two" } }, at);
  assert.notEqual(second.run.id, original.id);
  supervisor().reconcile(new Date());
  supervisor().reconcile(new Date());
  assert.deepEqual(store.getGlobalJobRun(original.id), original);
  assert.equal(starts, 2);
  assert.equal(store.listTasks().length, 0, "Global execution must never fabricate a Task.");
  assert.ok(store.getWorkMailbox({ kind: "operator" }));
  const noticeStore = new FileSchedulerStoreAdapter(store);
  let presentation;
  noticeStore.queueOperatorNotification = input => { presentation = input.text; return { status: "unavailable" }; };
  const notices = await processOperatorInputNotifications(noticeStore, undefined, new Date());
  assert.equal(notices.length, 2);
  assert.equal(notices[0].sourceKind, "global-job-run");
  assert.equal(notices[0].taskId, undefined);
  assert.match(presentation, /job run-get --global --job noop --run job-/);
  const third = control({ ...base, op: "run", trigger: { source: "manual", key: "unknown" } }, at).run;
  store.saveGlobalJobRun({ ...third, operation: { ...third.operation, effect: "possible" } });
  supervisor().reconcile(new Date());
  assert.equal(store.getGlobalJobRun(third.id).status, "unknown-needs-attention");
  assert.equal(control({ ...base, op: "run", trigger: { source: "manual", key: "no-replay" } }, at).reason, "overlap");
  assert.equal(starts, 2);
  const other = { ...base, id: "revoked-probe" };
  control({ ...other, op: "define", title: "Revoked", configuration: { kind: "builtin", action: "system.noop", input: {} } }, at);
  const revoked = control({ ...other, op: "run", trigger: { source: "manual", key: "revoked" } }, at).run;
  const sessionSet = store.getGlobalRoleSessionSet("operator");
  store.saveGlobalRoleSessionSet({ ...sessionSet, sessions: {
    ...sessionSet.sessions, codex: { ...sessionSet.sessions.codex, nativeSessionId: "replacement" }
  } });
  supervisor().reconcile(new Date());
  assert.equal(store.getGlobalJobRun(revoked.id).status, "failed");
  assert.equal(starts, 2);
});

test("1.8 migration preserves exact execution IDs, original bytes and results without grouping identical commands", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-job-migration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const at = new Date("2026-10-16T00:00:00Z");
  const store = new SqliteTaskStore(home);
  store.saveTask(createTask("task-1", "Historical Jobs", at));
  const originals = [];
  for (const id of ["job-1", "job-2"]) {
    let run = createDurableJob({
      id, taskId: "task-1", owner: { kind: "task" }, projectId: "project-1",
      head: "a".repeat(40), workspace: home, env: {}, steps: [{ name: "check", command: "true" }],
      artifactsLocator: `artifacts/jobs/task-1/${id}`,
      operation: { requestId: id, actorId: "global:operator", authorityRef: "authority", inputDigest: "b".repeat(64) }
    }, at);
    run = startDurableJob(run, { pid: 123, startIdentity: "historical" }, at);
    run = completeDurableJob(run, { outcome: "succeeded", exitCode: 0, signal: null, steps: [] }, at);
    store.saveDurableJob("task-1", run);
    const { definitionId, definitionRevision, trigger, ...original } = run;
    originals.push(original);
  }
  store.close();
  const db = new Database(join(home, "yui.db"));
  try {
    usePre19Layout(db);
    db.prepare("UPDATE storage_schema SET minor=8").run();
    for (const original of originals) db.prepare("UPDATE durable_jobs SET payload=? WHERE job_id=?")
      .run(JSON.stringify(original), original.id);
    applySqliteMinorUpgrades(db, home);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_definitions").get().n, 2);
    for (const original of originals) {
      const run = JSON.parse(db.prepare("SELECT payload FROM durable_jobs WHERE job_id=?").get(original.id).payload);
      assert.equal(run.id, original.id);
      assert.equal(run.definitionId, original.id);
      assert.deepEqual(run.result, original.result);
      const archived = db.prepare("SELECT payload FROM storage_migration_archive WHERE family='durable_jobs' AND record_key=?")
        .get(`task-1/${original.id}`).payload;
      assert.equal(archived, JSON.stringify(original));
    }
  } finally { db.close(); }
  const current = new SqliteTaskStore(home);
  try {
    assert.equal(current.listJobDefinitions({ kind: "task", taskId: "task-1" }).length, 2);
    assert.equal(current.getDurableJob("task-1", "job-1").result.outcome, "succeeded");
  } finally { current.close(); }
});
