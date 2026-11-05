import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createWorkItem, submitWorkItemCandidate, updateWorkItemStatus } from "../../dist/workItem/workItem.js";
import { createRun, completeRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { freezeRunContextSnapshot } from "../../dist/context/runContextPack.js";
import { contextSnapshotRef } from "../../dist/context/contextSnapshot.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRoleSessionSet, recordRoleAgentSession, bindTaskRoleProviderRuntime,
  updateTaskRoleProviderRuntime } from "../../dist/executor/agentExecutor.js";
import { updateRoleAgentSessionStatus } from "../../dist/executor/agentExecutor.js";
import { createProviderRuntimeBinding, beginProviderTurn, acceptProviderTurn } from "../../dist/runtime/providerRuntimeIdentity.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { resolveRuntimeHookRunFence } from "../../dist/controller/runtimeHookRunFence.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createRuntimeLifecycleDispatcher } from "../../dist/controller/runtime.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { publishStructuredProviderStarted, publishStructuredProviderTerminal } from "../../dist/controller/structuredProviderObservation.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import { requireManagedTaskCaller } from "../../dist/runtime/managedCaller.js";
import { sessionCallerEnvironment } from "../../dist/runtime/sessionCaller.js";

const now = new Date("2026-11-05T00:00:00Z");

