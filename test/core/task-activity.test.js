import assert from "node:assert/strict";
import test from "node:test";
import { projectTaskExecution } from "../../dist/scheduler/taskExecutionProjection.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createInputRequest } from "../../dist/input/inputRequest.js";
import { cancelInputRequest } from "../../dist/input/inputRequest.js";
import { createDurableJob, startDurableJob, completeDurableJob } from "../../dist/job/durableJob.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { completeRun } from "../../dist/agentRun/agentRun.js";
import { createFixtureRun } from "../helpers/runFixture.mjs";
import { readTaskContext, listTaskContext } from "../../dist/context/taskContext.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeObservation, runtimeObservationTaskEventPayload } from "../../dist/runtime/runtimeObservation.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";

test("execution keeps parallel Job facts visible while waiting for user and never equates unknown with done", () => {
  const now = new Date("2026-10-12T00:00:00Z");
  const task = activateTask(createTask("task-1", "Parallel activity", now), now);
  const base = { task, now, roles: [], runs: [], jobs: [{ id: "job-1", status: "running" }] };
  const running = projectTaskExecution(base);
  assert.equal(running.status, "waiting-on-jobs");
  assert.deepEqual(running.activity.jobs, { queued: 0, running: 1, unknown: 0 });
  const input = createInputRequest("input-1", task.id,
    { taskId: task.id, roleName: "leader", agentId: "codex", nativeSessionId: "fixture" },
    { question: "Choose", choices: [], blockedRefs: [] }, now);
  const waiting = projectTaskExecution({ ...base, inputRequests: [input] });
  assert.equal(waiting.status, "waiting-user");
  assert.equal(waiting.activity.jobs.running, 1);
  const role = createRole(task.id, "worker", [createRoleAgentBinding({ id: "codex", adapterId: "codex" })], "codex", "/fixture", now);
  const run = createFixtureRun(null, "run-1", task.id, role.name, "new", createRunInput({
    source: { type: "yui", channel: "task-dispatch" }, directive: "Fixture", deltaRefIds: []
  }), now, { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) });
  const parallel = projectTaskExecution({ ...base, inputRequests: [input], runs: [run], runDelivery: { "run-1": "accepted" } });
  assert.equal(parallel.status, "waiting-user");
  assert.equal(parallel.activeRuns.length, 1);
  assert.equal(parallel.activity.jobs.running, 1);
  const accepted = createTaskEvent("event-1", task.id, "runtime.observation",
    runtimeObservationTaskEventPayload(createRuntimeObservation({
      schemaVersion: 1, eventId: "fixture-accepted", semanticKey: "fixture-accepted",
      kind: "turn.accepted", authority: "provider-structured", receivedAt: now.toISOString(),
      fence: { taskId: task.id, roleName: role.name, agentId: "codex", driverId: "openai/codex",
        nativeSessionId: "fixture", conversationId: "fixture", nativeTurnId: "turn-1",
        receiptId: "attempt-1", runId: run.id }, payload: {}
    })), now);
  assert.equal(projectTaskExecution({ ...base, runs: [run], events: [accepted] }).activeRuns[0].delivery, "accepted");
  const unknown = projectTaskExecution({ ...base, jobs: [{ id: "job-1", status: "unknown-needs-attention" }] });
  assert.equal(unknown.status, "attention");
  assert.equal(unknown.failClosed, true);
  assert.equal(unknown.activity.jobs.unknown, 1);
  assert.equal(projectTaskExecution({ ...base, jobs: [{ id: "job-1", status: "succeeded" }] }).reason, "no-executor");
  const native = {
    counts: { active: 0, quiet: 0, waiting: 0, unknown: 0, diagnostic: 0 },
    sessions: [{ roleName: "leader", group: "background", background: [{ id: "child", execution: "unknown" }] }]
  };
  assert.equal(projectTaskExecution({ ...base, nativeSessions: native }).status, "attention");
  assert.equal(projectTaskExecution({ ...base, nativeSessions: {
    ...native, counts: { ...native.counts, waiting: 1 },
    sessions: [{ roleName: "leader", group: "waiting", waitingReason: "permission", background: [] }]
  } }).status, "waiting-user");
  assert.equal(projectTaskExecution({ ...base, nativeSessions: {
    ...native, counts: { ...native.counts, active: 1 },
    sessions: [{ roleName: "leader", group: "active", background: [] }]
  } }).status, "working");
});

