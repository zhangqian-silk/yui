import assert from "node:assert/strict";
import test from "node:test";
import { nextScheduleDue, validateScheduleRule } from "../../dist/schedule/schedule.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installDevLauncher } from "../../scripts/manage-dev-launcher.mjs";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createJobDefinitionControl } from "../../dist/controller/jobDefinitionControl.js";
import { createScheduleControl, reconcileSchedules } from "../../dist/controller/scheduleControl.js";
import { cancelQueuedDurableJob } from "../../dist/job/durableJob.js";
import { startFileTaskController } from "../../dist/controller/controller.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import Database from "../../dist/sqlite/driver.js";
import { usePre114Layout } from "../helpers/pre19Storage.mjs";
import { applySqliteMinorUpgrades, JOB_SCHEMA_CHECKSUM, validateSqliteSchemaObjects } from "../../dist/storage/sqliteSchema.js";

test("Schedule time rules keep interval anchors and explicit cron DST semantics", () => {
  const rule = { kind: "interval", anchor: "2026-01-01T00:00:00Z", everyMs: 60_000 };
  assert.equal(nextScheduleDue(rule, new Date("2026-01-01T00:03:20Z")), "2026-01-01T00:04:00.000Z");
  assert.equal(nextScheduleDue(rule, new Date("2025-12-31T23:00:00Z")), "2026-01-01T00:00:00.000Z");
  const cron = { kind: "cron", expression: "30 2 * * *", timezone: "America/New_York" };
  assert.equal(nextScheduleDue(cron, new Date("2026-03-08T00:00:00Z")), "2026-03-08T07:30:00.000Z");
  const fall = { ...cron, expression: "30 1 * * *" };
  assert.equal(nextScheduleDue(fall, new Date("2026-11-01T00:00:00Z")), "2026-11-01T05:30:00.000Z");
  assert.equal(nextScheduleDue(fall, new Date("2026-11-01T05:30:00Z")), "2026-11-02T06:30:00.000Z");
  assert.throws(() => validateScheduleRule({ ...cron, timezone: "not/a-zone" }));
  assert.throws(() => validateScheduleRule({ ...cron, expression: "H * * * *" }));
  assert.doesNotThrow(() => validateScheduleRule({ ...cron, expression: "0 9 * * THU" }));
  assert.throws(() => validateScheduleRule({ ...rule, everyMs: 0 }));
  assert.throws(() => validateScheduleRule({ kind: "once", at: "2026-10-01T09:00:00" }));
});

