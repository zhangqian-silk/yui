import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextBuilder, jsonByteEstimator } from '../../dist/nativeAgent/context/index.js';

const signal = () => new AbortController().signal;
const user = content => ({ role: 'user', content });
const pair = [
  { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read', arguments: {} }] },
  { role: 'tool', toolCallId: 'call-1', name: 'read', outcome: { ok: true, content: 'file' } },
];
const request = messages => ({ sessionId: 's', turnId: 't', step: 1, messages, tools: [] });
const input = (messages, capacity = 100) => ({
  request: request(messages), budget: { capacity, reserveOutput: 0 }, keepRecentGroups: 0,
});
const estimator = { id: 'message-count', estimate: req => req.messages.length };

test('context summarizes complete tool batches, preserves original goal/instructions and source history', async () => {
  const messages = [{ role: 'system', content: 'rules' }, user('old'), ...pair, user('current')];
  const original = structuredClone(messages);
  const result = await createContextBuilder({ estimator, compressor: { id: 'fixture',
    summarize: async () => 'earlier paired result' } }).build(input(messages, 4), signal());
  assert.deepEqual(result.request.messages.slice(0, 2), messages.slice(0, 2));
  assert.deepEqual(result.request.messages.at(-1), messages[4]);
  assert.deepEqual(messages, original);
  assert.equal(result.report.estimatedInput, 4);
  assert.deepEqual(result.report.entries.find(e => e.historyRange?.[0] === 2).historyRange, [2, 4]);
  assert.equal(result.report.entries.find(e => e.historyRange?.[0] === 2).action, 'summarized');
  await assert.rejects(createContextBuilder({ estimator }).build(input(messages, 3), signal()), { code: 'budget_exceeded' });
  assert.ok(Object.isFrozen(result.request.messages));
  await assert.rejects(createContextBuilder({ estimator }).build(input([user('q'), pair[0]]), signal()),
    { code: 'invalid_history' });
});

test('every step rebuilds with explicit sources and complete request estimation; required overflow is diagnostic', async () => {
  const scopes = [];
  const source = { id: 'selected', load: async scope => {
    scopes.push(scope.step);
    return [{ id: 'guide', kind: 'guidance', content: 'project rule', source: 'project-guide', revision: 'r1', required: true },
      { id: 'file', kind: 'file', content: 'selected text', source: 'selected/file.txt', revision: 'sha1', required: false }];
  } };
  const builder = createContextBuilder({ sources: [source], estimator: {
    id: 'with-tools', estimate: req => req.messages.length + req.tools.length * 2,
  } });
  const first = input([user('q')], 5);
  first.request.tools = [{ name: 'read', description: '', inputSchema: {} }];
  const result = await builder.build(first, signal());
  assert.equal(result.report.estimatedInput, 5);
  assert.equal(result.report.entries.find(e => e.materialId === 'file').revision, 'sha1');
  assert.equal(result.request.messages[0].role, 'system');
  const next = { ...first, request: { ...first.request, step: 2, messages: [user('q'), ...pair] } };
  await assert.rejects(builder.build(next, signal()), error =>
    error.code === 'budget_exceeded' && error.report.estimatedInput === 7);
  assert.deepEqual(scopes, [1, 2]);
});

test('replaceable compression summarizes whole optional batches without fabricating tool results', async () => {
  const seen = [];
  const builder = createContextBuilder({ estimator, compressor: { id: 'fake-summary',
    summarize: async unit => { seen.push(unit); return 'earlier evidence'; },
  } });
  const result = await builder.build(input([...pair, user('new')], 2), signal());
  assert.equal(seen[0].messages.length, 2);
  assert.ok(Object.isFrozen(seen[0].messages));
  assert.equal(result.report.entries[0].action, 'summarized');
  assert.equal(result.request.messages[0].role, 'user');
  assert.match(result.request.messages[0].content, /earlier evidence/);
  assert.match(result.request.messages[0].content, /summary/);
  assert.equal(result.request.messages.some(m => m.role === 'tool'), false);
  const facts = JSON.parse(result.request.messages[0].content).contextSummary.sources[0].toolOutcomes;
  assert.deepEqual(facts, [{ toolCallId: 'call-1', name: 'read', ok: true }]);
});

test('failures and cooperative cancellation return no partial request or fallback', async () => {
  await assert.rejects(createContextBuilder({ sources: [{ id: 'broken', load: async () => { throw Error('secret'); } }] })
    .build(input([user('q')]), signal()), { code: 'source_failed' });
  await assert.rejects(createContextBuilder({ estimator: { id: 'invalid', estimate: () => NaN } })
    .build(input([user('q')]), signal()), { code: 'invalid_estimate' });
  const controller = new AbortController();
  let settled = false;
  const builder = createContextBuilder({ sources: [{ id: 'cancel', load: async () => {
    controller.abort(); settled = true; return [];
  } }] });
  await assert.rejects(builder.build(input([user('q')]), controller.signal), { code: 'cancelled' });
  assert.equal(settled, true);
  await assert.rejects(createContextBuilder({ estimator, compressor: {
    id: 'broken', summarize: async () => { throw Error('secret'); },
  } }).build(input([...pair, user('q')], 2), signal()), { code: 'compression_failed' });
});

test('byte budgets honor output reserve, exact limits and recent retention with no-gain summaries', async () => {
  const messages = [user('goal'), { role: 'assistant', content: 'old '.repeat(100), toolCalls: [] }, user('new')];
  const full = request(messages);
  const bytes = jsonByteEstimator.estimate(full);
  const builder = createContextBuilder();
  const exact = await builder.build({ ...input(messages, bytes + 10),
    budget: { capacity: bytes + 10, reserveOutput: 10 } }, signal());
  assert.deepEqual(exact.request, full);
  await assert.rejects(builder.build(input(messages, bytes - 1), signal()), { code: 'budget_exceeded' });
  await assert.rejects(builder.build({ ...input(messages, bytes - 1), keepRecentGroups: 3 }, signal()),
    { code: 'budget_exceeded' });
  await assert.rejects(createContextBuilder({ compressor: { id: 'larger',
    summarize: async () => 'summary '.repeat(1000),
  } }).build(input(messages, bytes - 1), signal()), { code: 'compression_no_gain' });
});

test('one batch includes out-of-order paired results and cannot be partially retained', async () => {
  const batch = [
    { ...pair[0], toolCalls: [...pair[0].toolCalls, { id: 'call-2', name: 'write', arguments: {} }] },
    { role: 'tool', toolCallId: 'call-2', name: 'write', outcome: { ok: false,
      error: { code: 'denied', message: 'denied', effect: 'none' } } },
    pair[1],
  ];
  const result = await createContextBuilder({ estimator, compressor: { id: 'paired-summary',
    summarize: async unit => { assert.deepEqual(unit.messages, batch); return 'read confirmed; write denied'; },
  } }).build(input([...batch, user('new')], 3), signal());
  assert.deepEqual(result.request.messages.at(-1), user('new'));
  assert.equal(result.request.messages.some(m => m.role === 'tool'), false);
  assert.deepEqual(result.report.entries[0].historyRange, [0, 3]);
  const facts = JSON.parse(result.request.messages[0].content).contextSummary.sources[0].toolOutcomes;
  assert.deepEqual(facts, [{ toolCallId: 'call-2', name: 'write', ok: false, errorCode: 'denied', effect: 'none' },
    { toolCallId: 'call-1', name: 'read', ok: true }]);
  await assert.rejects(createContextBuilder({ estimator }).build(input([...pair, ...pair, user('new')]), signal()),
    { code: 'invalid_history' });
});
