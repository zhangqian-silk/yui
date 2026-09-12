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
  bindGlobalRoleProviderRuntime, createRoleSessionSet, recordRoleAgentSession,
  rememberRoleAgentCompletedTurn, updateGlobalRoleProviderRuntime
} from "../../dist/executor/agentExecutor.js";
import {
  acceptProviderTurn, beginProviderTurn, createProviderRuntimeBinding,
  markProviderTurnDeliveryUnknown, settleProviderTurn, transferProviderAuthority
} from "../../dist/runtime/providerRuntimeIdentity.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";
import { recordGlobalInterruptResult } from "../../dist/message/globalInterrupt.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { deliverGlobalInputs } from "../../dist/controller/globalInputDelivery.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { createRuntimeObservation } from "../../dist/runtime/runtimeObservation.js";

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

test("an unmanaged Global Session without a binding cannot fabricate an active Turn", t => {
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
  assert.equal(result.receiptId, "interrupt:assistant/cancel:t-1");
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
  const replay = command(["message", "queue", "assistant", "Do this next", "--request-id", "gq-1"]);
  assert.equal(replay.delivery.state, "idempotent-replay");
  assert.equal(replay.message.id, queued.message.id);
  assert.equal(store.listGlobalRoleMessages("assistant").length, 1);
  recordGlobalInterruptResult(store, "assistant", result.receiptId,
    { state: "interrupt-unavailable", outcome: "rejected" });
  const retry = command(["interrupt", "assistant", "--expected-target", "t-1",
    "--then-message", queued.message.id, "--request-id", "retry-after-rejection"]);
  assert.equal(retry.kind, "input-interrupt");
  assert.equal(store.listGlobalRoleMessages("assistant").length, 1);
});

test("global interrupt --then-message rejects a ref that is not an owned durable Global Message", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  assert.throws(() => command(["interrupt", "assistant", "--expected-target", "t-1",
    "--then-message", "global-message-999"]), /not a durable Global Message/);
});

// ── the managed self-read that delivers the durable queue (decision-3 §4/§9) ───

/** The env a managed Global Role presents when it reads its own Context — the one
 * authorized self-read that consumes its durable queue at its next legal
 * opportunity. An inspection read (no env) never delivers. */
function selfReadEnv(roleName) {
  return {
    YUI_SESSION_SCOPE: "global", YUI_ROLE: roleName,
    YUI_SESSION_MANIFEST: `/tmp/${roleName}-manifest.json`
  };
}

function contextSelfRead(store, roleName) {
  return JSON.parse(runGlobalRoleCommand(
    ["context", roleName], store, { env: selfReadEnv(roleName), jsonOutput: true }));
}

// ── Bug-2: the corrected queue contract — no mark-delivered while busy ─────────

test("an idle self-read exposes intent but never fabricates a Provider receipt", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  command(["message", "queue", "assistant", "First", "--request-id", "gq-1"]);
  command(["message", "queue", "assistant", "Second", "--request-id", "gq-2"]);
  // No live Turn: an idle self-read is the Role's real next legal opportunity, so
  // both queued Messages are delivered in order.
  const first = contextSelfRead(store, "assistant");
  assert.deepEqual(first.pendingMessages.map(m => m.id), ["global-message-1", "global-message-2"]);
  const delivered = store.listGlobalRoleMessages("assistant").filter(m => m.delivery !== undefined);
  assert.equal(delivered.length, 0);
  // A repeated self-read is idempotent: the consumed queue is not re-delivered.
  const second = contextSelfRead(store, "assistant");
  assert.deepEqual(second.pendingMessages, first.pendingMessages);
});

test("a self-read while the Role's own native Turn is in flight delivers nothing (busy-gate)", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  command(["message", "queue", "assistant", "Do this later", "--request-id", "gq-1"]);
  // The Role is mid-turn (accepted, in flight). Marking the queue delivered now
  // would filter it out of the next loaded context and lose it (§6/§11): the
  // busy-gate holds it undelivered until a read finds no in-flight Turn.
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const busy = contextSelfRead(store, "assistant");
  assert.deepEqual(busy.pendingMessages.map(m => m.id), ["global-message-1"]);
  assert.equal(store.listGlobalRoleMessages("assistant").every(m => m.delivery === undefined), true);
  // The Message is neither delivered nor failed: it is held for the next legal turn.
  assert.equal(store.listGlobalRoleMessages("assistant")[0].notDelivered ?? null, null);
});

