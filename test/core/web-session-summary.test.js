import assert from "node:assert/strict";
import test from "node:test";
import { projectWebSessions } from "../../dist/web/webSessions.js";
import { createRuntimeObservation, runtimeObservationTaskEventPayload } from "../../dist/runtime/runtimeObservation.js";
import { createProviderRuntimeBinding, beginProviderTurn, acceptProviderTurn, settleProviderTurn } from "../../dist/runtime/providerRuntimeIdentity.js";
import { recordProviderFailure, admitProviderRetry } from "../../dist/runtime/providerRetry.js";
import { readWebTaskActivity } from "../../dist/web/webTaskActivity.js";
import { nativeActivityRows } from "../../dist/web/webTaskActivity.js";
import { projectTaskExecution } from "../../dist/scheduler/taskExecutionProjection.js";

const at = n => new Date(Date.parse("2026-09-13T00:00:00Z") + n * 1000).toISOString();
const set = (status = "accepted") => ({
  owner: { scope: "task", taskId: "task-1", roleName: "leader" }, activeAgentId: "codex",
  sessions: { codex: { agentId: "codex", adapterId: "codex", nativeSessionId: "session-1",
    status: "active", createdAt: at(0), updatedAt: at(1) } },
  providerBinding: { providerNamespace: "openai/codex", accountScope: "codex", currentConversationEpoch: 1,
    conversations: [{ conversationId: "session-1", epoch: 1, status: "current" }],
    run: { attemptId: "notification-2", nativeTurnId: "turn-2", authorityEpoch: 1,
      status, submittedAt: at(10), updatedAt: at(10) } }
});
let id = 0;
function event(kind, n, payload = {}, fence = {}) {
  const observation = createRuntimeObservation({
    schemaVersion: 1, eventId: `web-${++id}`, semanticKey: `web-${id}`,
    kind, authority: kind === "host.observed" ? "host" : "provider-structured", receivedAt: at(n),
    fence: { taskId: "task-1", roleName: "leader", agentId: "codex", driverId: "openai/codex",
      nativeSessionId: "session-1", conversationId: "session-1", nativeTurnId: "turn-2", receiptId: "notification-2", ...fence },
    payload: kind === "activity.observed" ? { activityId: "activity-" + id, ...payload } : payload
  });
  return { id: `event-${id}`, taskId: "task-1", type: "runtime.observation", createdAt: at(n),
    payload: runtimeObservationTaskEventPayload(observation) };
}
const project = (sets, events, seconds = 30) => projectWebSessions({
  taskId: "task-1", sessionSets: sets, events, now: new Date(at(seconds)),
  semanticProgressAt: at(0)
});

test("an exactly observed ready Session without a submitted Turn is idle, not unknown work", () => {
  const current = set();
  current.providerBinding.run = null;
  const sessionFence = { nativeTurnId: undefined, receiptId: undefined };
  const ready = event("session.ready", 2, {}, sessionFence);
  const native = project([current], [ready]);
  assert.equal(native.counts.idle, 1);
  assert.equal(nativeActivityRows(native).length, 0);
  const execution = jobs => projectTaskExecution({
    task: { id: "task-1", status: "active", executionGate: { state: "enabled" } },
    roles: [], runs: [], jobs, nativeSessions: native, now: new Date(at(30))
  });
  assert.equal(execution([{ id: "job-1", status: "running" }]).status, "waiting-on-jobs");
  assert.notEqual(execution([]).status, "attention");
  assert.equal(project([current], []).counts.unknown, 1, "missing readiness is not empty execution");
  assert.equal(project([current], [event("session.ready", 2, {}, {
    ...sessionFence, nativeSessionId: "another-session"
  })]).counts.unknown, 1, "another Session cannot supply readiness");
  const goal = { ...current, providerBinding: { ...current.providerBinding, goal: { status: "active" } } };
  assert.equal(project([goal], [ready]).counts.unknown, 1, "an active Goal is not proven idle");
  assert.equal(project([current], [ready, event("host.observed", 3,
    { alive: false }, sessionFence)]).counts.unknown, 1);
});

