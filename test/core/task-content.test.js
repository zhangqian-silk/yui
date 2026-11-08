import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask } from "../../dist/task/task.js";
import { contextContentDigest, createContextSnapshot } from "../../dist/context/contextSnapshot.js";
import Database from "../../dist/sqlite/driver.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { validateCurrentTaskStore } from "../../dist/storage/currentTaskStore.js";

const now = new Date("2026-11-08T00:00:00Z");
function snapshot(taskId, sequence, value) {
  const ref = { layer: "L2", store: "task-message", refId: "message-1",
    revision: "1", digest: contextContentDigest(value) };
  return createContextSnapshot({
    id: `snapshot-${sequence}`, taskId, sequence, scope: "task", refs: [ref],
    resources: [{ ref, value }], acceptRefs: [], frozenAt: now, frozenBy: "leader"
  });
}

test("frozen context has one immutable task-owned content authority, preserving exact history", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-content-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  for (const id of ["task-1", "task-2"]) store.saveTask(createTask(id, id, now));
  const value = { body: "Original frozen evidence" };
  const a = snapshot("task-1", 1, value);
  store.saveContextSnapshot(a);
  store.saveContextSnapshot(snapshot("task-1", 2, value));
  store.saveContextSnapshot(snapshot("task-2", 1, value));
  const metadata = JSON.parse(store.databaseHandle().prepare(
    "SELECT payload FROM context_snapshots WHERE task_id=? AND snapshot_id=?"
  ).get("task-1", "snapshot-1").payload);
  assert.equal(Object.hasOwn(metadata, "resources"), false, "DB must not mirror resource bodies");
  const directory = join(home, "task-data/task-1/context-values");
  assert.deepEqual(readdirSync(directory), [`${a.refs[0].digest}.json`], "values deduplicate within the task");
  assert.deepEqual(store.getContextSnapshot("task-1", "snapshot-1"), a);
  assert.equal(store.getContextSnapshot("task-2", "snapshot-1").digest,
    snapshot("task-2", 1, value).digest);
  const file = join(directory, `${a.refs[0].digest}.json`);
  assert.equal(readFileSync(file, "utf8"), JSON.stringify(value));
  writeFileSync(file, JSON.stringify({ body: "tampered" }));
  assert.throws(() => store.getContextSnapshot("task-1", "snapshot-1"), /digest|content/i);
  assert.deepEqual(store.getContextSnapshot("task-2", "snapshot-1").resources[0].value, value);
});

test("rollback cannot publish a partial snapshot; retry verifies and reuses immutable content", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-content-rollback-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  store.saveTask(createTask("task-1", "Rollback", now));
  const frozen = snapshot("task-1", 1, { body: "Before commit" });
  assert.throws(() => store.transaction(s => {
    s.saveContextSnapshot(frozen);
    throw new Error("abort transaction");
  }), /abort transaction/);
  assert.equal(store.getContextSnapshot("task-1", "snapshot-1"), null);
  store.saveContextSnapshot(frozen);
  assert.deepEqual(store.getContextSnapshot("task-1", "snapshot-1"), frozen);
  rmSync(join(home, "task-data/task-1/context-values", `${frozen.refs[0].digest}.json`));
  assert.doesNotThrow(() => validateCurrentTaskStore(home), "missing history must not block Home admission");
  assert.throws(() => store.getContextSnapshot("task-1", frozen.id),
    error => error.code === "ENOENT", "exact reads preserve missing-file errors; no reconstruction");
  assert.equal(existsSync(join(home, "task-data/task-1/context-values", `${frozen.refs[0].digest}.json`)), false);
  const row = store.databaseHandle().prepare("SELECT payload FROM context_snapshots WHERE task_id=?").get("task-1");
  store.databaseHandle().prepare("UPDATE context_snapshots SET payload=? WHERE task_id=?")
    .run(JSON.stringify({ ...JSON.parse(row.payload), sequence: 0 }), "task-1");
  assert.throws(() => validateCurrentTaskStore(home), /sequence/i, "invalid control metadata remains an admission error");
});

