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
import { runTaskCommand, previewTaskRoleAgentConfigurationMutation } from "../../dist/commands/taskCommands.js";
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
import { readCurrentTaskLeader } from "../../dist/storage/currentTaskLeader.js";
import { applySqliteMinorUpgrades } from "../../dist/storage/sqliteSchema.js";
import Database from "../../dist/sqlite/driver.js";

test("experimental Task model overrides persist without freezing inherited fields or other Tasks", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-experiment-overrides-"));
  let store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  const agent = createConfiguredAgent("fixture", "codex", "unused", [], [], now);
  store.saveConfiguredAgent(agent);
  const parent = createGlobalRole("leader", [createRoleAgentBinding(agent, {
    adapterId: "codex", model: "parent", effort: "low", permission: { strategy: "default" }
  })], agent.id, home, now);
  store.saveGlobalRole(parent);
  const first = runTaskCommand(["create", "First", "--mode", "experiment"], store, { environment: {} }).data.task.id;
  const second = runTaskCommand(["create", "Second", "--mode", "experiment"], store, { environment: {} }).data.task.id;
  const update = args => runTaskCommand(["role", "update", first, "leader", ...args], store, { environment: {} });
  const launch = id => resolveEffectiveLaunch({ role: store.getRole(id, "leader"), purpose: "execution" });
  update(["--model", "task-model"]);
  assert.equal(launch(first).model, "task-model");
  store.close();
  store = new SqliteTaskStore(home);
  assert.equal(launch(first).model, "task-model");
  store.saveGlobalRole(updateGlobalRole(parent, { agentBindings: {
    [agent.id]: createRoleAgentBinding(agent, {
      adapterId: "codex", model: "new-parent", effort: "high", permission: { strategy: "default" }
    })
  } }, now));
  assert.equal(launch(first).model, "task-model");
  assert.equal(launch(first).effort, "high");
  assert.equal(launch(second).model, "new-parent");
  const revision = store.getRole(first, "leader").launchRevision;
  update(["--effort", "high"]);
  assert.ok(store.getRole(first, "leader").launchRevision > revision, "Pinning today's inherited value is a real intent change");
  assert.equal(launch(first).leaderStage.sources.effort, "task-default");
  update(["--clear-model"]);
  assert.equal(launch(first).model, "new-parent");
  assert.equal(store.getGlobalRole("leader").agentBindings[agent.id].config.model, "new-parent");
});

