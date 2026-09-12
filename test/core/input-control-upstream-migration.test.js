import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrateSqliteSchema, inspectSqliteSchemaMigrations, storageMigrationPlan } from "../../dist/storage/sqliteSchema.js";
import { createTask } from "../../dist/task/task.js";

test("published v22 history survives the additive input-control migration", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-input-v22-"));
  const db = new Database(join(home, "yui.db"));
  t.after(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  migrateSqliteSchema(db, { mode: "apply", throughVersion: 22 });
  const oldLedger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  const task = createTask("task-1", "Published v22 Task", new Date("2026-09-01T00:00:00.000Z"), { cwd: home });
  db.prepare("INSERT INTO tasks_catalog(task_id,status,lifecycle,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(task.id, task.status, "planning", 1, task.createdAt, task.updatedAt);
  db.prepare("INSERT INTO task_records(task_id,payload,updated_at) VALUES (?,?,?)")
    .run(task.id, JSON.stringify(task), task.updatedAt);
  db.prepare("INSERT INTO id_sequences(task_id,kind,high_water) VALUES (?,?,?)").run(task.id, "message", 1);
  const original = JSON.stringify({
    schemaVersion: 3, id: "message-1", taskId: "task-1", kind: "user",
    author: { type: "user" }, body: "Keep this intent and history.",
    intent: "record", submissionKey: "published-input",
    createdAt: "2026-09-01T00:00:00.000Z"
  });
  db.prepare("INSERT INTO messages(task_id, message_id, seq, payload, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("task-1", "message-1", 1, original, "2026-09-01T00:00:00.000Z");
  assert.equal(inspectSqliteSchemaMigrations(db).currentVersion, 22);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='global_role_messages'").get().n, 0);
  assert.deepEqual(storageMigrationPlan(22).map(step => [step.fromVersion, step.toVersion, step.name]),
    [[22, 23, "unified-message-input-control"]]);
  migrateSqliteSchema(db, { mode: "apply" });
  assert.equal(inspectSqliteSchemaMigrations(db).currentVersion, 23);
  assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version <= 22 ORDER BY version").all(), oldLedger);
  assert.equal(db.prepare("SELECT payload FROM messages WHERE message_id='message-1'").get().payload, original);
  assert.equal(db.prepare("SELECT count(*) AS n FROM global_role_messages").get().n, 0);
});
