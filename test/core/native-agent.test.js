import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgent, createMockProvider, createTextTools } from '../../dist/nativeAgent/index.js';

const scope = { sessionId: 'session-1', turnId: 'turn-1' };
const turn = (extra = {}) => ({ ...scope, input: 'Copy input.txt to output.txt', maxSteps: 3, ...extra });
const sequence = (...values) => () => {
  assert.ok(values.length, 'unexpected random draw');
  return values.shift();
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'native-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function assertSettled(result) {
  const calls = result.messages.flatMap(m => m.role === 'assistant' ? m.toolCalls : []);
  const results = result.messages.filter(m => m.role === 'tool');
  assert.deepEqual(results.map(m => m.toolCallId), calls.map(c => c.id));
  assert.equal(result.events.filter(e => e.data.type === 'turn_ended').length, 1);
  assert.equal(result.events.filter(e => e.data.type === 'step_started').length,
    result.events.filter(e => e.data.type === 'step_ended').length);
  assert.deepEqual(result.events.map(e => e.seq), result.events.map((_, i) => i + 1));
}

test('independent Agent: mock read → write → final, history reuse and immutable snapshots', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'input.txt'), 'hello 世界\n');
  const tools = createTextTools({ root });
  const mock = createMockProvider({ toolCallProbability: 0.5, random: sequence(0.1, 0.2, 0.9) });
  const requests = [];
  const agent = createAgent({ tools, provider: { async complete(request, signal) {
    requests.push(request);
    return mock.complete(request, signal);
  } } });
  const result = await agent.runTurn(turn());
  assert.equal(result.reason, 'completed');
  assert.equal(result.steps, 3);
  assert.equal(await readFile(path.join(root, 'output.txt'), 'utf8'), 'hello 世界\n');
  assert.deepEqual(requests.map(r => r.messages.length), [1, 3, 5]);
  assert.ok(Object.isFrozen(requests[1].messages[2].outcome));
  assertSettled(result);
  assert.deepEqual((await readdir(root)).sort(), ['input.txt', 'output.txt']);
  const next = await createAgent({ tools, provider: createMockProvider({
    toolCallProbability: 0, random: sequence(0),
  }) }).runTurn(turn({ turnId: 'turn-2', history: result.messages }));
  assert.equal(next.reason, 'completed');
  assert.equal(next.messages.length, 2);
});

test('mock probability boundaries and the last permitted step have exact termination', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'input.txt'), 'bounded');
  const tools = createTextTools({ root });
  for (const [p, samples, maxSteps, expected] of [
    [0, [0], 1, 'completed'], [0.5, [0.5], 1, 'completed'],
    [1, [0, 0.99], 2, 'budget_exhausted'],
  ]) {
    const result = await createAgent({ tools, provider: createMockProvider({
      toolCallProbability: p, random: sequence(...samples),
    }) }).runTurn(turn({ maxSteps }));
    assert.equal(result.reason, expected);
    assert.equal(result.steps, maxSteps);
    assertSettled(result);
  }
  assert.throws(() => createMockProvider({ toolCallProbability: NaN }));
  const badRandom = await createAgent({ tools, provider: createMockProvider({
    toolCallProbability: 0.5, random: () => 1,
  }) }).runTurn(turn());
  assert.equal(badRandom.error.code, 'provider_error');
});

const call = (id, name = 'effect', args = {}) => ({ id, name, arguments: args });
const batch = (...calls) => ({ kind: 'tool_calls', content: '', calls });
function effectTool(execute) {
  return { definition: { name: 'effect', description: 'test effect', inputSchema: {} },
    validate: () => null, execute };
}
test('errors remain evidence: validation is recoverable; protocol and uncertain effects stop', async () => {
  let executions = 0;
  let modelCalls = 0;
  const tool = effectTool(async () => { executions++; throw new Error('unknown write effect'); });
  const uncertain = await createAgent({ tools: [tool], provider: {
    async complete() { modelCalls++; return batch(call('a'), call('b')); },
  } }).runTurn(turn());
  assert.equal(uncertain.reason, 'error');
  assert.equal(uncertain.error.code, 'tool_exception');
  assert.equal(executions, 1);
  assert.equal(modelCalls, 1);
  assert.equal(uncertain.messages[2].outcome.error.effect, 'unknown');
  assert.equal(uncertain.messages[3].outcome.error.code, 'not_started');
  assertSettled(uncertain);

  const corrected = await createAgent({ tools: [], provider: {
    async complete(request) {
      if (request.step === 1) return batch(call('missing', 'absent'));
      assert.equal(request.messages.at(-1).outcome.error.code, 'unknown_tool');
      return { kind: 'final', content: 'Tool unavailable' };
    },
  } }).runTurn(turn());
  assert.equal(corrected.reason, 'completed');
  assertSettled(corrected);

  for (const raw of [batch(call('x'), call('x')), batch(), { kind: 'final' }]) {
    const bad = await createAgent({ tools: [tool], provider: { async complete() { return raw; } } }).runTurn(turn());
    assert.equal(bad.error.code, 'provider_protocol');
    assertSettled(bad);
  }
  const invalidHistory = await createAgent({ tools: [], provider: { async complete() { assert.fail(); } } })
    .runTurn(turn({ history: [{ role: 'assistant', content: '', toolCalls: [call('unsettled')] }] }));
  assert.equal(invalidHistory.error.code, 'invalid_history');
  assert.equal(executions, 1);
});

