import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createProject } from "../../dist/repository/project.js";
import { reconcileProjectSync } from "../../dist/job/projectSync.js";
import { createScheduleControl, reconcileSchedules } from "../../dist/controller/scheduleControl.js";
import { createJobDefinitionControl, authorizeGlobalJobStart } from "../../dist/controller/jobDefinitionControl.js";
import Database from "../../dist/sqlite/driver.js";
import { applySqliteMinorUpgrades } from "../../dist/storage/sqliteSchema.js";
import { usePre120Layout } from "../helpers/pre19Storage.mjs";

test("default sync uses explicit local clock boundaries and retains its timezone across restart", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-project-sync-clock-"));
  let store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const scope = { kind: "global" }, at = new Date("2026-10-19T15:50:48.360Z");
  store.saveProject(createProject("project-1", "Local", join(home, "projects/project-1"),
    { stable: "main", development: "main" }, at, { ownership: "managed", remoteUrl: "/local/remote.git" }));
  reconcileProjectSync(store, at);
  const plan = store.getSchedule(scope, "project-sync-project-1");
  assert.deepEqual(plan.rule, { kind: "cron", expression: "0 */6 * * *", timezone: "Asia/Shanghai" });
  assert.equal(plan.nextDue, "2026-10-19T16:00:00.000Z", "next local midnight, not six hours from creation");
  store.close(); store = new SqliteTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "Asia/Kathmandu" });
  reconcileProjectSync(store, new Date("2026-10-19T15:59:00Z"));
  assert.deepEqual(store.getSchedule(scope, plan.id), plan, "restart/config changes do not rewrite installed rules");
  store.saveProject(createProject("project-2", "Other", join(home, "projects/project-2"),
    { stable: "main", development: "main" }, at, { ownership: "managed", remoteUrl: "/local/remote.git" }));
  reconcileProjectSync(store, at);
  const other = store.getSchedule(scope, "project-sync-project-2");
  assert.equal(other.rule.timezone, "Asia/Kathmandu");
  assert.equal(other.nextDue, "2026-10-19T18:15:00.000Z", "explicit fractional-offset timezone");
  reconcileSchedules(store, home, new Date("2026-10-19T16:00:00Z"), e => { throw e; });
  assert.equal(store.getSchedule(scope, plan.id).nextDue, "2026-10-19T22:00:00.000Z");
  reconcileSchedules(store, home, new Date("2026-10-19T16:00:00Z"), e => { throw e; });
  assert.equal(store.listGlobalJobRuns().length, 1, "one admission at the boundary");
});

