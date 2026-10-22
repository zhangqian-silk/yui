import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { runTaskCommand, submitOperatorMessage } from "../../dist/commands/taskCommands.js";
import { runInboxCommand } from "../../dist/commands/inboxCommands.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { RuntimeLaunchCoordinator } from "../../dist/controller/runtimeLaunchCoordinator.js";
import { ExecutorRegistry } from "../../dist/executor/executorRegistry.js";
import { processLeaderWakeups } from "../../dist/scheduler/leaderWakeupProcessor.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { readTaskContext } from "../../dist/context/taskContext.js";
import { runControllerSchedulerPass } from "../../dist/controller/controller.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { resolveManagedTaskCaller } from "../../dist/runtime/managedCaller.js";
import { retireTask, archiveTask } from "../../dist/task/task.js";

const now = new Date("2026-10-22T00:00:00Z");
const later = new Date(now.getTime() + 120_000);
const owner = { scope: "task", taskId: "task-1", roleName: "leader" };
const runtime = { kind: "role-runtime", taskId: "task-1", roleName: "leader" };

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-draft-replacement-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  store.saveGlobalRole(createGlobalRole("leader", [createRoleAgentBinding(agent)], agent.id, home, now));
  store.saveConfig({ ...store.getConfig(), defaultAgent: agent.id, defaultWorkspace: home });
  submitOperatorMessage("Discuss the plan; do not start development.", undefined, store, { now: () => now });
  const scheduler = new FileSchedulerStoreAdapter(store);
  assert.equal(scheduler.prepareDraftPlanning("task-1", now), true);
  const run = store.getActiveRun("task-1", "leader");
  scheduler.recordLaunchedRuntimeNativeSession({
    owner, agentId: agent.id, adapterId: agent.adapterId,
    nativeSessionId: "original-planning", effective: run.effective
  }, () => {}, now);
  const command = args => runTaskCommand(args, store, { environment: {}, now: () => later });
  const inbox = (session, ...args) => runInboxCommand(args, store, { CODEX_THREAD_ID: session }, later).data;
  return { store, home, scheduler, run, command, inbox };
}

for (const interrupted of [false, true]) {
  test(`Draft replacement reaches a fresh planning Session (${interrupted ? "interrupted" : "completed, retained claim"})`, async t => {
    const { store, scheduler, run, command, inbox } = fixture(t);
    let retained;
    if (!interrupted) {
      store.transaction(tx => terminalizeExactTaskRun(tx, {
        taskId: "task-1", roleName: "leader", agentId: "codex", runId: run.id,
        outcome: { status: "completed", output: "Proposal preserved." }
      }, now));
      command(["message", "queue", "task-1", "Already handled; inspect effects before ACK", "--request-id", "old"]);
      const notification = scheduler.claimLeaderNotification("task-1", later);
      scheduler.settleLeaderNotification("task-1", notification.attemptId, "accepted", later);
      inbox("original-planning", "claim", notification.wakeId, "--request-id", "old-claim");
      retained = store.getTaskWake("task-1", notification.wakeId);
    }
    const replace = () => command(["role", "session", "new", "task-1", "leader", "--reason", "Recover planning"]);
    assert.equal(replace().data.alreadyRequested, false);
    assert.equal(replace().data.alreadyRequested, true);
    assert.equal(scheduler.claimLeaderNotification("task-1", later), null, "Unproven stop cannot hand off.");
    // Reopen storage as on Controller recovery. Only the external Host and
    // prompt transport are deterministic substitutes; scheduler, registry,
    // coordinator and native registration use the production path.
    const reopened = new SqliteTaskStore(store.rootDirectory());
    t.after(() => reopened.close());
    const adapter = new FileSchedulerStoreAdapter(reopened);
    const starts = [];
    const prompts = [];
    const planner = new FileRoleLaunchPlanner(store.rootDirectory(), reopened, {
      environment: { HOME: store.rootDirectory(), PATH: process.env.PATH }
    });
    const host = {
      start: async request => {
        planner.plan({ ...request, taskId: "task-1", roleName: "leader" });
        starts.push(request);
        return { id: "fresh-binding", owner, agentId: "codex", adapterId: "codex",
          hostRef: "isolated-host", nativeSessionId: "fresh-planning", hostCreated: true };
      },
      restore: async () => assert.fail("Replacement must not restore the old native ID.")
    };
    const delivery = new ExecutorRegistry({}, {}, undefined, {
      sessionHost: host,
      launchCoordinator: new RuntimeLaunchCoordinator(adapter, host, { now: () => later }),
      promptPush: { tryPush: async ({ envelope }) => {
        prompts.push(envelope);
        const context = readTaskContext(reopened, "task-1");
        assert.equal(context.phase.status, "draft");
        assert.ok(context.records.some(record => record.ref.store === "task-message"));
        assert.equal(resolveManagedTaskCaller(reopened, { CODEX_THREAD_ID: "fresh-planning" }).executionAuthority, "planning");
        return { result: "delivered" };
      } }
    });
    const cleanup = [];
    // A negative Host stop result cannot release the old writer or start the
    // successor. A later confirmed stop uses the same lifecycle request.
    const pass = stopped => runControllerSchedulerPass(adapter, delivery, later, undefined,
      { kind: "full" }, false, cleanup, { stopOwner: async actual => {
        assert.deepEqual(actual, owner);
        return stopped;
      } });
    await pass(false);
    assert.equal(cleanup.at(-1).status, "failed");
    assert.equal(starts.length, 0);
    await pass(true);
    assert.equal(cleanup.at(-1).status, "completed");
    assert.equal(adapter.completeRuntimeCleanup(runtime, later), false);
    assert.equal(reopened.getActiveRun("task-1", "leader"), null);
    assert.equal(reopened.getRun("task-1", run.id).status, interrupted ? "failed" : "completed");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].effective.executionAuthority, "planning");
    assert.deepEqual(starts[0].effective.workspace.entries, []);
    assert.equal(starts[0].runId, undefined, "Initialization is not a new business assignment.");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].text, /inbox list/);
    assert.equal(reopened.getTask("task-1").status, "draft");
    assert.equal(reopened.getTaskWorkspace("task-1"), null);
    assert.equal(reopened.getRoleSessionSet("task-1", "leader").sessions.codex.nativeSessionId, "fresh-planning");
    assert.equal(reopened.listRuns("task-1").length, 1);
    if (retained) assert.deepEqual(reopened.getTaskWake("task-1", retained.id), retained);
    await processLeaderWakeups(adapter, delivery, later);
    assert.equal(starts.length, 1);
    assert.equal(prompts.length, 1, "Reconcile cannot replay accepted initialization or retained input.");
  });
}

