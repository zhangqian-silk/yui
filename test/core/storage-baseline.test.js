import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "../../dist/storage/sqliteSchema.js";
import * as versions from "../../dist/storage/storageVersions.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRoleSessionSet, recordRoleAgentSession, updateRoleAgentSessionStatus } from "../../dist/executor/agentExecutor.js";
import { createCapabilityGrant } from "../../dist/grant/capabilityGrant.js";

test("fresh storage creates only the current 1.3 contract", () => {
  assert.equal(versions.CURRENT_STORAGE_VERSION, "1.3");
  const db = new Database(":memory:");
  try {
    schema.initializeSqliteSchema(db);
    assert.equal(schema.inspectSqliteSchema(db).currentVersion, "1.3");
    assert.equal(db.prepare("SELECT count(*) AS n FROM storage_schema").get().n, 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(), undefined);
    for (const name of ["coordination_locks", "work_item_candidates", "idx_input_open"]) {
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name), undefined);
    }
    assert.throws(() => schema.initializeSqliteSchema(db), /empty/i);
    schema.validateSqliteSchema(db);
    db.exec("CREATE TABLE sqliteX_extra(value TEXT)");
    assert.throws(() => schema.validateSqliteSchema(db), /unexpected schema objects/);
    db.exec("DROP TABLE sqliteX_extra");
    db.exec("DROP INDEX idx_mailboxes_ready");
    assert.throws(() => schema.validateSqliteSchema(db), /idx_mailboxes_ready/);
  } finally { db.close(); }
});

test("foreign non-empty SQLite state cannot be initialized over", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE unrelated_state(id INTEGER PRIMARY KEY, payload TEXT)");
    db.exec("INSERT INTO unrelated_state VALUES(1,'preserve-me')");
    const before = db.serialize();
    assert.throws(() => schema.inspectSqliteSchema(db), /baseline|format|storage_schema/i);
    assert.throws(() => schema.initializeSqliteSchema(db), /empty/i);
    assert.deepEqual(db.serialize(), before);
  } finally { db.close(); }
});

test("1.1 upgrade preserves valid Operator authority without inventing user provenance", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-source-upgrade-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const at = new Date("2026-09-01T00:00:00Z");
  const store = new SqliteTaskStore(home);
  store.saveTask(createTask("task-1", "Recorded authority", at));
  const grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "operator:codex", actions: ["post-verify"], maxUses: 2
  }, at);
  store.saveCapabilityGrant("task-1", grant);
  store.close();
  const old = new Database(join(home, "yui.db"));
  old.prepare("UPDATE storage_schema SET minor=1 WHERE id=1").run();
  old.close();
  assert.equal((await runStorageUpgrade({ home, mode: "execute" })).outcome, "upgraded");
  const current = new SqliteTaskStore(home);
  try { assert.deepEqual(current.getCapabilityGrant("task-1", grant.id), grant); }
  finally { current.close(); }
});

test("default storage upgrades advance only the minor version of the same major", () => {
  assert.equal(versions.isMinorStorageUpgrade("1.0", "1.1"), true);
  assert.equal(versions.isMinorStorageUpgrade("1.9", "1.10"), true);
  assert.equal(versions.isMinorStorageUpgrade("1.0", "2.0"), false);
  assert.equal(versions.isMinorStorageUpgrade("2.0", "1.9"), false);
  assert.equal(versions.isMinorStorageUpgrade("1.1", "1.0"), false);
  assert.equal(versions.isMinorStorageUpgrade("1.0", "1.0"), false);
  for (const value of [1, -1, "1", "01.0", "1.-1", "1.0.0", "0.1"]) {
    assert.equal(versions.isStorageVersion(value), false);
  }
});

test("1.0 upgrade adopts the main workspace of an active Project-free Task", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-workspace-upgrade-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const at = new Date("2026-09-01T00:00:00.000Z");
  const store = new SqliteTaskStore(home);
  const task = activateTask(createTask("task-1", "Old Project-free Task", at), at);
  store.saveTask(task);
  const agent = createConfiguredAgent("claude", "claude", "claude", [], [], at);
  store.saveConfiguredAgent(agent);
  store.saveRole(task.id, createRole(task.id, "leader", [createRoleAgentBinding(agent)],
    agent.id, join(home, "old-cwd"), at));
  store.close();
  const old = new Database(join(home, "yui.db"));
  old.prepare("UPDATE storage_schema SET minor=0 WHERE id=1").run();
  old.close();

  const result = await runStorageUpgrade({ home, mode: "execute" });
  assert.equal(result.outcome, "upgraded");
  const current = new SqliteTaskStore(home);
  t.after(() => current.close());
  const root = join(home, "workspaces", "tasks", task.id, "main");
  assert.equal(current.getTask(task.id).cwd, root);
  assert.equal(current.getTaskWorkspace(task.id).root, root);
  assert.deepEqual(current.getTaskWorkspace(task.id).entries, []);
  assert.equal(current.getRole(task.id, "leader").workspace, root);
  assert.equal(existsSync(root), true);
});

test("1.0 upgrade preserves a live Project-free Session and retries after it ends", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-workspace-upgrade-live-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const at = new Date("2026-09-01T00:00:00.000Z");
  const store = new SqliteTaskStore(home);
  const task = activateTask(createTask("task-1", "Live old Task", at), at);
  store.saveTask(task);
  const agent = createConfiguredAgent("claude", "claude", "claude", [], [], at);
  store.saveConfiguredAgent(agent);
  const role = createRole(task.id, "leader", [createRoleAgentBinding(agent)],
    agent.id, join(home, "old-cwd"), at);
  store.saveRole(task.id, role);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(
    createRoleSessionSet({ scope: "task", taskId: task.id, roleName: "leader" }, agent.id, at),
    { agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: "old-native",
      policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role }) }, at));
  store.close();
  const databasePath = join(home, "yui.db");
  const old = new Database(databasePath);
  old.prepare("UPDATE storage_schema SET minor=0 WHERE id=1").run();
  old.close();

  const blocked = await runStorageUpgrade({ home, mode: "execute" });
  assert.equal(blocked.outcome, "failed");
  assert.match(blocked.message, /native Session/);
  assert.equal(existsSync(join(home, "workspaces", "tasks", task.id, "main")), false);
  const quiesced = new Database(databasePath);
  assert.equal(schema.inspectSqliteSchema(quiesced).currentVersion, "1.0");
  const row = quiesced.prepare("SELECT payload FROM role_session_sets WHERE task_id=? AND role_name='leader'")
    .get(task.id);
  const ended = updateRoleAgentSessionStatus(JSON.parse(row.payload), agent.id, "ended", at);
  quiesced.prepare("UPDATE role_session_sets SET payload=? WHERE task_id=? AND role_name='leader'")
    .run(JSON.stringify(ended), task.id);
  quiesced.close();
  assert.equal((await runStorageUpgrade({ home, mode: "execute" })).outcome, "upgraded");
});
