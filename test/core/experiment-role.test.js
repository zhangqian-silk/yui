import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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

test("experimental Tasks copy global configuration once and maintain independent bindings", t => {
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
  assert.equal(launch(first).effort, "low");
  assert.equal(launch(second).model, "parent");
  const revision = store.getRole(first, "leader").launchRevision;
  update(["--effort", "high"]);
  assert.ok(store.getRole(first, "leader").launchRevision > revision);
  assert.equal(launch(first).leaderStage.sources.effort, "binding");
  update(["--clear-model"]);
  assert.equal(launch(first).model, undefined);
  assert.equal(store.getGlobalRole("leader").agentBindings[agent.id].config.model, "new-parent");
});

test("experiment and ordinary Leaders use identical configuration commands and validation", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-experiment-parity-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  for (const [id, adapter] of [["code", "codex"], ["plan", "claude"]]) {
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
  const ids = [[], ["--mode", "experiment"]].map(mode =>
    runTaskCommand(["create", "Parity", ...mode], store, { environment: {}, now: () => now }).data.task.id);
  const projection = id => {
    const r = store.getRole(id, "leader");
    return [r.activeAgentId, r.agentBindings, r.leaderStages, r.launchRevision, r.constraints, r.enabled];
  };
  const update = tail => {
    for (const id of ids) {
      const args = ["role", "update", id, "leader", ...tail];
      const preview = previewTaskRoleAgentConfigurationMutation(args, store);
      runTaskCommand(args, store, { environment: {}, yuiHome: home, now: () => now, validateAgentConfiguration: candidate => {
        assert.ok([preview, ...(preview?.related ?? [])].some(p => p?.agentId === candidate.agentId
          && JSON.stringify(p.config) === JSON.stringify(candidate.config)));
        if (candidate.config.model === "invalid") throw Error("illegal model");
      } });
    }
    assert.deepEqual(projection(ids[1]), projection(ids[0]));
  };
  update(["--model", "task-code", "--effort", "low"]);
  update(["--stage", "develop", "--model", "task-develop"]);
  update(["--stage", "develop", "--agent", "plan"]);
  update(["--stage", "develop", "--clear-model", "--clear-effort"]);
  update(["--stage", "develop", "--clear-agent"]);
  update(["--stage", "draft", "--clear-agent-config"]);
  update(["--permission-strategy", "default"]);
  update(["--constraint", "task-local rule"]);
  update(["--clear-skills"]);
  assert.deepEqual(roleSkillIds(store.getRole(ids[1], "leader"), "leader"), ["yui-runtime", "yui-experiment-leader"]);
  update(["--clear-model", "--clear-effort"]);
  update(["--clear-agent-config"]);
  for (const id of ids) {
    const before = store.getRole(id, "leader"), events = store.listEvents(id);
    assert.throws(() => runTaskCommand(["role", "update", id, "leader", "--model", "invalid"], store,
      { environment: {}, validateAgentConfiguration: () => { throw Error("illegal model"); } }), /illegal model/);
    assert.deepEqual(store.getRole(id, "leader"), before);
    assert.deepEqual(store.listEvents(id), events);
    assert.throws(() => runTaskCommand(["role", "update", id, "leader", "--agent", "plan"], store,
      { environment: {} }), /update option/);
    runTaskCommand(["role", "bind", id, "leader", "plan"], store, { environment: {}, now: () => now });
    assert.equal(store.getRole(id, "leader").activeAgentId, "plan");
    assert.deepEqual(readCurrentTaskLeader(home, id), store.getRole(id, "leader"));
  }
  assert.deepEqual(projection(ids[1]), projection(ids[0]));
  assert.deepEqual(store.getGlobalRole("leader"), parent);
});

