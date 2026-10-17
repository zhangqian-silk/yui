import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { runTaskCommand, sendTaskMessageCommand } from "../../dist/commands/taskCommands.js";
import { readTaskContext, readTaskContextDelta } from "../../dist/context/taskContext.js";
import { wakeMessages } from "../../dist/interaction/notificationPresentation.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createDurableJob, startDurableJob, completeDurableJob, touchDurableJobHeartbeat } from "../../dist/job/durableJob.js";

const now = new Date("2026-10-15T00:00:00Z");
const options = { environment: sanitizedTestEnv(), now: () => now };
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-context-temporal-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  store.saveTask(createTask("task-1", "Discuss then develop", now));
  return store;
}
const command = (store, args) => runTaskCommand(args, store, options).data;
const event = (store, type, at = now) => store.saveEvent("task-1",
  createTaskEvent(store.nextEventId("task-1"), "task-1", type, {}, at));

test("activation preserves exact native input without submitting it again; source changes are rejected", t => {
  const store = fixture(t);
  sendTaskMessageCommand(store, "task-1", "Discuss only; do not publish.", options, undefined, "discuss");
  const args = ["activation", "request", "task-1", "--request-id", "native-start",
    "--environment", "empty", "--source-text", "Start development now; still do not publish."];
  const first = command(store, args);
  assert.equal(first.created, true);
  assert.equal(command(store, args).created, false);
  assert.equal(store.listMessages("task-1").length, 1, "Capturing a source never queues another input.");
  assert.throws(() => command(store, [...args.slice(0, -1), "Publish now"]), /source.*different|different.*source/i);
  const context = readTaskContext(store, "task-1");
  const source = context.phase.activation.source;
  assert.equal(source.status, "available");
  const original = command(store, ["event", "show", "task-1", source.ref.refId]).event;
  assert.equal(original.payload.sourceText, args.at(-1));
  assert.equal(context.phase.status, "draft", "A recorded request is not adoption.");
  assert.equal(store.getTask("task-1").description, undefined);
  command(store, ["activation", "cancel", "task-1", "--request-id", "native-start", "--reason", "Revised intent"]);
  const receipt = runTaskCommand([...args.slice(0, 4), "second-start", ...args.slice(5)], store, {
    ...options,
    runtime: { notifyMailboxChanged() {
      command(store, ["activation", "cancel", "task-1", "--request-id", "second-start", "--reason", "Replaced"]);
      command(store, [...args.slice(0, 4), "third-start", ...args.slice(5, -1), "Third request input"]);
    } }
  }).data;
  const receiptEvent = command(store, ["event", "show", "task-1", receipt.source.ref.refId]).event;
  assert.equal(receiptEvent.payload.requestId, "second-start", "A receipt must retain its own request source.");
  assert.equal(receiptEvent.payload.sourceText, args.at(-1));
});

test("Brief guard rejects stale writers and intervening input even at the same timestamp", t => {
  const store = fixture(t);
  const show = () => command(store, ["brief", "show", "task-1"]);
  const initial = show();
  const fields = ["--objective", "Goal", "--focus", "Plan", "--leader-summary", "Awaiting development"];
  command(store, ["brief", "update", "task-1", "--if-current", initial.writeGuard, ...fields]);
  const first = show();
  sendTaskMessageCommand(store, "task-1", "Start implementation", options, undefined, "develop");
  assert.throws(() => command(store, ["brief", "update", "task-1", "--if-current", first.writeGuard,
    "--focus", "Old planning focus"]), /changed.*read|read.*changed/i);
  const next = show();
  event(store, "fixture.runtime-observation");
  command(store, ["brief", "update", "task-1", "--if-current", next.writeGuard, "--focus", "Development"]);
  assert.throws(() => command(store, ["brief", "update", "task-1", "--if-current", next.writeGuard,
    "--focus", "Late result"]), /changed.*read|read.*changed/i);
  assert.equal(show().brief.currentFocus, "Development");
  assert.equal(readTaskContext(store, "task-1").phase.brief.status, "current-at-last-semantic-write");
  event(store, "input.auto-answered");
  assert.equal(readTaskContext(store, "task-1").phase.brief.status, "refresh-needed");
});

test("delta continuations bind the baseline and fixed window, not clock or delivery order", t => {
  const store = fixture(t);
  const base = readTaskContext(store, "task-1");
  event(store, "fixture.one");
  const otherBase = readTaskContext(store, "task-1");
  event(store, "fixture.two", new Date(now.getTime() - 5000));
  event(store, "fixture.three");
  const first = readTaskContextDelta(store, "task-1", { after: base.coreCursor, limit: 1 });
  event(store, "fixture.concurrent");
  assert.throws(() => readTaskContextDelta(store, "task-1", {
    after: otherBase.coreCursor, continuation: first.continuation, limit: 1
  }), /baseline|starting cursor/i);
  const second = readTaskContextDelta(store, "task-1", {
    after: base.coreCursor, continuation: first.continuation, limit: 2
  });
  assert.deepEqual(second.events.map(e => e.ref.refId), ["event-2", "event-3"]);
  assert.equal(second.complete, true);
  assert.equal(second.throughCursor, first.throughCursor);
  assert.deepEqual(readTaskContextDelta(store, "task-1", {
    after: base.coreCursor, continuation: first.continuation, limit: 2
  }), second);
  const later = readTaskContextDelta(store, "task-1", { after: second.throughCursor });
  assert.deepEqual(later.events.map(e => e.ref.refId), ["event-4"]);
  const empty = readTaskContextDelta(store, "task-1", { after: later.throughCursor });
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.events, []);
  assert.equal(empty.kind, "event-history");
  const foreign = fixture(t);
  assert.throws(() => readTaskContextDelta(foreign, "task-1", { after: base.coreCursor }), /history|baseline/i);
  assert.throws(() => readTaskContextDelta(store, "task-1", { after: "expired" }), /reread.*baseline/i);
});