test("empty selected Sessions do not invent execution and retained children keep one original Run identity", () => {
  const empty = { ...set(), sessions: {}, providerBinding: null };
  const native = project([empty], []);
  assert.equal(native.sessions.length, 0);
  assert.equal(projectTaskExecution({
    task: { id: "task-1", status: "active", executionGate: { state: "enabled" } },
    roles: [], runs: [], jobs: [{ id: "job-1", status: "running" }], nativeSessions: native,
    now: new Date(at(30))
  }).status, "waiting-on-jobs");
  assert.equal(project([{ ...empty, providerBinding: set().providerBinding }], []).counts.unknown, 1,
    "real input with missing Session remains unknown");

  const fence = { runId: "run-1", nativeTurnId: "turn-1", receiptId: "attempt-1" };
  const events = [
    event("operation.started", 8, { operation: "subagent", operationId: "child-1" }, fence),
    event("continuation.started", 8, { execution: "active", outcome: "pending",
      attachment: "attached", observationQuality: "exact", mayWriteWorkspace: true },
      { ...fence, continuationId: "child-1" })
  ];
  const current = set("completed");
  current.providerBinding.run.runId = "run-2";
  for (const selected of [current, empty]) {
    const rows = nativeActivityRows(project([selected], events)).filter(row => row.kind === "background");
    assert.equal(rows.length, 1, "operation and continuation describe one child");
    assert.equal(rows[0].runId, "run-1", "never borrow the selected Turn's Run");
  }
  const operationOnly = nativeActivityRows(project([current], events.slice(0, 1)))
    .filter(row => row.kind === "background");
  assert.equal(operationOnly.length, 1);
  assert.equal(operationOnly[0].runId, "run-1");
  const otherRun = event("operation.started", 9, { operation: "subagent", operationId: "child-1" },
    { ...fence, runId: "run-3" });
  assert.equal(nativeActivityRows(project([current], [...events, otherRun]))
    .filter(row => row.kind === "background").length, 2, "same child ID in a different Run is distinct");
});

test("Web counts a direct native Turn once and never borrows a prior Turn or Session's activity", () => {
  const events = [
    event("turn.completed", 9, {}, { nativeTurnId: "turn-1", receiptId: "notification-1" }),
    event("operation.started", 11, { operation: "tool", operationId: "old" },
      { nativeTurnId: "turn-1", receiptId: "notification-1" }),
    event("activity.observed", 12, { activity: "model" }, { nativeSessionId: "replaced" })
  ];
  const quiet = project([set()], events);
  assert.equal(quiet.sessions.length, 1);
  assert.equal(quiet.counts.quiet, 1);
  assert.equal(quiet.sessions[0].lastActivityAt, null);
  const active = project([set(), set()], [...events, event("activity.observed", 15, { activity: "model" })]);
  assert.equal(active.sessions.length, 1);
  assert.equal(active.counts.active, 1);
  assert.equal(active.sessions[0].semanticProgressAt, at(0), "activity is not Task progress");
  const duplicateOwner = { ...set(), owner: { scope: "task", taskId: "task-1", roleName: "worker" } };
  assert.equal(project([set(), duplicateOwner], events).counts.unknown, 1);
  assert.equal(project([set()], events, 3600).counts.diagnostic, 1);
});

test("Web keeps waiting, missing observation, current failure and unsettled children distinct", () => {
  const wait = event("turn.waiting", 11, { reason: "user", waitId: "input-1" });
  assert.equal(project([set()], [wait]).counts.waiting, 1);
  assert.equal(project([set()], [wait]).sessions[0].waitingReason, "user");
  const missing = set();
  missing.providerBinding = null;
  assert.equal(project([missing], []).counts.unknown, 1);
  assert.equal(project([set("failed")], []).counts.stopped, 1);
  assert.equal(project([set("completed")], []).counts.idle, 1);
  assert.equal(project([set()], [event("host.observed", 11, { alive: false },
    { nativeTurnId: undefined, receiptId: undefined })]).counts.stopped, 1);
  const child = event("continuation.started", 8, {
    execution: "unknown", outcome: "unknown",
    attachment: "detached", observationQuality: "partial", mayWriteWorkspace: true, identityConflict: false
  }, { nativeTurnId: "turn-1", receiptId: "notification-1", runId: "run-1", continuationId: "child-1" });
  const result = project([set("completed")], [child]);
  assert.equal(result.counts.background, 1);
  assert.equal(result.sessions[0].background[0].execution, "unknown");
  const replacedChild = event("continuation.started", 8, {
    execution: "active", outcome: "pending", attachment: "detached",
    observationQuality: "exact", mayWriteWorkspace: true, identityConflict: false
  }, { nativeSessionId: "replaced-session", continuationId: "retained-child" });
  const retained = project([set("completed")], [replacedChild]);
  assert.equal(retained.sessions.length, 2);
  assert.equal(retained.sessions[1].nativeSessionId, "replaced-session");
  assert.equal(retained.counts.background, 1, "a selected Session cannot hide an older recorded unsettled child");
  assert.equal(project([missing], [child]).sessions.length, 1, "missing foreground binding does not duplicate a native Session");
  assert.equal(project([missing], [child]).sessions[0].background.length, 1);
  const foreignChild = { ...replacedChild, taskId: "task-2" };
  assert.equal(project([set("completed")], [foreignChild]).counts.background, 0);
  const operation = event("operation.started", 8, { operation: "subagent", operationId: "child-operation" });
  assert.equal(project([set("completed")], [operation, event("turn.completed", 9)]).counts.background, 1);
});

