import assert from "node:assert/strict";
import test from "node:test";
import { createHostSessionLifecycle } from "../../dist/runtime/hostSessionLifecycle.js";
import { createNonBlockingChecks } from "../../dist/runtime/lifecycleChecks.js";

const identity = { processInstanceId: "proxy-1", nativeSessionId: "thread-1" };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("Host lifecycle transitions are event/guard driven and reject stale or illegal facts", () => {
  const host = createHostSessionLifecycle();
  assert.equal(host.send({ type: "accepted", ...identity, attemptId: "not-submitted" }).status, "invalid");
  assert.equal(host.state, "idle");
  host.send({ type: "launch" });
  assert.equal(host.state, "starting");
  host.send({ type: "connected", ...identity, occupancy: "idle" });
  host.send({ type: "submit", ...identity, attemptId: "one" });
  host.send({ type: "accepted", ...identity, attemptId: "one", nativeTurnId: "turn-one" });
  assert.equal(host.state, "ready");
  assert.equal(host.send({ type: "terminal", ...identity, attemptId: "one", nativeTurnId: "old-turn" }).status, "ignored");
  assert.equal(host.send({ type: "terminal", ...identity, attemptId: "other" }).status, "ignored");
  assert.equal(host.state, "ready");
  host.send({ type: "terminal", ...identity, attemptId: "one", nativeTurnId: "turn-one" });
  assert.equal(host.state, "settling");
  host.send({ type: "settled", ...identity, occupancy: "idle" });
  assert.equal(host.state, "idle");
  host.send({ type: "disconnected", ...identity });
  host.send({ type: "connected", ...identity, processInstanceId: "proxy-2", occupancy: "busy" });
  assert.equal(host.state, "busy");
  assert.equal(host.send({ type: "failure", ...identity, outcome: "failed" }).status, "ignored");
  host.send({ type: "exit", ...identity, processInstanceId: "proxy-2" });
  assert.equal(host.state, "exited");
  assert.equal(host.send({ type: "native-started", ...identity }).status, "ignored");
  host.send({ type: "launch" });
  assert.equal(host.state, "starting", "A new authorized attachment uses an explicit launch event.");
  host.send({ type: "interactive-connected", nativeSessionId: "thread-2" });
  assert.equal(host.state, "ready", "Native TUI readiness is attachment readiness, not managed idle.");
  assert.equal(host.send({ type: "interactive-connected", nativeSessionId: "thread-2" }).status, "applied");
  assert.equal(host.state, "ready", "A duplicate attachment reply is a harmless self-transition.");
  host.send({ type: "exit" });
  assert.equal(host.send({ type: "interactive-connected", nativeSessionId: "thread-1" }).status, "ignored");
  host.send({ type: "launch" });
  host.send({ type: "failure", outcome: "failed", nativeSessionId: "missing-thread" });
  assert.equal(host.state, "failed", "A new launch failure cannot be hidden by a departed Session's identity.");
});

test("Lifecycle before/after checks cannot block, veto or mutate transitions; independent checks keep working", async () => {
  const seen = [], errors = [];
  const before = createNonBlockingChecks([
    { id: "hung", run: () => new Promise(() => {}) },
    { id: "broken", run: () => { throw new Error("check failed"); } }
  ], error => errors.push(error));
  const after = createNonBlockingChecks([
    { id: "observer", run: event => { seen.push(event); assert.ok(Object.isFrozen(event)); } }
  ]);
  const host = createHostSessionLifecycle({ before, after });
  host.send({ type: "launch" });
  host.send({ type: "connected", ...identity, occupancy: "idle" });
  assert.equal(host.state, "idle", "No check promise participates in state commitment.");
  await tick();
  assert.ok(seen.length > 0);
  assert.equal(seen.at(-1).to, "idle");
  assert.ok(errors.length > 0);
  for (let i = 0; i < 100; i++) {
    host.send({ type: "native-started", ...identity, nativeTurnId: `turn-${i}` });
    host.send({ type: "settled", ...identity, occupancy: "idle" });
  }
  await tick();
  assert.equal(host.state, "idle");
  assert.equal(before.pendingCount, 1, "A hung check retains only the latest coalesced observation.");
  before.close();
  after.close();
});
