import assert from "node:assert/strict";
import test from "node:test";
import { recordGlobalRuntimeAttention, recordGlobalRuntimeRecovery, runtimeDiagnosticGroups }
  from "../../dist/controller/globalRuntimeAttention.js";

test("diagnostics coalesce across Turns, preserve evidence and distinguish impact and recovery", () => {
  const messages = [];
  const store = {
    listGlobalRoleMessages: role => messages.filter(message => message.roleName === role),
    queryGlobalRoleMessages: (role, query) => ({
      messages: messages.filter(message => message.roleName === role && message.inputControl?.requestId === query.requestId)
    }),
    getGlobalRole: () => ({}),
    getGlobalRoleSessionSet: () => null,
    nextGlobalRoleMessageId: () => `global-message-${messages.length + 1}`,
    saveGlobalRoleMessage: message => messages.push(message)
  };
  const now = new Date("2026-10-14T00:00:00Z");
  const facts = {
    nativeSessionId: "session-1", reason: "host-terminal-unobservable",
    cause: "host-control-rejected", endpointImplementation: "host-1",
    detail: "Unsupported reconcile-turn", confirmed: "accepted", unknown: "terminal"
  };
  const record = (id, changes = {}) => recordGlobalRuntimeAttention(store, "assistant", id,
    { ...facts, attemptId: id, ...changes }, now);
  record("turn-1");
  record("turn-1"); // Same observation must not inflate the occurrence count.
  record("turn-2");
  assert.equal(messages.filter(m => m.inputControl).length, 1);
  const groups = runtimeDiagnosticGroups(store.listGlobalRoleMessages("assistant"));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
  assert.ok(groups[0].firstEvidence !== groups[0].latestEvidence);
  record("turn-3", { cause: "host-control-unavailable" });
  record("turn-4", { confirmed: "delivery-unknown" });
  record("turn-5", { nativeSessionId: "session-2" });
  assert.equal(messages.filter(m => m.inputControl).length, 4);
  recordGlobalRuntimeRecovery(store, "assistant", "recovery-1",
    { nativeSessionId: "session-1", reason: "host-terminal-unobservable", evidence: "exact-terminal-republished" }, now);
  const before = messages.filter(m => m.inputControl).length;
  record("turn-6");
  assert.equal(messages.filter(m => m.inputControl).length, before + 1);
  assert.ok(runtimeDiagnosticGroups(store.listGlobalRoleMessages("assistant")).some(group => group.recoveredAt));
  recordGlobalRuntimeAttention(store, "operator", "operator-failure", facts, now);
  const selfNotice = messages.at(-1);
  assert.equal(selfNotice.roleName, "operator");
  assert.equal(selfNotice.inputControl.action, "queue");
  assert.ok(selfNotice.notDelivered, "Operator failure evidence must not enqueue its own execution.");
});