test("Web preserves Controller-owned retry waiting and observes only its exact successor input", () => {
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: "session-1", startedAt: at(0)
  });
  binding = beginProviderTurn(binding, {
    attemptId: "notification-2", authorityEpoch: 1, submittedAt: at(10),
    input: { kind: "wake", taskId: "task-1", wakeId: "wake-1" }, retrySupported: true
  });
  binding = acceptProviderTurn(binding, {
    attemptId: "notification-2", nativeTurnId: "turn-2", acceptedAt: at(10)
  });
  binding = settleProviderTurn(binding, {
    attemptId: "notification-2", nativeTurnId: "turn-2", status: "failed", settledAt: at(11)
  });
  binding = recordProviderFailure(binding, {
    error: { source: "provider", phase: "turn-execute", category: "rate-limit", code: "provider.rate-limit",
      message: "Too many requests", raw: "fixture 429", inputDisposition: "accepted", sessionDisposition: "recoverable", retryable: true },
    failureRef: "event-1", at: Date.parse(at(11)), random: () => 0
  });
  const waiting = project([{ ...set(), providerBinding: binding }], []);
  assert.equal(waiting.counts.waiting, 1, "a bounded automatic retry is not a stopped Session or user approval");
  assert.match(waiting.sessions[0].reason, /retry/i);
  const old = event("turn.failed", 12, { failure: { error: binding.run.failure.error } });
  const retryAt = binding.retry.nextEligibleAt;
  binding = admitProviderRetry(binding, { attemptId: "retry-1", at: Date.parse(retryAt) });
  binding = beginProviderTurn(binding, { attemptId: "retry-1", authorityEpoch: 1, submittedAt: retryAt });
  binding = acceptProviderTurn(binding, { attemptId: "retry-1", nativeTurnId: "retry-turn", acceptedAt: retryAt });
  const active = event("activity.observed", 15, { activity: "model" },
    { receiptId: "retry-1", nativeTurnId: "retry-turn" });
  assert.equal(project([{ ...set(), providerBinding: binding }], [old, active]).counts.active, 1);
  const unknown = { ...binding, run: { ...binding.run, status: "delivery-unknown" } };
  assert.equal(project([{ ...set(), providerBinding: unknown }], [old, active]).counts.unknown, 1);
});

test("native activity pages discover every recorded child and Session, fence Tasks, and reject stale membership", () => {
  const sets = Array.from({ length: 19 }, (_, i) => {
    const value = set();
    return { ...value, owner: { ...value.owner, roleName: i ? `worker-${i}` : "leader" },
      sessions: { codex: { ...value.sessions.codex, nativeSessionId: `session-${i + 1}` } },
      providerBinding: { ...value.providerBinding, conversations: [
        { conversationId: `session-${i + 1}`, epoch: 1, status: "current" }
      ] } };
  });
  const events = Array.from({ length: 23 }, (_, i) => event("continuation.started", 11, {
    execution: "active", outcome: "pending", attachment: "detached",
    observationQuality: "exact", mayWriteWorkspace: false, identityConflict: false
  }, { continuationId: `child-${i}` }));
  const foreign = { ...set(), owner: { scope: "task", taskId: "task-2", roleName: "foreign" } };
  const store = {
    readTransaction: read => read(store), getTask: () => ({}), getConfig: () => ({}),
    listRoleSessionSets: () => [...sets, foreign], listEvents: () => events
  };
  const first = readWebTaskActivity(store, "task-1", { limit: 16 }, new Date(at(30)));
  assert.equal(first.total, 42);
  assert.deepEqual(first.counts, { sessions: 19, operations: 0, background: 23 });
  assert.equal(first.coverage, "partial");
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 32768);
  const ids = first.items.map(item => item.id);
  let cursor = first.nextCursor;
  while (cursor) {
    const page = readWebTaskActivity(store, "task-1", { limit: 16, cursor }, new Date(at(31)));
    ids.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
  }
  assert.equal(ids.length, 42);
  assert.equal(new Set(ids).size, 42);
  assert.throws(() => readWebTaskActivity(store, "task-2", { cursor: first.nextCursor }, new Date(at(30))), /source|scope|cursor/);
  events.push(event("continuation.settled", 12, {
    execution: "quiescent", outcome: "succeeded", attachment: "detached",
    observationQuality: "exact", mayWriteWorkspace: false, identityConflict: false
  }, { continuationId: "child-0" }));
  assert.throws(() => readWebTaskActivity(store, "task-1", { cursor: first.nextCursor }, new Date(at(30))), /changed/);
  assert.equal(readWebTaskActivity(store, "task-1", {}, new Date(at(30))).total, 41);
});
