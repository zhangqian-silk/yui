import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { JsonLineChannel } from "../../dist/runtime/jsonLineChannel.js";
import { reconcileKnownDetachedContinuations } from "../../dist/runtime/providerRuntimeReconciler.js";
import { createProviderContinuation } from "../../dist/runtime/providerContinuation.js";
import { closeAgentHostEndpoints } from "../../dist/runtime/agentHostCleanup.js";

function pipe(t) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  t.after(() => { child.stdout.destroy(); child.stdin.destroy(); });
  const diagnostics = [];
  return { child, diagnostics, channel: new JsonLineChannel(child, (stream, text) => {
    if (stream === "stderr") diagnostics.push(text);
  }) };
}

test("line transport distinguishes unrelated objects, malformed frames and callback failures", async t => {
  const { child, channel, diagnostics } = pipe(t);
  const received = [], closed = [];
  channel.onMessage(message => {
    if (message.type === "relevant") throw new Error("consumer failed", { cause: new Error("disk unavailable") });
    received.push(message);
  });
  channel.onClose(error => closed.push(error));
  child.stdout.write('{"type":"unrelated"}\n');
  assert.deepEqual(received, [{ type: "unrelated" }]);
  child.stdout.write('{"type":"relevant"}\n{"type":"must-not-run"}\n');
  assert.equal(closed.length, 1);
  assert.match(closed[0].message, /listener/i);
  assert.equal(closed[0].cause.cause.message, "disk unavailable");
  assert.match(diagnostics.join(""), /consumer failed/);
  await assert.rejects(channel.send({ type: "no-replay" }), /listener/i);
  assert.equal(received.length, 1);

  const malformed = pipe(t);
  malformed.child.stdout.write('[]\n{"type":"must-not-run"}\n');
  assert.match(malformed.channel.closedError?.message ?? "", /object/i);
  const invalid = pipe(t);
  invalid.child.stdout.write('not-json\n');
  assert.match(invalid.channel.closedError?.message ?? "", /JSON/);
});

const continuation = createProviderContinuation({
  identity: { providerNamespace: "openai/codex", accountScope: "fixture",
    conversationId: "parent", continuationId: "child" },
  taskId: "task-1", roleName: "leader", runId: "run-1",
  attachment: "detached", observation: "unavailable", mayWriteWorkspace: true,
  observedAt: "2026-09-17T00:00:00Z"
});

test("metadata failure preserves its cause, bounded schedule and unknown writer ownership", async () => {
  const now = new Date("2026-09-17T00:00:00Z");
  const result = await reconcileKnownDetachedContinuations({
    continuations: [continuation], now,
    port: { queryKnownContinuations: async () => {
      throw new Error("metadata unavailable", { cause: new Error("socket refused") });
    } }
  });
  assert.equal(result.quality, "unavailable");
  assert.match(result.failure.raw, /socket refused/);
  assert.equal(result.failure.inputDisposition, "unknown");
  assert.equal(result.schedule.attempts, 1);
  assert.equal(result.schedule.nextReconcileAt, "2026-09-17T00:00:02.000Z");
  assert.equal(result.continuations[0], continuation);
  const unavailable = await reconcileKnownDetachedContinuations({
    continuations: [continuation], now,
    port: { queryKnownContinuations: async () => ({
      quality: "unavailable", continuations: [], detail: "exact child query unavailable"
    }) }
  });
  assert.match(unavailable.failure.raw, /exact child query unavailable/);
  assert.equal(unavailable.continuations[0], continuation);
});

test("Host cleanup retains exact held effects and all causes while still closing control", async t => {
  const calls = [], reports = [];
  const logs = [];
  t.mock.method(process.stderr, "write", text => { logs.push(text); return true; });
  const drain = {
    quiescent: false, references: 1, opening: 0, waitedMs: 5, timedOut: true,
    sessions: [{ nativeSessionId: "held-session", processInstanceId: "held-process",
      attachment: "detach-requested", cancellation: "not-requested", resources: "unknown",
      releaseAwaitingExit: true, pending: [{ attemptId: "original", inputRef: "message-1", status: "unknown" }] }]
  };
  const stopError = new Error("stop inspection unavailable", { cause: new Error("client inspection failed") });
  const closeError = new Error("close inspection unavailable", { cause: new Error("endpoint unreachable") });
  for (const failStop of [false, true]) {
    calls.length = 0;
    reports.length = 0;
    await assert.rejects(closeAgentHostEndpoints({
      owner: {
        stop: async () => { calls.push("stop"); if (failStop) throw stopError; return drain; },
        close: async () => { calls.push("close"); throw closeError; }
      },
      session: { nativeSessionId: "held-session", processInstanceId: "held-process",
        detach: () => calls.push("detach") },
      lease: { implementation: { id: "endpoint", generation: "exact-generation" },
        release: async () => calls.push("release") },
      adapterId: "claude", attemptId: "original", timeoutMs: 5,
      report: async report => reports.push(report),
      closeControl: async () => { calls.push("control"); }
    }), error => {
      assert.ok(error.errors.includes(closeError));
      if (failStop) assert.ok(error.errors.includes(stopError));
      return true;
    });
    assert.deepEqual(calls, ["detach", "release", "stop", "close", "control"]);
    assert.equal(reports.length, 2);
    assert.match(reports[1].failure.raw, /endpoint unreachable/);
    assert.match(reports[1].failure.raw, /exact-generation/);
    assert.equal(reports[1].failure.inputDisposition, "unknown");
    if (!failStop) assert.match(reports[1].failure.raw, /message-1/);
  }
  assert.match(logs.join(""), /endpoint unreachable/);
});
