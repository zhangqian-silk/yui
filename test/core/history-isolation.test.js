import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { validateCurrentTaskStore } from "../../dist/storage/currentTaskStore.js";
import { createTask, retireTask, archiveTask } from "../../dist/task/task.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";

test("unreadable historical task is isolated from Home admission, catalog and new task creation", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-history-isolation-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-11-08T00:00:00Z");
  store.saveConfiguredAgent(createConfiguredAgent("fixture", "codex", "false", [], [], now));
  store.saveConfig({ ...store.getConfig(), defaultAgent: "fixture" });
  const id = store.nextTaskId();
  store.saveTask(archiveTask(retireTask(createTask(id, "Old history", now),
    { by: "user", summary: "fixture" }, now), now));
  const bad = { ...store.getTask(id) };
  delete bad.archivedBy;
  const db = store.databaseHandle();
  db.prepare("UPDATE task_records SET payload=? WHERE task_id=?").run(JSON.stringify(bad), id);
  assert.doesNotThrow(() => validateCurrentTaskStore(home));
  assert.throws(() => store.getTask(id), /archivedBy/);
  assert.throws(() => store.validateCurrentRecords(), /archivedBy/, "explicit audit remains strict");
  const upgraded = await runStorageUpgrade({ home, mode: "execute" });
  assert.equal(upgraded.outcome, "already-current", JSON.stringify(upgraded));
  const created = runTaskCommand(["create", "Independent new task"], store, {}).data.task;
  assert.equal(created.id, "task-2");
  for (const mode of ["missing-field", "missing-record"]) {
    if (mode === "missing-record") db.prepare("DELETE FROM task_records WHERE task_id=?").run(id);
    assert.doesNotThrow(() => validateCurrentTaskStore(home));
    const catalog = runTaskCommand(["list", "--all"], store, {}).data;
    assert.equal(catalog.tasks.length, 2, mode);
    const old = catalog.tasks.find(task => task.id === id);
    assert.equal(old.ref, null);
    assert.match(old.recordError, /Invalid|JSON|missing|Unexpected|property/i);
    assert.equal(catalog.tasks.find(task => task.id === created.id).recordError, undefined);
    assert.deepEqual(store.getTask(created.id), created);
  }
  const next = runTaskCommand(["create", "After historical record removal"], store, {}).data.task;
  assert.equal(next.id, "task-3");
  assert.equal(store.getTask(id), null, "creation must not resurrect deleted history");
  const config = { ...store.getConfig(), telemetryEnabled: "invalid" };
  db.prepare("UPDATE config SET payload=? WHERE id=1").run(JSON.stringify(config));
  assert.throws(() => validateCurrentTaskStore(home), /telemetry|boolean/i, "core config remains strict");
});