test("an inspection read never delivers the queue and reports it still pending", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  command(["message", "queue", "assistant", "Waiting", "--request-id", "gq-1"]);
  // No Session env: an unmanaged/inspection read observes but never consumes.
  const inspect = JSON.parse(runGlobalRoleCommand(
    ["context", "assistant"], store, { env: {}, jsonOutput: true }));
  assert.deepEqual(inspect.pendingMessages.map(m => m.id), ["global-message-1"]);
  assert.equal(store.listGlobalRoleMessages("assistant")[0].delivery ?? null, null);
});

// ── Bug-3: then-gate — no quiescence inferred from a new Turn (decision-3 §4/§8) ─

test("a then-handoff holds the whole queue while its interrupted Turn is still in flight", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const queued = command(["message", "queue", "assistant", "After the stop", "--request-id", "gq-1"]);
  command(["interrupt", "assistant", "--expected-target", "t-1",
    "--then-message", queued.message.id, "--request-id", "int-1"]);
  // The interrupted Turn t-1 is still the live accepted Turn: requested != stopped.
  // The handoff waits AND holds the ordinary queue behind it, so nothing delivers.
  const held = contextSelfRead(store, "assistant");
  assert.deepEqual(held.pendingMessages.map(m => m.id), [queued.message.id]);
  assert.equal(store.listGlobalRoleMessages("assistant")[0].delivery ?? null, null);
});

test("a terminal fact does not make a Context read deliver the then input", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const queued = command(["message", "queue", "assistant", "After the stop", "--request-id", "gq-1"]);
  command(["interrupt", "assistant", "--expected-target", "t-1",
    "--then-message", queued.message.id, "--request-id", "int-1"]);
  // The real Provider Stop hook observes the exact interrupted native Turn
  // terminate. This is the production edge: it settles the live binding AND
  // records the durable native terminal on the Role's own Session.
  const adapter = new FileSchedulerStoreAdapter(store);
  adapter.observeGlobalRuntimeRunTerminal({
    roleName: "assistant", agentId: role.activeAgentId, adapterId: "codex",
    nativeSessionId: "assistant-native", nativeTurnId: "t-1",
    providerStatus: "completed", outcome: { status: "completed", output: "stopped" }
  }, new Date("2026-09-11T00:02:00Z"));
  // Now the handoff's interrupted Turn has a proven terminal, so the then-Message
  // is released ahead of the ordinary queue in its own read (M before Q1).
  const released = contextSelfRead(store, "assistant");
  assert.deepEqual(released.pendingMessages.map(m => m.id), [queued.message.id]);
  const handoff = store.listGlobalRoleMessages("assistant").find(m => m.id === queued.message.id);
  assert.equal(handoff.delivery ?? null, null);
});

test("Context inspection never mutates a handoff whose interrupted Turn vanished", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const queued = command(["message", "queue", "assistant", "After the stop", "--request-id", "gq-1"]);
  command(["interrupt", "assistant", "--expected-target", "t-1",
    "--then-message", queued.message.id, "--request-id", "int-1"]);
  const alsoQueued = command(["message", "queue", "assistant", "Ordinary", "--request-id", "gq-2"]);
  // Drop the live binding without ever recording a durable native terminal for
  // t-1: the interrupted Turn's stop is now unobservable. The claim can never
  // prove a safe boundary, so it fails visibly (never released, never replayed)
  // and, once failed, stops holding the ordinary queue (§4/§8).
  const sessions = store.getGlobalRoleSessionSet("assistant");
  store.saveGlobalRoleSessionSet({ ...sessions, providerBinding: null });
  const drained = contextSelfRead(store, "assistant");
  const handoff = store.listGlobalRoleMessages("assistant").find(m => m.id === queued.message.id);
  assert.equal(handoff.notDelivered, undefined);
  assert.equal(handoff.delivery ?? null, null);
  // The ordinary queue behind the now-failed handoff drains at the same read.
  assert.deepEqual(drained.pendingMessages.map(m => m.id), [queued.message.id, alsoQueued.message.id]);
});

