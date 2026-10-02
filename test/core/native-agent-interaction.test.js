import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCli, createMemoryDemoSessions } from '../../dist/nativeAgent/interaction/index.js';

async function eventually(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await tick();
  }
  assert.ok(check(), 'expected interaction did not arrive');
}

function terminal() {
  const input = new PassThrough();
  let text = '';
  const output = new Writable({ write(chunk, _encoding, callback) { text += chunk; callback(); } });
  return { input, output, text: () => text };
}

test('CLI submits without blocking cancel, settles actual results, and rebuilds from session facts', async () => {
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const sessions = createMemoryDemoSessions({
    provider: { complete: async (_request, signal) => {
      started();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { kind: 'final', content: 'provider returned after cancellation' };
    } },
    tools: [],
  });
  const io = terminal();
  const cli = await openCli({ sessions, ...io });
  try {
    io.input.write('hello\n');
    await running;
    io.input.write('/cancel\n');
    await eventually(() => io.text().includes('[ended: cancelled]'));
    assert.match(io.text(), /cancel requested/);
    assert.match(io.text(), /\[message user\] hello/);
    io.input.write('/new second\n/use demo-session-1\n/history 0\n');
    await eventually(() => io.text().includes('[history'));
    assert.match(io.text(), /selected demo-session-2/);
    cli.close();
    const reconnect = terminal();
    const reopened = await openCli({ sessions, ...reconnect, initialSessionId: 'demo-session-1' });
    try {
      await eventually(() => reconnect.text().includes('[ended: cancelled]'));
      assert.match(reconnect.text(), /hello/);
    } finally { reopened.close(); }
    assert.equal((await cli.done).reason, 'closed');
  } finally {
    cli.close();
    await sessions.close();
  }
});

test('display failure and EOF only detach: execution continues and history remains queryable', async () => {
  let release;
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const providerWait = new Promise(resolve => { release = resolve; });
  const sessions = createMemoryDemoSessions({
    provider: { complete: async () => {
      started();
      await providerWait;
      return { kind: 'final', content: 'confirmed' };
    } },
    tools: [],
  });
  const io = terminal();
  const cli = await openCli({ sessions, ...io });
  try {
    io.input.write('go\n');
    await began;
    io.output.emit('error', new Error('display offline'));
    assert.equal((await cli.done).reason, 'display-error');
    const before = await sessions.read('demo-session-1', 0, 20);
    assert.ok(before.activeTurnId);
    release();
    await eventually(() => sessions.activeCount === 0);
    const history = await sessions.history('demo-session-1', 0, 20);
    assert.equal(history.messages.at(-1).content, 'confirmed');
    const next = terminal();
    const reconnected = await openCli({ sessions, ...next, initialSessionId: 'demo-session-1' });
    next.input.end();
    assert.equal((await reconnected.done).reason, 'eof');
    assert.equal(next.input.listenerCount('data'), 0);
  } finally {
    release();
    cli.close();
    await sessions.close();
  }
});

test('incremental display is provisional, ordered, bounded and terminal-safe; refresh rereads facts', async () => {
  let listener;
  const scope = { sessionId: 's', turnId: 't' };
  const records = [
    { cursor: 1, kind: 'text_delta', ...scope, text: 'draft\u001b[2J' },
    { cursor: 2, kind: 'event', event: { ...scope, seq: 1, data: {
      type: 'message_appended', message: { role: 'assistant', content: 'confirmed', toolCalls: [] },
    } } },
    { cursor: 3, kind: 'event', event: { ...scope, seq: 2, data: { type: 'turn_ended', reason: 'completed' } } },
  ];
  let reads = 0;
  const sessions = {
    create: async () => ({ id: 's', title: 'fixture' }),
    list: async () => ({ sessions: [{ id: 's', title: 'fixture' }], nextOffset: null }),
    submit: async () => scope,
    cancel: async () => false,
    read: async (_id, after, limit) => {
      reads++;
      assert.ok(limit <= 20);
      const page = records.filter(record => record.cursor > after).slice(0, 1);
      return { records: page, cursor: page.at(-1)?.cursor ?? after, hasMore: after < 2, activeTurnId: null };
    },
    history: async () => ({
      messages: [{ role: 'tool', name: 'read', toolCallId: 'call', outcome: { ok: true, content: 'x'.repeat(10000) } }],
      nextOffset: 1,
    }),
    subscribe: (_id, callback) => { listener = callback; return () => { listener = undefined; }; },
  };
  const io = terminal();
  const cli = await openCli({ sessions, ...io });
  try {
    await eventually(() => io.text().includes('[ended: completed]'));
    const text = io.text();
    assert.ok(text.indexOf('[provisional') < text.indexOf('[message assistant]'));
    assert.ok(text.indexOf('[message assistant]') < text.indexOf('[ended: completed]'));
    assert.ok(!text.includes('\u001b'));
    io.input.write('/history 0\n/refresh\n');
    await eventually(() => io.text().includes('[truncated'));
    await eventually(() => reads >= 6);
    assert.match(io.text(), /next: \/history 1/);
    assert.ok(io.text().length < 8000);
    assert.ok(listener);
  } finally { cli.close(); }
  assert.equal(listener, undefined);
});

