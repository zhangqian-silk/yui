import assert from "node:assert/strict";
import test from "node:test";
import { createHostUpgradeGate } from "../../dist/runtime/hostUpgradeGate.js";
import { HostUpgradeCoordinator } from "../../dist/controller/hostUpgrade.js";
import { isNativeContextRecovery } from "../../dist/runtime/contextRecovery.js";
import { runUpdate } from "../../dist/cli/updateOrchestrator.js";
import { runtimeCleanupDisposition, isRuntimeCleanupReason } from "../../dist/runtime/lifecycleReservation.js";
import { createHostLifecycleChecks } from "../../dist/controller/hostLifecycleChecks.js";

const fence = { requestId: "upgrade-one", nativeSessionId: "thread-one",
  processInstanceId: "process-one", hostGeneration: "old" };
const cleanEvents = { pending: 0, pendingTerminals: 0, unpersisted: 0 };

test("Host drain fences before awaits and requires terminal, durable events and released ownership", async () => {
  const gate = createHostUpgradeGate();
  let checks = 0, releases = 0;
  const input = { busy: true, events: cleanEvents,
    checkQuiescent: async () => { checks++; return true; }, release: async () => { releases++; } };
  gate.request(fence, fence);
  assert.equal(gate.fenced, true);
  assert.throws(() => gate.request({ ...fence, nativeSessionId: "other" }, fence), /identity/);
  await gate.drain(input);
  for (const events of [{ ...cleanEvents, pending: 1 }, { ...cleanEvents, unpersisted: 1 },
    { ...cleanEvents, failure: { stage: "persistence", detail: "disk full", observedAt: new Date().toISOString() } },
    { pending: 0, pendingTerminals: 0 }]) {
    await gate.drain({ ...input, busy: false, events });
  }
  assert.equal(checks, 0);
  await gate.drain({ ...input, busy: false, checkQuiescent: async () => false });
  assert.equal(gate.observation.state, "waiting", "Background work waits without losing the exact request.");
  assert.equal(releases, 0);
  await Promise.all([gate.drain({ ...input, busy: false }), gate.drain({ ...input, busy: false })]);
  assert.equal(gate.observation.state, "drained");
  assert.equal(releases, 1);
  gate.request(fence, fence);
  assert.equal(gate.observation.state, "drained", "Duplicate update never reacquires or replays work.");
  const failed = createHostUpgradeGate();
  failed.request(fence, fence);
  await failed.drain({ ...input, busy: false, release: async () => { throw new Error("owned client remains live"); } });
  assert.equal(failed.observation.state, "failed");
  assert.equal(failed.fenced, true);
});

