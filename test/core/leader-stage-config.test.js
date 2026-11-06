import assert from "node:assert/strict";
import test from "node:test";
import { createGlobalRole, createRoleAgentBinding, copyGlobalRoleToTaskRole, updateRole, updateGlobalRole } from "../../dist/role/role.js";
import { resolveEffectiveLaunch, roleSessionMayContinue } from "../../dist/executor/effectiveLaunch.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runGlobalRoleCommand, previewGlobalRoleAgentConfigurationMutation } from "../../dist/commands/globalRoleCommands.js";
import { runTaskCommand, submitOperatorMessage, previewTaskRoleAgentConfigurationMutation } from "../../dist/commands/taskCommands.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { resolveManagedTaskCaller } from "../../dist/runtime/managedCaller.js";
import { resolveTaskAgentCapabilities } from "../../dist/executor/taskAgentCapabilities.js";
import { requestTaskActivation } from "../../dist/task/taskActivationService.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { processLeaderWakeups } from "../../dist/scheduler/leaderWakeupProcessor.js";
import { validateAgentLaunchConfiguration } from "../../dist/executor/agentConfigurationCatalog.js";

const now = new Date("2026-11-06T00:00:00Z");
function template() {
  return createGlobalRole("leader", [
    createRoleAgentBinding({ id: "code", adapterId: "codex", component: "codex-cli" },
      { adapterId: "codex", model: "base", effort: "high", permission: { strategy: "bypass" } }),
    createRoleAgentBinding({ id: "plan", adapterId: "claude", component: "claude-code-cli" },
      { adapterId: "claude", model: "sonnet", effort: "low", permission: { strategy: "default" } })
  ], "code", "/fixture", now);
}
const launch = (role, planning = false) => resolveEffectiveLaunch({ role, purpose: planning ? "planning" : "execution" });

test("Leader stages freeze with the Task, fall back per selected Agent, and never change authority", () => {
  const base = template();
  const plain = copyGlobalRoleToTaskRole(base, "task-1", now);
  assert.equal(launch(plain, true).model, "base");
  const configured = updateGlobalRole(base, { leaderStages: {
    draft: { agentId: "plan", model: "opus" }, develop: { effort: "low" }
  } }, now);
  const task = copyGlobalRoleToTaskRole(configured, "task-2", now);
  const draft = launch(task, true), develop = launch(task);
  assert.equal(draft.agentId, "plan");
  assert.equal(draft.model, "opus");
  assert.equal(draft.effort, "low");
  assert.equal(draft.permission.strategy, "default");
  assert.equal(draft.executionAuthority, "planning");
  assert.deepEqual(draft.writeProjectIds, []);
  assert.equal(develop.agentId, "code");
  assert.equal(develop.model, "base");
  assert.equal(develop.effort, "low");
  assert.equal(develop.leaderStage.stage, "develop");
  assert.equal(draft.leaderStage.sources.model, "stage");
  assert.equal(draft.leaderStage.sources.effort, "binding");
  assert.equal(roleSessionMayContinue(draft, develop), false);
  configured.leaderStages.draft.model = "later";
  assert.equal(launch(task, true).model, "opus");
  const cleared = updateRole(task, { leaderStages: {} }, now);
  assert.equal(launch(cleared, true).model, "base");
  assert.equal(cleared.launchRevision, task.launchRevision + 1);
  assert.throws(() => updateRole(task, { name: "worker" }, now), /Leader/);
  assert.throws(() => updateRole(task, { leaderStages: { draft: { agentId: "missing" } } }, now), /bound/);
});

