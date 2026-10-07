import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { projectWorkItemExecution } from "../../dist/execution/workItemExecutionProjection.js";
import { createProject } from "../../dist/repository/project.js";
import { snapshotWorkItemCandidate } from "../../dist/repository/workItemCandidateSnapshot.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { activateTask, createTask, retireTask } from "../../dist/task/task.js";
import { projectNextAction } from "../../dist/task/nextAction.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { assertTaskProjectWriteAuthority, taskIntegrationTargetCheckout } from "../../dist/task/taskAuthority.js";
import { freezeRunContextSnapshot, buildRunContextPack } from "../../dist/context/runContextPack.js";
import { contextSnapshotRef } from "../../dist/context/contextSnapshot.js";
import { createRun, failRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";

const now = new Date("2026-09-12T00:00:00.000Z");

test("delivery Leader owns Task-main writes without an open WorkItem; other scopes do not", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-leader-direct-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  store.saveProject(createProject("project-1", "app", join(home, "reference"),
    { stable: "main", development: "main" }, now));
  const task = activateTask(createTask("task-1", "Direct delivery", now, {
    cwd: home, projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "main" }]
  }), now);
  store.saveTask(task);
  const workspace = createManagedWorkspace({
    owner: { type: "task", taskId: task.id }, root: home,
    entries: [{ projectId: "project-1", directory: "app", access: "write",
      path: join(home, "app"), branch: "main", baseRef: "main", baseCommit: "a".repeat(40) }]
  }, now);
  store.saveManagedWorkspace(workspace);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "leader", [binding], binding.agentId, home, now);
  store.saveRole(task.id, role);
  const scheduler = new FileSchedulerStoreAdapter(store);
  assert.deepEqual(scheduler.getRole(task.id, role.name).effective.writeProjectIds, ["project-1"]);
  const launch = input => resolveEffectiveLaunch({ role, purpose: "execution", workspace, ...input });
  assert.deepEqual(launch({}).writeProjectIds, ["project-1"]);
  for (const input of [
    { purpose: "planning" }, { executionAuthority: "planning" },
    { role: { ...role, defaultAccess: "read" } },
    { role: { ...role, name: "worker" } },
    { workspace: { ...workspace, owner: { type: "task", taskId: "task-2" } } },
    { workspace: { ...workspace, owner: { type: "work-item", taskId: task.id, workItemId: "work-item-1" } } },
    { workspace: undefined }, { workItemWriteProjectIds: [] }
  ]) assert.deepEqual(launch(input).writeProjectIds, [], JSON.stringify(input));
  assert.deepEqual(launch({ role: { ...role, name: "worker" },
    workItemWriteProjectIds: ["project-1"] }).writeProjectIds, ["project-1"]);
  assert.throws(() => launch({ workItemWriteProjectIds: ["project-2"] }), /scope/);

  // Retain an accepted result instead of reopening it for access.
  const command = args => runTaskCommand(args, store, { environment: {}, now: () => now });
  command(["work", "create", task.id, "Accepted finding"]);
  command(["work", "update", `${task.id}/work-item-1`, "done", "--summary", "Original evidence"]);
  command(["work", "accept", `${task.id}/work-item-1`, "--summary", "Original acceptance"]);
  const accepted = store.getWorkItem(task.id, "work-item-1");
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(scheduler.getRole(task.id, role.name).effective.writeProjectIds, ["project-1"]);

  // This valid empty scope represents the launch captured by the old runtime.
  // Desired Role/source changes cannot rewrite it.
  const oldEffective = launch({ workItemWriteProjectIds: [] });
  const session = (nativeSessionId, effective) => ({ agentId: binding.agentId,
    adapterId: binding.adapterId, nativeSessionId, status: "active", policy: "fixed", effective });
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet({
    scope: "task", taskId: task.id, roleName: role.name
  }, binding.agentId, now), session("old-session", oldEffective), now));
  assert.deepEqual(scheduler.getRole(task.id, role.name).effective.writeProjectIds, []);
  const env = { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: task.id, YUI_ROLE: role.name,
    YUI_NATIVE_SESSION_ID: "old-session", YUI_WORKSPACE: home };
  assert.throws(() => assertTaskProjectWriteAuthority(store, env, task.id, "project-1"), /captured/);
  store.saveConfiguredAgent(createConfiguredAgent("codex", "codex", "false", [], [], now));
  mkdirSync(join(home, "app"));
  const planner = new FileRoleLaunchPlanner(home, store, {
    environment: { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: join(home, "account") },
    inspectWorkspacePhysicalState: () => ({ physicalCommit: "a".repeat(40), recordedBaseIsAncestor: true })
  });
  const plan = (mode, effective, runId) => planner.plan({ taskId: task.id, roleName: role.name,
    agentId: binding.agentId, adapterId: binding.adapterId, mode, effective,
    ...(mode === "resume" ? { nativeSessionId: "old-session" } : {}),
    ...(runId === undefined ? {} : { runId }) });
  const oldPlan = plan("resume", oldEffective);
  assert.deepEqual(JSON.parse(oldPlan.launch.env.YUI_WRITABLE_PROJECT_IDS), []);
  assert.equal(JSON.parse(oldPlan.launch.env.YUI_WORKSPACE_PROJECTS)["project-1"].access, "read");
  assert.throws(() => plan("resume", launch({})), /snapshot changed/);

  // An ordinary retry is reachable on this same native Session. It must not
  // recalculate the new Leader fallback and advertise authority the Session lacks.
  const oldSnapshot = freezeRunContextSnapshot(store, {
    taskId: task.id, roleName: role.name, purpose: "execution", workspace
  }, now);
  const failed = failRun(createRun(store.nextRunId(task.id), task.id, role.name, "resume",
    createRunInput({ source: { type: "yui", channel: "task-dispatch" },
      contextSnapshotRef: contextSnapshotRef(oldSnapshot), deltaRefIds: [] }), now,
    { effective: oldEffective, workspace }), "startup-failed", "Fixture failure", now);
  store.saveRun(failed);
  command(["run", "retry", `${task.id}/${failed.id}`]);
  const retry = store.getActiveRun(task.id, role.name);
  assert.equal(retry.mode, "resume");
  assert.deepEqual(retry.effective.writeProjectIds, []);
  assert.deepEqual(buildRunContextPack(store, task.id, retry.id).authority.writableProjectIds, []);
  const retryPlan = plan("resume", retry.effective, retry.id);
  assert.deepEqual(JSON.parse(retryPlan.launch.env.YUI_WRITABLE_PROJECT_IDS), []);
  assert.equal(JSON.parse(retryPlan.launch.env.YUI_WORKSPACE_PROJECTS)["project-1"].access, "read");
  assert.throws(() => assertTaskProjectWriteAuthority(store, env, task.id, "project-1"), /captured/);
  store.saveRun(failRun(retry, "startup-failed", "Fixture stopped before Provider", now));
  store.clearActiveRun(task.id, role.name);
  assert.deepEqual(store.getTaskRoleSessionSet(task.id, role.name).sessions.codex.effective, oldEffective);

  runTaskCommand(["role", "session", "new", task.id, role.name, "--reason", "Adopt direct-delivery scope"],
    store, { environment: env, now: () => now });
  // This boundary is called after native stop proof; this fixture has no Host.
  scheduler.completeRuntimeCleanup({ kind: "role-runtime", taskId: task.id, roleName: role.name }, now);
  assert.deepEqual(store.getTaskRoleSessionSet(task.id, role.name).history.at(-1).effective.writeProjectIds, []);
  assert.throws(() => assertTaskProjectWriteAuthority(store, env, task.id, "project-1"), /Session|runtime/);
  const fresh = scheduler.getRole(task.id, role.name).effective;
  assert.deepEqual(fresh.writeProjectIds, ["project-1"]);
  // A separately assigned read-only Leader result is an explicit empty scope,
  // not the absence of an Assignment. Scheduler and actual launch must agree.
  command(["work", "create", task.id, "Leader finding", "--role", "leader"]);
  const assigned = scheduler.getRole(task.id, role.name).effective;
  assert.deepEqual(assigned.writeProjectIds, []);
  const assignedPlan = plan("new", assigned);
  assert.deepEqual(JSON.parse(assignedPlan.launch.env.YUI_WRITABLE_PROJECT_IDS), []);
  assert.equal(JSON.parse(assignedPlan.launch.env.YUI_WORKSPACE_PROJECTS)["project-1"].access, "read");
  command(["work", "retire", `${task.id}/work-item-2`, "--summary", "Fixture scope checked"]);
  assert.deepEqual(scheduler.getRole(task.id, role.name).effective, fresh);
  const snapshot = freezeRunContextSnapshot(store, { taskId: task.id, roleName: role.name,
    purpose: "execution" }, now);
  const run = createRun(store.nextRunId(task.id), task.id, role.name, "new", createRunInput({
    source: { type: "yui", channel: "leader-wakeup" }, directive: "Continue same Task",
    contextSnapshotRef: contextSnapshotRef(snapshot), deltaRefIds: []
  }), now, { effective: fresh, workspace });
  store.saveActiveRun(run);
  assert.deepEqual(buildRunContextPack(store, task.id, run.id).authority.writableProjectIds, ["project-1"]);
  const freshPlan = plan("new", fresh, run.id);
  assert.deepEqual(JSON.parse(freshPlan.launch.env.YUI_WRITABLE_PROJECT_IDS), ["project-1"]);
  const manifest = JSON.parse(readFileSync(freshPlan.launch.env.YUI_SESSION_MANIFEST, "utf8"));
  assert.equal(JSON.parse(readFileSync(manifest.roleProfileRef.path, "utf8")).defaultAccess, fresh.profileAccess);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(store.getTaskRoleSessionSet(task.id, role.name),
    session("new-session", fresh), now));
  const current = { ...env, YUI_NATIVE_SESSION_ID: "new-session" };
  assert.equal(assertTaskProjectWriteAuthority(store, current, task.id, "project-1"), "leader");
  assert.equal(taskIntegrationTargetCheckout(store, current, task.id, "project-1", "refs/heads/main"),
    join(home, "app"));
  store.saveManagedWorkspace({ ...workspace,
    entries: workspace.entries.map(entry => ({ ...entry, branch: "different-main" })) });
  assert.throws(() => taskIntegrationTargetCheckout(store, current, task.id, "project-1", "different-main"),
    /captured Task-main/);
  store.saveManagedWorkspace(workspace);
  assert.throws(() => assertTaskProjectWriteAuthority(store, current, task.id, "project-2"), /captured/);
  assert.throws(() => assertTaskProjectWriteAuthority(store, current, "task-2", "project-1"), /matching Leader/);
  store.saveTask({ ...task, executionGate: { state: "stopped" } });
  assert.throws(() => assertTaskProjectWriteAuthority(store, current, task.id, "project-1"), /captured/);
  store.saveTask(task);
  store.saveTask(retireTask(task, { by: "user", summary: "Terminal boundary" }, now));
  assert.throws(() => assertTaskProjectWriteAuthority(store, current, task.id, "project-1"), /captured/);
  assert.deepEqual(store.getWorkItem(task.id, accepted.id), accepted);
});

