import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding, copyGlobalRoleToTaskRole } from "../../dist/role/role.js";
import { createAgentProfile } from "../../dist/profile/agentProfile.js";
import { resolveAgentProfileRuntime } from "../../dist/profile/agentProfileRuntime.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";
import { runProfileCommand } from "../../dist/commands/profileCommands.js";
import { deliverGlobalInputs } from "../../dist/controller/globalInputDelivery.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { processLeaderWakeups } from "../../dist/scheduler/leaderWakeupProcessor.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { getSelectionCandidates } from "../../dist/cli/interactionCandidates.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { processActiveRoleRunDeliveries } from "../../dist/scheduler/activeRoleRunDelivery.js";
import { usePre124Layout } from "../helpers/pre19Storage.mjs";
import { RuntimeLaunchCoordinator } from "../../dist/controller/runtimeLaunchCoordinator.js";
import { TmuxSessionHost } from "../../dist/runtime/tmuxAdapters.js";
import { assertRoleEnabled } from "../../dist/role/availability.js";
import { createRoleSessionSet, bindTaskRoleProviderRuntime } from "../../dist/executor/agentExecutor.js";
import { createProviderRuntimeBinding, beginProviderTurn, acceptProviderTurn } from "../../dist/runtime/providerRuntimeIdentity.js";

test("pre-start disable preserves Worker input and Leader notification for one delivery after enable", async t => {
  for (const roleName of ["worker", "leader"]) {
    const home = mkdtempSync(join(tmpdir(), "yui-availability-race-"));
    const store = new SqliteTaskStore(home);
    t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
    const now = new Date();
    const agent = createConfiguredAgent("fixture", "codex", "unused", [], [], now);
    store.saveConfiguredAgent(agent);
    store.saveTask(activateTask(createTask("task-1", "Availability", now, { cwd: home }), now));
    store.saveManagedWorkspace(createManagedWorkspace({
      owner: { type: "task", taskId: "task-1" }, root: home, entries: []
    }, now));
    store.saveRole("task-1", copyGlobalRoleToTaskRole(
      createGlobalRole(roleName, [createRoleAgentBinding(agent)], agent.id, home, now), "task-1", now));
    const command = args => runTaskCommand(args, store, { environment: {}, now: () => now });
    if (roleName === "worker") {
      command(["work", "create", "task-1", "Original result", "--role", "worker"]);
      store.saveManagedWorkspace(createManagedWorkspace({
        owner: { type: "work-item", taskId: "task-1", workItemId: "work-item-1" }, root: home, entries: []
      }, now));
      command(["work", "dispatch", "task-1/work-item-1"]);
    } else {
      command(["message", "queue", "task-1", "Original requirement", "--request-id", "original"]);
    }
    const originalRun = store.getActiveRun("task-1", roleName);
    const originalMessages = store.listMessages("task-1");
    let pause = true, launches = 0, sends = 0;
    const planner = new FileRoleLaunchPlanner(home, store);
    const host = new TmuxSessionHost({
      plan: input => {
        const planned = planner.plan(input);
        return { ...planned, launch: { ...planned.launch, deferProviderStart: true } };
      }
    }, { ensureRoleWindow: () => { launches++; return true; } }, {
      validateLaunch: async () => {
        await Promise.resolve();
        if (pause) command(["role", "disable", "task-1", roleName]);
      }
    });
    const coordinator = new RuntimeLaunchCoordinator({
      recordLaunchedRuntimeNativeSession: () => {}
    }, host, { assertCurrent: () => assertRoleEnabled(store.getRole("task-1", roleName)) });
    const delivery = {
      prepareRoleSession: async input => {
        await coordinator.prepare({ ...input, owner: { scope: "task", taskId: input.taskId, roleName } },
          undefined, input.beforeHostStart);
        return { ...input, session: null };
      },
      waitUntilReady: async value => value,
      sendOnce: async ({ receiptId }) => {
        sends++;
        if (originalRun !== null) {
          // Model the Host's durable acceptance, not just its transport response.
          const binding = acceptProviderTurn(beginProviderTurn(createProviderRuntimeBinding({
            providerNamespace: "openai/codex", accountScope: "fixture", conversationId: "session",
            startedAt: now.toISOString()
          }), { runId: originalRun.id, attemptId: receiptId, authorityEpoch: 1, submittedAt: now.toISOString() }),
          { attemptId: receiptId, acceptedAt: now.toISOString() });
          store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(createRoleSessionSet({
            scope: "task", taskId: "task-1", roleName
          }, agent.id, now), binding, now));
        }
        return { status: "sent" };
      }
    };
    const scheduler = new FileSchedulerStoreAdapter(store);
    const process = () => roleName === "worker"
      ? processActiveRoleRunDeliveries(scheduler, delivery, now)
      : processLeaderWakeups(scheduler, delivery, now);
    const paused = await process();
    assert.equal(paused[0].status, "skipped", roleName);
    assert.equal(launches, 0);
    assert.equal(sends, 0);
    assert.equal(store.getActiveRun("task-1", roleName)?.id, originalRun?.id);
    assert.deepEqual(store.listMessages("task-1"), originalMessages);
    pause = false;
    command(["role", "enable", "task-1", roleName]);
    await process();
    await process();
    assert.equal(launches, 1, roleName);
    assert.equal(sends, 1, roleName);
  }
});

