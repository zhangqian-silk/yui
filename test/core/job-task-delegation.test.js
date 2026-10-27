import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createJobDefinitionControl } from "../../dist/controller/jobDefinitionControl.js";
import { completeTask, activateTask, createTask, reopenTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createWorkItem, submitWorkItemCandidate, editWorkItemDefinition } from "../../dist/workItem/workItem.js";
import { readTaskCatalog, parseTaskCatalogOptions } from "../../dist/context/taskCatalog.js";
import { createGlobalRole, createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { applySqliteMinorUpgrades } from "../../dist/storage/sqliteSchema.js";
import Database from "../../dist/sqlite/driver.js";
import { saveArtifactCapability } from "../../dist/artifacts/artifactCapability.js";
import { DurableJobSupervisor } from "../../dist/controller/jobSupervisor.js";
import { reconcileTaskDelegation } from "../../dist/controller/jobTaskDelegationControl.js";
import { validateDurableJob } from "../../dist/job/durableJob.js";
import { jobCleanupBlocker } from "../../dist/job/jobCleanupInspection.js";
import { usePre120Layout } from "../helpers/pre19Storage.mjs";

test("Task delegation is atomic per Run, source immutable, and only exact delivery completes it", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-delegate-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date();
  store.saveConfiguredAgent(createConfiguredAgent("fixture", "codex", "false", [], [], now));
  store.saveConfig({ ...store.getConfig(), defaultAgent: "fixture" });
  const control = createJobDefinitionControl(store, home);
  const base = { scope: { kind: "global" }, caller: { scope: "user" }, id: "delivery" };
  const call = (op, extra = {}) => control({ ...base, op, ...extra }, now);
  call("define", { title: "Delivery", configuration: { kind: "task",
    target: { kind: "new", title: "Deliver feature", description: "Deliver and verify.", type: "feature", projectBindings: [] },
    goal: "delivery" } });
  const first = call("run", { trigger: { source: "manual", key: "one" } }).run;
  assert.equal(first.status, "running");
  assert.equal(first.businessResult, undefined);
  for (const key of ["head", "workspace", "env", "steps", "process", "checkpoint", "result", "action"]) {
    assert.equal(Object.hasOwn(first, key), false, `Delegation must not fabricate ${key}`);
  }
  assert.throws(() => validateDurableJob({ ...first, steps: [] }), /process specification/);
  const unexpected = new Proxy({}, { get: (_, key) => () => assert.fail(`Delegation accessed process port ${String(key)}`) });
  let collected = 0;
  const supervisor = new DurableJobSupervisor({
    store: { listActiveDurableJobs: () => [store.getGlobalJobRun(first.id)] },
    process: unexpected, artifacts: unexpected, authorizeStart: () => assert.fail("Delegation tried to spawn"),
    onError: error => { throw error; },
    reconcileDelegation: (run, at) => { collected++; reconcileTaskDelegation(store, run, at); }
  });
  supervisor.reconcile(now);
  supervisor.confirmResult("global", first.id, now);
  assert.equal(collected, 2);
  const target = store.getTask(first.delegation.taskId);
  assert.equal(target.status, "draft");
  assert.equal(target.type, "feature");
  assert.equal(target.source.kind, "job-run");
  assert.equal(target.source.jobId, "delivery");
  assert.equal(target.source.run.runId, first.id);
  assert.equal(call("run", { trigger: { source: "manual", key: "one" } }).run.id, first.id);
  assert.equal(store.listTasks().length, 1);
  assert.throws(() => store.saveTask({ ...target, source: undefined }), /source.*immutable/i);
  assert.throws(() => call("run", { caller: { scope: "user", role: "operator" },
    trigger: { source: "manual", key: "forged" } }));
  store.saveTask(activateTask(target, now));
  assert.equal(call("run-confirm", { runId: first.id }).status, "running");
  const completed = completeTask(store.getTask(target.id), now, { by: "user", summary: "Verified delivery" });
  store.saveTask(completed);
  const event = createTaskEvent(store.nextEventId(target.id), target.id, "task.completed",
    { summary: completed.completionSummary, by: "user" }, now);
  store.saveEvent(target.id, event);
  const result = call("run-confirm", { runId: first.id });
  assert.equal(result.status, "succeeded");
  assert.equal(result.businessResult.evidence[0].kind, "task-result");
  assert.equal(result.businessResult.evidence[0].locator, `events/${event.id}`);
  store.saveTask(reopenTask(completed, now));
  assert.deepEqual(call("run-confirm", { runId: first.id }), result);
  const next = call("run", { trigger: { source: "manual", key: "two" } }).run;
  assert.notEqual(next.delegation.taskId, target.id);
  call("run-cancel", { runId: next.id });
  const cancelled = call("run-confirm", { runId: next.id });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(store.getTask(next.delegation.taskId).executionGate.state, "enabled");
  assert.match(cancelled.businessResult.summary, /not stopped/i);
  assert.equal(store.listTaskDelegations(target.id).items[0].sourceRun.runId, first.id);
  assert.equal(readTaskCatalog(store, parseTaskCatalogOptions(["--source", "job"])).tasks.length, 2);
  const ordinary = createTask(store.nextTaskId(), "Ordinary", now);
  store.saveTask(ordinary);
  assert.equal(ordinary.source, undefined);
  call("define", { id: "creation", title: "Explicit creation", configuration: { kind: "task",
    goal: "task-created", target: { kind: "new", title: "Only create", description: "Creation only.", projectBindings: [] } } });
  const creation = call("run", { id: "creation", trigger: { source: "manual", key: "create" } }).run;
  assert.equal(creation.status, "succeeded");
  assert.equal(store.getTask(creation.delegation.taskId).status, "draft");
  assert.match(creation.businessResult.summary, /no delivery completion/);
});

