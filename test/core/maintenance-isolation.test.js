import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { FileTaskController } from "../../dist/controller/controller.js";
import { ProviderContinuationReconciliationService } from "../../dist/runtime/providerContinuationReconciliationService.js";

test("optional maintenance failures stay observable without starving Controller scheduling", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-maintenance-isolation-"));
  const store = new SqliteTaskStore(home);
  const failures = [], calls = [];
  const controller = new FileTaskController(new FileSchedulerStoreAdapter(store), {}, {
    onError: error => failures.push(error),
    resourceReaper: async () => { calls.push("reap"); throw new Error("resource directory unavailable"); },
    continuationReconciler: { reconcile: async () => {
      calls.push("continuation"); throw new Error("metadata unavailable");
    } },
    jobSupervisor: { reconcile: () => calls.push("jobs") }
  });
  t.after(async () => {
    await controller.shutdownAndDrain();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const result = await controller.pump();
  assert.deepEqual(calls, ["reap", "continuation", "jobs"]);
  assert.equal(result.activeRunDeliveries.length, 0);
  assert.equal(failures.length, 2);
  assert.match(failures[0].message, /reap.*resource directory unavailable/i);
  assert.match(failures[1].message, /continuation.*metadata unavailable/i);
  assert.equal(failures[0].cause.message, "resource directory unavailable");
});

test("one Task's continuation read failure cannot stop inspection of another Task", async () => {
  const visited = [], failures = [];
  const error = new Error("Task events unavailable");
  const service = new ProviderContinuationReconciliationService({
    listTasks: () => ["task-1", "task-2"].map(id => ({ id, status: "active", executionGate: { state: "enabled" } })),
    listEvents: id => { visited.push(id); if (id === "task-1") throw error; return []; }
  }, { observeRuntimeObservation: () => assert.fail("No observation was proven") },
  { queryKnownContinuations: async () => assert.fail("No known continuation") },
  failure => failures.push(failure));
  assert.deepEqual(await service.reconcile(new Date()), []);
  assert.deepEqual(visited, ["task-1", "task-2"]);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /task-1.*Task events unavailable/);
  assert.equal(failures[0].cause, error);
});
