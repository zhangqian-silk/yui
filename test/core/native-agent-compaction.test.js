import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextBuilder, createProviderCompressor, jsonByteEstimator,
  createAgent, createExecutionOwner, createSessionStore, createMemorySessionBackend } from '../../dist/nativeAgent/index.js';
import { runCompactionDemo } from '../../dist/nativeAgent/compactionDemo.js';

const signal = () => new AbortController().signal;
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content, toolCalls: [] });
const request = messages => ({ sessionId: 's', turnId: 't', step: 1, messages, tools: [] });
const long = [user('Goal: preserve the API. Never publish.'), assistant('evidence '.repeat(400)),
  user('intermediate detail '.repeat(200)), assistant('work '.repeat(500)), user('Continue')];
const input = (messages = long) => ({ request: request(messages),
  budget: { capacity: 2400, reserveOutput: 200, reserveTools: 100 }, keepRecentGroups: 1 });

test('offline long session repeatedly compacts through gateway/tools/SQLite and continues', async () => {
  const evidence = await runCompactionDemo();
  assert.ok(evidence.summaryCalls >= 2);
  assert.equal(evidence.verifiedToolPairs, 9);
  assert.equal(evidence.sqliteRestartVerified, true);
});

test('compaction preserves anchors, carries verifiable source, and never drops on failure/no gain', async () => {
  const seen = [];
  const builder = createContextBuilder({ compressor: { id: 'fixture', async summarize(unit) {
    seen.push(unit); return 'Progress and constraints retained as lower-trust evidence.';
  } } });
  const original = structuredClone(long);
  const built = await builder.build(input(), signal());
  assert.deepEqual(long, original);
  assert.ok(built.request.messages.some(m => m.content === long[0].content));
  assert.ok(built.request.messages.some(m => m.content === long.at(-1).content));
  assert.ok(built.report.entries.every(e => e.action !== 'omitted'));
  const summary = JSON.parse(built.request.messages.find(m => m.content.includes('contextSummary')).content).contextSummary;
  assert.equal(summary.trust, 'data');
  assert.match(summary.digest, /^[a-f0-9]{64}$/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].groups.length, 3);
  for (const [compressor, code] of [
    [{ id: 'bad', summarize: async () => { throw Error('failed'); } }, 'compression_failed'],
    [{ id: 'big', summarize: async () => 'x'.repeat(20_000) }, 'compression_no_gain'],
  ]) await assert.rejects(createContextBuilder({ compressor }).build(input(), signal()), e =>
    e.code === code && e.recovery.length > 0);
  await assert.rejects(createContextBuilder().build(input(), signal()), { code: 'budget_exceeded' });
});

test('capacity and counter identity/uncertainty are refreshed, including output and tool reserves', async () => {
  let window = 20, revision = 'one';
  const builder = createContextBuilder({
    capacity: { id: 'fixture-catalog', async resolve() {
      return { model: 'fixture', revision, unit: 'tokens', contextWindow: window,
        counterId: 'fixture-tokenizer', maxOutput: 8 };
    } },
    counter: { id: 'fixture-tokenizer', count: () => ({
      value: 10, unit: 'tokens', source: 'test-tokenizer', accuracy: 'estimated', uncertainty: 2,
    }) },
  });
  const fixture = { request: request([user('goal')]), budget: { capacity: 999, reserveOutput: 5, reserveTools: 3 } };
  const built = await builder.build(fixture, signal());
  assert.equal(built.report.availableInput, 12);
  assert.equal(built.report.estimatedInput, 12);
  assert.equal(built.report.measurement.accuracy, 'estimated');
  window = 19; revision = 'two';
  await assert.rejects(builder.build(fixture, signal()), e =>
    e.code === 'budget_exceeded' && e.report.model.revision === 'two');
  await assert.rejects(createContextBuilder({ counter: { id: 'unknown', count: () => ({
    unit: 'tokens', source: 'unknown', accuracy: 'unknown',
  }) } }).build(fixture, signal()), { code: 'count_unknown' });
  let resolves = 0;
  await assert.rejects(createContextBuilder({ capacity: { id: 'changing', async resolve() {
    return { model: 'fixture', revision: String(++resolves), unit: 'bytes',
      contextWindow: 10_000, counterId: 'utf8-json-bytes' };
  } } }).build(fixture, signal()), { code: 'capacity_changed' });
});