test("persistent Schedule RPC: atomic admission, bounded catch-up, overlap, disable and authority revocation", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-schedule-"));
  let store, controller;
  t.after(async () => { await controller?.close(); store?.close(); rmSync(home, { recursive: true, force: true }); });
  store = new SqliteTaskStore(home);
  const at = new Date("2026-10-16T00:00:00Z");
  const atMinute = n => new Date(at.getTime() + n * 60_000);
  const agent = createConfiguredAgent("codex", "codex", "false", [], [], at);
  store.saveConfiguredAgent(agent);
  const role = createGlobalRole("operator", [createRoleAgentBinding(agent)], agent.id, home, at);
  store.createGlobalRoleIfAbsent(role);
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "global", roleName: "operator" }, agent.id, at
  ), { agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: "schedule-test",
    status: "active", policy: "fixed", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, at));
  const caller = { scope: "global", role: "operator", nativeSessionId: "schedule-test" };
  const scope = { kind: "global" };
  const job = { scope, id: "noop", caller };
  let jobs = createJobDefinitionControl(store, home);
  jobs({ ...job, op: "define", title: "No-op", configuration: { kind: "builtin", action: "system.noop", input: {} } }, at);
  let control = createScheduleControl(store, home);
  let clock = at;
  controller = await startFileTaskController(home, new FileSchedulerStoreAdapter(store), {}, undefined, {
    schedules: { control, reconcile: now => reconcileSchedules(store, home, now) }, now: () => clock,
    intervalMs: 60_000, signalWindowMs: 60_000
  });
  const { launcherPath } = installDevLauncher({ projectRoot: process.cwd(), outputDir: join(home, "dev") });
  const command = async (op, id, ...args) => {
    const { stdout } = await promisify(execFile)(launcherPath, [
      "schedule", op, "--global", "--schedule", id, ...args, "--json"
    ], { timeout: 10_000, env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, YUI_HOME: home,
      CODEX_THREAD_ID: "schedule-test", YUI_SESSION_SCOPE: "global", YUI_ROLE: "operator",
      YUI_NATIVE_SESSION_ID: "schedule-test", YUI_STORE_WORKER: "false"
    } });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.ok(Object.hasOwn(result, "data"), "real CLI must return structured data, not JSON in output");
    return result.data;
  };
  const once = await command("create", "once", "--job", job.id, "--rule",
    JSON.stringify({ kind: "once", at: atMinute(1).toISOString() }));
  assert.equal((await command("show", "once")).schedule.id, once.id);
  assert.equal((await command("list", "once"))[0].id, once.id);
  const manual = jobs({ ...job, op: "run", trigger: { source: "manual", key: "manual" } }, at);
  clock = atMinute(1);
  await controller.runtime.pump();
  assert.equal(store.getSchedule(scope, "once").lastAttempt.outcome, "overlap", "Controller invokes Schedule reconciliation");
  await controller.close(); controller = undefined;
  const request = (op, id, extra = {}) => ({ op, id, scope, caller, ...extra });
  const tick = n => reconcileSchedules(store, home, atMinute(n), error => { throw error; });
  const cancel = run => store.saveGlobalJobRun(cancelQueuedDurableJob(run, new Date(run.updatedAt)));
  tick(0); assert.equal(store.listGlobalJobRuns().length, 1);
  tick(1);
  assert.equal(store.getSchedule(scope, "once").lastAttempt.outcome, "overlap");
  assert.equal(store.getSchedule(scope, "once").nextDue, atMinute(1).toISOString());
  cancel(manual.run);
  tick(2);
  const onceRun = store.listGlobalJobRuns().find(run => run.trigger.source === "schedule");
  assert.equal(store.getSchedule(scope, "once").state, "completed");
  store.close(); store = new SqliteTaskStore(home);
  control = createScheduleControl(store, home); jobs = createJobDefinitionControl(store, home);
  tick(3); tick(0);
  assert.equal(store.listGlobalJobRuns().length, 2, "restart and rollback cannot replay once");
  cancel(onceRun);
  control(request("create", "interval", { jobId: job.id,
    rule: { kind: "interval", everyMs: 60_000, anchor: atMinute(1).toISOString() } }), at);
  // Inject an advancement write failure: Run admission must roll back as well.
  const save = store.saveSchedule.bind(store);
  let fail = true;
  store.saveSchedule = value => {
    if (fail && value.lastAttempt?.outcome === "admitted") { fail = false; throw new Error("advance failed"); }
    save(value);
  };
  const errors = [];
  reconcileSchedules(store, home, atMinute(1), e => errors.push(e.message));
  assert.match(errors[0], /advance failed/);
  assert.equal(store.listGlobalJobRuns().length, 2);
  let s = store.getSchedule(scope, "interval");
  assert.equal(s.state, "needs-attention");
  store.saveSchedule = save;
  control(request("enable", s.id, { expectedRevision: s.revision }), at);
  tick(20);
  s = store.getSchedule(scope, s.id);
  assert.equal(s.nextDue, atMinute(21).toISOString());
  assert.equal(store.listGlobalJobRuns().length, 3, "missed periods coalesce, not replay");
  tick(20);
  assert.equal(store.listGlobalJobRuns().length, 3);
  tick(21);
  s = store.getSchedule(scope, s.id);
  assert.equal(s.lastAttempt.outcome, "overlap");
  assert.equal(s.nextDue, atMinute(22).toISOString());
  const queued = store.listGlobalJobRuns().find(run => run.status === "queued");
  control(request("disable", s.id, { expectedRevision: s.revision }), atMinute(21));
  s = store.getSchedule(scope, s.id);
  control(request("update", s.id, { expectedRevision: s.revision, rule: s.rule }), atMinute(21));
  assert.equal(store.getSchedule(scope, s.id).state, "disabled", "editing a disabled rule does not enable it");
  tick(30);
  assert.equal(store.getGlobalJobRun(queued.id).status, "queued", "disable does not cancel a Run");
  cancel(queued);
  s = store.getSchedule(scope, s.id);
  control(request("enable", s.id, { expectedRevision: s.revision }), atMinute(30));
  const beforeManual = store.getSchedule(scope, s.id).nextDue;
  const extra = jobs({ ...job, op: "run", trigger: { source: "manual", key: "extra" } }, atMinute(30));
  cancel(extra.run);
  assert.equal(store.getSchedule(scope, s.id).nextDue, beforeManual);
  tick(31);
  assert.notEqual(store.getSchedule(scope, s.id).lastAttempt.runId, queued.id);
  const second = store.getGlobalJobRun(store.getSchedule(scope, s.id).lastAttempt.runId);
  cancel(second);
  s = store.getSchedule(scope, s.id);
  control(request("update", s.id, { expectedRevision: s.revision,
    rule: { kind: "cron", expression: "* * * * *", timezone: "UTC" } }), atMinute(31));
  tick(32);
  const cronFirst = store.getGlobalJobRun(store.getSchedule(scope, s.id).lastAttempt.runId);
  cancel(cronFirst); tick(33);
  assert.notEqual(store.getSchedule(scope, s.id).lastAttempt.runId, cronFirst.id);
  s = store.getSchedule(scope, s.id);
  control(request("update", s.id, { expectedRevision: s.revision,
    rule: { kind: "interval", everyMs: 60_000, anchor: at.toISOString() } }), atMinute(2));
  assert.equal(store.getSchedule(scope, s.id).nextDue, atMinute(34).toISOString(), "edit cannot move behind processed UTC fence");
  assert.throws(() => control(request("disable", s.id, { expectedRevision: s.revision }), at), /revision/);
  for (const bad of [{ scope: "user" }, { scope: "task", taskId: "task-1", role: "leader" }, { ...caller, nativeSessionId: "wrong" }]) {
    assert.throws(() => control({ ...request("list", s.id), caller: bad }, at));
  }
  const sessions = store.getGlobalRoleSessionSet("operator");
  store.saveGlobalRoleSessionSet({ ...sessions, sessions: {
    ...sessions.sessions, codex: { ...sessions.sessions.codex, nativeSessionId: "replacement" }
  } });
  const count = store.listGlobalJobRuns().length;
  reconcileSchedules(store, home, atMinute(34), e => errors.push(e.message));
  assert.equal(store.getSchedule(scope, s.id).state, "needs-attention");
  assert.equal(store.listGlobalJobRuns().length, count, "revoked Session is never reused");
});

test("storage 1.9 -> current appends schedules without changing Job history", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-schedule-migration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  store.close();
  const db = new Database(join(home, "yui.db"));
  try {
    usePre114Layout(db);
    db.exec("DROP TABLE schedules");
    db.prepare("UPDATE storage_schema SET minor=9,checksum=?").run(JOB_SCHEMA_CHECKSUM);
    validateSqliteSchemaObjects(db, "1.9");
    applySqliteMinorUpgrades(db, home);
    assert.equal(db.prepare("SELECT minor FROM storage_schema").get().minor, 14);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schedules").get().n, 0);
  } finally { db.close(); }
  const migrated = new SqliteTaskStore(home);
  try { assert.deepEqual(migrated.listSchedules({ kind: "global" }), []); }
  finally { migrated.close(); }
});
