import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createAgent } from '../../dist/nativeAgent/index.js';
import {
  createSessionStore, createMemorySessionBackend, createSqliteSessionBackend,
} from '../../dist/nativeAgent/session/index.js';

const event = (seq, data, turnId = 't1') => ({ sessionId: 's1', turnId, seq, data });
const call = { id: 'c1', name: 'write', arguments: { text: 'hello' } };
const prefix = [
  event(1, { type: 'turn_started' }),
  event(2, { type: 'message_appended', message: { role: 'user', content: 'write' } }),
  event(3, { type: 'step_started', step: 1 }),
  event(4, { type: 'message_appended', step: 1,
    message: { role: 'assistant', content: '', toolCalls: [call] } }),
];

test('session backends preserve restart history, receipts, CAS and bounded observation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-session-'));
  const file = join(directory, 'sessions.sqlite');
  const stores = [];
  try {
    for (const backend of [createMemorySessionBackend(), createSqliteSessionBackend(file)]) {
      const store = createSessionStore(backend);
      stores.push(store);
      await store.create('s1');
      let notified = 0;
      const unsubscribe = store.subscribe('s1', () => { notified++; throw new Error('UI gone'); });
      const recorder = await store.recorder('s1');
      const agent = createAgent({
        provider: { async complete() { return { kind: 'final', content: 'hello' }; } },
        tools: [], onEvent: async e => { await recorder.record(e); },
      });
      assert.equal((await agent.runTurn({
        sessionId: 's1', turnId: 't1', input: 'hi', maxSteps: 1,
      })).reason, 'completed');
      const saved = await store.load('s1');
      assert.equal(saved.recovery.disposition, 'ready');
      assert.deepEqual(saved.messages.map(m => m.content), ['hi', 'hello']);
      assert.equal(recorder.lastReceipt.revision, saved.revision);
      assert.equal(recorder.lastReceipt.source.id, backend.source.id);
      assert.equal(saved.recovery.turns[0].terminal.reason, 'completed');
      const first = await store.query('s1', { after: 0, limit: 2 });
      assert.equal(first.records.length, 2);
      assert.equal(first.nextCursor, 2);
      assert.equal((await store.query('s1', { after: first.nextCursor, limit: 100 })).nextCursor, null);
      await assert.rejects(store.append(event(1, { type: 'turn_started' }, 't2'), 0), /revision/i);
      await assert.rejects(store.query('s1', { limit: 0 }), /limit/i);
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(notified > 0);
      unsubscribe();
      const priorNotifications = notified;
      const second = await store.recorder('s1');
      await second.record(event(1, { type: 'turn_started' }, 't2'));
      await second.record(event(2, { type: 'turn_ended', reason: 'cancelled' }, 't2'));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(notified, priorNotifications);
      await store.close();
    }
    const reopened = createSessionStore(createSqliteSessionBackend(file));
    stores.push(reopened);
    const loaded = await reopened.load('s1');
    assert.equal(loaded.recovery.disposition, 'ready');
    assert.equal(loaded.recovery.turns.length, 2);
    assert.deepEqual(loaded.messages.map(m => m.content), ['hi', 'hello']);
    const continuation = await reopened.recorder('s1');
    const agent = createAgent({
      provider: { async complete(request) {
        assert.deepEqual(request.messages.map(m => m.content), ['hi', 'hello', 'again']);
        return { kind: 'final', content: 'continued after restart' };
      } },
      tools: [], onEvent: async e => { await continuation.record(e); },
    });
    assert.equal((await agent.runTurn({ sessionId: 's1', turnId: 't3', input: 'again',
      history: loaded.messages, maxSteps: 1 })).reason, 'completed');
    assert.equal((await reopened.load('s1')).messages.at(-1).content, 'continued after restart');
  } finally {
    await Promise.all(stores.map(store => store.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('recovery distinguishes unstarted, uncertain and settled effects without fabricating results', async () => {
  const store = createSessionStore(createMemorySessionBackend());
  try {
    await store.create('s1');
    for (const fact of prefix) await store.append(fact, fact.seq - 1);
    let state = await store.load('s1');
    assert.equal(state.recovery.disposition, 'interrupted');
    assert.equal(state.recovery.calls[0].status, 'not-started');
    assert.equal(state.messages.length, 2);
    await store.append(event(5, { type: 'tool_started', step: 1, toolCallId: 'c1', name: 'write' }), 4);
    state = await store.load('s1');
    assert.equal(state.recovery.disposition, 'unknown-effects');
    assert.equal(state.recovery.calls[0].status, 'unknown');
    await assert.rejects(store.recorder('s1'), /recovery/i);
    await assert.rejects(store.append(event(6, { type: 'turn_ended', reason: 'cancelled' }), 5), /unsettled|step/i);
    await store.append(event(6, { type: 'message_appended', step: 1,
      message: { role: 'tool', toolCallId: 'c1', name: 'write', outcome: { ok: true, content: 'written' } } }), 5);
    await store.append(event(7, { type: 'step_ended', step: 1 }), 6);
    await store.append(event(8, { type: 'turn_ended', reason: 'cancelled' }), 7);
    state = await store.load('s1');
    assert.equal(state.recovery.disposition, 'ready');
    assert.equal(state.recovery.calls[0].status, 'settled');
    assert.deepEqual(state.messages.at(-1).outcome, { ok: true, content: 'written' });
    await assert.rejects(store.append(event(9, { type: 'turn_ended', reason: 'completed' }), 8), /turn/i);
  } finally { await store.close(); }
});

test('required recorder failure blocks new effects and preserves exact unsaved evidence', async () => {
  const memory = createMemorySessionBackend();
  const failure = new Error('disk full');
  const backend = {
    source: memory.source, read: memory.read, close: memory.close,
    async write(document, expectedRevision) {
      if (document.events.at(-1)?.data.type === 'tool_started') throw failure;
      await memory.write(document, expectedRevision);
    },
  };
  const store = createSessionStore(backend);
  try {
    await store.create('s1');
    const recorder = await store.recorder('s1');
    let executions = 0;
    const agent = createAgent({
      provider: { async complete() { return { kind: 'tool_calls', content: '', calls: [call] }; } },
      tools: [{ definition: { name: 'write', description: '', inputSchema: {} },
        validate: () => null, async execute() { executions++; return { ok: true, content: 'done' }; } }],
      onEvent: async e => { await recorder.record(e); },
    });
    const result = await agent.runTurn({ sessionId: 's1', turnId: 't1', input: 'write', maxSteps: 1 });
    assert.equal(result.reason, 'error');
    assert.equal(executions, 0);
    assert.equal(recorder.failure.cause, failure);
    assert.equal(recorder.failure.event.data.type, 'tool_started');
    assert.equal(recorder.lastReceipt.revision, 4);
    assert.equal((await store.load('s1')).recovery.calls[0].status, 'not-started');
    await assert.rejects(recorder.record(event(5, { type: 'step_ended', step: 1 })), /recorder/i);
  } finally { await store.close(); }
});

test('SQLite restart exposes an interrupted effect; stale writers and malformed records fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-session-recovery-'));
  const filename = join(directory, 'state.sqlite');
  const stores = [];
  let diagnosticDb;
  try {
    const first = createSessionStore(createSqliteSessionBackend(filename));
    const concurrent = createSessionStore(createSqliteSessionBackend(filename));
    stores.push(first, concurrent);
    await first.create('s1');
    await first.create('race');
    const competing = await Promise.allSettled([first, concurrent].map(store =>
      store.append({ sessionId: 'race', turnId: 'race-turn', seq: 1, data: { type: 'turn_started' } }, 0)));
    assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(competing.find(result => result.status === 'rejected').reason.cause.code, 'revision_conflict');
    assert.equal((await first.load('race')).revision, 1);
    const writer = await first.recorder('s1');
    const stale = await concurrent.recorder('s1');
    for (const fact of prefix) await writer.record(fact);
    await assert.rejects(stale.record(prefix[0]), /revision/i);
    await writer.record(event(5, { type: 'tool_started', step: 1, toolCallId: 'c1', name: 'write' }));
    await first.close();
    await concurrent.close();
    const restarted = createSessionStore(createSqliteSessionBackend(filename));
    stores.push(restarted);
    assert.equal((await restarted.load('s1')).recovery.calls[0].status, 'unknown');
    await assert.rejects(restarted.recorder('s1'), /recovery/i);
    await restarted.close();
    diagnosticDb = new Database(filename);
    const good = diagnosticDb.prepare("SELECT document FROM sessions WHERE id = 's1'").get().document;
    // A valid SQLite transaction containing a semantically malformed fact must
    // also be rejected, even if its content digest matches.
    const malformed = JSON.parse(good);
    malformed.events[4].data.toolCallId = 'another-call';
    const text = JSON.stringify(malformed);
    diagnosticDb.prepare("UPDATE sessions SET document = ?, digest = ? WHERE id = 's1'")
      .run(text, createHash('sha256').update(text).digest('hex'));
    const reader = createSessionStore(createSqliteSessionBackend(filename));
    stores.push(reader);
    await assert.rejects(reader.load('s1'), /malformed/);
    assert.equal(diagnosticDb.prepare("SELECT document FROM sessions WHERE id = 's1'").get().document, text);
    diagnosticDb.prepare("UPDATE sessions SET document = ? WHERE id = 's1'").run(good.slice(0, -5));
    await assert.rejects(reader.load('s1'), /malformed/);
    await reader.close();
    diagnosticDb.pragma('user_version = 2');
    assert.throws(() => createSqliteSessionBackend(filename), /version-1/);
    assert.equal(diagnosticDb.pragma('user_version', { simple: true }), 2);
  } finally {
    diagnosticDb?.close();
    await Promise.all(stores.map(store => store.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('unknown result remains authoritative; ambiguous save acknowledgement is not replay permission', async () => {
  const memory = createMemorySessionBackend();
  let fail = false;
  const store = createSessionStore({
    source: memory.source, read: memory.read, close: memory.close,
    async write(document, expected) {
      await memory.write(document, expected);
      if (fail) throw new Error('acknowledgement lost after commit');
    },
  });
  try {
    await store.create('s1');
    const recorder = await store.recorder('s1');
    for (const fact of prefix) await recorder.record(fact);
    fail = true;
    await assert.rejects(recorder.record(event(5, {
      type: 'tool_started', step: 1, toolCallId: 'c1', name: 'write',
    })), /save failed/);
    assert.equal(recorder.lastReceipt.revision, 4);
    assert.equal(recorder.failure.effect, 'unknown');
    assert.equal((await store.load('s1')).revision, 5);
    assert.equal((await store.load('s1')).recovery.disposition, 'unknown-effects');
    fail = false;
    // Explicit settlement records an unknown result, not an invented success.
    await store.append(event(6, { type: 'message_appended', step: 1,
      message: { role: 'tool', toolCallId: 'c1', name: 'write',
        outcome: { ok: false, error: { code: 'interrupted', message: 'effect unknown', effect: 'unknown' } } } }), 5);
    await store.append(event(7, { type: 'step_ended', step: 1 }), 6);
    await store.append(event(8, { type: 'turn_ended', reason: 'error' }), 7);
    const state = await store.load('s1');
    assert.equal(state.recovery.disposition, 'unknown-effects');
    assert.equal(state.recovery.calls[0].resultRevision, 6);
    await assert.rejects(store.recorder('s1'), /recovery/);
    await assert.rejects(store.append(event(1, { type: 'turn_started' }, 't2'), 8), /unknown effects/);
  } finally { await store.close(); }
});