test("availability persists without changing launch identity, copied bindings or configuration", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-availability-"));
  let store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  const agent = createConfiguredAgent("fixture", "codex", "unused", [], [], now);
  store.saveConfiguredAgent(agent);
  const role = createGlobalRole("worker", [createRoleAgentBinding(agent)], agent.id, home, now);
  // Missing state in valid older payloads means enabled, without rewriting history.
  delete role.enabled;
  store.saveGlobalRole(role);
  const copied = copyGlobalRoleToTaskRole(role, "task-1", now);
  const oldProfile = createAgentProfile({ id: "worker" }, now);
  delete oldProfile.enabled;
  store.saveAgentProfile(oldProfile);
  const oldPayload = store.databaseHandle().prepare("SELECT payload FROM global_roles WHERE name='worker'").get().payload;
  usePre124Layout(store.databaseHandle());
  store.databaseHandle().prepare("UPDATE storage_schema SET minor=21").run();
  store.close();
  assert.equal((await runStorageUpgrade({ home, mode: "execute" })).outcome, "upgraded");
  store = new SqliteTaskStore(home);
  assert.equal(store.databaseHandle().prepare("SELECT payload FROM global_roles WHERE name='worker'").get().payload, oldPayload);
  assert.deepEqual(store.getAgentProfile("worker"), oldProfile);
  assert.equal(resolveAgentProfileRuntime(oldProfile, store).status, "resolved");
  runGlobalRoleCommand(["disable", "worker"], store);
  const disabled = store.getGlobalRole("worker");
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.launchRevision, role.launchRevision);
  assert.deepEqual(disabled.agentBindings, role.agentBindings);
  runGlobalRoleCommand(["disable", "worker"], store);
  assert.deepEqual(store.getGlobalRole("worker"), disabled, "repeated disable is a no-op");
  assert.throws(() => copyGlobalRoleToTaskRole(disabled, "task-2", now), /disabled/);
  assert.notEqual(copied.enabled, false, "existing Task bindings are independent");
  assert.match(resolveAgentProfileRuntime(store.getAgentProfile("worker"), store).reason, /disabled/);
  const explicit = createAgentProfile({ id: "explicit", runtime: { source: "explicit", agentId: agent.id } }, now);
  assert.match(resolveAgentProfileRuntime(explicit, store).reason, /matching Worker binding.*disabled/);
  let launched = 0;
  await deliverGlobalInputs(home, store, async () => { launched++; }, error => { throw error; });
  assert.equal(launched, 0);
  runProfileCommand(["disable", "worker"], store);
  const disabledProfile = store.getAgentProfile("worker");
  runProfileCommand(["disable", "worker"], store);
  assert.deepEqual(store.getAgentProfile("worker"), disabledProfile);
  runProfileCommand(["reset"], store);
  assert.equal(store.getAgentProfile("worker").enabled, false, "reset must not resurrect templates");
  store.close();
  store = new SqliteTaskStore(home);
  assert.equal(store.getGlobalRole("worker").enabled, false);
  assert.equal(store.getAgentProfile("worker").enabled, false);
  runGlobalRoleCommand(["enable", "worker"], store);
  assert.match(resolveAgentProfileRuntime(store.getAgentProfile("worker"), store).reason, /disabled/);
  runProfileCommand(["enable", "worker"], store);
  assert.equal(resolveAgentProfileRuntime(store.getAgentProfile("worker"), store).status, "resolved");
  assert.deepEqual(store.getGlobalRole("worker").agentBindings, role.agentBindings);
});

