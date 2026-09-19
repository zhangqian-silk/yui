import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { createTask, setTaskActivationRequest } from "../../dist/task/task.js";
import { createTaskActivationRequest, validateTaskActivationRequest } from "../../dist/task/taskActivation.js";
import { admitStoredTaskActivation } from "../../dist/task/taskActivationService.js";
import { createTaskMessage, validateTaskMessage } from "../../dist/message/message.js";
import { runControllerSchedulerPass } from "../../dist/controller/controller.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";

const at = new Date("2026-09-15T00:00:00Z");

test("current activation trusts admitted requests but still honors planning deferral and cancellation", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-current-activation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  try {
    const request = createTaskActivationRequest("task-1", {
      requestId: "deferred", actorId: "task:task-1/role:leader", authorityRef: "fixture:planning",
      startMode: "after-planning-turn", afterPlanningRun: "run-1", environmentPlan: { kind: "empty" }
    }, at);
    store.saveTask(setTaskActivationRequest(createTask("task-1", "Wait for planning", at), request, at));
    const reader = { getTask: id => store.getTask(id), getRun: () => ({ status: "active" }) };
    assert.equal(admitStoredTaskActivation(reader, "task-1").disposition, "deferred");
    reader.getRun = () => ({ status: "completed" });
    assert.equal(admitStoredTaskActivation(reader, "task-1").disposition, "ready");
    store.saveTask({ ...store.getTask("task-1"), activationRequest: { ...request, disposition: "cancelled" } });
    assert.equal(admitStoredTaskActivation(reader, "task-1").disposition, "settled");
    let adopted = 0;
    const pass = () => runControllerSchedulerPass(new FileSchedulerStoreAdapter(store), {
      inspectRole: async () => "absent",
      prepareRoleSession: async () => assert.fail("No Provider should be launched by this fixture.")
    }, at, {
      prepareTaskWorkspace: async () => {},
      activateTaskWorkspace: async id => { assert.equal(id, "task-1"); adopted++; }
    }, { kind: "full" }, false);
    await pass();
    assert.equal(adopted, 0, "The Controller must not revive a cancelled request.");
    store.saveTask({ ...store.getTask("task-1"), activationRequest: {
      ...createTaskActivationRequest("task-1", {
        requestId: "current-immediate", actorId: "user:local", authorityRef: "user:local",
        startMode: "immediate", environmentPlan: { kind: "empty" }
      }, at)
    } });
    await pass();
    assert.equal(adopted, 1, "The current Controller continues an admitted request without an origin gate.");
  } finally { store.close(); }
});