function fixture(t, accepted, reviewPolicy) {
  const home = mkdtempSync(join(tmpdir(), "yui-work-continue-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const task = activateTask(createTask("task-1", "Continuation", now, { cwd: home }), now);
  store.saveTask(task);
  const workspace = createManagedWorkspace({ owner: { type: "task", taskId: task.id }, root: home, entries: [] }, now);
  store.saveManagedWorkspace(workspace);
  const agent = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  store.saveConfiguredAgent(createConfiguredAgent("codex", "codex", "false", [], [], now));
  const role = createRole(task.id, "worker", [agent], agent.agentId, home, now);
  store.saveRole(task.id, role);
  let item = createWorkItem("work-item-1", task.id,
    { title: "Original scope", assignee: role.name, objective: "Fix the original result", writeProjectIds: [] }, now);
  store.saveWorkItem(task.id, item);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution", workspace, workItemWriteProjectIds: [] });
  const snapshot = freezeRunContextSnapshot(store, { taskId: task.id, roleName: role.name,
    purpose: "execution", workItemId: item.id, workspace }, now);
  const run = completeRun(createRun(store.nextRunId(task.id), task.id, role.name, "new",
    createRunInput({ source: { type: "yui", channel: "workitem-dispatch" },
      contextSnapshotRef: contextSnapshotRef(snapshot), deltaRefIds: [] }), now,
    { workItemId: item.id, workspace, effective }), "Original result", now,
    { providerNamespace: "codex", accountScope: "fixture", conversationId: "original",
      nativeTurnId: "old-turn", status: "completed" });
  store.saveRun(run);
  item = submitWorkItemCandidate(item, { summary: "Original candidate", source: { type: "run", runId: run.id },
    ...(reviewPolicy === undefined ? {} : { reviewPolicy }) }, now);
  if (accepted) item = updateWorkItemStatus(item, "accepted", now, "Original acceptance");
  store.saveWorkItem(task.id, item);
  let sessions = recordRoleAgentSession(createRoleSessionSet({ scope: "task", taskId: task.id,
    roleName: role.name }, agent.agentId, now), { agentId: agent.agentId, adapterId: agent.adapterId,
    nativeSessionId: "original", status: "active", policy: "fixed", effective }, now);
  sessions = bindTaskRoleProviderRuntime(sessions, createProviderRuntimeBinding({
    providerNamespace: "codex", accountScope: "fixture", conversationId: "original", startedAt: now.toISOString()
  }), now);
  store.saveTaskRoleSessionSet(sessions);
  const environment = { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: task.id, YUI_ROLE: role.name,
    YUI_NATIVE_SESSION_ID: "original", YUI_WORKSPACE: home };
  const direct = (id) => {
    const set = store.getTaskRoleSessionSet(task.id, role.name);
    store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(set,
      acceptProviderTurn(beginProviderTurn(set.providerBinding, { attemptId: `direct:${id}`,
        authorityEpoch: 1, submittedAt: now.toISOString() }),
      { attemptId: `direct:${id}`, nativeTurnId: id, acceptedAt: now.toISOString() }), now));
  };
  const command = (key = "repair-1", input = "Please fix the original result", turn = "question") =>
    runTaskCommand(["work", "continue", `${task.id}/${item.id}`, "--request-id", key, "--input", input,
      "--expected-turn", turn],
      store, { environment, now: () => now });
  return { home, store, task, item, role, run, environment, direct, command };
}

test("original WorkItem conversation promotes only explicit repair, retains acceptance evidence, and collects its exact new result", t => {
  for (const accepted of [false, true]) {
    const f = fixture(t, accepted);
    const { store, task, item, role, run, environment } = f;
    // An ordinary native question is not a managed execution or withdrawal.
    f.direct("question");
    assert.equal(store.getActiveRun(task.id, role.name), null);
    assert.deepEqual(store.getWorkItem(task.id, item.id), item);
    f.command();
    const next = store.getActiveRun(task.id, role.name);
    assert.ok(next && next.id !== run.id);
    assert.equal(next.mode, "resume");
    assert.deepEqual(next.effective, run.effective);
    assert.equal(store.getWorkItem(task.id, item.id).status, "open");
    assert.equal(store.getWorkItem(task.id, item.id).currentCandidateId, undefined);
    assert.equal(store.getWorkItem(task.id, item.id).acceptedCandidateId, undefined);
    assert.deepEqual(store.getWorkItem(task.id, item.id).candidates, item.candidates);
    assert.deepEqual(store.getRun(task.id, run.id), run);
    f.command();
    assert.equal(store.listRuns(task.id).length, 2);
    assert.throws(() => f.command("repair-1", "different input"), /reused|conflict/i);
    assert.throws(() => f.command("repair-2"), /active|already|bound/i);
    assert.equal(store.getTaskRoleSessionSet(task.id, role.name).sessions.codex.nativeSessionId, "original");
    const fence = resolveRuntimeHookRunFence({ ...environment, YUI_AGENT_ID: "codex", YUI_ADAPTER_ID: "codex" },
      "codex", "original", { terminal: true, exactInput: true, attemptId: "direct:question", nativeTurnId: "question" }, store);
    assert.equal(fence.runId, next.id);
    const scheduler = new FileSchedulerStoreAdapter(store);
    scheduler.observeRuntimeRunTerminal({ taskId: task.id, roleName: role.name, agentId: "codex",
      adapterId: "codex", nativeSessionId: "original", nativeTurnId: "question",
      attemptId: "direct:question", providerStatus: "completed",
      outcome: { status: "completed", output: "Repaired result" } }, now);
    assert.equal(store.getRun(task.id, next.id).result.output, "Repaired result");
    assert.equal(store.getActiveRun(task.id, role.name), null);
    assert.equal(store.getWorkItem(task.id, item.id).status, "open", "a new result is not acceptance");
  }
});

test("continuation fences paused, released, replaced and changed-scope owners without mutating history", t => {
  const f = fixture(t, true);
  const { store, task, item, role } = f;
  f.direct("repair");
  const refused = pattern => {
    assert.throws(() => f.command("repair-1", "Please fix the original result", "repair"), pattern);
    assert.equal(store.listRuns(task.id).length, 1);
    assert.equal(store.getWorkItem(task.id, item.id).candidates.length, 1);
  };
  store.saveTask({ ...task, executionGate: { state: "stopped" } });
  refused(/stopped/);
  store.saveTask(task);
  store.saveWorkItem(task.id, { ...item, workspaceDisposition: "integrated" });
  refused(/released/);
  store.saveWorkItem(task.id, { ...item, objective: "A different scope" });
  refused(/scope changed/);
  store.saveWorkItem(task.id, item);
  store.saveRole(task.id, { ...role, defaultAccess: "read" });
  refused(/authority|environment/);
  store.saveRole(task.id, role);
  const sessions = store.getTaskRoleSessionSet(task.id, role.name);
  store.saveTaskRoleSessionSet({ ...sessions, sessions: { ...sessions.sessions,
    codex: { ...sessions.sessions.codex, nativeSessionId: "successor" } } });
  refused(/replaced/);
});

test("failed repair cannot reuse an old result or acceptance, and another repair retains required review", t => {
  const reviewPolicy = { roleName: "reviewer", trigger: "always" };
  const f = fixture(t, true, reviewPolicy);
  const { store, task, item, role } = f;
  const leaderCommand = args => runTaskCommand(args, store, { environment: {}, now: () => now });
  const scheduler = new FileSchedulerStoreAdapter(store);
  const terminal = (turn, failed) => scheduler.observeRuntimeRunTerminal({
    taskId: task.id, roleName: role.name, agentId: "codex", adapterId: "codex",
    nativeSessionId: "original", nativeTurnId: turn, attemptId: `direct:${turn}`,
    providerStatus: failed ? "failed" : "completed",
    outcome: failed ? { status: "failed", failureReason: "runtime-failed", diagnostic: "Repair failed" }
      : { status: "completed", output: "New repair result" }
  }, now);
  f.direct("question");
  f.command();
  terminal("question", true);
  assert.throws(() => leaderCommand(["work", "update", `${task.id}/${item.id}`, "done", "--summary", "Old result"]),
    /no completed/);
  assert.throws(() => leaderCommand(["work", "accept", `${task.id}/${item.id}`,
    "--candidate", item.candidates[0].id, "--summary", "Old acceptance"]), /historical acceptance/);
  const replay = f.command();
  assert.match(replay.output, /Historical continuation receipt/);
  assert.equal(store.getActiveRun(task.id, role.name), null);
  f.direct("retry");
  f.command("repair-2", "Retry the same repair", "retry");
  terminal("retry", false);
  // This Gitless fixture cannot prepare a mandatory Review. Admission must
  // hit that prerequisite, not silently downgrade the old always policy.
  assert.throws(() => leaderCommand(["work", "update", `${task.id}/${item.id}`, "done", "--summary", "Fresh result"]),
    /frozen managed Git snapshot/);
  assert.deepEqual(store.getWorkItem(task.id, item.id).candidates, item.candidates);
  assert.equal(store.listEventsByType(task.id, ["work.continued"]).at(-1).payload.previousCandidateId,
    item.candidates[0].id);
  assert.equal(store.getWorkItem(task.id, item.id).status, "open");
});

test("stopped Host restores the retained conversation without creating a Run or dropping files", async t => {
  const f = fixture(t, true);
  const { store, task, role, item, home } = f;
  writeFileSync(join(home, "unfinished.txt"), "Preserve this user's unfinished work");
  const sessions = store.getTaskRoleSessionSet(task.id, role.name);
  store.saveTaskRoleSessionSet(updateRoleAgentSessionStatus(sessions, "codex", "ended", now, "stopped"));
  assert.throws(() => requireManagedTaskCaller(store, f.environment), /runtime/);
  assert.throws(() => sessionCallerEnvironment(store, { CODEX_THREAD_ID: "original" }), /no longer current/);
  assert.equal(sessionCallerEnvironment(store, { CODEX_THREAD_ID: "original" }, true).YUI_ROLE, role.name);
  const command = runTaskCommand(["role", "session", "resume", task.id, role.name],
    store, { environment: f.environment, now: () => now });
  assert.equal(command.kind, "session-resume");
  let restored = 0;
  const scheduler = new FileSchedulerStoreAdapter(store);
  const dispatch = createRuntimeLifecycleDispatcher(store, scheduler, {
    start: async () => assert.fail("must not start a new conversation"),
    restore: async request => {
      assert.equal(request.nativeSessionId, "original");
      assert.equal(request.runId, undefined);
      restored++;
      return { id: "fixture-host", owner: request.owner, agentId: request.agentId,
        adapterId: request.adapterId, nativeSessionId: request.nativeSessionId,
        hostRef: "fixture-host", hostCreated: true };
    }
  });
  const target = { scope: "task", taskId: task.id, roleName: role.name, expectedNativeSessionId: "original" };
  await assert.rejects(dispatch("runtime.ensure-role-session", { ...target, expectedNativeSessionId: "old" }), /changed/);
  await dispatch("runtime.ensure-role-session", target);
  assert.equal(restored, 1);
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).sessions.codex.status, "active");
  assert.deepEqual(store.getWorkItem(task.id, item.id), item);
  assert.equal(store.listRuns(task.id).length, 1);
  assert.equal(readFileSync(join(home, "unfinished.txt"), "utf8"), "Preserve this user's unfinished work");
  f.direct("question");
  await assert.rejects(dispatch("runtime.ensure-role-session", target), /unsettled/);
  f.command();
  assert.equal(store.listRuns(task.id).length, 2);
});