test('a real Writable failure closes observers without an unhandled stream error', async () => {
  const sessions = createMemoryDemoSessions({
    provider: { complete: async () => ({ kind: 'final', content: 'ok' }) }, tools: [],
  });
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('broken pipe')); } });
  const cli = await openCli({ sessions, input, output });
  try {
    assert.equal((await cli.done).reason, 'display-error');
    await tick();
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(output.listenerCount('error'), 0);
  } finally { cli.close(); await sessions.close(); }
});

test('input stream failure detaches readline without an unhandled interface error', async () => {
  const sessions = createMemoryDemoSessions({
    provider: { complete: async () => ({ kind: 'final', content: 'ok' }) }, tools: [],
  });
  const io = terminal();
  const cli = await openCli({ sessions, ...io });
  try {
    io.input.destroy(new Error('input disconnected'));
    assert.equal((await cli.done).reason, 'input-error');
    assert.equal(io.input.listenerCount('data'), 0);
  } finally { cli.close(); await sessions.close(); }
});

test('tool effects settle after cancellation, observer exceptions isolate, and exact turn identity is enforced', async () => {
  let toolStarted;
  const started = new Promise(resolve => { toolStarted = resolve; });
  let finishTool;
  const settle = new Promise(resolve => { finishTool = resolve; });
  const sessions = createMemoryDemoSessions({
    provider: { complete: async () => ({ kind: 'tool_calls', content: '', calls: [{ id: 'call', name: 'write', arguments: {} }] }) },
    tools: [{
      definition: { name: 'write', description: 'fixture', inputSchema: {} },
      validate: () => null,
      execute: async () => {
        toolStarted();
        await settle;
        return { ok: true, content: 'committed before cancellation settled' };
      },
    }],
  });
  const { id } = await sessions.create('settlement');
  const remove = sessions.subscribe(id, () => { throw new Error('UI unavailable'); });
  const io = terminal();
  const cli = await openCli({ sessions, ...io, initialSessionId: id });
  try {
    const scope = await sessions.submit(id, 'write');
    await started;
    await assert.rejects(sessions.submit(id, 'another'), /already running/);
    assert.equal(await sessions.cancel({ ...scope, turnId: 'stale' }), false);
    assert.equal(await sessions.cancel(scope), true);
    assert.equal(sessions.activeCount, 1);
    finishTool();
    await eventually(() => io.text().includes('[ended: cancelled]'));
    assert.ok(io.text().indexOf('[tool call') < io.text().indexOf('[tool running'));
    assert.ok(io.text().indexOf('[tool running') < io.text().indexOf('[tool result'));
    assert.ok(io.text().indexOf('[tool result') < io.text().indexOf('[ended: cancelled]'));
    const page = await sessions.history(id, 0, 20);
    assert.equal(page.messages.at(-1).outcome.ok, true);
    page.messages.length = 0;
    assert.ok((await sessions.history(id, 0, 20)).messages.length > 0);
  } finally {
    finishTool();
    remove();
    cli.close();
    await sessions.close();
  }
});

test('standalone mock CLI runs real tools and its owner removes disposable resources', { timeout: 5000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'interaction-entry-test-'));
  let child;
  let exited;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (exited) await exited;
    await rm(root, { recursive: true, force: true });
  });
  child = spawn(process.execPath, ['dist/nativeAgent/cliDemo.js'], {
    env: { ...process.env, TMPDIR: root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let text = '';
  let errors = '';
  let sent = false;
  let quit = false;
  child.stdout.on('data', chunk => {
    text += chunk;
    if (!sent && text.includes('[selected')) {
      sent = true;
      child.stdin.write('copy the fixture\n');
    }
    if (!quit && text.includes('[ended: completed]')) {
      quit = true;
      child.stdin.write('/history 0\n/quit\n');
    }
  });
  child.stderr.on('data', chunk => { errors += chunk; });
  const result = await exited;
  assert.equal(result.code, 0, errors);
  assert.equal(result.signal, null);
  assert.match(text, /\[tool result write /);
  assert.match(text, /\[history/);
  assert.deepEqual(await readdir(root), []);
});
