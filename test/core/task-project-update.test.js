import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createProject } from "../../dist/repository/project.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { runTaskCommand, updateTaskMetadataCommand } from "../../dist/commands/taskCommands.js";
import { runTaskProjectUpdateCommand, taskProjectBindingsGuard } from "../../dist/commands/taskProjectUpdateCommands.js";

test("binding updates distinguish aliases and upstream targets, retain commits and reject stale/foreign writes", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-project-update-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-11-05T00:00:00Z");
  const base = "a".repeat(40), head = "b".repeat(40), upstream = "c".repeat(40);
  store.saveProject(createProject("project-1", "app", join(home, "repo"),
    { stable: "master", development: "master" }, now, { remoteUrl: join(home, "remote") }));
  store.saveTask(activateTask(createTask("task-1", "Binding update", now, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "origin/master",
      baseCommit: base, currentCommit: head }]
  }), now));
  const workspace = createManagedWorkspace({ owner: { type: "task", taskId: "task-1" },
    root: join(home, "main"), entries: [{ projectId: "project-1", directory: "app",
      path: join(home, "main/app"), access: "write", branch: "task-main",
      baseRef: "origin/master", baseCommit: base }] }, now);
  store.saveManagedWorkspace(workspace);
  let resolved = base;
  const options = { environment: {}, now: () => now,
    git: { resolveRemoteHead: async () => ({ branch: "master", commit: resolved }) } };
  const guard = () => taskProjectBindingsGuard(store.getTask("task-1"));
  const update = (baseRef, token = guard(), extra = {}) =>
    runTaskProjectUpdateCommand(["task-1", "project-1", "--base", baseRef, "--if-current", token],
      store, { ...options, ...extra });
  assert.equal(runTaskCommand(["project", "list", "task-1"], store).data.writeGuard, guard());
  const oldGuard = guard();
  assert.throws(() => updateTaskMetadataCommand(store, "task-1", { projectBindings: [] },
    { environment: {} }), /Use task project update/);
  assert.equal(guard(), oldGuard, "The ordinary metadata service cannot bypass binding validation.");
  const alias = await update("master");
  assert.equal(alias.data.change, "reference-only");
  assert.equal(store.getTaskWorkspace("task-1").entries[0].baseRef, "master");
  assert.equal(store.getTask("task-1").projectBindings[0].currentCommit, head);
  assert.equal(store.getTask("task-1").projectBindings[0].baseCommit, base);
  await assert.rejects(update("other", oldGuard), /changed|guard/i);
  resolved = upstream;
  const target = await update("next");
  assert.equal(target.data.change, "upstream-target");
  assert.equal(target.data.workspaceMigrated, false);
  assert.match(target.data.nextAction, /upstream integrate/);
  assert.equal(store.getTaskWorkspace("task-1").entries[0].baseCommit, base);
  assert.equal(store.getTask("task-1").projectBindings[0].currentCommit, head);
  const before = store.getTask("task-1");
  await assert.rejects(update("foreign", guard(), { environment: {
    YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-other", YUI_ROLE: "leader"
  } }), /matching Leader|authority|Session/i);
  await assert.rejects(update("racing", guard(), { git: { resolveRemoteHead: async () => {
    store.saveTask({ ...store.getTask("task-1"), projectBindings: [
      { ...before.projectBindings[0], baseRef: "concurrent" }
    ] });
    return { branch: "racing", commit: base };
  } } }), /changed|guard/i);
  assert.equal(store.getTask("task-1").projectBindings[0].baseRef, "concurrent");
  assert.equal(store.listEvents("task-1").filter(e => e.type === "task.project-updated").length, 2);
});