test("Job results invalidate Brief atomically without heartbeat or receipt noise", t => {
  const store = fixture(t);
  const adapter = new FileSchedulerStoreAdapter(store);
  let job = createDurableJob({
    id: "job-1", taskId: "task-1", owner: { kind: "task" }, projectId: "project-1",
    head: "a".repeat(40), workspace: tmpdir(), env: {}, steps: [{ name: "check", command: "true" }],
    artifactsLocator: "artifacts/jobs/task-1/job-1",
    operation: { requestId: "job-1", actorId: "global:operator", authorityRef: "fixture", inputDigest: "b".repeat(64) }
  }, now);
  job = startDurableJob(job, { pid: 123, startIdentity: "fixture-no-process" }, now);
  store.saveDurableJob("task-1", job);
  const show = () => command(store, ["brief", "show", "task-1"]);
  command(store, ["brief", "update", "task-1", "--if-current", show().writeGuard,
    "--objective", "Verify result", "--focus", "Waiting for Job", "--leader-summary", "No result yet"]);
  const before = show();
  adapter.transitionDurableJob("task-1", job.id, current => touchDurableJobHeartbeat(current, now), now);
  assert.equal(show().writeGuard, before.writeGuard);
  const fail = current => completeDurableJob(current,
    { outcome: "failed", exitCode: 1, signal: null, steps: [] }, now);
  assert.throws(() => store.transaction(() => {
    adapter.transitionDurableJob("task-1", job.id, fail, now);
    throw new Error("rollback fixture");
  }), /rollback fixture/);
  assert.equal(show().writeGuard, before.writeGuard, "A rolled-back result cannot invalidate the Brief.");
  adapter.transitionDurableJob("task-1", job.id, fail, now,
    { reason: "job-finished", refs: [{ type: "task", id: "task-1" }] });
  const after = show();
  assert.notEqual(after.writeGuard, before.writeGuard);
  assert.equal(after.phase.brief.status, "refresh-needed");
  assert.throws(() => command(store, ["brief", "update", "task-1", "--if-current", before.writeGuard,
    "--focus", "Still waiting"]), /changed.*read|read.*changed/i);
  assert.ok(store.getWorkMailbox({ kind: "role", taskId: "task-1", roleName: "leader" }));
  const lastSequence = store.latestEventSequence("task-1");
  store.saveDurableJob("task-1", { ...store.getDurableJob("task-1", job.id), wakeupNotified: true });
  assert.equal(store.latestEventSequence("task-1"), lastSequence);
  assert.equal(show().writeGuard, after.writeGuard);
  command(store, ["brief", "update", "task-1", "--if-current", after.writeGuard, "--focus", "Inspect failed result"]);
  assert.equal(show().phase.brief.status, "current-at-last-semantic-write");
});

test("develop submission links its original body and diagnoses source drift without changing authority", t => {
  const store = fixture(t);
  const result = sendTaskMessageCommand(store, "task-1", "Develop; do not release.", options,
    undefined, "develop", "initial");
  let phase = readTaskContext(store, "task-1").phase;
  assert.equal(phase.activation.source.messageId, result.message.id);
  assert.equal(phase.activation.source.status, "available");
  assert.equal(phase.activation.source.attribution, "task-message");
  store.updateMessage("task-1", { ...result.message, body: "Different input" });
  phase = readTaskContext(store, "task-1").phase;
  assert.equal(phase.activation.source.status, "changed");
  assert.match(phase.activation.source.recovery, /exact activation event/);
  // Provenance is diagnostic; Core neither cancels nor expands an admitted request.
  assert.equal(store.getTask("task-1").activationRequest.disposition, "pending");
});

test("focused wake respects exact references; timestamps remain historical discovery only", () => {
  const messages = [
    { id: "message-1", taskId: "task-1", createdAt: now.toISOString() },
    { id: "message-2", taskId: "task-1", createdAt: now.toISOString() },
    { id: "message-3", taskId: "task-1", createdAt: "2026-10-14T00:00:00Z" }
  ];
  const wake = { taskId: "task-1", fromCursor: "2026-10-14T23:59:59Z",
    toCursor: now.toISOString(), refs: [{ type: "message", taskId: "task-1", id: "message-3" }] };
  assert.deepEqual(wakeMessages(wake, messages).map(m => m.id), ["message-3"]);
  assert.deepEqual(wakeMessages(wake, messages, true).map(m => m.id),
    ["message-1", "message-2", "message-3"]);
});
