import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, activateTask, completeTask, archiveTask } from "../../dist/task/task.js";
import { createProject } from "../../dist/repository/project.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession, replaceTaskRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createFixtureRun } from "../helpers/runFixture.mjs";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { createDurableJobControl, authorizeJobStart } from "../../dist/controller/jobControl.js";
import { createBuiltinCapabilities } from "../../dist/kernel/builtinCapabilities.js";
import { InstanceHost } from "../../dist/kernel/instanceHost.js";
import { createJobDefinitionControl, admitJobRun } from "../../dist/controller/jobDefinitionControl.js";
import { cancelQueuedDurableJob } from "../../dist/job/durableJob.js";
import { createScheduleControl, reconcileSchedules } from "../../dist/controller/scheduleControl.js";
import { saveArtifactCapability } from "../../dist/artifacts/artifactCapability.js";

test("Job admission, management and spawn keep a Worker inside its current Assignment", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-job-assignment-"));
  const store = new SqliteTaskStore(join(root, "home"));
  const host = new InstanceHost();
  t.after(async () => { await host.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const at = new Date("2026-09-15T12:00:00Z");
  const repository = path => {
    mkdirSync(path);
    const git = (...args) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-b", "main");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "--allow-empty", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  const main = join(root, "main"), worker = join(root, "worker");
  const head = repository(main), workerHead = repository(worker);
  const project = createProject("project-1", "app", join(root, "stable"), { stable: "main", development: "main" }, at);
  store.saveProject(project);
  const task = activateTask(createTask("task-1", "Scoped Jobs", at, {
    projectBindings: [{ projectId: project.id, directory: "app", baseRef: "main", baseCommit: head, currentCommit: head }]
  }), at);
  store.saveTask(task);
  const entry = (path, baseCommit) => ({ projectId: project.id, directory: "app", access: "write", path, branch: "main", baseRef: "main", baseCommit });
  const mainWorkspace = createManagedWorkspace({ owner: { type: "task", taskId: task.id }, root: main, entries: [entry(main, head)] }, at);
  const item = createWorkItem("work-item-1", task.id, { title: "Worker scope", assignee: "worker", writeProjectIds: [project.id] }, at);
  store.saveWorkItem(task.id, item);
  const workspace = createManagedWorkspace({ owner: { type: "work-item", taskId: task.id, workItemId: item.id },
    root: worker, entries: [entry(worker, workerHead)] }, at);
  store.saveManagedWorkspace(mainWorkspace);
  store.saveManagedWorkspace(workspace);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], at);
  store.saveConfiguredAgent(agent);
  for (const [name, space] of [["worker", workspace], ["leader", mainWorkspace]]) {
    const role = createRole(task.id, name, [createRoleAgentBinding(agent)], agent.id, space.root, at);
    store.saveRole(task.id, role);
    const effective = resolveEffectiveLaunch({ role, purpose: "execution", workspace: space,
      ...(name === "worker" ? { workItemWriteProjectIds: [project.id] } : {}) });
    store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet({ scope: "task", taskId: task.id, roleName: name }, agent.id, at),
      { agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: `session-${name}`, status: "active", policy: "fixed", effective }, at));
    if (name === "worker") store.saveActiveRun(createFixtureRun(store, "run-1", task.id, name, "new",
      createRunInput({ source: { type: "yui", channel: "workitem-dispatch" }, directive: "Work only in this Assignment.", deltaRefIds: [] }), at,
      { workItemId: item.id, workspace, effective }));
  }
  const caller = name => ({ scope: "task", taskId: task.id, role: name, nativeSessionId: `session-${name}` });
  const params = { taskId: task.id, requestId: "own-check", owner: { kind: "work-item", workItemId: item.id },
    projectId: project.id, head: workerHead, workspace: worker, env: {}, steps: [{ name: "check", command: "true" }], caller: caller("worker") };
  const control = createDurableJobControl(store);
  const own = control.startJob(params, at);
  assert.equal(own.created, true);
  assert.equal(control.getJob(task.id, own.job.id, caller("worker")).id, own.job.id);
  authorizeJobStart(store, own.job);
  assert.equal(control.startJob(params, at).job.id, own.job.id);
  const outside = { ...params, requestId: "main-check", owner: { kind: "task" }, head, workspace: main };
  assert.throws(() => control.startJob(outside, at),
    error => error.name === "CoreApplicationError" && error.code === "UNAUTHORIZED" && /Assignment/.test(error.message));
  const kernel = createBuiltinCapabilities(host, store, control);
  const { caller: _caller, requestId: _request, ...input } = outside;
  const denied = await kernel.registry.call(kernel.authenticate(caller("worker"), task.id), {
    name: "job.start", requestId: "capability-main-check", input
  });
  assert.equal(denied.kind, "denied");
  assert.equal(denied.effect, "none", "A rejected Assignment must not be reported as an unknown external effect.");
  // An older queued record must also be rejected at the actual spawn boundary.
  assert.throws(() => authorizeJobStart(store, { ...own.job, owner: outside.owner, workspace: main, head }), /[Aa]ssignment/);
  const leaderJob = control.startJob({ ...outside, caller: caller("leader") }, at).job;
  const definitions = createJobDefinitionControl(store, join(root, "home"));
  const scope = { kind: "task", taskId: task.id };
  const material = await saveArtifactCapability(join(root, "home"), task.id, {
    relativePath: "delegated.md", content: "selected Task evidence"
  });
  const artifactRequest = { scope, id: leaderJob.definitionId, runId: leaderJob.id, caller: caller("leader") };
  const selected = { kind: "artifact", owner: { kind: "task", taskId: task.id },
    sourceRun: { scope, runId: leaderJob.id }, version: material.commit,
    relativePath: material.relativePath, digest: material.digest };
  await definitions({ ...artifactRequest, op: "artifact-register", reference: selected }, at);
  await saveArtifactCapability(join(root, "home"), task.id, { relativePath: "delegated.md", content: "later bytes" });
  assert.equal((await definitions({ ...artifactRequest, op: "artifact-read", reference: selected }, at)).content, "selected Task evidence");
  await assert.rejects(async () => definitions({ ...artifactRequest, op: "artifact-read",
    caller: caller("worker"), reference: selected }, at), /Assignment/i);
  await assert.rejects(async () => definitions({ ...artifactRequest, op: "artifact-register",
    reference: { ...selected, owner: { kind: "task", taskId: "task-2" } } }, at), /different Task/);
  await assert.rejects(async () => definitions({ ...artifactRequest, op: "artifact-read",
    reference: { ...selected, relativePath: "unselected.md" } }, at), /registered/);
  const configuration = { kind: "shell", owner: { kind: "task" }, projectId: project.id,
    head, workspace: main, env: {}, steps: [{ name: "first", command: "true" }] };
  const definition = definitions({ op: "define", id: "repeatable", title: "Repeated check",
    scope, caller: caller("leader"), configuration }, at);
  assert.throws(() => definitions({ op: "show", id: definition.id, scope, caller: caller("worker") }, at), /Assignment/i);
  assert.throws(() => definitions({ op: "show", id: definition.id, scope,
    caller: { ...caller("worker"), scope: "invalid" } }, at),
    error => error.code === "INVALID_PARAMS");
  const first = admitJobRun(store, root, scope, definition.id, caller("leader"), { source: "manual", key: "one" }, at);
  assert.equal(first.created, true);
  assert.equal(admitJobRun(store, root, scope, definition.id, caller("leader"), { source: "manual", key: "one" }, at).run.id, first.run.id);
  assert.equal(admitJobRun(store, root, scope, definition.id, caller("leader"), { source: "manual", key: "two" }, at).reason, "overlap");
  store.saveDurableJob(task.id, cancelQueuedDurableJob(first.run, at));
  const original = store.getDurableJob(task.id, first.run.id);
  definitions({ op: "update", id: definition.id, scope, caller: caller("leader"), expectedRevision: 1,
    title: "Changed check", configuration: { ...configuration, steps: [{ name: "second", command: "echo second" }] } }, at);
  assert.throws(() => admitJobRun(store, root, scope, definition.id, caller("leader"), { source: "manual", key: "one" }, at), /conflict/i);
  const second = admitJobRun(store, root, scope, definition.id, caller("leader"), { source: "manual", key: "two" }, at);
  assert.notEqual(second.run.id, first.run.id);
  assert.equal(second.run.definitionRevision, 2);
  assert.deepEqual(store.getDurableJob(task.id, first.run.id), original);
  store.saveDurableJob(task.id, cancelQueuedDurableJob(second.run, at));
  assert.throws(() => store.transaction(tx => {
    admitJobRun(tx, root, scope, definition.id, caller("leader"), { source: "schedule", key: "atomic-tick" }, at);
    throw new Error("rollback schedule");
  }), /rollback schedule/);
  assert.equal(store.listDurableJobs(task.id).filter(run => run.definitionId === definition.id).length, 2);
  const schedules = createScheduleControl(store, join(root, "home"));
  const scheduleInput = { scope, caller: caller("leader"), jobId: definition.id };
  assert.throws(() => schedules({ ...scheduleInput, op: "create", id: "forbidden-service",
    authorization: "service", rule: { kind: "once", at: new Date(at.getTime() + 60_000).toISOString() } }, at),
    /service.*scope|service.*action/i);
  schedules({ ...scheduleInput, op: "create", id: "periodic",
    rule: { kind: "interval", anchor: at.toISOString(), everyMs: 60_000 } }, at);
  assert.throws(() => schedules({ ...scheduleInput, op: "show", id: "periodic", caller: caller("worker") }, at), /Assignment/);
  assert.throws(() => schedules({ ...scheduleInput, op: "list", scope: { kind: "task", taskId: "task-2" } }, at));
  const due = new Date(at.getTime() + 60_000);
  reconcileSchedules(store, join(root, "home"), due, error => { throw error; });
  const periodic = store.getSchedule(scope, "periodic");
  const scheduled = store.getDurableJob(task.id, periodic.lastAttempt.runId);
  assert.equal(scheduled.definitionId, definition.id);
  assert.equal(scheduled.trigger.source, "schedule");
  authorizeJobStart(store, scheduled);
  store.saveDurableJob(task.id, cancelQueuedDurableJob(scheduled, due));
  assert.throws(() => store.transaction(tx => {
    schedules({ ...scheduleInput, op: "create", id: "future",
      rule: { kind: "once", at: new Date(at.getTime() + 3600_000).toISOString() } }, at);
    assert.throws(() => tx.saveTask(completeTask(task, at, { by: "leader", summary: "Done" })), /unfulfilled once/);
    schedules({ ...scheduleInput, op: "disable", id: "future", expectedRevision: 1 }, at);
    tx.saveTask(completeTask(task, at, { by: "leader", summary: "Done" }));
    assert.equal(tx.getSchedule(scope, "periodic").state, "retired");
    assert.equal(tx.getSchedule(scope, "future").state, "disabled");
    throw new Error("restore active fixture");
  }), /restore active fixture/);
  assert.throws(() => control.startJob({ ...params, requestId: "leader-private-workspace",
    caller: caller("leader") }, at), /Assignment/);
  assert.throws(() => control.getJob(task.id, leaderJob.id, caller("worker")), /Assignment/i);
  assert.throws(() => control.cancelJob(task.id, leaderJob.id, at, caller("worker")), /[Aa]ssignment/);
  assert.throws(() => control.acknowledgeJob(task.id, leaderJob.id, at, caller("worker")), /[Aa]ssignment/);
  assert.equal(store.getDurableJob(task.id, leaderJob.id).cancelRequestedAt, undefined);
  assert.ok(control.cancelJob(task.id, own.job.id, at, caller("worker")).cancelRequestedAt);
  const workerRun = store.getActiveRun(task.id, "worker");
  store.clearActiveRun(task.id, "worker");
  assert.throws(() => authorizeJobStart(store, own.job), /[Aa]ssignment/);
  authorizeJobStart(store, leaderJob);
  // A desired Profile edit cannot broaden an old queued Job's captured scope.
  const leaderSet = store.getTaskRoleSessionSet(task.id, "leader");
  const leaderRole = store.getRole(task.id, "leader");
  const old = { ...leaderSet.sessions.codex,
    effective: resolveEffectiveLaunch({ role: leaderRole, purpose: "execution", workspace: mainWorkspace,
      workItemWriteProjectIds: [] }) };
  store.saveTaskRoleSessionSet({ ...leaderSet, sessions: { ...leaderSet.sessions, codex: old } });
  assert.throws(() => authorizeJobStart(store, leaderJob), /captured/);
  assert.throws(() => control.startJob({ ...outside, requestId: "old-scope", caller: caller("leader") }, at), /captured/);
  assert.ok(control.cancelJob(task.id, leaderJob.id, at, caller("leader")).cancelRequestedAt,
    "Scope denial must not prevent safe cancellation of an owned Job.");
  // Updating a stable definition authorizes the old owner, not its stale
  // execution snapshot. Only the replacement configuration must be runnable.
  store.saveTaskRoleSessionSet(leaderSet);
  store.saveActiveRun(workerRun);
  execFileSync("git", ["-C", main, "-c", "user.name=Fixture", "-c", "user.email=fixture@local",
    "commit", "--allow-empty", "-m", "advance"]);
  const advancedHead = execFileSync("git", ["-C", main, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const update = { op: "update", id: definition.id, scope, caller: caller("leader"),
    expectedRevision: 2, title: "Advanced check", configuration: { ...configuration, head: advancedHead } };
  assert.throws(() => definitions({ ...update, caller: caller("worker") }, at), /Assignment/i);
  assert.throws(() => definitions({ ...update, configuration }, at), /HEAD/i);
  assert.equal(store.getJobDefinition(scope, definition.id).revision, 2);
  assert.equal(definitions(update, at).revision, 3);
  const advanced = admitJobRun(store, root, scope, definition.id, caller("leader"),
    { source: "manual", key: "advanced" }, at);
  assert.equal(advanced.run.head, advancedHead);
  assert.deepEqual(store.getDurableJob(task.id, first.run.id), original);

  // An Operator can retarget a definition, but that does not grant the new
  // Assignment permission to read an already-admitted Run's old snapshot.
  for (const name of ["operator", "assistant"]) {
    const globalRole = createGlobalRole(name, [createRoleAgentBinding(agent)], agent.id, root, at);
    store.createGlobalRoleIfAbsent(globalRole);
    store.saveGlobalRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
      { scope: "global", roleName: name }, agent.id, at
    ), { agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: `session-${name}`,
      status: "active", policy: "fixed", effective: resolveEffectiveLaunch({ role: globalRole, purpose: "execution" }) }, at));
  }
  const operatorCaller = { scope: "global", role: "operator", nativeSessionId: "session-operator" };
  const assistantCaller = { scope: "global", role: "assistant", nativeSessionId: "session-assistant" };
  assert.throws(() => control.getJob(task.id, advanced.run.id, assistantCaller),
    error => error.code === "UNAUTHORIZED");
  for (const op of ["show", "list", "run"]) {
    assert.throws(() => definitions({ op, id: definition.id, scope, caller: assistantCaller,
      trigger: { source: "manual", key: "assistant-denied" } }, at),
    error => error.code === "UNAUTHORIZED");
  }
  assert.equal(definitions({ op: "show", id: definition.id, scope, caller: operatorCaller }, at).id, definition.id);
  definitions({ ...update, caller: operatorCaller, expectedRevision: 3, configuration: {
    ...configuration, owner: params.owner, workspace: worker, head: workerHead
  } }, at);
  const workerRequest = { id: definition.id, scope, caller: caller("worker") };
  assert.throws(() => definitions({ ...workerRequest, op: "run-get", runId: advanced.run.id }, at), /Assignment/i);
  assert.deepEqual(definitions({ ...workerRequest, op: "runs" }, at), []);
  const trigger = { source: "manual", key: "retargeted" };
  assert.throws(() => definitions({ ...workerRequest, op: "run", trigger }, at),
    error => error.code === "UNAUTHORIZED" && /Assignment/i.test(error.message));
  assert.throws(() => definitions({ ...workerRequest, op: "run", trigger: advanced.run.trigger }, at),
    error => error.code === "UNAUTHORIZED" && /Assignment/i.test(error.message));
  const overlap = admitJobRun(store, root, scope, definition.id, operatorCaller, trigger, at);
  assert.equal(overlap.reason, "overlap");
  assert.equal(overlap.run.id, advanced.run.id);
  assert.equal(store.listDurableJobs(task.id).filter(run => run.definitionId === definition.id).length, 4);
  assert.deepEqual(store.getDurableJob(task.id, advanced.run.id), advanced.run);
  // Formal selected evidence is independent of a replaced reader Session,
  // retired schedules and released delivery working directories.
  const replacement = replaceTaskRoleAgentSession(leaderSet, {
    ...leaderSet.sessions.codex, nativeSessionId: "replacement-leader", status: "active"
  }, due);
  store.saveTaskRoleSessionSet(replacement);
  await assert.rejects(async () => definitions({ ...artifactRequest, op: "artifact-read", reference: selected }, due), /Session|caller|identity/i);
  for (const job of store.listDurableJobs(task.id)) {
    if (job.status === "queued") store.saveDurableJob(task.id, cancelQueuedDurableJob(job, due));
  }
  store.saveTask(archiveTask(completeTask(task, due, { by: "leader", summary: "Fixture complete" }), due));
  assert.equal(store.getSchedule(scope, "periodic").state, "retired");
  rmSync(main, { recursive: true, force: true });
  rmSync(worker, { recursive: true, force: true });
  const retained = await definitions({ ...artifactRequest, caller: { ...caller("leader"), nativeSessionId: "replacement-leader" },
    op: "artifact-read", reference: selected }, due);
  assert.equal(retained.content, "selected Task evidence");
  assert.equal(retained.reference.owner.kind, "task", "selection never copies the Task's artifact");
});