test("Task Role availability is independent and keeps a pending Leader wake until ordinary delivery", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-availability-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  const agent = createConfiguredAgent("fixture", "codex", "unused", [], [], now);
  store.saveConfiguredAgent(agent);
  const template = createGlobalRole("leader", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.saveGlobalRole(template);
  store.saveTask(activateTask(createTask("task-1", "Availability", now, { cwd: home }), now));
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: "task-1" }, root: home, entries: []
  }, now));
  store.saveRole("task-1", copyGlobalRoleToTaskRole(template, "task-1", now));
  const command = args => runTaskCommand(args, store, { environment: {}, now: () => now });
  command(["message", "queue", "task-1", "Keep requirement", "--request-id", "requirement"]);
  command(["role", "disable", "task-1", "leader"]);
  const disabled = store.getRole("task-1", "leader");
  command(["role", "disable", "task-1", "leader"]);
  assert.deepEqual(store.getRole("task-1", "leader"), disabled);
  const wake = store.getPendingWakeup("task-1");
  const inputs = store.listMessages("task-1");
  const planner = new FileRoleLaunchPlanner(home, store);
  assert.throws(() => planner.plan({ taskId: "task-1", roleName: "leader",
    agentId: "fixture", adapterId: "codex", mode: "new" }), /disabled/);
  let submitted = 0;
  const delivery = {
    prepareRoleSession: async () => ({}),
    waitUntilReady: async value => value,
    sendOnce: async () => { submitted++; return { status: "sent" }; }
  };
  const scheduler = new FileSchedulerStoreAdapter(store);
  const result = await processLeaderWakeups(scheduler, delivery, now);
  assert.match(result[0].error, /disabled/);
  assert.equal(submitted, 0);
  assert.deepEqual(store.getPendingWakeup("task-1"), wake);
  assert.deepEqual(store.listMessages("task-1"), inputs);
  runGlobalRoleCommand(["disable", "leader"], store);
  command(["role", "enable", "task-1", "leader"]);
  assert.equal(store.getTask("task-1").status, "active");
  assert.equal(store.getGlobalRole("leader").enabled, false);
  await processLeaderWakeups(scheduler, delivery, new Date(now.getTime() + 120_000));
  assert.equal(submitted, 1, "copied Task Role remains usable when its template is disabled");
  await processLeaderWakeups(scheduler, delivery, new Date(now.getTime() + 120_000));
  assert.equal(submitted, 1);
  store.saveAgentProfile(createAgentProfile({ id: "unavailable", enabled: false,
    runtime: { source: "explicit", agentId: agent.id } }, now));
  assert.throws(() => command(["role", "add", "task-1", "worker", "--profile", "unavailable"]), /disabled/);
  assert.equal(store.getRole("task-1", "worker"), null);
});

test("selectors retain disabled templates for management but never offer them for application", async () => {
  const profiles = [{ id: "off", enabled: false }, { id: "on", enabled: true },
    { id: "blocked", enabled: true, effectiveRuntime: { status: "unavailable" } }];
  const ports = { call: async () => profiles };
  const application = await getSelectionCandidates({ provider: "agent-profiles", actionTarget: false }, ports, []);
  assert.deepEqual(application.candidates.map(c => c.value), ["on"]);
  const management = await getSelectionCandidates({ provider: "agent-profiles", actionTarget: true }, ports, []);
  assert.deepEqual(management.candidates.map(c => c.value), ["off", "on", "blocked"]);
});
