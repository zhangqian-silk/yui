import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createRole, createGlobalRole, createRoleAgentBinding, updateGlobalRole, updateRole } from "../../dist/role/role.js";
import { createExperimentLeader } from "../../dist/role/roleTemplate.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { roleSkillIds, roleSessionKind } from "../../dist/context/roleSessionContext.js";
import { discoveryCommandTree } from "../../dist/cli/commandDiscovery.js";
import { findCommandNode } from "../../dist/cli/commandCatalog.js";
import { runIterationCommand } from "../../dist/commands/iterationCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { compileRoleSessionContext } from "../../dist/context/roleSessionContext.js";
import { materializeSessionBootstrap, checkSessionSkills } from "../../dist/context/sessionBootstrapManifest.js";
import { createSessionSkillNotice } from "../../dist/context/sessionSkillNotice.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { freezeRunContextSnapshot } from "../../dist/context/runContextPack.js";
import { contextSnapshotRef } from "../../dist/context/contextSnapshot.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";

test("ExperimentLeader has one Leader identity and resolves the current parent without copied configuration", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-experiment-role-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  const agent = createConfiguredAgent("fixture", "codex", "unused", [], [], now);
  store.saveConfiguredAgent(agent);
  const parent = createGlobalRole("leader", [createRoleAgentBinding(agent)], agent.id, home, now,
    { constraints: ["original"], responsibilities: ["coordinate"] });
  store.saveGlobalRole(parent);
  const created = runTaskCommand(["create", "Research", "--mode", "experiment"], store, { environment: {} });
  assert.equal(created.data.leader.template, "experiment-leader");
  const taskId = created.data.task.id;
  const first = store.getRole(taskId, "leader");
  assert.equal(first.name, "leader");
  assert.equal(roleSessionKind(first, { scope: "task", taskId }, "planning"), "leader");
  assert.deepEqual(roleSkillIds(first, "leader"), ["yui-runtime", "yui-experiment-leader"]);
  const bootstrap = materializeSessionBootstrap({ yuiHome: home, role: first,
    owner: { scope: "task", taskId }, roleKind: "leader",
    skills: compileRoleSessionContext(home, first, { scope: "task", taskId }).skills,
    entryPoint: { executable: process.execPath, cliEntry: "/fixture/yui.js" } });
  const notice = createSessionSkillNotice(home);
  const environment = { YUI_SESSION_MANIFEST: bootstrap.manifestPath };
  notice.prepare("first", environment, "session").commit();
  store.saveGlobalRole(updateGlobalRole(parent, { constraints: ["updated"], systemPrompt: "new parent rule",
    leaderStages: { draft: { model: "planning-fixture" }, develop: { model: "delivery-fixture" } } }, new Date()));
  const changed = store.getRole(taskId, "leader");
  assert.deepEqual(changed.constraints, ["updated"]);
  assert.equal(changed.systemPrompt, "new parent rule");
  assert.equal(resolveEffectiveLaunch({ role: changed, purpose: "planning" }).model, "planning-fixture");
  assert.equal(resolveEffectiveLaunch({ role: changed, purpose: "execution" }).model, "delivery-fixture");
  assert.throws(() => store.saveRole(taskId, updateRole(changed, { leaderStages: {} }, new Date())), /inherits/);
  assert.ok(changed.launchRevision > first.launchRevision);
  const checked = checkSessionSkills(home, bootstrap.manifestPath);
  assert.notEqual(checked.roleProfileRef.digest, bootstrap.manifest.roleProfileRef.digest);
  assert.deepEqual(JSON.parse(readFileSync(checked.roleProfileRef.path, "utf8")).constraints, ["updated"]);
  assert.match(notice.prepare("next", environment, "session").context, /exact Role profile/);
  store.saveRole(taskId, updateRole(changed, { workspace: join(home, "delivery") }, new Date()));
  assert.deepEqual(store.getRole(taskId, "leader").constraints, ["updated"]);
  assert.throws(() => store.saveRole(taskId, updateRole(changed, { constraints: ["bypass"] }, new Date())), /inherits/);
  assert.equal(store.listRoles(taskId).length, 1);
  assert.ok(findCommandNode(["task", "iteration", "save"], discoveryCommandTree({}, "experiment-leader")));
  assert.ok(findCommandNode(["task", "work", "create"], discoveryCommandTree({}, "experiment-leader")));
  assert.equal(findCommandNode(["task", "iteration"], discoveryCommandTree({}, "leader")), undefined);
});

