import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { AsyncRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import { createRuntimeObservation, runtimeObservationTaskEventPayload } from "../../dist/runtime/runtimeObservation.js";
import { AgentRuntimeObserver } from "../../dist/controller/agentRuntimeObserver.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createFixtureRun } from "../helpers/runFixture.mjs";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";

test("sampler awaits durable usage admission, keeps occurrence order and retries a failed cursor", async t => {
  const home = await mkdtemp(join(tmpdir(), "yui-sampler-admission-"));
  let store, releasePending, pendingSample;
  t.after(async () => {
    releasePending?.();
    await pendingSample?.catch(() => undefined);
    store?.close();
    await rm(home, { recursive: true, force: true });
  });
  store = new SqliteTaskStore(home);
  const at = new Date("2026-10-31T00:00:00Z");
  const task = activateTask(createTask("task-1", "Synthetic sampler", at, { cwd: home }), at);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "leader", [binding], binding.agentId, home, at);
  store.saveRole(task.id, role);
  const run = createFixtureRun(store, "run-1", task.id, role.name, "new", createRunInput({
    source: { type: "yui", channel: "task-dispatch" }, directive: "Synthetic", deltaRefIds: []
  }), at, { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) });
  store.saveActiveRun(run);
  const fence = { taskId: task.id, runId: run.id, roleName: role.name,
    agentId: "codex", driverId: "openai/codex", nativeSessionId: "fixture-session",
    nativeTurnId: "fixture-turn" };
  const accepted = createRuntimeObservation({ schemaVersion: 1, eventId: "accepted",
    semanticKey: "accepted", kind: "turn.accepted", authority: "controller",
    receivedAt: at.toISOString(), sequence: 0, fence, payload: {
      observerSource: { schemaVersion: 1, sourceId: "fixture-source",
        transport: "append-only-jsonl", locator: join(home, "synthetic") }
    } });
  store.saveEvent(task.id, createTaskEvent("event-1", task.id, "runtime.observation",
    runtimeObservationTaskEventPayload(accepted), at));
  const inbox = new FileRuntimeEventInbox(home);
  const enqueue = inbox.enqueueObservationAsync?.bind(inbox);
  assert.equal(typeof enqueue, "function", "Controller producers need awaitable admission");
  let controlTurn = false, fail = true;
  const cursors = [], admitted = [];
  inbox.enqueueObservation = () => assert.fail("sampler must not use synchronous producer scans");
  inbox.enqueueObservationAsync = async observation => {
    if (observation.payload.usage) {
      if (fail && observation.ordinal === 3) throw new Error("fixture persistence failure");
    }
    const result = await enqueue(observation);
    if (observation.payload.usage) assert.equal(controlTurn, true,
      "pending control I/O runs before a usage admission completes");
    admitted.push(result.event.observation);
    return result;
  };
  const observer = new AgentRuntimeObserver(store, inbox, { require: () => ({
    runtime: { observer: { sample: async (_source, cursor) => {
      cursors.push(cursor);
      return { status: "healthy", cursor: { offset: cursors.length }, usages: [1, 2].map(i => ({
        occurrenceId: `usage-${i}`, usage: { semantics: "request-context", inputTokens: i, outputTokens: 1 }
      })) };
    } } }
  }) });
  setImmediate(() => { controlTurn = true; });
  await assert.rejects(observer.sample(at), /fixture persistence failure/);
  fail = false;
  await observer.sample(at);
  fail = true;
  await assert.rejects(observer.sample(at), /fixture persistence failure/);
  fail = false;
  await observer.sample(at);
  assert.deepEqual(cursors, [undefined, undefined, { offset: 2 }, { offset: 2 }],
    "failed persistence must not advance even an existing process-local cursor");
  assert.deepEqual(observer.metrics(), { samples: 4, sources: 4,
    published: 8, usagePublications: 6, failed: 2 });
  const usage = (await inbox.listAsync()).filter(event => event.observation?.payload.usage);
  assert.deepEqual(usage.map(event => event.observation.payload.usage.inputTokens), [1, 2]);
  assert.deepEqual(usage.map(event => event.observation.ordinal), [2, 3]);
  const original = usage[0].observation;
  assert.equal((await enqueue({ ...original, semanticKey: "different-checkpoint" })).created, false,
    "same eventId remains duplicate even when semanticKey differs");
  const independent = { ...original, eventId: "different-occurrence", semanticKey: "different-checkpoint" };
  assert.equal((await enqueue(independent)).created, true, "distinct occurrence and key remain distinct");
  const concurrent = await Promise.all(["checkpoint-a", "checkpoint-b"].map(semanticKey =>
    enqueue({ ...original, eventId: "concurrent-occurrence", semanticKey })));
  assert.deepEqual(concurrent.map(result => result.created), [true, false]);
  const terminal = { ...original, eventId: "terminal", semanticKey: "terminal",
    kind: "turn.completed", authority: "controller", payload: { output: "original" } };
  await enqueue(terminal);
  await assert.rejects(enqueue({ ...terminal, payload: { output: "conflicting" } }),
    error => error.code === "RUNTIME_EVENT_CONFLICT");
  assert.throws(() => enqueue({ ...independent, kind: "not-valid" }));
  assert.equal((await enqueue({ ...original, eventId: "after-failure", semanticKey: "after-failure" })).created,
    true, "a failed admission must not poison the producer queue");
  assert.ok(admitted.length > 0);

  const sibling = createRole(task.id, "worker", [binding], binding.agentId, home, at);
  store.saveRole(task.id, sibling);
  const siblingRun = createFixtureRun(store, "run-2", task.id, sibling.name, "new", createRunInput({
    source: { type: "yui", channel: "task-dispatch" }, directive: "Synthetic", deltaRefIds: []
  }), at, { effective: resolveEffectiveLaunch({ role: sibling, purpose: "execution" }) });
  store.saveActiveRun(siblingRun);
  store.saveEvent(task.id, createTaskEvent("event-2", task.id, "runtime.observation",
    runtimeObservationTaskEventPayload(createRuntimeObservation({
      ...accepted, eventId: "accepted-sibling", semanticKey: "accepted-sibling",
      fence: { ...fence, roleName: sibling.name, runId: siblingRun.id },
      payload: { observerSource: { ...accepted.payload.observerSource, sourceId: "sibling" } }
    })), at));
  let settled = false;
  const blocked = new Promise(resolve => { releasePending = resolve; });
  inbox.enqueueObservationAsync = async observation => {
    if (observation.payload.sourceId === "fixture-source") throw new Error("source admission failed");
    return enqueue(observation);
  };
  const concurrentObserver = new AgentRuntimeObserver(store, inbox, { require: () => ({ runtime: { observer: {
    sample: async source => {
      if (source.sourceId === "sibling") await blocked;
      return { status: "healthy", cursor: {} };
    }
  } } }) });
  const sampling = concurrentObserver.sample(at);
  pendingSample = sampling;
  sampling.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "failure cannot release the sample guard while another source still publishes");
  releasePending();
  await assert.rejects(sampling, /source admission failed/);
});