test("experiment stage/default overrides resolve per Agent, validate atomically and clear back to inheritance", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-experiment-stage-overrides-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  for (const [id, adapter] of [["code", "codex"], ["plan", "claude"], ["extra", "codex"]]) {
    store.saveConfiguredAgent(createConfiguredAgent(id, adapter, "unused", [], [], now));
  }
  const parent = updateGlobalRole(createGlobalRole("leader", [
    createRoleAgentBinding(store.getConfiguredAgent("code"), {
      adapterId: "codex", model: "code-default", effort: "high", permission: { strategy: "bypass" }
    }),
    createRoleAgentBinding(store.getConfiguredAgent("plan"), {
      adapterId: "claude", model: "plan-default", effort: "low", permission: { strategy: "default" }
    })
  ], "code", home, now), { leaderStages: { draft: { agentId: "plan", model: "parent-draft" },
    develop: { model: "parent-develop", effort: "medium" } } }, now);
  store.saveGlobalRole(parent);
  const task = runTaskCommand(["create", "Overrides", "--mode", "experiment"], store, { environment: {} }).data.task.id;
  const launch = stage => resolveEffectiveLaunch({ role: store.getRole(task, "leader"),
    purpose: stage === "draft" ? "planning" : "execution" });
  const command = tail => {
    const args = ["role", "update", task, "leader", ...tail];
    const preview = previewTaskRoleAgentConfigurationMutation(args, store);
    return runTaskCommand(args, store, { environment: {}, validateAgentConfiguration: candidate => {
      assert.ok([preview, ...preview.related].some(p => p.agentId === candidate.agentId
        && JSON.stringify(p.config) === JSON.stringify(candidate.config)));
      if (candidate.config.model === "invalid") throw Error("illegal model");
    } });
  };
  assert.equal(launch("draft").model, "parent-draft");
  command(["--model", "task-code", "--effort", "low"]);
  assert.equal(launch("develop").model, "task-code");
  assert.equal(launch("draft").model, "parent-draft", "Base binding overrides never cross Agents");
  assert.equal(launch("develop").leaderStage.sources.model, "task-default");
  command(["--stage", "develop", "--model", "task-develop"]);
  assert.equal(launch("develop").model, "task-develop");
  assert.equal(launch("develop").leaderStage.sources.model, "task-stage");
  command(["--stage", "develop", "--agent", "plan"]);
  assert.equal(launch("develop").model, "plan-default");
  assert.equal(launch("develop").effort, "low");
  assert.equal(launch("develop").permission.strategy, "default");
  command(["--stage", "develop", "--model", "task-plan", "--effort", "high"]);
  command(["--stage", "develop", "--clear-agent"]);
  assert.equal(launch("develop").model, "task-develop", "Stage fields are scoped to their selected Agent");
  command(["--stage", "develop", "--clear-model"]);
  assert.equal(launch("develop").model, "task-code");
  command(["--stage", "develop", "--clear-agent-config"]);
  command(["--clear-model"]);
  assert.equal(launch("develop").model, "parent-develop");
  assert.equal(launch("develop").effort, "low");
  command(["--clear-effort"]);
  assert.equal(launch("develop").effort, "medium");
  command(["--agent", "extra"]);
  assert.equal(launch("draft").agentId, "extra");
  assert.equal(launch("draft").model, undefined);
  assert.equal(launch("draft").effort, undefined);
  assert.deepEqual(launch("draft").permission, createRoleAgentBinding(store.getConfiguredAgent("extra")).config.permission,
    "A newly selected Agent uses its own standard binding, not another Agent's permissions");
  command(["--model", "extra-model", "--effort", "medium"]);
  assert.equal(launch("develop").model, "extra-model");
  command(["--clear-agent"]);
  assert.equal(launch("draft").agentId, "plan");
  assert.equal(launch("draft").model, "parent-draft");
  assert.deepEqual(readCurrentTaskLeader(home, task), store.getRole(task, "leader"));
  const before = store.getRole(task, "leader"), events = store.listEvents(task);
  assert.throws(() => command(["--model", "invalid"]), /illegal model/);
  assert.deepEqual(store.getRole(task, "leader"), before);
  assert.deepEqual(store.listEvents(task), events);
  assert.throws(() => command(["--permission-strategy", "bypass"]), /only/);
  assert.throws(() => command(["--agent", "missing"]), /Agent/);
  assert.throws(() => command(["--model", "x", "--clear-model"]), /together/);
  assert.throws(() => store.saveRole(task, { ...before,
    launchOverrides: { permission: "bypass" } }), /unsupported/);
  assert.throws(() => store.saveRole(task, { ...before,
    launchOverrides: { stages: { draft: { bindings: { extra: { adapterId: "codex", component: "claude-code-cli" } } } } } }), /component|inconsistent/);
  command(["--clear-agent-config"]);
  assert.equal(store.getRole(task, "leader").launchOverrides, undefined);
  assert.equal(launch("develop").model, "parent-develop");
  assert.deepEqual(store.getGlobalRole("leader"), parent);
  runTaskCommand(["role", "bind", task, "leader", "extra"], store, { environment: {} });
  assert.equal(launch("develop").agentId, "extra");
});

test("1.32 experiment bindings upgrade without inventing overrides or rewriting history", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-experiment-override-migration-"));
  let store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  const agent = createConfiguredAgent("code", "codex", "unused", [], [], now);
  store.saveConfiguredAgent(agent);
  store.saveGlobalRole(createGlobalRole("leader", [createRoleAgentBinding(agent)], agent.id, home, now));
  const task = runTaskCommand(["create", "Existing", "--mode", "experiment"], store, { environment: {} }).data.task.id;
  const before = store.databaseHandle().prepare("SELECT payload FROM task_roles").all();
  store.databaseHandle().prepare("UPDATE storage_schema SET minor=32").run();
  store.close();
  assert.throws(() => new SqliteTaskStore(home), /upgrade|storage/i);
  const db = new Database(join(home, "yui.db"));
  try {
    applySqliteMinorUpgrades(db, home);
    assert.deepEqual(db.prepare("SELECT payload FROM task_roles").all(), before);
  } finally { db.close(); }
  store = new SqliteTaskStore(home);
  assert.equal(store.getRole(task, "leader").launchOverrides, undefined);
  assert.equal(store.getRole(task, "leader").activeAgentId, "code");
});

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