test("snapshot scope lookup reads selected content only and rejects symlinked task storage", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-content-bounds-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  store.saveTask(createTask("task-1", "Bounded", now));
  const first = snapshot("task-1", 1, { body: "old" });
  const latest = snapshot("task-1", 2, { body: "latest" });
  store.saveContextSnapshot(first);
  store.saveContextSnapshot(latest);
  rmSync(join(home, "task-data/task-1/context-values", `${first.refs[0].digest}.json`));
  assert.deepEqual(store.queryContextSnapshots("task-1", { scope: "task", limit: 1, descending: true }), [latest]);
  assert.throws(() => store.queryContextSnapshots("task-1", { scope: "task", limit: 257 }), /limit/i);
  store.saveTask(createTask("task-2", "No traversal", now));
  symlinkSync(join(home, "task-data/task-1"), join(home, "task-data/task-2"));
  assert.throws(() => store.saveContextSnapshot(snapshot("task-2", 1, { body: "foreign" })), /Unsafe/);
  assert.equal(store.getContextSnapshot("task-2", "snapshot-1"), null);
});

test("1.32 migration is backed up, preserves frozen values and rolls back its own file effects on failure", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-content-migration-"));
  let store = new SqliteTaskStore(home);
  let db;
  t.after(() => { store?.close(); db?.close(); rmSync(home, { recursive: true, force: true }); });
  const workspace = join(home, "workspaces/tasks/task-1/main");
  mkdirSync(workspace, { recursive: true });
  const dirtyFile = join(workspace, "uncommitted.txt");
  writeFileSync(dirtyFile, "User edits must survive an upgrade.\n");
  store.saveTask(createTask("task-1", "Migration", now));
  store.upsertTelemetryProgress({ taskId: "task-1", roleName: "leader", runId: "run-1",
    progressId: "p-1", payload: { text: "Upgrade is not cleanup authorization" }, receivedAt: now.toISOString() });
  store.close(); store = undefined;
  const first = snapshot("task-1", 1, { body: "original" });
  const second = snapshot("task-1", 2, { body: "second" });
  db = new Database(join(home, "yui.db"));
  const insert = db.prepare(`INSERT INTO context_snapshots
    (task_id,snapshot_id,scope,scope_ref,sequence,digest,payload,frozen_at) VALUES (?,?,'task',NULL,?,?,?,?)`);
  insert.run("task-1", first.id, first.sequence, first.digest, JSON.stringify(first), first.frozenAt);
  insert.run("task-1", second.id, second.sequence, second.digest,
    JSON.stringify({ ...second, digest: "0".repeat(64) }), second.frozenAt);
  db.exec("UPDATE storage_schema SET minor=32");
  const before = db.prepare("SELECT * FROM context_snapshots").all();
  db.close(); db = undefined;
  const failed = await runStorageUpgrade({ home, mode: "execute" });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.sceneUnchanged, true);
  assert.equal(existsSync(join(home, "task-data")), false);
  db = new Database(join(home, "yui.db"));
  assert.deepEqual(db.prepare("SELECT * FROM context_snapshots").all(), before);
  db.prepare("UPDATE context_snapshots SET payload=? WHERE snapshot_id=?").run(JSON.stringify(second), second.id);
  db.close(); db = undefined;
  const migrated = await runStorageUpgrade({ home, mode: "execute" });
  assert.equal(migrated.outcome, "upgraded", JSON.stringify(migrated));
  assert.equal(existsSync(migrated.report.backupPath), true);
  store = new SqliteTaskStore(home);
  assert.deepEqual(store.getContextSnapshot("task-1", first.id), first);
  assert.deepEqual(store.getContextSnapshot("task-1", second.id), second);
  assert.equal(store.countTelemetry("task-1"), 1, "version upgrade must not clear process data");
  assert.equal(store.listEventsByType("task-1", ["task.process-cleanup"]).length, 0);
  assert.equal(readFileSync(dirtyFile, "utf8"), "User edits must survive an upgrade.\n");
});