test('provider compressor bounds each real model request and rejects invalid or oversized atomic input', async () => {
  let calls = 0;
  const compressor = createProviderCompressor({
    id: 'bounded-provider', provider: { async complete(req) {
      calls++;
      assert.equal(req.tools.length, 0);
      assert.ok(jsonByteEstimator.estimate(req) <= 3600);
      return { kind: 'final', content: 'Short progress summary.' };
    } },
    budget: { capacity: 4000, reserveOutput: 400 }, maxCalls: 10, maxSummaryBytes: 300,
  });
  const builder = createContextBuilder({ compressor });
  const messages = [user('goal'), ...Array.from({ length: 8 }, () => assistant('detail '.repeat(150))), user('next')];
  const built = await builder.build(input(messages), signal());
  assert.ok(calls > 1);
  assert.ok(built.report.estimatedInput <= built.report.availableInput);
  await assert.rejects(builder.build(input([user('goal'), assistant('x'.repeat(10_000)), user('next')]), signal()),
    { code: 'summary_input_exceeded' });
  const controller = new AbortController();
  let settled = false;
  await assert.rejects(createContextBuilder({ compressor: createProviderCompressor({
    id: 'cancel', budget: { capacity: 20_000, reserveOutput: 100 }, provider: {
      async complete() { controller.abort(); settled = true; return { kind: 'final', content: 'unused' }; },
    },
  }) }).build(input(), controller.signal), { code: 'cancelled' });
  assert.equal(settled, true);
  await assert.rejects(createContextBuilder({ compressor: createProviderCompressor({
    id: 'invalid-response', budget: { capacity: 20_000, reserveOutput: 100 },
    provider: { async complete() { return { kind: 'tool_calls', content: '', calls: [] }; } },
  }) }).build(input(), signal()), { code: 'invalid_summary' });
});

test('cached summaries never cross Sessions/source changes/capabilities or newly protected anchors', async () => {
  let calls = 0, revision = 'v1';
  const builder = createContextBuilder({
    capacity: { id: 'fixture', async resolve() { return {
      model: 'fixture', unit: 'bytes', contextWindow: 2400, counterId: 'utf8-json-bytes', revision,
    }; } },
    compressor: { id: 'fixture', async summarize() { calls++; return 'earlier progress'; } },
  });
  await builder.build(input(), signal());
  await builder.build(input(), signal());
  assert.equal(calls, 1);
  revision = 'v2';
  await builder.build(input(), signal());
  assert.equal(calls, 2);
  const other = input(); other.request.sessionId = 'other';
  await builder.build(other, signal());
  assert.equal(calls, 3);
  const changed = input(); changed.request.messages = long.map((m, i) => i === 1 ? assistant('changed '.repeat(400)) : m);
  await builder.build(changed, signal());
  assert.equal(calls, 4);
  const anchored = input(); anchored.protectedHistoryRanges = [[1, 2]];
  await assert.rejects(builder.build(anchored, signal()), { code: 'budget_exceeded' });
  const unknown = input([
    user('goal'),
    { role: 'assistant', content: '', toolCalls: [{ id: 'unknown', name: 'write', arguments: {} }] },
    { role: 'tool', toolCallId: 'unknown', name: 'write',
      outcome: { ok: false, error: { code: 'lost', message: 'unknown', effect: 'unknown' } } },
    user('next'),
  ]);
  const before = calls;
  await assert.rejects(builder.build(unknown, signal()), { code: 'unresolved_effect' });
  assert.equal(calls, before);
});