test("1.20 upgrade converts only proven unedited builtins, preserving overrides and history", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-project-sync-clock-upgrade-"));
  let store = new SqliteTaskStore(home);
  t.after(() => { store?.close(); rmSync(home, { recursive: true, force: true }); });
  const scope = { kind: "global" }, at = new Date("2026-10-19T09:50:48.360Z");
  store.saveConfig({ ...store.getConfig(), timeZone: "Asia/Kathmandu" });
  for (let i = 1; i <= 4; i++) {
    store.saveProject(createProject(`project-${i}`, "Local", join(home, `projects/project-${i}`),
      { stable: "main", development: "main" }, at, { ownership: "managed", remoteUrl: "/local/remote.git" }));
  }
  reconcileProjectSync(store, at);
  store.close(); store = undefined;
  const db = new Database(join(home, "yui.db"));
  try {
    const oldRule = { kind: "interval", anchor: "2026-10-19T15:50:48.360Z", everyMs: 21600000 };
    for (const row of db.prepare("SELECT schedule_id,payload FROM schedules").all()) {
      const plan = JSON.parse(row.payload), n = Number(row.schedule_id.split("-").at(-1));
      plan.rule = n === 4 ? { kind: "cron", expression: "15 3 * * *", timezone: "America/New_York" } : oldRule;
      plan.nextDue = n === 4 ? "2026-10-20T07:15:00.000Z" : oldRule.anchor;
      // v1.20 did not retain rule-edit provenance: even equal-valued edits must survive.
      if (n > 1) plan.revision = 2;
      if (n === 2 || n === 4) plan.generation = 2;
      if (n === 3) {
        plan.builtin.enabled = false;
        plan.state = "disabled";
        plan.authorization.revoked = true;
      }
      db.prepare("UPDATE schedules SET payload=?,state=?,next_due=? WHERE schedule_id=?")
        .run(JSON.stringify(plan), plan.state, plan.nextDue, row.schedule_id);
    }
    const before = db.prepare("SELECT * FROM schedules ORDER BY schedule_id").all();
    const definitions = db.prepare("SELECT payload FROM job_definitions").all();
    db.prepare("UPDATE storage_schema SET minor=20").run();
    applySqliteMinorUpgrades(db, home);
    const after = db.prepare("SELECT * FROM schedules ORDER BY schedule_id").all();
    const converted = JSON.parse(after[0].payload);
    assert.deepEqual(converted.rule, { kind: "cron", expression: "0 */6 * * *", timezone: "Asia/Kathmandu" });
    assert.equal(converted.generation, 2);
    assert.equal(converted.revision, 2);
    assert.equal(converted.nextDue, after[0].next_due);
    assert.ok(Date.parse(converted.nextDue) > Date.parse(converted.processedThrough));
    assert.deepEqual(converted.authorization, JSON.parse(before[0].payload).authorization);
    assert.deepEqual(after.slice(1), before.slice(1), "ambiguous, disabled, equal-valued and timezone overrides remain exact");
    assert.deepEqual(db.prepare("SELECT payload FROM job_definitions").all(), definitions);
    assert.equal(db.prepare("SELECT payload FROM storage_migration_archive WHERE migration_version=21").get().payload, before[0].payload);
    applySqliteMinorUpgrades(db, home);
    assert.deepEqual(db.prepare("SELECT * FROM schedules ORDER BY schedule_id").all(), after);
  } finally { db.close(); }
  store = new SqliteTaskStore(home);
  const migrated = store.getSchedule(scope, "project-sync-project-1");
  reconcileProjectSync(store, new Date());
  assert.deepEqual(store.getSchedule(scope, migrated.id), migrated);
  assert.equal(store.listSchedules(scope).length, 4);
});

test("builtin Project sync preserves user intent and fences stale targets without Sessions", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-project-sync-"));
  let store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const at = new Date("2026-10-19T00:00:00Z"), scope = { kind: "global" }, caller = { scope: "user" };
  const project = createProject("project-1", "Local", join(home, "projects/project-1"),
    { stable: "main", development: "main" }, at, { ownership: "managed", remoteUrl: "/local/remote.git" });
  store.saveProject(project);
  reconcileProjectSync(store, at);
  const id = "project-sync-project-1";
  let plan = store.getSchedule(scope, id);
  assert.equal(plan.state, "enabled");
  assert.equal(plan.authorization.grantedBy.scope, "service");
  assert.equal(store.listJobDefinitions(scope).length, 1);
  reconcileProjectSync(store, at);
  assert.deepEqual(store.getSchedule(scope, id), plan, "no churn or duplicate installation");
  const control = (op, extra = {}) => createScheduleControl(store, home)({
    op, scope, caller, id, expectedRevision: store.getSchedule(scope, id).revision, ...extra
  }, at);
  const rule = { kind: "interval", anchor: "2026-10-19T00:01:00Z", everyMs: 60_000 };
  control("update", { rule });
  control("disable");
  store.close(); store = new SqliteTaskStore(home);
  reconcileProjectSync(store, new Date("2026-10-20T00:00:00Z"));
  plan = store.getSchedule(scope, id);
  assert.equal(plan.state, "disabled");
  assert.deepEqual(plan.rule, rule);
  control("enable");
  reconcileSchedules(store, home, new Date("2026-10-21T00:00:00Z"), e => { throw e; });
  const run = store.listGlobalJobRuns()[0];
  assert.ok(run);
  assert.doesNotThrow(() => authorizeGlobalJobStart(store, run));
  store.saveProject({ ...project, remoteUrl: "/local/other.git" });
  assert.throws(() => authorizeGlobalJobStart(store, run), /changed|target/i);
  reconcileProjectSync(store, at);
  assert.throws(() => authorizeGlobalJobStart(store, run), /authority|revoked/i);
  assert.deepEqual(store.getSchedule(scope, id).rule, rule);
  store.saveProject({ ...project, ownership: "external" });
  reconcileProjectSync(store, at);
  assert.equal(store.getSchedule(scope, id).state, "needs-attention");
  assert.match(store.getSchedule(scope, id).reason, /managed/i);
  assert.equal(store.listTasks().length, 0);
  assert.equal(store.getGlobalRole("operator"), null);
});