test("a then-handoff persists its interrupted native Turn id for the durable fallback", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const queued = command(["message", "queue", "assistant", "After the stop", "--request-id", "gq-1"]);
  command(["interrupt", "assistant", "--expected-target", "t-1",
    "--then-message", queued.message.id, "--request-id", "int-1"]);
  const claim = store.listGlobalRoleMessages("assistant").find(m => m.id === queued.message.id);
  // The claim captures BOTH ids from the resolved target: the attemptId (primary
  // live proof) and the nativeTurnId (durable recentCompletedTurnIds fallback).
  assert.equal(claim.interruptThen.targetAttemptId, "a-1");
  assert.equal(claim.interruptThen.targetNativeTurnId, "t-1");
});

/** Advance the Role's binding onto a live replacement Turn: settle the current
 * accepted Turn, then begin+accept a new one. The binding now holds a *different*
 * live native Turn than the interrupted target — the §4/§8 hazard where a new
 * Turn's mere existence must never be read as the old Turn having stopped. */
function withGlobalReplacementTurn(store, roleName, settle, next) {
  const settled = settleProviderTurn(store.getGlobalRoleSessionSet(roleName).providerBinding, {
    nativeTurnId: settle.nativeTurnId, status: "completed",
    settledAt: new Date("2026-09-11T00:03:00Z").toISOString()
  });
  let binding = beginProviderTurn(settled, {
    attemptId: next.attemptId, authorityEpoch: 1,
    submittedAt: new Date("2026-09-11T00:03:01Z").toISOString()
  });
  binding = acceptProviderTurn(binding, {
    attemptId: next.attemptId, nativeTurnId: next.nativeTurnId,
    acceptedAt: new Date("2026-09-11T00:03:02Z").toISOString()
  });
  store.saveGlobalRoleSessionSet(updateGlobalRoleProviderRuntime(
    store.getGlobalRoleSessionSet(roleName), binding, new Date("2026-09-11T00:03:02Z")));
}

test("a replacement Turn's existence never releases a handoff without the durable terminal", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const queued = command(["message", "queue", "assistant", "After the stop", "--request-id", "gq-1"]);
  command(["interrupt", "assistant", "--expected-target", "t-1",
    "--then-message", queued.message.id, "--request-id", "int-1"]);
  // A NEW native Turn t-2 becomes live. The binding no longer holds t-1, and no
  // durable terminal for t-1 was recorded. decision-3 §4/§8: "requested != stopped"
  // and native quiescence is never inferred from a replacement Turn's existence.
  // The claim's stop is unobservable → it fails visibly, never released.
  withGlobalReplacementTurn(store, "assistant", { nativeTurnId: "t-1" }, { attemptId: "a-2", nativeTurnId: "t-2" });
  contextSelfRead(store, "assistant");
  const handoff = store.listGlobalRoleMessages("assistant").find(m => m.id === queued.message.id);
  assert.equal(handoff.notDelivered, undefined);
  assert.equal(handoff.delivery ?? null, null);
});