test("current Context discovery agrees with totals beyond the sample/query caps and converges after terminal changes", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-current-activity-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-10-12T00:00:00Z");
  store.saveTask(activateTask(createTask("task-1", "Discover current work", now), now));
  store.saveTask(createTask("task-2", "Other Task", now));
  for (let i = 1; i <= 67; i++) {
    const role = createRole("task-1", `worker-${i}`, [createRoleAgentBinding({ id: "codex", adapterId: "codex" })], "codex", home, now);
    store.saveRole("task-1", role);
    const run = createFixtureRun(store, `run-${i}`, "task-1", role.name, "new", createRunInput({
      source: { type: "yui", channel: "task-dispatch" }, directive: "Fixture", deltaRefIds: []
    }), now, { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) });
    store.saveRun(run);
    store.saveDurableJob("task-1", createDurableJob({
      id: `job-${i}`, taskId: "task-1", owner: { kind: "task" }, projectId: "project-1",
      head: "a".repeat(40), workspace: home, env: {}, steps: [{ name: "fixture", command: "true" }],
      artifactsLocator: `artifacts/job-${i}`,
      operation: { requestId: `fixture-${i}`, actorId: "fixture", authorityRef: "fixture", inputDigest: "b".repeat(64) }
    }, now));
    store.saveInputRequest("task-1", createInputRequest(`input-${i}`, "task-1",
      { taskId: "task-1", roleName: "leader", agentId: "codex", nativeSessionId: "fixture" },
      { question: `Choose ${i}`, choices: [], blockedRefs: [] }, now));
  }
  const context = readTaskContext(store, "task-1");
  assert.ok(Buffer.byteLength(JSON.stringify(context)) < 32768);
  for (const family of ["run", "job", "input-request", "role"]) {
    const count = context.collections.find(item => item.store === family);
    assert.equal(count.total, 67);
    assert.ok(count.returned <= 8);
    const ids = [];
    let cursor;
    do {
      const page = listTaskContext(store, "task-1", family, { view: "current", limit: 20, cursor });
      assert.equal(page.total, count.total);
      assert.ok(page.items.length <= 20);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32768);
      ids.push(...page.items.map(item => item.ref.refId));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 67);
    assert.equal(new Set(ids).size, 67);
  }
  const first = listTaskContext(store, "task-1", "job", { view: "current" });
  const running = startDurableJob(store.getDurableJob("task-1", "job-1"), { pid: 1, startIdentity: "fixture-only" }, now);
  store.saveDurableJob("task-1", running);
  store.saveDurableJob("task-1", completeDurableJob(running, {
    outcome: "succeeded", exitCode: 0, signal: null, steps: []
  }, now));
  store.saveRun(completeRun(store.getRun("task-1", "run-1"), "Fixture result", now));
  store.saveInputRequest("task-1", cancelInputRequest(store.getInputRequest("task-1", "input-1"), "Fixture", now));
  assert.throws(() => listTaskContext(store, "task-1", "job", { view: "current", cursor: first.nextCursor }), /changed/);
  assert.throws(() => listTaskContext(store, "task-2", "job", { view: "current", cursor: first.nextCursor }), /cursor|scope/);
  for (const family of ["job", "run", "input-request"]) {
    assert.equal(listTaskContext(store, "task-1", family, { view: "current" }).total, 66);
    assert.equal(listTaskContext(store, "task-1", family).total, 67, "terminal history remains discoverable");
  }
});
