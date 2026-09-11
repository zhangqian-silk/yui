import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  bindGlobalRoleProviderRuntime, createRoleSessionSet, recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import {
  acceptProviderTurn, beginProviderTurn, createProviderRuntimeBinding,
  markProviderTurnDeliveryUnknown, transferProviderAuthority
} from "../../dist/runtime/providerRuntimeIdentity.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";

const at = new Date("2026-09-11T00:00:00Z");
const later = new Date("2026-09-11T00:01:00Z");

/**
 * A configured Global Role with an active native Session, so a live control can
 * be resolved against a real capability plan and writer fence — the Global twin
 * of the Task fixture. The Global Role uses its own real owner (the Role name)
 * and never a fabricated Task (decision-3 §9). `command` returns the structured
 * result: a control object as-is, or a parsed JSON disposition for the string
 * dispositions (queued / idempotent-replay / an explicit not-* failure).
 */
function globalFixture(t, adapterId = "codex") {
  const home = mkdtempSync(join(tmpdir(), "yui-global-input-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const agent = createConfiguredAgent(adapterId, adapterId, adapterId, [], [], at);
  store.saveConfiguredAgent(agent);
  const role = createGlobalRole("assistant", [createRoleAgentBinding(agent)], agent.id, home, at);
  store.createGlobalRoleIfAbsent(role);
  const command = (args) => {
    const result = runGlobalRoleCommand(args, store, { env: {}, jsonOutput: true });
    return typeof result === "string" ? JSON.parse(result) : result;
  };
  return { store, home, command, agent, role };
}

/** Record the Global Role's own active native Session (no live Provider yet). */
function recordGlobalSession(store, role, adapterId = "codex") {
  const set = recordRoleAgentSession(createRoleSessionSet(
    { scope: "global", roleName: role.name }, role.activeAgentId, at
  ), {
    agentId: role.activeAgentId, adapterId, nativeSessionId: `${role.name}-native`,
    policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  }, at);
  store.saveGlobalRoleSessionSet(set);
}

/**
 * Put the Global Role's Provider on an accepted (in-flight) native Turn the
 * Controller owns. This is the fake binding message-3 #6 requires: it exercises
 * the real resolver/target/fence chain deterministically without a real model,
 * standing in for the managed Global Host that does not populate one today.
 */
function withGlobalControllerTurn(store, roleName, { attemptId, nativeTurnId }) {
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: `${roleName}-native`, startedAt: at.toISOString()
  });
  binding = beginProviderTurn(binding, { attemptId, authorityEpoch: 1, submittedAt: at.toISOString() });
  binding = acceptProviderTurn(binding, { attemptId, nativeTurnId, acceptedAt: later.toISOString() });
  store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(
    store.getGlobalRoleSessionSet(roleName), binding, later));
  return binding;
}

/** Same in-flight Turn, but a human takeover holds the writer fence. */
function withGlobalHumanHeldTurn(store, roleName, { attemptId, nativeTurnId }) {
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: `${roleName}-native`, startedAt: at.toISOString()
  });
  binding = transferProviderAuthority(binding, {
    expectedEpoch: 1, expectedOwner: "controller", owner: "human",
    holderId: "human-1", changedAt: at.toISOString()
  });
  binding = beginProviderTurn(binding, { attemptId, authorityEpoch: 2, submittedAt: at.toISOString() });
  binding = acceptProviderTurn(binding, { attemptId, nativeTurnId, acceptedAt: later.toISOString() });
  store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(
    store.getGlobalRoleSessionSet(roleName), binding, later));
}

/** The Global Role's Provider on an unconfirmed-delivery native Turn (submitted,
 * never `accepted`) — the exact state separated from a clean active Turn. */
function withGlobalUnconfirmedTurn(store, roleName, { attemptId, unknown = false }) {
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: `${roleName}-native`, startedAt: at.toISOString()
  });
  binding = beginProviderTurn(binding, { attemptId, authorityEpoch: 1, submittedAt: at.toISOString() });
  if (unknown) {
    binding = markProviderTurnDeliveryUnknown(binding, {
      attemptId, observedAt: later.toISOString(), reason: "transport-dropped" });
  }
  store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(
    store.getGlobalRoleSessionSet(roleName), binding, later));
}

// ── queue: durable owner-keyed store, no fabrication (decision-3 §11 L146) ─────