test("worker-backed drain admits control I/O while reading the durable inbox, without changing order or ACK", async t => {
  const home = await mkdtemp(join(tmpdir(), "yui-inbox-scheduling-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const inbox = new FileRuntimeEventInbox(home);
  for (let i = 0; i < 8; i++) inbox.enqueueRunTerminal({
    scope: "global", roleName: "fixture", agentId: "codex", adapterId: "codex",
    nativeSessionId: "original-session", nativeTurnId: `turn-${i}`,
    providerStatus: "completed", outcome: { status: "completed", output: `original-${i}` }
  });
  const original = inbox.list();
  const invalidName = `turn-${"0".repeat(64)}.json`;
  await writeFile(join(home, "runtime/inbox", invalidName), "not-json", { mode: 0o600 });
  let controlTurn = false;
  setImmediate(() => { controlTurn = true; });
  const applied = [];
  const processor = new AsyncRuntimeEventProcessor(inbox, {
    classifyGlobalRuntimeRunTerminal: async () => {
      assert.equal(controlTurn, true, "the inbox scan must not run inline before pending control I/O");
      return "apply";
    },
    observeGlobalRuntimeRunTerminal: async input => { applied.push(input); }
  }, { maxEventsPerDrain: 3 });
  const first = await processor.drainAsync(new Date());
  assert.deepEqual(first.failed, []);
  assert.deepEqual(await readdir(join(home, "runtime/inbox-invalid")), [invalidName]);
  assert.equal(await readFile(join(home, "runtime/inbox-invalid", invalidName), "utf8"), "not-json");
  assert.deepEqual(first.acknowledgedEventIds, original.slice(0, 3).map(event => event.id));
  assert.equal(first.remainingEventCount, 5);
  assert.deepEqual(inbox.list(), original.slice(3), "unselected facts remain byte-for-byte available");
  const rest = await processor.drainAsync(new Date());
  assert.deepEqual(rest.failed, []);
  await processor.drainAsync(new Date());
  assert.equal(inbox.list().length, 0);
  assert.deepEqual(applied.map(input => input.nativeTurnId), original.map(event => event.nativeTurnId));
  assert.deepEqual(applied.map(input => input.outcome), original.map(event => event.outcome));
  assert.equal((await processor.drainAsync(new Date())).acknowledgedEventIds.length, 0);
});
