import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, activateTask, retireTask, reopenTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { FileTaskRuntimeIsolation } from "../../dist/runtime/taskRuntimeIsolation.js";
import { managedRuntimeRoot } from "../../dist/storage/homeLayout.js";
import { controllerSocketPath } from "../../dist/core/controllerEndpoint.js";
import { planResourceGc, applyResourceGc, restoreAllResourceGc, purgeResourceQuarantine } from "../../dist/resources/resourceGc.js";

test("GC owns one physical subtree and rechecks durable ownership before moving it", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-lifecycle-"));
  const home = join(root, "home");
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const now = new Date("2026-09-16T00:00:00Z");
  const task = retireTask(activateTask(createTask("task-1", "GC fixture", now), now),
    { by: "user", summary: "Work stopped." }, now);
  store.saveTask(task);
  const path = join(root, "workspace");
  mkdirSync(path);
  const workspace = createManagedWorkspace({ owner: { type: "task", taskId: task.id }, root: path, entries: [] }, now);
  store.saveManagedWorkspace(workspace);
  const isolation = new FileTaskRuntimeIsolation({ runtimeRoot: managedRuntimeRoot(home),
    controlPlane: { yuiHome: home, controllerSocketPath: controllerSocketPath(store.getHomeIdentity().homeId),
      tmuxNamespace: "fixture-no-server", managedRuntimeRoot: managedRuntimeRoot(home) } });
  const prepared = isolation.preflight({ workspace });
  isolation.activate(prepared);
  const ports = { processCwdRefs: () => new Map(), tmuxPaneCwds: async () => [] };
  const input = { home, sessionOwners: [], projects: [], managedWorkspaces: [workspace], taskStatusById: new Map([[task.id, task.status]]),
    mode: "quarantine", now, liveReferencePorts: ports, activeWorkspaceOwnerPaths: [] };
  const plan = await planResourceGc(input);
  assert.ok(plan.releasable.length > 0);
  store.saveTask(reopenTask(task, now));
  const blocked = await applyResourceGc(input, plan, store);
  assert.equal(blocked.applied.length, 0, "A stale cancelled snapshot cannot quarantine an active Task.");
  assert.ok(blocked.planned.retained.some(record => /terminal|ownership/i.test(record.blocker ?? "")));
  assert.equal(existsSync(prepared.descriptor.roots.data), true);
  store.saveTask(retireTask(store.getTask(task.id), { by: "user", summary: "Stopped again." }, now));
  const applied = await applyResourceGc(input, plan, store);
  assert.equal(applied.applied.length, 1, "Move the enclosing runtime once.");
  assert.equal(applied.failed.length, 0, "Moving the parent must not produce child ENOENT failures.");
  assert.equal(existsSync(prepared.descriptor.roots.runtime), false);
  const restored = await restoreAllResourceGc(home, { now });
  assert.equal(restored.restored.length, 1);
  assert.equal(restored.failed.length, 0);
  assert.equal(existsSync(prepared.descriptor.roots.data), true);
  await applyResourceGc(input, await planResourceGc(input), store);
  store.saveTask(reopenTask(store.getTask(task.id), now));
  const revived = await purgeResourceQuarantine(home, {
    now: new Date(now.valueOf() + 25 * 3600_000), liveReferencePorts: ports, managedWorkspaces: [workspace]
  }, store);
  assert.equal(revived.purged.length, 0);
  assert.equal(revived.restored.length, 1, "Purge must not discard a reopened Task's runtime.");
  store.saveTask(retireTask(store.getTask(task.id), { by: "user", summary: "Finished." }, now));
  await applyResourceGc(input, await planResourceGc(input), store);
  const purged = await purgeResourceQuarantine(home, {
    now: new Date(now.valueOf() + 25 * 3600_000), liveReferencePorts: ports, managedWorkspaces: [workspace]
  }, store);
  assert.equal(purged.purged.length, 1);
  assert.equal(purged.failed.length, 0);
});
