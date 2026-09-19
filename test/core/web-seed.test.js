import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

test("dashboard seed creates current records once without starting runtime or replacing a Home", t => {
  const root = mkdtempSync(join(tmpdir(), "yui-web-seed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const seed = () => spawnSync(process.execPath,
    [new URL("../../scripts/seed-web-dashboard.mjs", import.meta.url).pathname],
    { env: { ...sanitizedTestEnv(), YUI_HOME: home }, encoding: "utf8", timeout: 10000 });
  const result = seed();
  assert.equal(result.status, 0, result.stderr);
  const store = new SqliteTaskStore(home);
  try {
    store.validateCurrentRecords();
    assert.equal(store.getConfig().schemaVersion, 1);
    assert.equal(store.listTasks().length, 6);
    assert.ok(store.getRun("task-1", "run-1").inputs[0].input.contextSnapshotRef);
    assert.equal(store.getRun("task-6", "run-1").status, "failed");
    const revision = store.getRevision();
    const again = seed();
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /Refusing to seed existing/);
    assert.equal(store.getRevision(), revision);
    assert.equal(existsSync(join(home, "runtime/controller.json")), false);
    assert.equal(store.nextTaskId(), "task-7");
    assert.equal(store.nextRunId("task-6"), "run-2",
      "Continuing or retrying demo work must never reuse the seeded Run id.");
  } finally { store.close(); }
});