test("Task-owned delegation preserves management scope, rolls back partial admission and migrates ordinary history unchanged", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-scoped-delegate-"));
  let store;
  t.after(() => { store?.close(); rmSync(home, { recursive: true, force: true }); });
  store = new SqliteTaskStore(home);
  const now = new Date();
  const agent = createConfiguredAgent("fixture", "codex", "false", [], [], now);
  store.saveConfiguredAgent(agent);
  store.saveConfig({ ...store.getConfig(), defaultAgent: agent.id });
  const role = createGlobalRole("operator", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.createGlobalRoleIfAbsent(role);
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "global", roleName: "operator" }, agent.id, now
  ), { agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: "fixture-operator",
    status: "active", policy: "fixed", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, now));
  const caller = { scope: "global", role: "operator", nativeSessionId: "fixture-operator" };
  const owner = activateTask(createTask(store.nextTaskId(), "Owns the Job", now), now);
  store.saveTask(owner);
  store.close(); store = undefined;
  const db = new Database(join(home, "yui.db"));
  try {
    const before = db.prepare("SELECT payload FROM task_records WHERE task_id=?").get(owner.id).payload;
    usePre120Layout(db);
    db.prepare("UPDATE storage_schema SET minor=18").run();
    applySqliteMinorUpgrades(db, home);
    assert.equal(db.prepare("SELECT minor FROM storage_schema").get().minor, 24);
    assert.equal(db.prepare("SELECT payload FROM task_records WHERE task_id=?").get(owner.id).payload, before);
  } finally { db.close(); }
  store = new SqliteTaskStore(home);
  let control = createJobDefinitionControl(store, home);
  const base = { scope: { kind: "task", taskId: owner.id }, caller, id: "owned" };
  const config = { kind: "task", goal: "delivery", target: { kind: "new", title: "Independent delivery",
    description: "Complete through the normal Task workflow.", projectBindings: [] } };
  control({ ...base, op: "define", title: "Managed by A", configuration: config }, now);
  const save = store.saveDurableJob;
  store.saveDurableJob = () => { throw new Error("fixture admission persistence failure"); };
  assert.throws(() => control({ ...base, op: "run", trigger: { source: "manual", key: "one" } }, now), /fixture/);
  assert.equal(store.listTasks().length, 1, "Task creation and relation must roll back with Run persistence");
  store.saveDurableJob = save;
  const run = control({ ...base, op: "run", trigger: { source: "manual", key: "one" } }, now).run;
  const target = store.getTask(run.delegation.taskId);
  assert.notEqual(target.id, owner.id);
  assert.equal(target.source.run.scope.taskId, owner.id);
  assert.equal(store.listJobDefinitions({ kind: "task", taskId: target.id }).length, 0);
  assert.equal(store.listJobDefinitions(base.scope)[0].id, "owned");
  const leader = createRole(owner.id, "leader", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.saveRole(owner.id, leader);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: owner.id, roleName: "leader" }, agent.id, now
  ), { agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: "source-leader",
    status: "active", policy: "fixed", effective: resolveEffectiveLaunch({ role: leader, purpose: "execution" }) }, now));
  const sourceCaller = { scope: "task", taskId: owner.id, role: "leader", nativeSessionId: "source-leader" };
  assert.throws(() => control({ ...base, op: "run", caller: sourceCaller,
    trigger: { source: "manual", key: "cross-target" } }, now), /target authority|cross-Task/);
  const material = await saveArtifactCapability(home, target.id, { relativePath: "selected.md", content: "frozen target result" });
  const reference = { kind: "artifact", owner: { kind: "task", taskId: target.id },
    sourceRun: { scope: base.scope, runId: run.id }, version: material.commit,
    relativePath: material.relativePath, digest: material.digest };
  const request = { ...base, runId: run.id, reference };
  await assert.rejects(async () => control({ ...request, caller: sourceCaller, op: "artifact-register" }, now), /different Task/);
  assert.equal((await control({ ...request, op: "artifact-register" }, now)).status, "registered");
  await saveArtifactCapability(home, target.id, { relativePath: "selected.md", content: "new target bytes" });
  assert.equal((await control({ ...request, caller: sourceCaller, op: "artifact-read" }, now)).content, "frozen target result");
  await assert.rejects(async () => control({ ...request, caller: sourceCaller, op: "artifact-read",
    reference: { ...reference, relativePath: "unselected.md" } }, now), /registered/);
  assert.throws(() => control({ ...base, op: "run", caller: { ...caller, nativeSessionId: "revoked" },
    trigger: { source: "manual", key: "bad" } }, now), /Session/);
  store.close(); store = undefined;
  store = new SqliteTaskStore(home);
  control = createJobDefinitionControl(store, home);
  assert.equal(control({ ...base, op: "run", trigger: { source: "manual", key: "one" } }, now).run.delegation.taskId, target.id);
  assert.equal(store.getTask(owner.id).source, undefined);
  assert.match(jobCleanupBlocker(run, home), /running/);
  control({ ...base, op: "run-cancel", runId: run.id }, now);
  const cancelled = control({ ...base, op: "run-confirm", runId: run.id }, now);
  assert.equal(jobCleanupBlocker(cancelled, home), undefined);
  assert.equal(store.getTask(target.id).executionGate.state, "enabled");
});