test('cancellation settles started effects; failed required recording prevents new effects', async () => {
  const controller = new AbortController();
  let executions = 0;
  const tool = effectTool(async () => {
    executions++;
    controller.abort();
    // The effect already completed; cancellation must not replace it with a false no-effect result.
    return { ok: true, content: 'write confirmed' };
  });
  const options = { tools: [tool], provider: { async complete() { return batch(call('a'), call('b')); } } };
  const cancelled = await createAgent(options).runTurn(turn({ signal: controller.signal }));
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal(cancelled.messages[2].outcome.ok, true);
  assert.equal(cancelled.messages[3].outcome.error.code, 'cancelled_before_start');
  assert.equal(executions, 1);
  assertSettled(cancelled);
  const before = await createAgent(options).runTurn(turn({ signal: controller.signal }));
  assert.equal(before.reason, 'cancelled');
  assert.equal(before.steps, 0);
  assertSettled(before);
  const sink = await createAgent({ ...options, recorder: { async record(event) {
    if (event.data.type === 'tool_started') throw new Error('sink offline');
  } } }).runTurn(turn());
  assert.equal(sink.error.code, 'recording_failed');
  assert.equal(executions, 1);
  assert.equal(sink.recording.status, 'failed');
  assert.equal(sink.recording.failedSeq, sink.recording.lastRecordedSeq + 1);
  assertSettled(sink);
  const observed = [];
  const terminal = await createAgent({ tools: [], provider: {
    async complete() { return { kind: 'final', content: 'done' }; },
  }, recorder: { async record(event) {
    if (event.data.type === 'turn_ended') throw new Error('sink offline');
  } }, observer: { observe(event) { observed.push(event); } } }).runTurn(turn());
  assert.equal(terminal.reason, 'error');
  assert.equal(terminal.events.at(-1).data.reason, 'error');
  assert.equal(terminal.recording.failedSeq, terminal.events.at(-1).seq);
  assert.deepEqual(observed, terminal.events);
  assertSettled(terminal);

  let callsAfterWrite = 0;
  const lostRecord = await createAgent({
    tools: [effectTool(async () => { callsAfterWrite++; return { ok: true, content: 'committed' }; })],
    provider: options.provider,
    recorder: { async record(event) {
      if (event.data.type === 'message_appended' && event.data.message.role === 'tool') throw new Error('disk failed');
    } },
  }).runTurn(turn());
  assert.equal(callsAfterWrite, 1);
  assert.equal(lostRecord.messages[2].outcome.content, 'committed');
  assert.equal(lostRecord.messages[3].outcome.error.effect, 'none');
  assert.equal(lostRecord.reason, 'error');
  assert.match(lostRecord.error.message, /disk failed/);
  assertSettled(lostRecord);
});

test('explicit composition replaces context and execution without changing authoritative history', async () => {
  const recorded = [];
  const contexts = [];
  const executed = [];
  const result = await createAgent({
    toolExecutor: {
      definitions: [{ name: 'effect', description: 'fixture', inputSchema: {} }],
      async execute(call, stepScope, signal) {
        assert.ok(Object.isFrozen(call.arguments));
        assert.ok(Object.isFrozen(stepScope));
        assert.equal(signal.aborted, false);
        executed.push({ call, stepScope });
        return { ok: true, content: 'settled' };
      },
    },
    contextBuilder: { async build(request) {
      contexts.push(request);
      assert.ok(Object.isFrozen(request.messages));
      return [{ role: 'system', content: `context-${request.step}` }, ...request.messages];
    } },
    provider: { async complete(request) {
      assert.equal(request.messages[0].content, `context-${request.step}`);
      return request.step === 1 ? batch(call('one')) : { kind: 'final', content: 'done' };
    } },
    recorder: { async record(event) { recorded.push(event); } },
    observer: { observe() { throw new Error('UI disconnected'); } },
  }).runTurn(turn());
  assert.equal(result.reason, 'completed');
  assert.deepEqual(contexts.map(r => r.step), [1, 2]);
  assert.deepEqual(contexts.map(r => r.messages.length), [1, 3]);
  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0].stepScope, { ...scope, step: 1 });
  assert.equal(result.messages.some(m => m.role === 'system'), false);
  assert.deepEqual(recorded, result.events);
  assert.deepEqual(result.recording, { status: 'recorded', lastRecordedSeq: result.events.length });
  assert.deepEqual(result.observerErrors, [{ seq: 1, message: 'UI disconnected' }]);
  assertSettled(result);
});