function fixture() {
  const owner = { scope: "global", roleName: "operator" };
  const target = { id: "yui.agent-host", generation: "new" };
  const endpoint = { id: "yui.agent-endpoint.codex", generation: "new" };
  let mailbox = null, enabled = true, state = "running", busy = true;
  let native = "thread-one", resumes = 0, finishes = 0, prepares = 0;
  let effective = { model: "fixed", permission: "fixed", workspace: { root: "/fixture" },
    context: { description: "exact original role" } };
  let snapshot = { schemaVersion: 1, state: "idle", nativeSessionId: native,
    adapterId: "codex", processInstanceId: "process-one",
    hostImplementation: { id: "yui.agent-host", generation: "old" },
    endpointImplementation: { ...endpoint, generation: "old" },
    controlCapabilities: ["status", "prepare-upgrade", "finish-upgrade", "reconcile-turn"],
    eventDelivery: cleanEvents };
  const store = {
    transaction: run => run(store),
    listRuntimeSessionCandidates: () => [{ owner, nativeSessionId: native, agentId: "agent", adapterId: "codex" }],
    getGlobalRole: () => ({ name: "operator", enabled }),
    getGlobalRoleSessionSet: () => ({ activeAgentId: "agent", sessions: {
      agent: { nativeSessionId: native, status: "active", effective }
    } }),
    getWorkMailbox: () => mailbox,
    saveWorkMailbox: value => { mailbox = structuredClone(value); },
    listWorkMailboxes: () => mailbox ? [mailbox] : []
  };
  const ports = {
    inspect: async () => structuredClone(snapshot), hostState: async () => state, endpoint: () => endpoint,
    control: async (_owner, type, request) => {
      if (type === "prepare-upgrade") {
        prepares++;
        snapshot = { ...snapshot, hostUpgrade: { ...request, state: busy ? "waiting" : "drained" } };
      } else {
        finishes++;
        assert.ok(mailbox.pending.reasons.includes("runtime-host-upgrade-drained"),
          "Stable drain receipt precedes old Host exit.");
        state = "stopped";
      }
      return structuredClone(snapshot);
    },
    restore: async (actualOwner, request, actualEffective) => {
      resumes++;
      assert.deepEqual(actualOwner, owner);
      assert.equal(request.nativeSessionId, "thread-one");
      assert.deepEqual(actualEffective, effective);
      state = "running";
      snapshot = { ...snapshot, hostUpgrade: undefined, hostImplementation: target,
        endpointImplementation: endpoint, processInstanceId: "process-new" };
    }
  };
  return { store, ports, target, coordinator: () => new HostUpgradeCoordinator(store, target, ports),
    get mailbox() { return mailbox; }, get resumes() { return resumes; }, get prepares() { return prepares; },
    get finishes() { return finishes; },
    setBusy: value => { busy = value; }, setEnabled: value => { enabled = value; },
    setNative: value => { native = value; },
    setEffective: value => { effective = structuredClone(value); },
    get effective() { return effective; },
    setSnapshot: change => { snapshot = { ...snapshot, ...change }; } };
}

test("same-generation configuration changes never request Host drain or replacement", async () => {
  const f = fixture();
  f.setSnapshot({ hostImplementation: f.target, endpointImplementation: f.ports.endpoint() });
  const old = structuredClone(f.effective);
  const desired = { ...old, workspace: { root: "/fixture", entries: ["new-project"] } };
  f.setEffective(desired);
  assert.equal((await f.coordinator().status())[0].status, "current");
  assert.equal((await f.coordinator().request())[0].status, "current");
  assert.equal(f.prepares, 0);
  assert.equal(f.resumes, 0);
  assert.equal(f.finishes, 0);
  assert.equal(f.mailbox, null);
});

test("Upgrade survives Controller restart and queued input without changing native identity or replay", async () => {
  const f = fixture();
  assert.equal((await f.coordinator().status())[0].status, "unknown");
  assert.equal(f.mailbox, null, "Inspection never admits an upgrade.");
  assert.equal((await f.coordinator().request())[0].status, "waiting");
  const retained = structuredClone(f.mailbox);
  assert.equal((await f.coordinator().status())[0].status, "waiting");
  assert.deepEqual(f.mailbox, retained, "Inspection never advances a waiting upgrade.");
  assert.equal(f.finishes, 0, "Self-update stays alive until its calling Turn completes.");
  assert.equal((await f.coordinator().request())[0].status, "waiting", "Duplicate update reuses exact request.");
  f.setBusy(false);
  assert.equal((await f.coordinator().reconcile())[0].status, "waiting");
  assert.equal(f.finishes, 1);
  // New coordinator has no volatile phase memory. It resumes only because the
  // original mailbox contains the exact already-persisted drain receipt.
  assert.equal((await f.coordinator().reconcile())[0].status, "upgraded");
  assert.equal(f.resumes, 1);
  assert.equal(f.mailbox.pending, null);
  assert.equal((await f.coordinator().request())[0].status, "current");
  assert.equal(f.resumes, 1);
});