test("a historical native terminal cannot release a handoff through Context while another Turn is live", t => {
  const { store, command, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const queued = command(["message", "queue", "assistant", "After the stop", "--request-id", "gq-1"]);
  command(["interrupt", "assistant", "--expected-target", "t-1",
    "--then-message", queued.message.id, "--request-id", "int-1"]);
  // The interrupted Turn t-1 has a proven durable native terminal (the real Claude
  // Stop-hook fact on recentCompletedTurnIds), even though a later Turn t-2 is now
  // the live one. The durable terminal — not the live binding — proves t-1 stopped,
  // so the handoff releases. The gate reads the terminal by the claim's nativeTurnId.
  const withTerminal = rememberRoleAgentCompletedTurn(
    store.getGlobalRoleSessionSet("assistant"), role.activeAgentId, "assistant-native", "t-1",
    new Date("2026-09-11T00:02:30Z"));
  store.saveGlobalRoleSessionSet(withTerminal);
  withGlobalReplacementTurn(store, "assistant", { nativeTurnId: "t-1" }, { attemptId: "a-2", nativeTurnId: "t-2" });
  const released = contextSelfRead(store, "assistant");
  assert.deepEqual(released.pendingMessages.map(m => m.id), [queued.message.id]);
  const handoff = store.listGlobalRoleMessages("assistant").find(m => m.id === queued.message.id);
  assert.equal(handoff.delivery ?? null, null);
});


// ── Bug-1: the production terminal edge settles the live binding ───────────────

test("the Global runtime terminal settles a bound controller-owned Turn to terminal", t => {
  const { store, role } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-1", nativeTurnId: "t-1" });
  const adapter = new FileSchedulerStoreAdapter(store);
  adapter.observeGlobalRuntimeRunTerminal({
    roleName: "assistant", agentId: role.activeAgentId, adapterId: "codex",
    nativeSessionId: "assistant-native", nativeTurnId: "t-1",
    providerStatus: "completed", outcome: { status: "completed", output: "done" }
  }, new Date("2026-09-11T00:02:00Z"));
  const sessions = store.getGlobalRoleSessionSet("assistant");
  // Bug-1: the live binding's run is settled to the observed terminal, so the
  // scope-generic resolver and the then-gate see the real stop — not a run
  // wedged forever at "accepted".
  assert.equal(sessions.providerBinding.run.status, "completed");
  assert.equal(sessions.providerBinding.run.nativeTurnId, "t-1");
  // The durable native terminal is recorded on the Role's own Session as well.
  assert.equal(sessions.sessions[role.activeAgentId].recentCompletedTurnIds.includes("t-1"), true);
});

test("the Global runtime terminal is a strict no-op when no controller-owned Turn is bound", t => {
  const { store, role } = globalFixture(t);
  recordGlobalSession(store, role);
  // The honest unmanaged reality: no providerBinding, so nothing to settle. Only
  // the durable native terminal is recorded; no binding is fabricated.
  const adapter = new FileSchedulerStoreAdapter(store);
  adapter.observeGlobalRuntimeRunTerminal({
    roleName: "assistant", agentId: role.activeAgentId, adapterId: "codex",
    nativeSessionId: "assistant-native", nativeTurnId: "t-1",
    providerStatus: "completed", outcome: { status: "completed", output: "done" }
  }, new Date("2026-09-11T00:02:00Z"));
  const sessions = store.getGlobalRoleSessionSet("assistant");
  assert.equal(sessions.providerBinding ?? null, null);
  assert.equal(sessions.sessions[role.activeAgentId].recentCompletedTurnIds.includes("t-1"), true);
});

test("the Global runtime terminal leaves a non-matching bound Turn untouched", t => {
  const { store, role } = globalFixture(t);
  recordGlobalSession(store, role);
  // A different native Turn (t-2) is live; the terminal for t-1 must not settle it.
  withGlobalControllerTurn(store, "assistant", { attemptId: "a-2", nativeTurnId: "t-2" });
  const adapter = new FileSchedulerStoreAdapter(store);
  adapter.observeGlobalRuntimeRunTerminal({
    roleName: "assistant", agentId: role.activeAgentId, adapterId: "codex",
    nativeSessionId: "assistant-native", nativeTurnId: "t-1",
    providerStatus: "completed", outcome: { status: "completed", output: "done" }
  }, new Date("2026-09-11T00:02:00Z"));
  const sessions = store.getGlobalRoleSessionSet("assistant");
  // The live Turn t-2 is untouched (still accepted); only t-1's durable terminal lands.
  assert.equal(sessions.providerBinding.run.status, "accepted");
  assert.equal(sessions.providerBinding.run.nativeTurnId, "t-2");
  assert.equal(sessions.sessions[role.activeAgentId].recentCompletedTurnIds.includes("t-1"), true);
});

test("Global input authority precedes persistence and retired Sessions cannot impersonate the operator", t => {
  const { store, role } = globalFixture(t);
  recordGlobalSession(store, role);
  const args = ["message", "queue", "assistant", "Scoped input", "--request-id", "scoped"];
  assert.throws(() => runGlobalRoleCommand(args, store, { env: {
    YUI_SESSION_SCOPE: "task", YUI_ROLE: "leader", YUI_TASK_ID: "task-1"
  } }), /Session authority/);
  assert.throws(() => runGlobalRoleCommand(args, store, { env: {
    YUI_SESSION_SCOPE: "global", YUI_ROLE: "assistant", YUI_AGENT_ID: "codex",
    YUI_ADAPTER_ID: "codex", CODEX_THREAD_ID: "retired-session"
  } }), /current native caller Session/);
  assert.deepEqual(store.listGlobalRoleMessages("assistant"), []);
  runGlobalRoleCommand(args, store, { env: {
    YUI_SESSION_SCOPE: "global", YUI_ROLE: "assistant", YUI_AGENT_ID: "codex",
    YUI_ADAPTER_ID: "codex", CODEX_THREAD_ID: "assistant-native"
  } });
  assert.equal(store.listGlobalRoleMessages("assistant")[0].author.type, "agent");
});

test("Global queue pins reject Session replacement both before and during ensure", async t => {
  const { store, role, command } = globalFixture(t);
  recordGlobalSession(store, role);
  withGlobalControllerTurn(store, role.name, { attemptId: "old", nativeTurnId: "old-turn" });
  const binding = settleProviderTurn(store.getGlobalRoleSessionSet(role.name).providerBinding, {
    attemptId: "old", nativeTurnId: "old-turn", status: "completed", settledAt: later.toISOString()
  });
  store.saveGlobalRoleSessionSet(updateGlobalRoleProviderRuntime(store.getGlobalRoleSessionSet(role.name), binding, later));
  const queued = command(["message", "queue", role.name, "Never retarget", "--request-id", "pinned"]).message;
  const before = store.getGlobalRoleSessionSet(role.name);
  let ensureCalls = 0;
  await deliverGlobalInputs("/not-used", store, async () => {
    ensureCalls += 1;
    const current = store.getGlobalRoleSessionSet(role.name);
    store.saveGlobalRoleSessionSet({
      ...current, sessions: { ...current.sessions,
        codex: { ...current.sessions.codex, nativeSessionId: "replacement" } },
      providerBinding: createProviderRuntimeBinding({
        providerNamespace: "openai/codex", accountScope: "codex", conversationId: "replacement",
        startedAt: later.toISOString()
      })
    });
  }, error => { throw error; });
  assert.equal(ensureCalls, 1);
  const preserved = store.listGlobalRoleMessages(role.name).find(message => message.id === queued.id);
  assert.equal(preserved.deliveryTarget.nativeSessionId, before.sessions.codex.nativeSessionId);
  assert.equal(preserved.delivery, undefined);
  assert.equal(preserved.notDelivered.reason, "native-session-changed");
  await deliverGlobalInputs("/not-used", store, async () => { ensureCalls += 1; }, error => { throw error; });
  assert.equal(ensureCalls, 1);
});

test("Global unknown survives restart, late evidence settles it, and conclusive rejection remains visible", async t => {
  const { store, role, home, command } = globalFixture(t);
  recordGlobalSession(store, role);
  store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(store.getGlobalRoleSessionSet(role.name),
    createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
      conversationId: "assistant-native", startedAt: at.toISOString() }), at));
  const message = command(["message", "queue", role.name, "Only once", "--request-id", "unknown"]).message;
  const attemptId = `global-input:${role.name}/${message.id}`;
  const scheduler = new FileSchedulerStoreAdapter(store);
  scheduler.beginAgentHostProviderTurn({ roleName: role.name, agentId: "codex",
    nativeSessionId: "assistant-native", attemptId, authorityEpoch: 1, authorityOwner: "controller",
    holderId: "controller", now: later });
  scheduler.observeRuntimeObservation(createRuntimeObservation({
    schemaVersion: 4, eventId: "transport-only", semanticKey: "transport-only",
    kind: "turn.accepted", authority: "transport", receivedAt: later.toISOString(),
    observedAt: later.toISOString(), payload: {},
    fence: { roleName: role.name, agentId: "codex", driverId: "openai/codex",
      nativeSessionId: "assistant-native", conversationId: "assistant-native", receiptId: attemptId }
  }), later);
  assert.equal(store.getGlobalRoleSessionSet(role.name).providerBinding.run.status, "submitting");
  assert.equal(store.listGlobalRoleMessages(role.name)[0].delivery.via, "transport");
  scheduler.resolveAgentHostProviderTurnSubmission({ roleName: role.name, attemptId,
    status: "delivery-unknown", reason: "acknowledgement lost", raw: "acknowledgement lost", now: later });
  const reopened = new SqliteTaskStore(home);
  t.after(() => reopened.close());
  let calls = 0;
  await deliverGlobalInputs(home, reopened, async () => { calls += 1; }, error => { throw error; });
  assert.equal(calls, 0);
  const pending = reopened.listGlobalRoleMessages(role.name)[0];
  assert.equal(pending.control.outcome, "delivery-unknown");
  assert.equal(pending.delivery.via, "transport");
  const reloadedScheduler = new FileSchedulerStoreAdapter(reopened);
  const accepted = createRuntimeObservation({
    schemaVersion: 4, eventId: "late-global-receipt", semanticKey: "late-global-receipt",
    kind: "turn.accepted", authority: "provider-structured", receivedAt: later.toISOString(),
    observedAt: later.toISOString(), payload: {},
    fence: { roleName: role.name, agentId: "codex", driverId: "openai/codex",
      nativeSessionId: "assistant-native", conversationId: "assistant-native",
      nativeTurnId: "confirmed-turn", receiptId: attemptId }
  });
  assert.equal(reloadedScheduler.observeRuntimeObservation(accepted, later), "applied");
  assert.equal(reopened.listGlobalRoleMessages(role.name)[0].control.outcome, "accepted");
  assert.equal(reopened.listGlobalRoleMessages(role.name)[0].delivery.via, "provider");
  assert.equal(command(["message", "queue", role.name, "Only once", "--request-id", "unknown"]).delivery.state,
    "idempotent-replay");
  reloadedScheduler.observeRuntimeObservation(createRuntimeObservation({
    ...accepted, kind: "turn.completed", eventId: "known-terminal", semanticKey: "known-terminal",
    payload: { output: "done" }
  }), later);
  const rejected = command(["message", "queue", role.name, "Explicit rejection", "--request-id", "rejected"]).message;
  const rejectedAttempt = `global-input:${role.name}/${rejected.id}`;
  reloadedScheduler.beginAgentHostProviderTurn({ roleName: role.name, agentId: "codex",
    nativeSessionId: "assistant-native", attemptId: rejectedAttempt, authorityEpoch: 1,
    authorityOwner: "controller", holderId: "controller", now: later });
  reloadedScheduler.resolveAgentHostProviderTurnSubmission({ roleName: role.name, attemptId: rejectedAttempt,
    status: "rejected", reason: "Provider refused this input", raw: "Provider refused this input", now: later });
  const context = contextSelfRead(reopened, role.name);
  assert.equal(context.messages.find(entry => entry.id === rejected.id).notDelivered.reason, "Provider refused this input");
  assert.equal(context.messages.find(entry => entry.id === rejected.id).control.outcome, "rejected");
  await deliverGlobalInputs(home, reopened, async () => { calls += 1; }, error => { throw error; });
  assert.equal(calls, 0);
});

test("Global planner refuses live unmanaged Sessions instead of silently migrating them", t => {
  const { store, role, home } = globalFixture(t);
  recordGlobalSession(store, role);
  const planner = new FileRoleLaunchPlanner(home, store, { environment: { HOME: home, PATH: process.env.PATH } });
  const before = store.getGlobalRoleSessionSet(role.name);
  assert.throws(() => planner.planGlobalRole({
    roleName: role.name, agentId: "codex", adapterId: "codex", mode: "resume",
    nativeSessionId: "assistant-native"
  }), /unmanaged live Session/);
  assert.deepEqual(store.getGlobalRoleSessionSet(role.name), before);
});