test("public stage updates validate resolved settings atomically, clear to defaults and preserve frozen Tasks", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-stage-cli-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  for (const [id, adapter] of [["code", "codex"], ["plan", "claude"]]) {
    store.saveConfiguredAgent(createConfiguredAgent(id, adapter, "unused", [], [], now));
  }
  store.saveGlobalRole(template());
  // Use the real submission path for a frozen Task and an authorized update.
  store.saveConfig({ ...store.getConfig(), defaultAgent: "code", defaultWorkspace: home });
  const global = args => {
    const preview = previewGlobalRoleAgentConfigurationMutation(args, store);
    return runGlobalRoleCommand(args, store, { env: {}, validateAgentConfiguration: candidate => {
      assert.ok([preview, ...(preview?.related ?? [])].some(p =>
        p.agentId === candidate.agentId && JSON.stringify(p.config) === JSON.stringify(candidate.config)));
    } });
  };
  global(["update", "leader", "--stage", "draft", "--agent", "plan", "--model", "opus"]);
  const submitted = submitOperatorMessage("Discuss configuration", undefined, store, { now: () => now });
  const task = store.listTasks().find(task => task.status === "draft");
  assert.ok(task, JSON.stringify(submitted));
  const frozen = store.getRole(task.id, "leader");
  global(["update", "leader", "--stage", "draft", "--model", "sonnet"]);
  assert.equal(launch(store.getRole(task.id, "leader"), true).model, "opus");
  const command = args => {
    const preview = previewTaskRoleAgentConfigurationMutation(args, store);
    return runTaskCommand(args, store, { environment: {}, now: () => now,
      validateAgentConfiguration: candidate => {
        assert.ok([preview, ...(preview?.related ?? [])].some(p =>
          p.agentId === candidate.agentId && JSON.stringify(p.config) === JSON.stringify(candidate.config)));
        validateAgentLaunchConfiguration({ schemaVersion: 1, agentId: "plan", adapterId: "claude",
          models: [{ value: "opus", label: "Opus", efforts: [{ value: "low" }] }],
          fields: [{ key: "model", allowCustom: true }], warnings: [] }, candidate.config);
      }
    });
  };
  assert.throws(() => command(["role", "update", task.id, "leader", "--stage", "draft", "--effort", "invalid"]), /effort/);
  assert.deepEqual(store.getRole(task.id, "leader"), frozen);
  command(["role", "update", task.id, "leader", "--stage", "develop", "--model", "fast"]);
  assert.equal(launch(store.getRole(task.id, "leader")).model, "fast");
  command(["role", "update", task.id, "leader", "--stage", "develop", "--clear-model"]);
  assert.equal(launch(store.getRole(task.id, "leader")).model, "base");
  command(["role", "update", task.id, "leader", "--stage", "draft", "--clear-agent-config"]);
  assert.equal(launch(store.getRole(task.id, "leader"), true).agentId, "code");
  command(["role", "update", task.id, "leader", "--stage", "develop", "--agent", "plan", "--effort", "low"]);
  command(["role", "update", task.id, "leader", "--stage", "develop", "--clear-agent"]);
  assert.equal(launch(store.getRole(task.id, "leader")).agentId, "code");
  assert.equal(launch(store.getRole(task.id, "leader")).effort, "low");
  command(["role", "update", task.id, "leader", "--stage", "develop", "--clear-effort"]);
  assert.equal(launch(store.getRole(task.id, "leader")).effort, "high");
  assert.throws(() => global(["update", "leader", "--stage", "draft", "--permission-strategy", "bypass"]), /only/);
  assert.throws(() => global(["update", "leader", "--clear-agent"]), /requires --stage/);
  assert.throws(() => global(["update", "leader", "--stage", "draft", "--agent", "plan", "--clear-agent"]), /together/);
  command(["role", "update", task.id, "leader", "--stage", "draft", "--model", "opus", "--effort", "low"]);
  command(["role", "bind", task.id, "leader", "plan"]);
  assert.equal(launch(store.getRole(task.id, "leader"), true).agentId, "plan");
  assert.equal(launch(store.getRole(task.id, "leader"), true).model, "opus");
});