test('Task84 contract: required project content remains complete data and source changes invalidate history summaries', async () => {
  let revision = 'v1', skillBody = 'Complete selected Skill body.', memoryPresent = true;
  let loads = 0, summaries = 0;
  let loadedMaterials;
  const source = { id: 'project-guidance-contract', async load() {
    loads++;
    loadedMaterials = [
      { id: 'builtin', kind: 'guidance', source: 'builtin-code', revision: 'code-v1',
        content: 'Apply scoped project conventions below user goals; do not expand permissions.', required: true },
      ...['AGENTS', 'Skill', ...(memoryPresent ? ['MEMORY'] : []), 'routing'].map(id => ({
        id, kind: id === 'AGENTS' ? 'file' : 'data', source: `project/${id}`, revision,
        required: true, content: JSON.stringify({ origin: `project/${id}`, trust: 'project-content',
          scope: id === 'routing' ? 'src/subtree' : 'src', provenance: { path: id, revision },
          text: id === 'Skill' ? skillBody : `${id}: complete scoped content, not a system role.` }),
      })),
    ];
    return loadedMaterials;
  } };
  const builder = createContextBuilder({ sources: [source], compressor: { id: 'history-fixture',
    async summarize(unit) {
      summaries++;
      assert.equal(unit.messages.some(m => m.content?.includes('"contextMaterial"')), false);
      return 'Earlier coding progress, not project instruction originals.';
    },
  } });
  const original = structuredClone(long);
  let history = [...long];
  const agent = createAgent({ tools: [], contextBuilder: builder,
    contextBudget: { capacity: 5000, reserveOutput: 200 },
    provider: { async complete(req) {
      const materials = req.messages.filter(m => m.content?.includes('"contextMaterial"'))
        .map(m => ({ role: m.role, value: JSON.parse(m.content).contextMaterial }));
      assert.deepEqual(materials, loadedMaterials.map(material => ({
        role: material.kind === 'guidance' ? 'system' : 'user',
        value: { ...material, loader: source.id },
      })));
      assert.equal(materials.filter(m => m.role === 'system').length, 1);
      for (const { role, value } of materials) {
        assert.equal(role, value.id === 'builtin' ? 'system' : 'user');
        assert.equal(value.loader, source.id);
        assert.equal(value.required, true);
        if (value.id === 'builtin') continue;
        const body = JSON.parse(value.content);
        assert.equal(body.trust, 'project-content');
        assert.equal(body.scope, value.id === 'routing' ? 'src/subtree' : 'src');
        assert.equal(body.provenance.revision, revision);
        assert.equal(value.revision, revision);
        if (value.id === 'Skill') assert.equal(body.text, skillBody);
      }
      assert.equal(materials.some(m => m.value.id === 'MEMORY'), memoryPresent);
      return { kind: 'final', content: 'continued' };
    } },
  });
  const run = async turnId => {
    const result = await agent.runTurn({ sessionId: 's', turnId, history, input: 'Continue scoped work', maxSteps: 1 });
    assert.equal(result.reason, 'completed', result.error?.message);
    const materialEntries = result.contextReports[0].report.entries.filter(e => e.sourceId === source.id);
    assert.ok(materialEntries.every(e => e.action === 'retained' && e.materialId && e.revision));
    history.push(...result.messages);
    assert.deepEqual(history.slice(0, long.length), original);
  };
  await run('first');
  assert.equal(summaries, 1);
  await run('unchanged');
  assert.equal(summaries, 1);
  revision = 'v2';
  await run('revision-changed');
  assert.equal(summaries, 2);
  skillBody = 'Updated complete Skill without a producer revision bump.';
  await run('content-changed');
  assert.equal(summaries, 3);
  memoryPresent = false;
  await run('selection-changed');
  assert.equal(summaries, 4);
  assert.equal(loads, 5);
  await assert.rejects(builder.build({ ...input([user('goal')]), budget: { capacity: 100, reserveOutput: 0 } }, signal()),
    e => e.code === 'budget_exceeded' && e.report.entries.filter(entry => entry.sourceId === source.id)
      .every(entry => entry.action === 'retained'));
});