test("an ordinary shared Task keeps its source and exact WorkItem acceptance settles only that delegation", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-shared-delegate-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date();
  const ordinary = activateTask(createTask(store.nextTaskId(), "Existing", now), now);
  store.saveTask(ordinary);
  let work = createWorkItem("work-item-1", ordinary.id, { title: "Bounded action", objective: "Deliver just this unit" }, now);
  store.saveWorkItem(ordinary.id, work);
  store.saveWorkItem(ordinary.id, createWorkItem("work-item-2", ordinary.id, { title: "Unrelated work" }, now));
  const control = createJobDefinitionControl(store, home);
  const base = { scope: { kind: "global" }, caller: { scope: "user" }, id: "append" };
  const call = (op, extra = {}) => control({ ...base, op, ...extra }, now);
  call("define", { title: "Bounded append", configuration: { kind: "task", goal: "work-item",
    target: { kind: "work-item", taskId: ordinary.id, workItemId: work.id, revision: work.revision } } });
  const run = call("run", { trigger: { source: "manual", key: "one" } }).run;
  assert.equal(run.businessResult, undefined);
  assert.equal(store.getTask(ordinary.id).source, undefined);
  call("define", { id: "cancel-only", title: "Separate bounded action", configuration: { kind: "task", goal: "work-item",
    target: { kind: "work-item", taskId: ordinary.id, workItemId: "work-item-2", revision: 1 } } });
  const second = call("run", { id: "cancel-only", trigger: { source: "manual", key: "two" } }).run;
  call("run-cancel", { id: "cancel-only", runId: second.id });
  assert.equal(call("run-confirm", { id: "cancel-only", runId: second.id }).status, "cancelled");
  assert.equal(store.getWorkItem(ordinary.id, "work-item-2").status, "open");
  assert.equal(store.getTask(ordinary.id).executionGate.state, "enabled");
  const changed = call("run", { id: "cancel-only", trigger: { source: "manual", key: "three" } }).run;
  store.saveWorkItem(ordinary.id, editWorkItemDefinition(store.getWorkItem(ordinary.id, "work-item-2"),
    { objective: "A materially different request" }, now));
  assert.equal(call("run-confirm", { id: "cancel-only", runId: changed.id }).status, "unknown-needs-attention");
  assert.equal(readTaskCatalog(store, parseTaskCatalogOptions(["--attention", "pendingOperations"])).total, 1);
  work = submitWorkItemCandidate(work, { summary: "Exact deliverable", source: { type: "direct" } }, now);
  store.saveWorkItem(ordinary.id, work);
  assert.equal(call("run-confirm", { runId: run.id }).status, "running", "Candidate/Agent result is not acceptance");
  // Fixture represents the existing Leader acceptance boundary, not a Job-owned acceptance.
  work = { ...work, status: "accepted", acceptedCandidateId: work.currentCandidateId,
    outcome: "Accepted bounded action", endedAt: now.toISOString() };
  store.saveWorkItem(ordinary.id, work);
  const settled = call("run-confirm", { runId: run.id });
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.businessResult.evidence[0].kind, "work-item-result");
  assert.equal(store.getTask(ordinary.id).status, "active");
  assert.equal(store.getWorkItem(ordinary.id, "work-item-2").status, "open");
  assert.equal(store.getTask(ordinary.id).source, undefined);
});