test("Lifecycle hints discover old Hosts without update; duplicates, missing events and pause remain safe", async () => {
  const f = fixture();
  const checks = createHostLifecycleChecks(f.coordinator());
  const tick = () => new Promise(resolve => setImmediate(resolve));
  checks.notify("startup");
  await tick();
  assert.ok(f.mailbox, "Startup discovers the version difference without an explicit update request.");
  assert.equal(f.finishes, 0);
  f.setBusy(false);
  f.setEnabled(false);
  checks.notify("events-persisted");
  await tick();
  assert.equal(f.finishes, 0);
  f.setEnabled(true);
  checks.notify("periodic"); // background-completion hint was missed
  await tick();
  assert.equal(f.finishes, 1);
  checks.close(); // Controller interrupted after the persisted drain receipt
  const replacement = createHostLifecycleChecks(f.coordinator());
  for (const hint of ["startup", "host-observed", "events-persisted", "signal", "periodic"]) replacement.notify(hint);
  await tick();
  assert.equal(f.resumes, 1);
  for (let i = 0; i < 100; i++) replacement.notify("signal");
  await tick();
  assert.equal(f.resumes, 1, "Late/duplicate hints reread current truth, never replay an input or startup.");
  replacement.close();
});

test("Incomplete lifecycle readiness is not a version mismatch and never fences current input", async () => {
  const f = fixture();
  f.setSnapshot({ hostImplementation: f.target, endpointImplementation: f.ports.endpoint(),
    state: "settling", eventDelivery: { ...cleanEvents, unpersisted: 1 } });
  const checks = createHostLifecycleChecks(f.coordinator());
  checks.notify("signal");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.mailbox, null);
  assert.equal(f.prepares, 0);
  checks.close();
});

test("Changed target never silently retargets an admitted request; stopped ownership never restarts", async () => {
  const f = fixture();
  await f.coordinator().request();
  const replacement = new HostUpgradeCoordinator(f.store, { ...f.target, generation: "another-target" }, f.ports);
  f.setBusy(false);
  const blocked = (await replacement.request())[0];
  assert.equal(blocked.status, "waiting");
  assert.match(blocked.detail, /pinned update target/);
  assert.equal(f.finishes, 0);
  f.mailbox.pending.reasons.push("runtime-cleanup-required");
  const stopped = createHostLifecycleChecks(f.coordinator());
  stopped.notify("host-observed");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.resumes, 0);
  assert.equal(f.finishes, 0);
  stopped.close();
});

test("Controller shutdown revokes an in-flight discovery before it can admit an upgrade", async () => {
  const f = fixture();
  const inspect = f.ports.inspect;
  let release;
  f.ports.inspect = async (...args) => {
    await new Promise(resolve => { release = resolve; });
    return inspect(...args);
  };
  const coordinator = f.coordinator();
  const request = coordinator.request();
  await new Promise(resolve => setImmediate(resolve));
  coordinator.stop();
  release();
  await request;
  await coordinator.close();
  assert.equal(f.mailbox, null);
  assert.equal(f.prepares, 0);
});

test("Unsupported, paused, changed and failed Hosts preserve exact intent rather than guessing success", async () => {
  const old = fixture();
  old.setSnapshot({ controlCapabilities: ["status"] });
  assert.equal((await old.coordinator().request())[0].status, "unsupported");
  await old.coordinator().request();
  assert.equal(old.prepares, 0);
  const paused = fixture();
  paused.setEnabled(false);
  assert.equal((await paused.coordinator().request())[0].status, "paused");
  assert.equal(paused.mailbox, null);
  const changed = fixture();
  await changed.coordinator().request();
  changed.setNative("replacement");
  assert.equal((await changed.coordinator().reconcile())[0].status, "unknown");
  assert.equal(changed.finishes, 0);
  const failure = fixture();
  failure.setBusy(false);
  await failure.coordinator().request();
  failure.ports.restore = async () => { throw new Error("handshake lost"); };
  assert.equal((await failure.coordinator().reconcile())[0].status, "failed");
  failure.ports.restore = async () => assert.fail("Unknown launch must not be automatically replayed.");
  assert.equal((await failure.coordinator().reconcile())[0].status, "failed");
  const late = fixture();
  late.setBusy(false);
  await late.coordinator().request();
  const restore = late.ports.restore;
  late.ports.restore = async (...args) => { await restore(...args); throw new Error("response lost"); };
  assert.equal((await late.coordinator().reconcile())[0].status, "failed");
  assert.equal((await late.coordinator().reconcile())[0].status, "upgraded",
    "A later exact handshake settles the same request without replaying startup.");
  assert.equal(late.resumes, 1);
});