test("custom maintenance is never adopted or duplicated; builtin identity cannot be forged or retargeted", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-project-sync-custom-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const at = new Date("2026-10-19T00:00:00Z"), scope = { kind: "global" }, caller = { scope: "user" };
  const project = createProject("project-1", "Local", join(home, "projects/project-1"),
    { stable: "main", development: "main" }, at, { ownership: "managed", remoteUrl: "/local/remote.git" });
  store.saveProject(project);
  const jobs = createJobDefinitionControl(store, home);
  const custom = jobs({ op: "define", id: "my-refresh", title: "Mine", scope, caller,
    configuration: { kind: "builtin", action: "project.refresh", projectId: project.id, input: {} } }, at);
  reconcileProjectSync(store, at);
  const id = "project-sync-project-1", plan = store.getSchedule(scope, id);
  assert.equal(plan.state, "needs-attention");
  assert.match(plan.reason, /my-refresh/);
  assert.deepEqual(store.getJobDefinition(scope, custom.id), custom);
  assert.throws(() => jobs({ op: "update", id, scope, caller, expectedRevision: 1,
    title: "Hijack", configuration: { kind: "builtin", action: "system.noop", input: {} } }, at), /builtin|built-in/i);
  assert.throws(() => jobs({ op: "define", id: "forged", scope, caller, builtin: "project-sync",
    title: "Forged", configuration: custom.configuration }, at), /field/i);
  assert.throws(() => createScheduleControl(store, home)({ op: "create", scope, caller, id: "other",
    jobId: id, authorization: "service", rule: plan.rule }, at), /builtin|built-in/i);
  reconcileSchedules(store, home, new Date("2026-10-22T00:00:00Z"));
  assert.equal(store.listGlobalJobRuns().length, 0);
});

test("1.17 upgrade preserves custom definitions, service grants, overrides and Run bytes", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-project-sync-migration-"));
  let store = new SqliteTaskStore(home);
  t.after(() => { store?.close(); rmSync(home, { recursive: true, force: true }); });
  const at = new Date(), scope = { kind: "global" }, caller = { scope: "user" }, id = "custom";
  const jobs = createJobDefinitionControl(store, home), schedules = createScheduleControl(store, home);
  jobs({ op: "define", scope, caller, id, title: "Custom",
    configuration: { kind: "builtin", action: "system.noop", input: {} } }, at);
  schedules({ op: "create", scope, caller, id, jobId: id, authorization: "service",
    rule: { kind: "interval", everyMs: 120000, anchor: at.toISOString() } }, at);
  schedules({ op: "disable", scope, caller, id, expectedRevision: 1 }, at);
  jobs({ op: "run", scope, caller, id, trigger: { source: "manual", key: "preserved" } }, at);
  store.close(); store = undefined;
  const db = new Database(join(home, "yui.db"));
  try {
    const tables = ["job_definitions", "schedules", "global_job_runs"];
    const before = tables.map(table => db.prepare(`SELECT payload FROM ${table}`).all());
    usePre120Layout(db);
    db.prepare("UPDATE storage_schema SET minor=17").run();
    applySqliteMinorUpgrades(db, home);
    assert.equal(db.prepare("SELECT minor FROM storage_schema").get().minor, 22);
    assert.deepEqual(tables.map(table => db.prepare(`SELECT payload FROM ${table}`).all()), before);
  } finally { db.close(); }
  store = new SqliteTaskStore(home);
  assert.equal(store.getSchedule(scope, id).state, "disabled");
  assert.equal(store.getJobDefinition(scope, id).builtin, undefined);
  assert.equal(store.listGlobalJobRuns().length, 1);
});