test("global queue persists a durable owner-keyed Message and never a live intent", t => {
  const { store, command } = globalFixture(t);
  const result = command(["message", "queue", "assistant", "Handle this when free", "--request-id", "gq-1"]);
  assert.equal(result.delivery.state, "queued");
  assert.equal(result.roleName, "assistant");
  // Persisted in the Global-owned store keyed by the Role name — an explicit
  // owner, never a Task and never a new private queue.
  const messages = store.listGlobalRoleMessages("assistant");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].roleName, "assistant");
  assert.equal(messages[0].id, "global-message-1");
  assert.equal(messages[0].inputControl.action, "queue");
  assert.equal(messages[0].inputControl.requestId, "gq-1");
  // The stored Message carries no taskId anywhere; its owner is the Role name.
  assert.equal("taskId" in messages[0], false);
});

test("global queue is idempotent by request id and rejects a conflicting reuse", t => {
  const { store, command } = globalFixture(t);
  command(["message", "queue", "assistant", "Same body", "--request-id", "gq-1"]);
  const replay = command(["message", "queue", "assistant", "Same body", "--request-id", "gq-1"]);
  assert.equal(replay.delivery.state, "idempotent-replay");
  assert.equal(store.listGlobalRoleMessages("assistant").filter(
    m => m.inputControl?.requestId === "gq-1").length, 1);
  assert.throws(() => command(["message", "queue", "assistant", "Different body", "--request-id", "gq-1"]),
    /different content/);
});

test("durable Global Messages survive a store reopen (fresh replay of the unified migration)", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-global-input-reopen-"));
  const store = new SqliteTaskStore(home);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], at);
  store.saveConfiguredAgent(agent);
  store.createGlobalRoleIfAbsent(
    createGlobalRole("assistant", [createRoleAgentBinding(agent)], agent.id, home, at));
  runGlobalRoleCommand(["message", "queue", "assistant", "First", "--request-id", "gq-1"], store, { env: {} });
  runGlobalRoleCommand(["message", "queue", "assistant", "Second", "--request-id", "gq-2"], store, { env: {} });
  store.close();
  const reopened = new SqliteTaskStore(home);
  t.after(() => { reopened.close(); rmSync(home, { recursive: true, force: true }); });
  const messages = reopened.listGlobalRoleMessages("assistant");
  assert.deepEqual(messages.map(m => m.id), ["global-message-1", "global-message-2"]);
  assert.equal(messages[0].inputControl.requestId, "gq-1");
});

// ── the honest live-Host residual (decision-3 §9) ─────────────────────────────

test("a Global Role Session set persists and reloads with an absent providerBinding", t => {
  const { store, role } = globalFixture(t);
  recordGlobalSession(store, role);
  const reloaded = store.getGlobalRoleSessionSet("assistant");
  // Legacy/real shape: no live Provider binding on the managed Global path today.
  assert.equal(reloaded.providerBinding ?? null, null);
  assert.equal(reloaded.sessions[role.activeAgentId].status, "active");
});

test("a real Global Role has no live providerBinding, so steer is NO_ACTIVE_TURN, never faked", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  // No providerBinding bound: the honest state of a managed Global Role today.
  const result = command(["message", "steer", "assistant", "Redirect now",
    "--request-id", "gs-1", "--expected-target", "t-1"]);
  assert.equal(result.steer.state, "not-steered");
  assert.equal(result.steer.code, "NO_ACTIVE_TURN");
  // Saved, never downgraded to a queue or a different action.
  assert.ok(store.listGlobalRoleMessages("assistant").some(
    m => m.id === result.message.id && m.inputControl.action === "steer"));
});

// ── steer: the shared resolver over a fake Global binding (message-3 #6) ───────

test("global steer resolves the exact current native Turn via a fake providerBinding", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const result = command(["message", "steer", "assistant", "Prefer approach B",
    "--request-id", "gs-1", "--expected-target", "t-1"]);
  assert.equal(result.kind, "input-steer");
  assert.equal(result.roleName, "assistant");
  assert.equal(result.target.nativeTurnId, "t-1");
  assert.equal(result.target.attemptId, "a-1");
  // A Global target carries no taskId — the resolver never fabricates one.
  assert.equal(result.target.taskId, undefined);
  assert.equal(result.receiptId, `steer:assistant/${result.messageId}`);
  // The Message is persisted before the live edge, so it survives a failed call.
  assert.ok(store.listGlobalRoleMessages("assistant").some(
    m => m.id === result.messageId && m.inputControl.action === "steer"));
});

