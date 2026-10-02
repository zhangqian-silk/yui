import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgent, createCodingTools, createToolExecutor, createContextBuilder, createLocalObserver,
  createModelGateway, connectModelObservations, createInteractionDiagnostics } from '../../dist/nativeAgent/index.js';

const turn = { sessionId: 'composed', turnId: 'first', input: 'Read, edit, check, answer', maxSteps: 4 };
const batch = (id, name, args) => ({ kind: 'tool_calls', content: '', calls: [{ id, name, arguments: args }] });

test('real context/tools/observer compose read → exact edit → local check → answer with required settlements', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-composed-'));
  const observer = createLocalObserver();
  t.after(async () => { observer.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'input.txt'), 'before\n');
  const trace = [];
  const events = [];
  const tools = createCodingTools({ root, command: { env: {} } });
  const executor = createToolExecutor({
    tools,
    environment: { async acquire() { return { value: { root }, async release() { trace.push('release'); } }; } },
    permission: { async check(invocation, environment) {
      assert.equal(environment.root, root);
      trace.push(`allow:${invocation.call.id}`);
      return { allowed: true };
    } },
  });
  const contexts = [];
  let requestCount = 0;
  const result = await createAgent({
    toolExecutor: executor, observer,
    recorder: { async record(event) {
      events.push(event);
      if (event.data.settlement) {
        assert.equal(trace.at(-1), 'release');
        trace.push(`record:${event.data.settlement.identity.toolCallId}`);
      }
    } },
    contextBuilder: createContextBuilder({ sources: [{ id: 'selected-guide', async load(scope) {
      contexts.push(scope.step);
      return [{ id: 'rules', kind: 'guidance', source: 'fixture-guide', revision: 'r1', required: true, content: 'Bounded edits only' }];
    } }] }),
    contextBudget: { capacity: 100_000, reserveOutput: 1000 },
    provider: createModelGateway({
      endpoint: 'https://fixture.invalid/chat', model: 'offline-fixture', account: { kind: 'none' },
      onObservation: connectModelObservations(observer),
      async transport(_endpoint, init) {
      const request = JSON.parse(init.body);
      assert.equal(request.messages[0].role, 'system');
      const step = ++requestCount;
      let response;
      if (step === 1) response = batch('read', 'read', { path: 'input.txt' });
      if (step === 2) response = batch('edit', 'edit', {
        path: 'input.txt', oldText: 'before', newText: 'after',
        expectedSha256: JSON.parse(JSON.parse(request.messages.at(-1).content).content).sha256,
      });
      if (step === 3) response = batch('check', 'command', { command: process.execPath, argv: [
        '-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("input.txt","utf8"),"after\\n")',
      ], cwd: root });
      if (step === 4) {
        const checked = JSON.parse(JSON.parse(request.messages.at(-1).content).content);
        assert.equal(checked.exitCode, 0);
        assert.equal(checked.processGroup, 'absent');
        response = { kind: 'final', content: 'Edit and local check confirmed' };
      }
      return Response.json({ choices: [{ index: 0, finish_reason: response.kind === 'final' ? 'stop' : 'tool_calls',
        message: { role: 'assistant', content: response.content, ...(response.calls ? { tool_calls: response.calls.map(call => ({
          id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })) } : {}) } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
      { headers: { 'x-request-id': `fixture-${step}` } });
    } }),
  }).runTurn(turn);
  assert.equal(result.reason, 'completed');
  assert.deepEqual(contexts, [1, 2, 3, 4]);
  assert.equal(result.contextReports.length, 4);
  assert.ok(result.contextReports.every(r => r.report.reserveOutput === 1000
    && r.report.entries.some(e => e.source === 'fixture-guide' && e.revision === 'r1')));
  assert.equal(await readFile(path.join(root, 'input.txt'), 'utf8'), 'after\n');
  assert.deepEqual(events, result.events);
  assert.deepEqual(events.filter(e => e.data.settlement).map(e => e.data.settlement.cleanup.status),
    ['released', 'released', 'released']);
  assert.equal(observer.health().rejected, 0);
  assert.equal(observer.query().records.at(-1).status, 'completed');
  const models = observer.query().records.filter(r => r.kind === 'model');
  assert.equal(models.length, 4);
  assert.ok(models.every(r => r.source === 'live' && r.clientRequestId && r.providerRequestId
    && r.elapsedMs >= 0 && r.durationMs === undefined && r.usage.totalTokens === 15));
  const diagnostic = createInteractionDiagnostics(observer);
  const page = await diagnostic.query('composed', 0, 20);
  assert.equal(page.lines.length, 20);
  assert.notEqual(page.nextOffset, null);
  assert.equal(JSON.parse(page.lines[0]).gap, false);
  assert.equal(JSON.parse(await diagnostic.health()).rejected, 0);
});

test('cleanup and required settlement recording stop later effects without replacing confirmed results', async () => {
  for (const boundary of ['cleanup', 'record']) {
    let executions = 0;
    let models = 0;
    const executor = createToolExecutor({
      tools: [{ definition: { name: 'effect', description: 'fixture', inputSchema: {} }, validate: () => null,
        async execute() { executions++; return { ok: true, content: 'confirmed' }; } }],
      environment: { async acquire() { return { value: {}, async release() {
        if (boundary === 'cleanup') throw new Error('lease remains');
      } }; } },
      permission: { async check() { return { allowed: true }; } },
    });
    const result = await createAgent({
      toolExecutor: executor,
      recorder: { async record(event) {
        if (boundary === 'record' && event.data.settlement?.started) throw new Error('storage unavailable');
      } },
      provider: { async complete() {
        models++;
        return { kind: 'tool_calls', content: '', calls: [
          { id: 'one', name: 'effect', arguments: {} }, { id: 'two', name: 'effect', arguments: {} },
        ] };
      } },
    }).runTurn(turn);
    assert.equal(result.reason, 'error');
    assert.equal(executions, 1);
    assert.equal(models, 1);
    assert.equal(result.messages[2].outcome.content, 'confirmed');
    assert.equal(result.messages[3].outcome.error.effect, 'none');
    const settlement = result.events.find(e => e.data.settlement?.started).data.settlement;
    assert.equal(settlement.cleanup.status, boundary === 'cleanup' ? 'failed' : 'released');
    assert.equal(result.recording.status, boundary === 'record' ? 'failed' : 'recorded');
    assert.equal(result.events.filter(e => e.data.type === 'turn_ended').length, 1);
  }
});

test('real context overflow preserves its report and never falls back to an unbudgeted model request', async () => {
  const result = await createAgent({
    tools: [], contextBuilder: createContextBuilder(), contextBudget: { capacity: 1, reserveOutput: 0 },
    provider: { async complete() { assert.fail('budget failure must stop model'); } },
  }).runTurn(turn);
  assert.equal(result.reason, 'error');
  assert.equal(result.contextReports[0].status, 'failed');
  assert.ok(result.contextReports[0].report.estimatedInput > 1);
});
