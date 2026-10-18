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
    assert.equal(db.prepare("SELECT minor FROM storage_schema").get().minor, 20);
    assert.deepEqual(tables.map(table => db.prepare(`SELECT payload FROM ${table}`).all()), before);
  } finally { db.close(); }
  store = new SqliteTaskStore(home);
  assert.equal(store.getSchedule(scope, id).state, "disabled");
  assert.equal(store.getJobDefinition(scope, id).builtin, undefined);
  assert.equal(store.listGlobalJobRuns().length, 1);
});