test("stage Agent survives planning follow-ups and Host restoration, then activation selects develop without replay", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-stage-lifecycle-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  for (const id of ["code", "draft-code", "delivery-code"]) store.saveConfiguredAgent(createConfiguredAgent(id, "codex", "unused", [], [], now));
  const role = createGlobalRole("leader", ["code", "draft-code", "delivery-code"].map(id =>
    createRoleAgentBinding(store.getConfiguredAgent(id))), "code", home, now);
  store.saveGlobalRole(updateGlobalRole(role, { leaderStages: {
    draft: { agentId: "draft-code", model: "planning-model", effort: "low" },
    develop: { agentId: "delivery-code", model: "delivery-model", effort: "high" }
  } }, now));
  store.saveConfig({ ...store.getConfig(), defaultAgent: "code", defaultWorkspace: home });
  submitOperatorMessage("Discuss first", undefined, store, { now: () => now });
  const scheduler = new FileSchedulerStoreAdapter(store);
  assert.equal(scheduler.prepareDraftPlanning("task-1", now), true);
  const run = store.getActiveRun("task-1", "leader");
  assert.equal(run.effective.agentId, "draft-code");
  const planner = new FileRoleLaunchPlanner(home, store, { environment: { HOME: home, PATH: process.env.PATH } });
  const request = { taskId: "task-1", roleName: "leader", agentId: "draft-code", adapterId: "codex",
    mode: "new", effective: run.effective, runId: run.id };
  const planned = planner.plan(request);
  assert.equal(planned.launch.providerControl.codexThread.model, "planning-model");
  scheduler.recordLaunchedRuntimeNativeSession({
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "draft-code", adapterId: "codex", nativeSessionId: "stage-planning", effective: run.effective
  }, () => {}, now);
  store.transaction(tx => terminalizeExactTaskRun(tx, {
    taskId: "task-1", roleName: "leader", agentId: "draft-code", runId: run.id,
    outcome: { status: "completed", output: "Plan saved" }
  }, now));
  assert.equal(resolveManagedTaskCaller(store, { ...planned.launch.env, CODEX_THREAD_ID: "stage-planning" }).executionAuthority, "planning");
  const restored = planner.plan({ ...request, mode: "resume", runId: undefined, nativeSessionId: "stage-planning" });
  assert.equal(restored.launch.env.YUI_AGENT_ID, "draft-code");
  assert.equal(resolveTaskAgentCapabilities({ taskId: "task-1", roleName: "leader", stage: "draft" }, store).input.config.model, "planning-model");
  const later = new Date(now.getTime() + 120_000);
  runTaskCommand(["message", "queue", "task-1", "Refine the plan", "--request-id", "followup"],
    store, { environment: {}, now: () => later });
  const sent = [];
  const delivery = {
    prepareRoleSession: async request => { sent.push(request); return {}; },
    waitUntilReady: async value => value, sendOnce: async () => ({ status: "sent" })
  };
  await processLeaderWakeups(scheduler, delivery, later);
  assert.equal(sent.at(-1).effective.model, "planning-model");
  const originalWakeCount = store.listTaskWakes("task-1").length;
  await processLeaderWakeups(scheduler, delivery, later);
  assert.equal(store.listTaskWakes("task-1").length, originalWakeCount);
  runTaskCommand(["role", "update", "task-1", "leader", "--stage", "draft", "--agent", "code"],
    store, { environment: {}, now: () => later });
  assert.equal(scheduler.getRole("task-1", "leader").effective.agentId, "draft-code");
  runTaskCommand(["role", "session", "new", "task-1", "leader", "--reason", "Adopt planning Agent"],
    store, { environment: {}, now: () => later });
  scheduler.completeRuntimeCleanup({ kind: "role-runtime", taskId: "task-1", roleName: "leader" }, later);
  const replacementResults = await processLeaderWakeups(scheduler, {
    ...delivery, prepareRoleSession: async replacement => {
      assert.equal(replacement.agentId, "code");
      assert.equal(replacement.effective.leaderStage.stage, "draft");
      planner.plan(replacement);
      scheduler.recordLaunchedRuntimeNativeSession({
        owner: { scope: "task", taskId: "task-1", roleName: "leader" },
        agentId: replacement.agentId, adapterId: replacement.adapterId,
        nativeSessionId: "planning-replacement", effective: replacement.effective
      }, () => {}, later);
      return {};
    }
  }, later);
  assert.equal(replacementResults[0].status, "dispatched", JSON.stringify(replacementResults));
  assert.equal(store.listRuns("task-1").length, 1, "Replacement initialization is not a replay of the planning Run.");
  requestTaskActivation(store, { taskId: "task-1", requestId: "activate", actorId: "global:operator",
    authorityRef: "fixture", environmentPlan: { kind: "scratch" } }, later);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => later);
  // The preparer owns stop/handover; no stage code manufactures a Session.
  await preparer.activateTaskWorkspace("task-1");
  const selected = scheduler.getRole("task-1", "leader");
  assert.equal(selected.effective.agentId, "delivery-code");
  assert.equal(selected.effective.model, "delivery-model");
  assert.equal(selected.effective.executionAuthority, "delivery");
  assert.equal(store.getRun("task-1", run.id).effective.model, "planning-model");
  assert.equal(store.listMessages("task-1")[0].body, "Discuss first");
  assert.equal(store.getTaskRoleSessionSet("task-1", "leader").history
    .find(session => session.nativeSessionId === "stage-planning").status, "ended");
  assert.ok(store.getWorkMailbox({ kind: "role-runtime", taskId: "task-1", roleName: "leader" }).pending,
    "Activation preserves the physical Host cleanup fence.");
  scheduler.completeRuntimeCleanup({ kind: "role-runtime", taskId: "task-1", roleName: "leader" }, later);
  const next = planner.plan({ taskId: "task-1", roleName: "leader", agentId: "delivery-code", adapterId: "codex",
    mode: "new", effective: selected.effective });
  assert.equal(next.launch.providerControl.codexThread.model, "delivery-model");
  scheduler.recordLaunchedRuntimeNativeSession({
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "delivery-code", adapterId: "codex", nativeSessionId: "stage-develop", effective: selected.effective
  }, () => {}, later);
  assert.equal(resolveManagedTaskCaller(store, { ...next.launch.env, CODEX_THREAD_ID: "stage-develop" }).executionAuthority, "delivery");
  assert.throws(() => resolveManagedTaskCaller(store, { ...planned.launch.env, CODEX_THREAD_ID: "stage-planning" }), /no longer/);
  runTaskCommand(["role", "update", "task-1", "leader", "--stage", "develop", "--model", "next-model"],
    store, { environment: {}, now: () => later });
  const resumed = planner.plan({ taskId: "task-1", roleName: "leader", agentId: "delivery-code", adapterId: "codex",
    mode: "resume", effective: selected.effective, nativeSessionId: "stage-develop" });
  assert.equal(resumed.launch.env.YUI_AGENT_ID, "delivery-code");
  assert.equal(store.getTaskRoleSessionSet("task-1", "leader").sessions["delivery-code"].effective.model, "delivery-model",
    "Desired updates do not rewrite the current Session, including Host rebuild.");
  runTaskCommand(["role", "update", "task-1", "leader", "--stage", "develop", "--agent", "draft-code"],
    store, { environment: {}, now: () => later });
  assert.equal(scheduler.getRole("task-1", "leader").effective.agentId, "delivery-code",
    "A pending stage Agent change must not prevent input to the still-current Session.");
  runTaskCommand(["role", "session", "new", "task-1", "leader", "--reason", "Adopt stage configuration"],
    store, { environment: {}, now: () => later });
  assert.equal(scheduler.completeRuntimeCleanup({ kind: "role-runtime", taskId: "task-1", roleName: "leader" }, later), true);
  const replacement = scheduler.getRole("task-1", "leader").effective;
  assert.equal(replacement.agentId, "draft-code");
  assert.equal(store.getTaskRoleSessionSet("task-1", "leader").activeAgentId, "draft-code");
  assert.equal(replacement.model, "next-model");
  assert.equal(replacement.leaderStage.stage, "develop");
});