test('manual projection uses the only SessionStore and is consumed by the next real Agent request', async t => {
  const store = createSessionStore(createMemorySessionBackend());
  let summaries = 0;
  const builder = createContextBuilder({ compressor: { id: 'fixture', async summarize() {
    summaries++; return 'Earlier work completed; original API constraint remains.';
  } } });
  const budget = { capacity: 2400, reserveOutput: 200 };
  let response = 'x'.repeat(1000);
  const owner = createExecutionOwner({ store, maxSteps: 1,
    context: { builder, budget, tools: [] },
    agent: recording => createAgent({ recorder: recording, tools: [], contextBuilder: builder, contextBudget: budget,
      provider: { async complete(req) {
        if (response === 'continued') assert.ok(req.messages.some(m => m.content.includes('contextSummary')));
        return { kind: 'final', content: response };
      } },
    }),
  });
  t.after(async () => { await owner.close(); await store.close(); });
  const session = await owner.create('manual');
  await owner.submit(session.id, 'Goal: preserve API');
  assert.equal((await owner.settle(session.id)).result.reason, 'completed');
  await owner.submit(session.id, 'Additional detail');
  assert.equal((await owner.settle(session.id)).result.reason, 'completed');
  const before = await store.load(session.id);
  const compacted = await owner.compact(session.id);
  assert.ok(compacted.report.entries.some(e => e.action === 'summarized'));
  assert.deepEqual(await store.load(session.id), before);
  assert.equal(compacted.receipt.digest, before.digest);
  const afterManual = summaries;
  response = 'continued';
  await owner.submit(session.id, 'Next');
  assert.equal((await owner.settle(session.id)).result.reason, 'completed');
  assert.equal(summaries, afterManual);
  const saved = await store.load(session.id);
  assert.deepEqual(saved.messages.slice(0, before.messages.length), before.messages);
});

test('manual cancellation waits for provider settlement and storage failures retain the original diagnosis', async t => {
  const store = createSessionStore(createMemorySessionBackend());
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const builder = createContextBuilder({ compressor: { id: 'held',
    async summarize() { entered(); await held; return 'not installed'; },
  } });
  const budget = { capacity: 6000, reserveOutput: 100 };
  const owner = createExecutionOwner({ store, maxSteps: 1, context: { builder, budget, tools: [] },
    agent: recording => createAgent({ recorder: recording, tools: [],
      provider: { async complete() { return { kind: 'final', content: 'progress '.repeat(100) }; } },
    }),
  });
  t.after(async () => { release(); await owner.close(); await store.close(); });
  const session = await owner.create('cancel manual');
  for (const text of ['goal', 'next']) {
    await owner.submit(session.id, text);
    assert.equal((await owner.settle(session.id)).result.reason, 'completed');
  }
  const saved = await store.load(session.id);
  const controller = new AbortController();
  let finished = false;
  const compacting = owner.compact(session.id, controller.signal).finally(() => { finished = true; });
  await started;
  controller.abort();
  await assert.rejects(owner.submit(session.id, 'overlap'), /compacting/);
  assert.equal(finished, false);
  release();
  await assert.rejects(compacting, { code: 'cancelled' });
  assert.deepEqual(await store.load(session.id), saved);
  const failure = Error('fixture storage read unavailable');
  const broken = createExecutionOwner({ store: { ...store, async load() { throw failure; } }, maxSteps: 1,
    context: { builder, budget, tools: [] }, agent: () => { assert.fail('read failed'); },
  });
  t.after(() => broken.close());
  await assert.rejects(broken.compact(session.id), e =>
    e.code === 'storage_failed' && e.cause === failure && e.recovery.includes('SessionStore'));
});