test("Context recovery uses exact native identity and explicit compaction, not ordinary traffic", () => {
  assert.equal(isNativeContextRecovery("codex", "thread", {
    method: "item/completed", params: { threadId: "thread", item: { type: "contextCompaction" } }
  }), true);
  assert.equal(isNativeContextRecovery("codex", "thread", {
    method: "thread/compacted", params: { threadId: "other" }
  }), false);
  assert.equal(isNativeContextRecovery("claude", "session", {
    type: "system", subtype: "compact_boundary", session_id: "session"
  }), true);
  assert.equal(isNativeContextRecovery("claude", "session", { type: "assistant", session_id: "session" }), false);
});

test("A failed durable drain write never authorizes the old Host to exit", async () => {
  const f = fixture();
  await f.coordinator().request();
  f.setBusy(false);
  const save = f.store.saveWorkMailbox;
  f.store.saveWorkMailbox = value => {
    if (value.pending?.reasons.includes("runtime-host-upgrade-drained")) throw new Error("disk full");
    save(value);
  };
  assert.equal((await f.coordinator().reconcile())[0].status, "unknown");
  assert.equal(f.finishes, 0);
  assert.equal(f.resumes, 0);
  f.store.saveWorkMailbox = save;
  await f.coordinator().reconcile();
  assert.equal((await f.coordinator().reconcile())[0].status, "upgraded");
});

test("Explicit stop supersedes upgrade and can settle all retained upgrade receipts", async () => {
  const f = fixture();
  f.setBusy(false);
  await f.coordinator().request();
  f.mailbox.pending.reasons.push("runtime-cleanup-required");
  assert.equal(runtimeCleanupDisposition(f.mailbox), "end-session");
  assert.ok(f.mailbox.pending.reasons.every(isRuntimeCleanupReason));
  assert.equal((await f.coordinator().reconcile())[0].status, "waiting");
  assert.equal(f.resumes, 0);
  const racing = fixture();
  racing.setBusy(false);
  await racing.coordinator().request();
  racing.ports.restore = async (_owner, _request, _effective, assertCurrent) => {
    racing.mailbox.pending.reasons.push("runtime-cleanup-required");
    assert.throws(assertCurrent, /no longer owns/, "Pre-start recheck must observe a concurrent stop.");
    throw new Error("Stop superseded startup");
  };
  assert.equal((await racing.coordinator().reconcile())[0].status, "failed");
  assert.equal(racing.resumes, 0);
});

test("Update separates installed package and Controller from partial Host outcomes", () => {
  const effects = [];
  const ports = {
    stage: () => ({ binaryPath: "/fixture/yui", version: "next" }),
    preflight: () => ({ status: "already-current" }),
    activateBinary: () => effects.push("activate"),
    verify: () => effects.push("verify"),
    cleanup: () => effects.push("cleanup"),
    controllerStatus: () => ({ running: false }),
    stopController: () => assert.fail("No running Controller to stop"),
    restoreController: () => assert.fail("Successful installation must not be rolled back for Host uncertainty"),
    startController: () => effects.push("controller"),
    upgradeHosts: () => { effects.push("hosts"); throw new Error("Host status unavailable"); }
  };
  const result = runUpdate(ports, { home: "/fixture" });
  assert.equal(result.outcome, "updated");
  assert.equal(result.controllerStarted, true);
  assert.match(result.hostUpgradeError, /Host status unavailable/);
  assert.deepEqual(effects, ["activate", "verify", "controller", "hosts", "cleanup"]);
});