test("direct ownership is actionable without dispatch and preserves managed assignments", () => {
  const task = activateTask(createTask("task-1", "One coherent outcome", now), now);
  const item = createWorkItem("work-item-1", task.id, { title: "Independent acceptance" }, now);
  const facts = {
    task, workItems: [item], changeSets: [], integrations: [],
    reviewRounds: [], reviewConfig: null, openInputRequests: [], activeRuns: [], leaderRuns: []
  };
  assert.equal(projectWorkItemExecution(item, []).nextAction.kind, "execute-directly");
  assert.equal(projectNextAction(facts).recommendedCommand,
    "yui task work update task-1/work-item-1 running");
  for (const assignee of ["worker", "leader"]) {
    const managed = { ...item, assignee };
    assert.equal(projectWorkItemExecution(managed, []).nextAction.kind, "dispatch-work");
    assert.equal(projectNextAction({ ...facts, workItems: [managed] }).recommendedCommand,
      "yui task work dispatch task-1/work-item-1");
  }
});

test("a read-only direct Candidate needs no Git workspace or AgentRun; writable work still does", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-direct-work-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  store.saveProject(createProject("project-1", "lab", join(home, "reference"),
    { stable: "main", development: "main" }, now));
  const task = activateTask(createTask("task-1", "Bounded direct delivery", now, {
    projectBindings: [{ projectId: "project-1", directory: "lab", baseRef: "main" }]
  }), now);
  store.saveTask(task);
  const item = createWorkItem("work-item-1", task.id, { title: "Read-only finding" }, now);
  store.saveWorkItem(task.id, item);
  const noGit = {
    snapshotCandidateWorkspace() { assert.fail("read-only work must not require Git"); },
    snapshotDirectTaskMain() { assert.fail("read-only work must not require Task main"); }
  };
  const snapshots = await snapshotWorkItemCandidate(store, noGit, task.id, item.id);
  assert.deepEqual(snapshots, {});
  const result = runTaskCommand(
    ["work", "update", "task-1/work-item-1", "done", "--summary", "Finding with evidence"],
    store, { environment: {}, ...snapshots }
  );
  assert.equal(result.data.workItem.candidates[0].source.type, "direct");
  runTaskCommand(["work", "accept", "task-1/work-item-1", "--summary", "Evidence inspected"],
    store, { environment: {} });
  assert.equal(store.getWorkItem(task.id, item.id).status, "accepted");
  assert.deepEqual(store.listRuns(task.id), []);
  assert.deepEqual(store.listManagedWorkspaces(task.id), []);

  const writable = createWorkItem("work-item-2", task.id,
    { title: "Code result", writeProjectIds: ["project-1"] }, now);
  store.saveWorkItem(task.id, writable);
  await assert.rejects(
    snapshotWorkItemCandidate(store, noGit, task.id, writable.id),
    /isolate/u
  );
});

test("a no-Project Worker dispatch uses the Task main workspace", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-projectless-worker-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const task = activateTask(createTask("task-1", "Worker result", now, { cwd: home }), now);
  store.saveTask(task);
  const workspace = createManagedWorkspace({
    owner: { type: "task", taskId: task.id }, root: home, entries: []
  }, now);
  store.saveManagedWorkspace(workspace);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  store.saveRole(task.id, createRole(task.id, "worker", [binding], binding.agentId, home, now));
  const item = createWorkItem("work-item-1", task.id, {
    title: "Exact result", assignee: "worker"
  }, now);
  store.saveWorkItem(task.id, item);

  runTaskCommand(["work", "dispatch", `${task.id}/${item.id}`], store,
    { now: () => now, environment: {} });
  const run = store.getActiveRun(task.id, "worker");
  assert.ok(run);
  assert.deepEqual(run.workspace, workspace);
  assert.deepEqual(run.effective.writeProjectIds, []);
  assert.equal(run.workItemId, item.id);
  assert.equal(store.getWorkItem(task.id, item.id).status, "open");
});
