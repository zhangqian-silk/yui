import assert from "node:assert/strict";
import test from "node:test";
import { projectWebSessions } from "../../dist/web/webSessions.js";
import { createRuntimeObservation, runtimeObservationTaskEventPayload } from "../../dist/runtime/runtimeObservation.js";
import { createProviderRuntimeBinding, beginProviderTurn, acceptProviderTurn, settleProviderTurn } from "../../dist/runtime/providerRuntimeIdentity.js";
import { recordProviderFailure, admitProviderRetry } from "../../dist/runtime/providerRetry.js";

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
    schemaVersion: 4, eventId: `web-${++id}`, semanticKey: `web-${id}`,
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