test("global steer on a plan without native steering is saved and reported, never downgraded", t => {
  const { store, command, role } = globalFixture(t, "claude");
  recordGlobalSession(store, role, "claude");
  const result = command(["message", "steer", "assistant", "Redirect",
    "--request-id", "gs-1", "--expected-target", "t-1"]);
  assert.equal(result.steer.state, "not-steered");
  assert.equal(result.steer.code, "STEER_UNSUPPORTED");
  assert.ok(store.listGlobalRoleMessages("assistant").some(
    m => m.id === result.message.id && m.inputControl.action === "steer"));
});

test("global steer against a stale target is TARGET_CHANGED, never retargeted", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const result = command(["message", "steer", "assistant", "Redirect",
    "--request-id", "gs-1", "--expected-target", "t-OLD"]);
  assert.equal(result.steer.code, "TARGET_CHANGED");
});

test("global steer across a human writer fence is TARGET_CHANGED", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalHumanHeldTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const result = command(["message", "steer", "assistant", "Redirect",
    "--request-id", "gs-1", "--expected-target", "t-1"]);
  assert.equal(result.steer.code, "TARGET_CHANGED");
});

test("global steer against a still-submitting original Turn is DELIVERY_UNKNOWN, never a steer", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalUnconfirmedTurn(store, "assistant", { attemptId: "a-1" });
  const result = command(["message", "steer", "assistant", "Prefer approach B",
    "--request-id", "gs-1", "--expected-target", "a-1"]);
  assert.equal(result.steer.state, "not-steered");
  assert.equal(result.steer.code, "DELIVERY_UNKNOWN");
});

test("global steer is idempotent by request id", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const first = command(["message", "steer", "assistant", "Prefer approach B",
    "--request-id", "gs-1", "--expected-target", "t-1"]);
  assert.equal(first.kind, "input-steer");
  const replay = command(["message", "steer", "assistant", "Prefer approach B",
    "--request-id", "gs-1", "--expected-target", "t-1"]);
  assert.equal(replay.steer.state, "idempotent-replay");
  assert.equal(store.listGlobalRoleMessages("assistant").filter(
    m => m.inputControl?.requestId === "gs-1").length, 1);
});

// ── interrupt: native cancel only, explicit then, no fourth action ────────────

test("global interrupt resolves a native cancel via a fake providerBinding", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const result = command(["interrupt", "assistant", "--expected-target", "t-1"]);
  assert.equal(result.kind, "input-interrupt");
  assert.equal(result.roleName, "assistant");
  assert.equal(result.receiptId, "interrupt:assistant/a-1");
  assert.equal(result.thenMessageId, undefined);
  assert.equal(result.target.taskId, undefined);
});

test("global interrupt on an owned-process plan is INTERRUPT_UNSUPPORTED, never a kill", t => {
  const { command, role, store } = globalFixture(t, "claude");
  recordGlobalSession(store, role, "claude");
  const result = command(["interrupt", "assistant", "--expected-target", "t-1"]);
  assert.equal(result.interrupt.state, "not-interrupted");
  assert.equal(result.interrupt.code, "INTERRUPT_UNSUPPORTED");
});

test("global interrupt against a delivery-unknown original Turn is DELIVERY_UNKNOWN, never a guessed cancel", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalUnconfirmedTurn(store, "assistant", { attemptId: "a-1", unknown: true });
  const result = command(["interrupt", "assistant", "--expected-target", "a-1"]);
  assert.equal(result.interrupt.state, "not-interrupted");
  assert.equal(result.interrupt.code, "DELIVERY_UNKNOWN");
});

test("global interrupt --then-message names an already-persisted durable Global Message", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const queued = command(["message", "queue", "assistant", "Do this next", "--request-id", "gq-1"]);
  const result = command(["interrupt", "assistant", "--expected-target", "t-1",
    "--then-message", queued.message.id]);
  assert.equal(result.kind, "input-interrupt");
  // The ordered composition: an existing durable Global Message, not a fourth action.
  assert.equal(result.thenMessageId, queued.message.id);
});

test("global interrupt --then-message rejects a ref that is not an owned durable Global Message", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  assert.throws(() => command(["interrupt", "assistant", "--expected-target", "t-1",
    "--then-message", "global-message-999"]), /not a durable Global Message/);
});
