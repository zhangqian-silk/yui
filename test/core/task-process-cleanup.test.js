import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, archiveTask, retireTask } from "../../dist/task/task.js";
import { writeTelemetryBatch } from "../../dist/telemetry/sqliteTelemetryBatch.js";
import { parseProcessCleanupArguments, runTaskProcessCleanup } from "../../dist/task/processCleanup.js";
import { createWorkMailbox, enqueueSignal } from "../../dist/coordination/workMailbox.js";

const now = new Date("2026-11-08T00:00:00Z");
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-process-cleanup-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  for (const id of ["task-1", "task-2"]) store.saveTask(createTask(id, id, now));
  const entry = taskId => ({ taskId, roleName: "leader", runId: "run-1", progressId: "p-1",
    payload: { text: "diagnostic only" }, receivedAt: now.toISOString() });
  for (const id of ["task-1", "task-2"]) store.upsertTelemetryProgress(entry(id));
  return { store, entry };
}
function archive(store, id) {
  store.saveTask(archiveTask(retireTask(store.getTask(id), { by: "user", summary: "fixture" }, now), now));
}

test("process cleanup is explicit, preview-bound and atomic, preserving other tasks and aggregates", t => {
  const { store, entry } = fixture(t);
  assert.throws(() => store.clearTaskProcessData("task-1", "0".repeat(64), "clean-1", "user"), /archived/i);
  archive(store, "task-1");
  const before = store.getTask("task-1");
  const aggregate = store.databaseHandle().prepare("SELECT * FROM telemetry_aggregate").all();
  const preview = store.inspectTaskProcessData("task-1");
  assert.equal(preview.telemetryRows, 1);
  assert.equal(store.countTelemetry("task-1"), 1, "preview is read only");
  assert.throws(() => store.clearTaskProcessData("task-1", "0".repeat(64), "clean-1", "user"), /changed|preview/i);
  assert.throws(() => store.transaction(() => {
    store.clearTaskProcessData("task-1", preview.digest, "clean-1", "user");
    throw new Error("injected rollback");
  }), /injected rollback/);
  assert.equal(store.countTelemetry("task-1"), 1);
  assert.equal(store.listEvents("task-1").length, 0);
  const result = store.clearTaskProcessData("task-1", preview.digest, "clean-1", "user");
  assert.equal(result.removedTelemetryRows, 1);
  assert.equal(store.countTelemetry("task-1"), 0);
  assert.equal(store.countTelemetry("task-2"), 1);
  assert.deepEqual(store.getTask("task-1"), before);
  assert.deepEqual(store.databaseHandle().prepare("SELECT * FROM telemetry_aggregate").all(), aggregate);
  assert.deepEqual(store.clearTaskProcessData("task-1", preview.digest, "clean-1", "user"), result);
  assert.throws(() => store.clearTaskProcessData("task-1", "f".repeat(64), "clean-1", "user"), /request|different/i);
  assert.equal(store.listEvents("task-1").length, 1);
  // A queued observer flush cannot repopulate an archived task's diagnostics.
  store.upsertTelemetryProgress(entry("task-1"));
  writeTelemetryBatch(store.databaseHandle(), [entry("task-1"), { ...entry("task-2"), progressId: "p-2" }], 100);
  assert.equal(store.countTelemetry("task-1"), 0);
  assert.equal(store.countTelemetry("task-2"), 2);
});

test("process preview cannot be reused after task facts change or across homes", t => {
  const { store } = fixture(t);
  archive(store, "task-1");
  const preview = store.inspectTaskProcessData("task-1");
  store.saveTask({ ...store.getTask("task-1"), title: "changed task" });
  assert.throws(() => store.clearTaskProcessData("task-1", preview.digest, "clean-1", "user"), /changed|preview/i);
  const other = fixture(t).store;
  archive(other, "task-1");
  assert.notEqual(other.inspectTaskProcessData("task-1").digest, preview.digest);
  assert.equal(store.countTelemetry("task-1"), 1);
});

test("process cleanup entry rejects missing confirmation, foreign identity, physical uncertainty and queued work", async t => {
  const { store } = fixture(t);
  archive(store, "task-1");
  assert.throws(() => parseProcessCleanupArguments(["task-1"]), /Usage/);
  assert.throws(() => parseProcessCleanupArguments(["task-1", "--preview", "--confirm", "a".repeat(64)]), /Usage/);
  const previewRequest = parseProcessCleanupArguments(["task-1", "--preview"]);
  const preview = await runTaskProcessCleanup(store, previewRequest, {}, async () => {
    assert.fail("preview must not run physical mutation/inspection");
  });
  const apply = parseProcessCleanupArguments(["task-1", "--confirm", preview.digest, "--request-id", "clean-1"]);
  await assert.rejects(runTaskProcessCleanup(store, apply, {
    YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-2", YUI_ROLE: "leader"
  }, async () => {}), /matching Leader/);
  await assert.rejects(runTaskProcessCleanup(store, apply, {}, async () => {
    throw new Error("retained native process");
  }), /retained native process/);
  store.saveWorkMailbox(enqueueSignal(createWorkMailbox({ kind: "task", taskId: "task-1" }), {
    reason: "pending-work", refs: [], occurredAt: now.toISOString()
  }));
  await assert.rejects(runTaskProcessCleanup(store, apply, {}, async () => {}), /mailbox/);
  assert.equal(store.countTelemetry("task-1"), 1);
  assert.equal(store.listEvents("task-1").length, 0);
});