test('unsettled or unknown effects cannot resume; projection cannot bypass canonical call identity', async () => {
  let effects = 0;
  const options = { toolExecutor: {
    definitions: [{ name: 'effect', description: 'fixture', inputSchema: {} }],
    async execute() { effects++; throw new Error('uncertain'); },
  }, provider: { async complete() { return batch(call('old'), call('skipped')); } } };
  const first = await createAgent(options).runTurn(turn());
  assert.equal(first.error.code, 'tool_exception');
  assert.equal(effects, 1);
  assertSettled(first);
  const resumed = await createAgent({ ...options, provider: {
    async complete() { assert.fail('unknown history must not reach model'); },
  } }).runTurn(turn({ turnId: 'next', history: first.messages }));
  assert.equal(resumed.error.code, 'unresolved_effect');
  assert.equal(effects, 1);
  assertSettled(resumed);
  const settled = [
    { role: 'assistant', content: '', toolCalls: [call('old')] },
    { role: 'tool', toolCallId: 'old', name: 'effect', outcome: { ok: true, content: 'confirmed' } },
  ];
  const duplicate = await createAgent({ ...options,
    contextBuilder: { async build() { return [{ role: 'user', content: 'compressed' }]; } },
  }).runTurn(turn({ history: settled }));
  assert.equal(duplicate.error.code, 'provider_protocol');
  assert.equal(effects, 1);
  assertSettled(duplicate);
});

test('context failure/cancellation gates providers; observers are nonblocking notifications', async () => {
  let providers = 0;
  const controller = new AbortController();
  const base = { tools: [], provider: { async complete() {
    providers++;
    return { kind: 'final', content: 'done' };
  } } };
  const invalid = await createAgent({ ...base, contextBuilder: { async build() {
    return [{ role: 'assistant', content: '', toolCalls: [call('dangling')] }];
  } } }).runTurn(turn());
  assert.equal(invalid.error.code, 'context_error');
  assert.equal(providers, 0);
  const cancelled = await createAgent({ ...base, contextBuilder: { async build(request) {
    controller.abort();
    return request.messages;
  } } }).runTurn(turn({ signal: controller.signal }));
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal(providers, 0);
  const observer = await createAgent({ ...base, observer: {
    observe() { return new Promise(() => {}); },
  } }).runTurn(turn());
  assert.equal(observer.reason, 'completed');
  assert.equal(observer.observerErrors.length, 1);
  assert.equal(observer.recording.status, 'memory');
  const rejectedObserver = await createAgent({ ...base, observer: {
    async observe() { throw new Error('invalid async observer'); },
  } }).runTurn(turn());
  assert.equal(rejectedObserver.reason, 'completed');
  assert.equal(rejectedObserver.observerErrors.length, 1);
  for (const result of [invalid, cancelled, observer]) assertSettled(result);
});

test('model budget applies after context projection; missing or conflicting capabilities are explicit', async () => {
  const provider = { async complete(request) {
    assert.deepEqual(request.messages, [{ role: 'user', content: 'summary' }]);
    return { kind: 'final', content: 'done' };
  } };
  const largeHistory = Array.from({ length: 6 }, () => ({ role: 'user', content: 'x'.repeat(200_000) }));
  const projected = await createAgent({ provider, tools: [],
    contextBuilder: { async build(request) {
      assert.equal(request.messages.length, 7);
      return [{ role: 'user', content: 'summary' }];
    } },
  }).runTurn(turn({ history: largeHistory }));
  assert.equal(projected.reason, 'completed');
  const unprojected = await createAgent({ provider, tools: [] }).runTurn(turn({ history: largeHistory }));
  assert.equal(unprojected.error.code, 'context_limit');
  assert.throws(() => createAgent({ tools: [] }), /provider/);
  assert.throws(() => createAgent({ provider }), /exactly one/);
  assert.throws(() => createAgent({ provider, tools: [], toolExecutor: { definitions: [], execute() {} } }), /exactly one/);
});

test('text tools constrain paths, bytes and UTF-8 without changing external files', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const sentinel = path.join(outside, 'sentinel');
  await writeFile(sentinel, 'untouched');
  await symlink(outside, path.join(root, 'escape'));
  await writeFile(path.join(root, 'large'), '123456789');
  await writeFile(path.join(root, 'invalid'), Buffer.from([0xff]));
  const [read, write] = createTextTools({ root, maxBytes: 8 });
  const invoke = (tool, args) => tool.execute(args, { ...scope, step: 1, toolCallId: 'test' }, new AbortController().signal);
  for (const relative of ['../sentinel', sentinel, 'escape/sentinel', `${root}-sibling/sentinel`]) {
    assert.equal((await invoke(write, { path: relative, content: 'oops' })).ok, false);
  }
  assert.equal((await invoke(read, { path: 'large' })).error.code, 'too_large');
  assert.equal((await invoke(read, { path: 'invalid' })).error.code, 'invalid_utf8');
  assert.equal((await invoke(write, { path: 'new', content: '123456789' })).error.code, 'too_large');
  assert.equal((await invoke(write, { path: 'new', content: 'ok', extra: true })).error.code, 'invalid_arguments');
  assert.equal((await invoke(write, { path: 'new', content: 'ok' })).ok, true);
  assert.equal((await invoke(write, { path: 'new', content: 'replaced' })).ok, true);
  assert.equal(await readFile(path.join(root, 'new'), 'utf8'), 'replaced');
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.agent-')));
});