test("experiment commands reject ordinary Tasks and forged or unassigned callers before writes", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-experiment-authority-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  store.saveTask(createTask("task-1", "Ordinary", now));
  await assert.rejects(runIterationCommand(["init", "task-1"], store, {}), /ExperimentLeader/);
  const agent = createConfiguredAgent("fixture", "codex", "unused", [], [], now);
  const parent = createGlobalRole("leader", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.saveGlobalRole(parent);
  store.saveRole("task-1", createExperimentLeader("task-1", home, parent, now));
  await assert.rejects(runIterationCommand(["init", "task-1"], store,
    { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1", YUI_ROLE: "leader", YUI_NATIVE_SESSION_ID: "fake" }), /current|Session/i);
  const initialized = await runIterationCommand(["init", "task-1"], store, {});
  assert.match(initialized.commit, /^[a-f0-9]{40}$/);
  store.saveTask(activateTask(store.getTask("task-1"), now));
  store.saveConfiguredAgent(agent);
  const worker = createRole("task-1", "worker", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.saveRole("task-1", worker);
  const effective = resolveEffectiveLaunch({ role: worker, purpose: "execution" });
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet({
    scope: "task", taskId: "task-1", roleName: "worker"
  }, agent.id, now), { agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: "worker-current",
    status: "active", policy: "fixed", effective }, now));
  store.saveWorkItem("task-1", createWorkItem("work-item-1", "task-1", { title: "Measure", assignee: "worker" }, now));
  const snapshot = freezeRunContextSnapshot(store, {
    taskId: "task-1", roleName: "worker", purpose: "execution", workItemId: "work-item-1"
  }, now);
  store.saveActiveRun(createRun("run-1", "task-1", "worker", "new",
    createRunInput({ source: { type: "yui", channel: "workitem-dispatch" },
      contextSnapshotRef: contextSnapshotRef(snapshot), deltaRefIds: [] }), now, { workItemId: "work-item-1", effective }));
  const environment = { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1", YUI_ROLE: "worker",
    YUI_NATIVE_SESSION_ID: "worker-current", YUI_AGENT_ID: agent.id, YUI_ADAPTER_ID: agent.adapterId };
  let head = initialized.commit, count = 0;
  const save = async (record, env = {}, experiment) => {
    const result = await runIterationCommand(["save", "task-1", JSON.stringify(record),
      "--request-id", `request-${++count}`, "--expected-head", head,
      ...(experiment ? ["--experiment", JSON.stringify(experiment)] : [])], store, env);
    head = result.commit;
    return result.ref;
  };
  await save({ schemaVersion: 1, kind: "direction", id: "latency", title: "Latency", problem: "Slow",
    goal: "Faster", metrics: ["p95"], constraints: ["offline"], priority: "high", status: "active", next: "measure", unresolved: [] });
  const plan = await save({ schemaVersion: 1, kind: "plan", id: "paired", title: "Paired", method: "paired",
    parameters: {}, document: "fixed inputs" });
  const experiment = await save({ schemaVersion: 1, kind: "experiment", id: "trial", title: "Trial",
    directions: ["latency"], hypothesis: "lower latency", plan, parameters: {}, conditions: { dataset: "fixture" },
    baseline: { repository: "fixture", commit: "a".repeat(40), tree: "clean" },
    candidate: { repository: "fixture", commit: "b".repeat(40), tree: "clean" }, workItemIds: ["work-item-1"] });
  const scoped = await runIterationCommand(["overview", "task-1", "--experiment", JSON.stringify(experiment)], store, environment);
  assert.equal(scoped.value.id, "trial");
  await assert.rejects(runIterationCommand(["overview", "task-1"], store, environment), /Assignment/);
  await assert.rejects(save({ schemaVersion: 1, kind: "plan", id: "forbidden", title: "No", method: "No",
    parameters: {}, document: "No" }, environment, experiment), /Workers may submit only/);
  const execution = await save({ schemaVersion: 1, kind: "execution", id: "measurement", experiment,
    sample: "sample-1", conditions: { model: "fake" }, observations: { latency: 1 }, evidence: [],
    outcome: "observed", limitations: [], runId: "run-1" }, environment, experiment);
  assert.equal(execution.kind, "execution");
});
