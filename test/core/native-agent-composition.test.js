import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgent, createCodingTools, createToolExecutor, createContextBuilder, createLocalObserver } from '../../dist/nativeAgent/index.js';

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
    provider: { async complete(request) {
      assert.equal(request.messages[0].role, 'system');
      if (request.step === 1) return batch('read', 'read', { path: 'input.txt' });
      if (request.step === 2) return batch('edit', 'edit', {
        path: 'input.txt', oldText: 'before', newText: 'after',
        expectedSha256: JSON.parse(request.messages.at(-1).outcome.content).sha256,
      });
      if (request.step === 3) return batch('check', 'command', { command: process.execPath, argv: [
        '-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("input.txt","utf8"),"after\\n")',
      ], cwd: root });
      assert.equal(JSON.parse(request.messages.at(-1).outcome.content).exitCode, 0);
      assert.equal(JSON.parse(request.messages.at(-1).outcome.content).processGroup, 'absent');
      return { kind: 'final', content: 'Edit and local check confirmed' };
    } },
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