test("Draft startup rejection remains explicitly recoverable without replay or wider registration authority", async t => {
  const { store, scheduler, run, command } = fixture(t);
  store.transaction(tx => terminalizeExactTaskRun(tx, {
    taskId: "task-1", roleName: "leader", agentId: "codex", runId: run.id,
    outcome: { status: "completed", output: "Plan saved." }
  }, now));
  const input = { owner, agentId: "codex", adapterId: "codex",
    nativeSessionId: "new-planning", effective: run.effective };
  const register = overrides => scheduler.recordLaunchedRuntimeNativeSession(
    { ...input, ...overrides }, () => {}, later);
  assert.throws(() => register(), /not active/, "Historical planning alone cannot admit a new ID.");
  assert.throws(() => runTaskCommand(
    ["role", "session", "new", "task-1", "leader", "--reason", "Unauthorized"],
    store, { environment: { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1",
      YUI_ROLE: "leader", YUI_NATIVE_SESSION_ID: "not-current" } }
  ), /Session|identity/i);
  command(["role", "session", "new", "task-1", "leader", "--reason", "Replace planning"]);
  scheduler.completeRuntimeCleanup(runtime, later);
  assert.throws(() => register(), /not active/, "Cleanup alone is not an admitted initialization.");

  let checks = 0;
  let rejectRegistration = true;
  let starts = 0;
  let pushes = 0;
  const host = { start: async () => {
    starts++;
    // Reattaching the same deterministic Host after the rejected adoption.
    return { id: "new-binding", owner, agentId: "codex", adapterId: "codex",
      hostRef: "isolated-host", nativeSessionId: input.nativeSessionId };
  } };
  const delivery = new ExecutorRegistry({}, {}, undefined, {
    sessionHost: host,
    launchCoordinator: new RuntimeLaunchCoordinator(scheduler, host, {
      now: () => later,
      assertCurrent: () => {
        if (rejectRegistration && ++checks === 2) throw new Error("Registration precondition changed");
      }
    }),
    promptPush: { tryPush: async () => { pushes++; return { result: "delivered" }; } }
  });
  const failed = await processLeaderWakeups(scheduler, delivery, later);
  assert.match(failed[0].error, /Registration precondition changed/);
  assert.equal(store.getRoleSessionSet("task-1", "leader").sessions.codex, undefined);
  assert.equal(pushes, 0);
  await processLeaderWakeups(scheduler, delivery, later);
  assert.equal(starts, 1, "A rejected startup needs explicit recovery, not a launch loop.");
  assert.throws(() => register(), /not active/, "A rejected initialization is not fresh admission.");
  const rejectedWake = store.listTaskWakes("task-1").at(-1);
  command(["wake", "retry", "task-1", rejectedWake.id, "--reason", "Precondition corrected; no prompt was sent"]);
  rejectRegistration = false;

  // Inspect the exact selected retry before registration. Independent stops
  // and configuration/identity mismatches still fence the same valid wake.
  const retry = scheduler.claimLeaderNotification("task-1", later);
  assert.equal(retry.disposition, "submit");
  const draft = store.getTask("task-1");
  const cancelled = retireTask(draft, { by: "user", summary: "Cancelled planning" }, later);
  for (const blocked of [
    { ...draft, executionGate: { state: "stopped" } },
    cancelled,
    archiveTask(cancelled, later)
  ]) {
    store.saveTask(blocked);
    assert.throws(() => register(), /not active|archived/);
  }
  store.saveTask(draft);
  assert.throws(() => register({ effective: { ...run.effective, executionAuthority: "delivery" } }), /not active/);
  assert.throws(() => register({ adapterId: "claude" }), /active Role Agent/);
  assert.throws(() => scheduler.recordRuntimeNativeSession({
    taskId: "task-1", roleName: "leader", agentId: "codex", adapterId: "codex",
    nativeSessionId: "unscoped-hook"
  }, later), /not active/, "An unscoped native hook cannot borrow notification admission.");
  // Typed deferred pre-submission backpressure lets the scheduler resume this
  // exact retry; no accepted/unknown business input is replayed.
  scheduler.settleLeaderNotification("task-1", retry.attemptId, "deferred", later);
  const recovered = await processLeaderWakeups(scheduler, delivery, later);
  assert.equal(recovered[0].status, "dispatched", JSON.stringify(recovered));
  assert.equal(starts, 2);
  assert.equal(pushes, 1);
  assert.equal(store.getTask("task-1").status, "draft");
  assert.equal(store.listRuns("task-1").length, 1);
  assert.equal(store.getTaskWorkspace("task-1"), null);
});
