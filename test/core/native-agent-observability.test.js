import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgent } from '../../dist/nativeAgent/index.js';
import { createLocalObserver, createJsonlExporter } from '../../dist/nativeAgent/observability/index.js';

const scope = { sessionId: 's', turnId: 't' };
const event = (seq, data) => ({ ...scope, seq, data });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('observations distinguish live events, snapshots and model evidence without exposing payloads', async () => {
  let now = 10;
  const observer = createLocalObserver({ clock: () => now });
  observer.observeEvent(event(1, { type: 'turn_started' }));
  now = 25;
  observer.observeModel({ ...scope, step: 1, requestId: 'r', attempt: 1, phase: 'started' });
  now = 30;
  observer.observeModel({ ...scope, step: 1, requestId: 'r', attempt: 1, phase: 'ended',
    status: 'error', effect: 'unknown', errorCode: 'transport_error',
    usage: { inputTokens: 12 }, retryAfterMs: 100 });
  observer.observeEvent(event(2, { type: 'tool_started', step: 1, toolCallId: 'c', name: 'write' }));
  now = 32;
  observer.observeEvent(event(3, { type: 'message_appended', step: 1,
    message: { role: 'tool', toolCallId: 'c', name: 'write',
      outcome: { ok: false, error: { code: 'io_error', message: 'SECRET', effect: 'unknown' } } } }));
  observer.observeStream({ ...scope, step: 1, requestId: 'r', text: 'SECRET' });
  now = 40;
  const result = await createAgent({ tools: [], provider: {
    async complete() { return { kind: 'final', content: 'SECRET' }; },
  } }).runTurn({ ...scope, input: 'SECRET', maxSteps: 1 });
  observer.observeSnapshot(result, 'cached');
  observer.observeEvent(event(4, { type: 'turn_ended', reason: 'cancelled' }));
  const records = observer.query().records;
  assert.equal(records.at(-1).durationMs, 30);
  assert.equal(records.at(-1).status, 'cancelled');
  assert.equal(records.find(r => r.kind === 'model' && r.status === 'error').durationMs, 5);
  assert.deepEqual(records.find(r => r.usage).usage, { inputTokens: 12 });
  assert.equal(records.find(r => r.kind === 'stream').completeness, 'provisional');
  assert.equal(records.find(r => r.kind === 'snapshot').source, 'cached');
  assert.equal(records.find(r => r.kind === 'snapshot').durationMs, undefined);
  const toolResult = records.find(r => r.toolCallId === 'c' && r.role === 'tool');
  assert.equal(toolResult.effect, 'unknown');
  assert.equal(toolResult.durationMs, 2);
  assert.equal(toolResult.usage, undefined);
  assert.ok(!JSON.stringify(records).includes('SECRET'));
  assert.ok(Object.isFrozen(records[0]));
  assert.ok(Object.isFrozen(records.find(r => r.usage).usage));
  assert.equal(observer.query({ requestId: 'r' }).records.length, 3);
  observer.close();
});

test('optional exporters never hold execution; busy, failure and unsubscribe are observable', async () => {
  const observer = createLocalObserver();
  let signal;
  let release;
  const unsubscribe = observer.subscribe({ export(record, abort) {
    signal = abort;
    return new Promise(resolve => { release = resolve; });
  } });
  observer.subscribe({ export() { throw new Error('SECRET exporter credentials'); } });
  const result = await createAgent({ tools: [], observer, provider: {
    async complete() { return { kind: 'final', content: 'ok' }; },
  } }).runTurn({ ...scope, input: 'hi', maxSteps: 1 });
  assert.equal(result.reason, 'completed');
  await tick();
  assert.ok(observer.health().consumerDropped > 0);
  assert.ok(observer.health().consumerFailures > 0);
  assert.equal(observer.health().inFlight, 1);
  unsubscribe();
  assert.equal(signal.aborted, true);
  assert.equal(observer.health().inFlight, 1, 'abort is not settlement');
  release();
  await tick();
  assert.equal(observer.health().inFlight, 0);
  observer.close();
  assert.equal(observer.health().subscribers, 0);
  assert.ok(!JSON.stringify(observer.health()).includes('SECRET'));
  const badClock = createLocalObserver({ clock() { throw new Error('SECRET'); } });
  const unaffected = await createAgent({ tools: [], observer: badClock, provider: {
    async complete() { return { kind: 'final', content: 'ok' }; },
  } }).runTurn({ ...scope, input: 'hi', maxSteps: 1 });
  assert.equal(unaffected.reason, 'completed');
  assert.ok(badClock.health().rejected > 0);
  assert.equal(badClock.query().records.length, 0);
  badClock.close();
});

test('retention, pairing, cursor gaps and export are bounded and truthful', async () => {
  let now = 0;
  const observer = createLocalObserver({ capacity: 2, clock: () => ++now });
  observer.observeEvent(event(1, { type: 'turn_started' }));
  observer.observeEvent(event(2, { type: 'step_started', step: 1 }));
  observer.observeEvent(event(3, { type: 'step_ended', step: 1 }));
  observer.observeEvent(event(4, { type: 'turn_ended', reason: 'error', errorCode: 'failure' }), 'replay');
  const page = observer.query({ after: 0, limit: 1 });
  assert.equal(page.evicted, 2);
  assert.equal(page.gap, true);
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].durationMs, 1);
  const next = observer.query({ after: page.nextCursor });
  assert.equal(next.records[0].durationMs, undefined);
  assert.equal(next.records[0].source, 'replay');
  assert.equal(observer.observeModel({ ...scope, step: 1, requestId: 'r', attempt: 1,
    phase: 'ended', usage: { outputTokens: NaN } }), false);
  assert.equal(observer.health().rejected, 1);
  assert.throws(() => observer.query({ limit: 1001 }));
  observer.observeEvent(event(5, { type: 'turn_ended', reason: 'completed' }));
  assert.equal(observer.query().records.at(-1).durationMs, undefined, 'evicted starts cannot prove duration');
  const lines = [];
  await createJsonlExporter(async line => lines.push(line)).export(next.records[0], new AbortController().signal);
  assert.deepEqual(JSON.parse(lines[0]), next.records[0]);
  assert.equal(lines[0].split('\n').length, 2);
  observer.close();
  assert.equal(observer.observeEvent(event(6, { type: 'turn_started' })), false);
});