test("1.32 inherited experiment Leaders migrate once without rewriting ordinary Roles or Sessions", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-experiment-copy-migration-"));
  let store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  const agent = createConfiguredAgent("code", "codex", "unused", [], [], now);
  store.saveConfiguredAgent(agent);
  const parent = createGlobalRole("leader", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.saveGlobalRole(parent);
  const task = runTaskCommand(["create", "Existing", "--mode", "experiment"], store, { environment: {} }).data.task.id;
  const ordinary = runTaskCommand(["create", "Ordinary"], store, { environment: {} }).data.task.id;
  const copied = store.getRole(task, "leader");
  const effective = resolveEffectiveLaunch({ role: copied, purpose: "planning" });
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet({ scope: "task", taskId: task,
    roleName: "leader" }, agent.id, now), { agentId: agent.id, adapterId: agent.adapterId,
    nativeSessionId: "existing", status: "active", policy: "fixed", effective }, now));
  const local = { schemaVersion: 1, taskId: task, name: "leader", template: "experiment-leader",
    workspace: copied.workspace, launchRevision: 1, createdAt: copied.createdAt, updatedAt: copied.updatedAt };
  const dbBefore = store.databaseHandle();
  const ordinaryBytes = dbBefore.prepare("SELECT payload FROM task_roles WHERE task_id=?").get(ordinary).payload;
  const sessionBytes = dbBefore.prepare("SELECT payload FROM role_session_sets").all();
  dbBefore.prepare("UPDATE task_roles SET payload=? WHERE task_id=?").run(JSON.stringify(local), task);
  dbBefore.prepare("UPDATE storage_schema SET minor=32").run();
  store.close();
  assert.throws(() => new SqliteTaskStore(home), /upgrade|storage/i);
  const db = new Database(join(home, "yui.db"));
  try {
    db.prepare("DELETE FROM global_roles WHERE name='leader'").run();
    assert.throws(() => applySqliteMinorUpgrades(db, home), /global Leader/);
    assert.equal(db.prepare("SELECT minor FROM storage_schema").get().minor, 32);
    assert.equal(db.prepare("SELECT payload FROM task_roles WHERE task_id=?").get(task).payload, JSON.stringify(local));
    db.prepare("INSERT INTO global_roles(name,payload,updated_at) VALUES(?,?,?)").run("leader", JSON.stringify(parent), now.toISOString());
    applySqliteMinorUpgrades(db, home);
    assert.equal(db.prepare("SELECT payload FROM task_roles WHERE task_id=?").get(ordinary).payload, ordinaryBytes);
    assert.deepEqual(db.prepare("SELECT payload FROM role_session_sets").all(), sessionBytes);
    const once = db.prepare("SELECT payload FROM task_roles WHERE task_id=?").get(task).payload;
    applySqliteMinorUpgrades(db, home);
    assert.equal(db.prepare("SELECT payload FROM task_roles WHERE task_id=?").get(task).payload, once);
  } finally { db.close(); }
  store = new SqliteTaskStore(home);
  const migrated = store.getRole(task, "leader");
  assert.deepEqual(migrated, { ...copied, launchRevision: parent.launchRevision + local.launchRevision });
  store.saveGlobalRole(updateGlobalRole(parent, { leaderStages: { draft: { model: "new-parent" } } }, now));
  assert.deepEqual(store.getRole(task, "leader"), migrated);
  runTaskCommand(["role", "update", task, "leader", "--model", "local-model"], store, { environment: {} });
  assert.equal(store.getRole(task, "leader").agentBindings.code.config.model, "local-model");
});

test("ExperimentLeader keeps a copied profile while sharing current Skill files like ordinary Leaders", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-experiment-role-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  const agent = createConfiguredAgent("fixture", "codex", "unused", [], [], now);
  store.saveConfiguredAgent(agent);
  const skill = join(home, "skills", "shared-policy");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "Shared policy version one.\n");
  writeFileSync(join(skill, "VERSION"), "1\n");
  const parent = createGlobalRole("leader", [createRoleAgentBinding(agent)], agent.id, home, now,
    { constraints: ["original"], responsibilities: ["coordinate"], skills: ["shared-policy"] });
  store.saveGlobalRole(parent);
  const created = runTaskCommand(["create", "Research", "--mode", "experiment"], store, { environment: {} });
  assert.equal(created.data.leader.template, "experiment-leader");
  const taskId = created.data.task.id;
  const first = store.getRole(taskId, "leader");
  assert.equal(first.name, "leader");
  assert.equal(roleSessionKind(first, { scope: "task", taskId }, "planning"), "leader");
  assert.deepEqual(roleSkillIds(first, "leader"), ["yui-runtime", "yui-experiment-leader", "shared-policy"]);
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
  assert.deepEqual(changed, first);
  const checked = checkSessionSkills(home, bootstrap.manifestPath);
  assert.equal(checked.roleProfileRef.digest, bootstrap.manifest.roleProfileRef.digest);
  assert.deepEqual(JSON.parse(readFileSync(checked.roleProfileRef.path, "utf8")).constraints, ["original"]);
  assert.equal(notice.prepare("next", environment, "session").context, undefined);
  writeFileSync(join(skill, "SKILL.md"), "Shared policy version two.\n");
  writeFileSync(join(skill, "VERSION"), "2\n");
  const skillCheck = checkSessionSkills(home, bootstrap.manifestPath).skills.find(s => s.id === "shared-policy");
  assert.equal(skillCheck.path, skill);
  assert.equal(skillCheck.version, "2");
  assert.match(notice.prepare("skill changed", environment, "session").context, /shared-policy/);
  assert.equal(compileRoleSessionContext(home, changed, { scope: "task", taskId }).skills
    .find(s => s.id === "shared-policy").content, "Shared policy version two.");
  store.saveRole(taskId, updateRole(changed, { constraints: ["task-local"], workspace: join(home, "delivery"),
    leaderStages: { draft: { model: "task-planning" } } }, new Date()));
  assert.deepEqual(store.getRole(taskId, "leader").constraints, ["task-local"]);
  assert.equal(resolveEffectiveLaunch({ role: store.getRole(taskId, "leader"), purpose: "planning" }).model, "task-planning");
  assert.equal(checkSessionSkills(home, bootstrap.manifestPath).roleProfileRef.digest, bootstrap.manifest.roleProfileRef.digest,
    "Task profile updates use the same next-Session boundary as ordinary Leaders.");
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
