import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { createAgent, createCodingTools, createToolExecutor, createContextBuilder, createLocalObserver,
  createModelGateway, connectModelObservations, createInteractionDiagnostics, createSessionStore,
  createSqliteSessionBackend, createMemorySessionBackend, createExecutionOwner, openCli,
  createInteractionProgress } from '../../dist/nativeAgent/index.js';

const turn = { sessionId: 'composed', turnId: 'first', input: 'Read, edit, check, answer', maxSteps: 4 };
const batch = (id, name, args) => ({ kind: 'tool_calls', content: '', calls: [{ id, name, arguments: args }] });

test('all real modules compose read → edit → check → answer → SQLite restart through CLI', { timeout: 5000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-composed-'));
  const observer = createLocalObserver();
  const progress = createInteractionProgress();
  const detachBrokenDisplay = progress.subscribe(async () => { throw new Error('display unavailable'); });
  let store, owner, cli;
  t.after(async () => {
    cli?.close(); detachBrokenDisplay(); await owner?.close(); await store?.close();
    observer.close(); await rm(root, { recursive: true, force: true });
  });
  const filename = path.join(root, 'sessions.sqlite');
  store = createSessionStore(createSqliteSessionBackend(filename));
  await store.create('composed');
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
  const makeAgent = recording => createAgent({
    toolExecutor: executor, observer,
    recorder: { async record(event) {
      await recording.record(event);
      events.push(event);
      if (event.data.settlement) {
        assert.equal(trace.at(-1), 'release');
        trace.push(`record:${event.data.message.toolCallId}`);
      }
    } },
    contextBuilder: createContextBuilder({ sources: [{ id: 'selected-guide', async load(scope) {
      contexts.push(scope.step);
      return [{ id: 'rules', kind: 'guidance', source: 'fixture-guide', revision: 'r1', required: true, content: 'Bounded edits only' }];
    } }] }),
    contextBudget: { capacity: 100_000, reserveOutput: 1000 },
    provider: createModelGateway({
      endpoint: 'https://fixture.invalid/chat', model: 'offline-fixture', account: { kind: 'none' },
      stream: true, onObservation: connectModelObservations(observer, progress.observe),
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
      if (step === 5) {
        assert.ok(request.messages.some(m => m.content === 'Edit and local check confirmed'));
        response = { kind: 'final', content: 'Continued from saved facts' };
      }
      const frame = value => `data: ${JSON.stringify(value)}\n\n`;
      return new Response(frame({ choices: [{ index: 0, finish_reason: response.kind === 'final' ? 'stop' : 'tool_calls',
        delta: { role: 'assistant', content: response.content, ...(response.calls ? { tool_calls: response.calls.map((call, index) => ({
          index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })) } : {}) } }] })
        + frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }) + 'data: [DONE]\n\n',
      { headers: { 'x-request-id': `fixture-${step}` } });
    } }),
  });
  owner = createExecutionOwner({ store, agent: makeAgent, sessions: [{ id: 'composed', title: 'fixture' }],
    maxSteps: 4, observer });
  const input = new PassThrough();
  let text = '';
  const output = new Writable({ write(chunk, _encoding, callback) { text += chunk; callback(); } });
  cli = await openCli({ sessions: owner, input, output, initialSessionId: 'composed',
    diagnostics: createInteractionDiagnostics(observer), progress });
  input.write('Read, edit, check, answer\n');
  // Wait on the real execution owner, not a guessed UI terminal.
  let evidence;
  for (let i = 0; i < 100 && !evidence; i++) { await tick(); evidence = await owner.settle('composed'); }
  assert.ok(evidence);
  const result = evidence.result;
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
  input.write('/history\n/diagnostics\n');
  for (let i = 0; i < 100 && !text.includes('[history'); i++) await tick();
  assert.match(text, /\[submitted/);
  assert.match(text, /\[ended: completed\]/);
  assert.match(text, /\[provisional/);
  assert.match(text, /\[history/);
  const saved = await store.load('composed');
  assert.equal(evidence.receipt.digest, saved.digest);
  assert.equal(evidence.receipt.source.durability, 'persistent');
  assert.deepEqual(saved.messages, result.messages);
  assert.equal(saved.recovery.disposition, 'ready');
  cli.close(); await owner.close(); await store.close();
  store = createSessionStore(createSqliteSessionBackend(filename));
  assert.equal((await store.load('composed')).digest, saved.digest);
  owner = createExecutionOwner({ store, agent: makeAgent, maxSteps: 4,
    sessions: [{ id: 'composed', title: 'reopened' }], observer });
  assert.equal((await owner.read('composed', 0, 20)).activeTurnId, null);
  for (const event of saved.document.events) observer.observeEvent(event, 'replay');
  await owner.submit('composed', 'Continue after restart');
  assert.equal((await owner.settle('composed')).result.reason, 'completed');
  assert.equal((await store.load('composed')).messages.at(-1).content, 'Continued from saved facts');
  assert.equal(requestCount, 5);
});

test('cleanup and required settlement recording stop later effects without replacing confirmed results', async t => {
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
    const store = createSessionStore(createMemorySessionBackend());
    t.after(() => store.close());
    await store.create(turn.sessionId);
    const recording = await store.recorder(turn.sessionId);
    const result = await createAgent({
      toolExecutor: executor,
      recorder: { async record(event) {
        if (boundary === 'record' && event.data.settlement?.started) throw new Error('storage unavailable');
        await recording.record(event);
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
    if (boundary === 'cleanup') {
      assert.equal((await store.load(turn.sessionId)).recovery.disposition, 'cleanup-required');
      await assert.rejects(store.recorder(turn.sessionId), /recovery/);
    }
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

test('execution owner cancels exact Turn during successful intent recording without inventing storage failure', async t => {
  const store = createSessionStore(createMemorySessionBackend());
  let releaseRecord, intentWritten;
  const held = new Promise(resolve => { releaseRecord = resolve; });
  const started = new Promise(resolve => { intentWritten = resolve; });
  let executions = 0;
  const owner = createExecutionOwner({
    store, maxSteps: 1,
    agent: recording => createAgent({
      tools: [{ definition: { name: 'effect', description: '', inputSchema: {} }, validate: () => null,
        async execute() { executions++; return { ok: true, content: 'unexpected' }; } }],
      provider: { async complete() { return batch('one', 'effect', {}); } },
      recorder: { async record(event) {
        await recording.record(event);
        if (event.data.type === 'tool_started') { intentWritten(); await held; }
      } },
    }),
  });
  t.after(async () => { releaseRecord(); await owner.close(); await store.close(); });
  const session = await owner.create('cancel fixture');
  const scope = await owner.submit(session.id, 'execute');
  await started;
  await assert.rejects(owner.submit(session.id, 'overlap'), /already running/);
  assert.equal(await owner.cancel({ ...scope, turnId: 'stale' }), false);
  assert.equal(await owner.cancel(scope), true);
  assert.equal((await owner.read(session.id, 0, 20)).activeTurnId, scope.turnId);
  releaseRecord();
  const evidence = await owner.settle(session.id);
  assert.equal(evidence.result.reason, 'cancelled');
  assert.equal(evidence.result.error, undefined);
  assert.equal(evidence.result.recording.status, 'recorded');
  assert.equal(evidence.result.messages.at(-1).outcome.error.code, 'cancelled_before_start');
  assert.equal(executions, 0);
  assert.equal((await owner.read(session.id, 0, 20)).activeTurnId, null);
  assert.equal((await store.load(session.id)).recovery.disposition, 'ready');
});