test("Host direct-input and terminal ingress resolves promoted and late results after the next Turn", async t => {
  const f = fixture(t, true);
  const { store, task, role, home } = f;
  const environment = { ...f.environment, YUI_HOME: home, YUI_AGENT_ID: "codex", YUI_ADAPTER_ID: "codex" };
  const scheduler = new FileSchedulerStoreAdapter(store);
  const processor = new FileRuntimeEventProcessor(new FileRuntimeEventInbox(home), scheduler);
  const drain = () => assert.deepEqual(processor.drain(new Date()).failed, []);
  const start = async turn => {
    await publishStructuredProviderStarted({ home, environment, started: {
      nativeSessionId: "original", conversationId: "original", nativeTurnId: turn,
      clientOwned: false, input: "Please fix the original result", observedAt: new Date().toISOString()
    } });
    drain();
  };
  await start("question");
  assert.equal(store.listRuns(task.id).length, 1);
  f.command();
  const continued = store.getActiveRun(task.id, role.name);
  const terminal = { nativeSessionId: "original", conversationId: "original", nativeTurnId: "question",
    clientOwned: false, status: "completed", output: "Fresh native result", observedAt: new Date().toISOString() };
  await publishStructuredProviderTerminal({ home, environment, terminal });
  drain();
  assert.equal(store.getRun(task.id, continued.id).result.output, "Fresh native result");
  await start("next-question");
  await publishStructuredProviderTerminal({ home, environment, terminal });
  drain();
  assert.equal(store.getRun(task.id, continued.id).result.output, "Fresh native result");
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).providerBinding.run.nativeTurnId, "next-question");
  assert.equal(store.getActiveRun(task.id, role.name), null);
});

test("Leader can withdraw an accepted Candidate without erasing it", t => {
  const { store, task, item } = fixture(t, true);
  runTaskCommand(["work", "reject", `${task.id}/${item.id}`, "--summary", "Repair required"],
    store, { environment: {}, now: () => now });
  const reopened = store.getWorkItem(task.id, item.id);
  assert.equal(reopened.status, "open");
  assert.deepEqual(reopened.candidates, item.candidates);
});
