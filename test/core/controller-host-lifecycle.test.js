import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHostLifecycle } from "../../dist/controller/hostLifecycle.js";
import { createNonBlockingChecks } from "../../dist/runtime/lifecycleChecks.js";
import { createHostSessionLifecycle } from "../../dist/runtime/hostSessionLifecycle.js";

const owner = { scope: "global", roleName: "operator" };
const request = { owner, mode: "resume", nativeSessionId: "thread", agentId: "a", adapterId: "codex" };
const binding = { id: "binding", owner, nativeSessionId: "thread", agentId: "a", adapterId: "codex", hostRef: "pane" };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let state = "stopped", starts = 0, stops = 0;
  const raw = {
    start: async () => { starts++; state = "running"; return binding; },
    restore: async () => raw.start(),
    stop: async () => { stops++; state = "stopped"; },
    stopOwner: async () => { stops++; state = "stopped"; return true; },
    inspect: async () => ({ state }),
    inspectOwner: async () => ({ state })
  };
  return { raw, setState: value => { state = value; }, get starts() { return starts; }, get stops() { return stops; } };
}

test("Controller Host FSM gates effects, correlates native identity, and recovers by observation without replay", async () => {
  const f = fixture(), transitions = [];
  const after = createNonBlockingChecks([{ id: "observer", run: value => transitions.push(value) }]);
  const hosts = createControllerHostLifecycle(f.raw, { after });
  assert.equal(hosts.snapshot(owner).state, "unavailable");
  await hosts.port.restore(request);
  assert.equal(hosts.snapshot(owner).state, "running");
  assert.equal(hosts.snapshot(owner).nativeSessionId, "thread");
  await tick();
  assert.equal(transitions.at(-1).event, "launched");
  const revision = hosts.snapshot(owner).revision;
  await hosts.port.inspectOwner(owner);
  await hosts.port.inspectOwner(owner);
  assert.equal(hosts.snapshot(owner).revision, revision, "Repeated observations must not create check feedback loops.");
  f.raw.inspect = async () => ({ state: "stopped" });
  await hosts.port.inspect({ ...binding, id: "retired-binding" });
  assert.equal(hosts.snapshot(owner).state, "running", "An old binding cannot overwrite current Host custody.");
  await assert.rejects(hosts.port.stop({ ...binding, id: "retired-binding" }), /stale binding/);
  assert.equal(f.stops, 0);
  await hosts.requestExit(owner, async () => {});
  assert.equal(hosts.snapshot(owner).state, "stopping", "Sending exit is not physical stop proof.");
  await assert.rejects(hosts.port.restore(request), /lifecycle/);
  assert.equal(f.starts, 1);
  f.setState("stopped");
  await hosts.port.inspectOwner(owner);
  assert.equal(hosts.snapshot(owner).state, "stopped");
  await hosts.port.restore(request);
  const recovered = createControllerHostLifecycle(f.raw);
  await recovered.port.inspectOwner(owner);
  assert.equal(recovered.snapshot(owner).state, "running");
  assert.equal(f.starts, 2, "Controller recovery only observes; it never replays launch or native input.");
  await recovered.port.stopOwner(owner);
  assert.equal(recovered.snapshot(owner).state, "stopped");
  after.close();
});

test("Controller Host FSM rejects competing effects and late reads; hooks cannot hold either layer", async () => {
  const f = fixture(), errors = [], seen = [];
  const after = createNonBlockingChecks([
    { id: "stuck", run: () => new Promise(() => {}) },
    { id: "broken", run: () => { throw new Error("optional"); } },
    { id: "extra", run: value => seen.push(value) }
  ], error => errors.push(error));
  const hosts = createControllerHostLifecycle(f.raw, { after });
  let releaseStart;
  f.raw.restore = async () => { await new Promise(resolve => { releaseStart = resolve; }); return binding; };
  const launched = hosts.port.restore(request);
  await tick();
  assert.equal(hosts.snapshot(owner).state, "starting");
  await assert.rejects(hosts.port.stopOwner(owner), /lifecycle/);
  assert.equal(f.stops, 0);
  releaseStart();
  await launched;
  let releaseRead;
  f.raw.inspectOwner = async () => new Promise(resolve => { releaseRead = resolve; });
  const stale = hosts.port.inspectOwner(owner);
  await hosts.port.stopOwner(owner);
  releaseRead({ state: "running", nativeSessionId: "old" });
  await stale;
  assert.equal(hosts.snapshot(owner).state, "stopped");
  assert.equal(hosts.snapshot(owner).nativeSessionId, undefined);
  await tick();
  assert.ok(seen.length && errors.length);
  after.close();
});

test("Unknown effects and mismatched handshakes remain unavailable without an automatic retry", async () => {
  const f = fixture(), hosts = createControllerHostLifecycle(f.raw);
  f.raw.restore = async () => ({ ...binding, nativeSessionId: "wrong-thread" });
  await assert.rejects(hosts.port.restore(request), /identity/);
  assert.equal(hosts.snapshot(owner).state, "unavailable");
  f.raw.restore = async () => { throw new Error("unknown native effect"); };
  await assert.rejects(hosts.port.restore(request), /unknown native effect/);
  assert.equal(hosts.snapshot(owner).state, "unavailable");
  f.raw.stopOwner = async () => false;
  assert.equal(await hosts.port.stopOwner(owner), false);
  assert.equal(hosts.snapshot(owner).state, "unavailable");
});

test("Two lifecycle layers correlate the same Session but never infer physical Host exit from a native terminal", async () => {
  const f = fixture(), session = createHostSessionLifecycle();
  const restore = f.raw.restore;
  f.raw.restore = async () => {
    session.send({ type: "launch" });
    session.send({ type: "connected", occupancy: "idle", nativeSessionId: "thread", processInstanceId: "proxy" });
    return restore();
  };
  const hosts = createControllerHostLifecycle(f.raw);
  await hosts.port.restore(request);
  session.send({ type: "native-started", nativeSessionId: "thread", nativeTurnId: "turn" });
  assert.equal(session.state, "busy");
  assert.equal(hosts.snapshot(owner).state, "running");
  assert.equal(hosts.snapshot(owner).nativeSessionId, "thread");
  session.send({ type: "terminal", nativeSessionId: "thread", nativeTurnId: "turn" });
  session.send({ type: "settled", occupancy: "idle", nativeSessionId: "thread" });
  assert.equal(hosts.snapshot(owner).state, "running");
  await hosts.requestExit(owner, async () => {});
  session.send({ type: "exit", processInstanceId: "proxy", nativeSessionId: "thread" });
  await hosts.port.inspectOwner(owner);
  assert.equal(hosts.snapshot(owner).state, "stopping", "Native attachment exit is not physical Host exit proof.");
  f.setState("stopped");
  await hosts.port.inspectOwner(owner);
  assert.equal(hosts.snapshot(owner).state, "stopped");
});
