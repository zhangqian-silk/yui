import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  createAgent, createExecutionOwner, createSessionStore,
  createMemorySessionBackend, createSqliteSessionBackend,
} from '../../dist/nativeAgent/index.js';

test('public catalog: Memory/SQLite naming CAS, bounded history, restart discovery and owner continuation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-catalog-'));
  const file = join(directory, 'sessions.sqlite');
  const owned = [];
  let owner;
  try {
    for (const makeBackend of [createMemorySessionBackend, () => createSqliteSessionBackend(file)]) {
      const backend = makeBackend();
      // Catalog/history must not fall back to loading complete documents.
      const store = createSessionStore({
        ...backend, read: async () => { throw new Error('Full document read forbidden in queries'); },
      });
      owned.push(store);
      for (const id of ['c', 'a', 'b']) await store.create(id);
      const info = await store.getSessionInfo('a');
      assert.equal(info.title, null);
      await store.renameSession('a', '  Same title  ', info.metadataRevision);
      await store.renameSession('b', 'Same title', 0);
      await assert.rejects(store.renameSession('a', 'lost update', 0), { code: 'revision_conflict' });
      const first = await store.listSessions({ limit: 1 });
      assert.deepEqual(first.items.map(x => [x.sessionId, x.title]), [['a', 'Same title']]);
      const second = await store.listSessions({ limit: 1, cursor: first.nextCursor });
      assert.equal(second.items[0].sessionId, 'b');
      const third = await store.listSessions({ limit: 1, cursor: second.nextCursor });
      assert.equal(third.items[0].sessionId, 'c');
      assert.equal(third.nextCursor, null);
      await store.renameSession('a', null, 1);
      await assert.rejects(store.listSessions({ limit: 1, cursor: first.nextCursor }), { code: 'cursor_stale' });
      assert.equal((await store.getSessionInfo('a')).title, null);
      await assert.rejects(store.getSessionInfo('missing'), { code: 'not_found' });
      await assert.rejects(store.readHistory('missing'), { code: 'not_found' });
      await assert.rejects(store.listSessions({ cursor: 'invalid' }), { code: 'invalid_cursor' });
      for (const limit of [0, null, 1.5, 101]) {
        await assert.rejects(store.listSessions({ limit }), { code: 'invalid_query' });
      }
      const invalidPosition = JSON.parse(Buffer.from(second.nextCursor, 'base64url'));
      invalidPosition.after = 'not-a-saved-id';
      // Refresh revision after the title clear; a structurally valid forged
      // location is still not a saved Session in this store.
      invalidPosition.revision = (await store.listSessions()).catalogRevision;
      await assert.rejects(store.listSessions({ limit: 1,
        cursor: Buffer.from(JSON.stringify(invalidPosition)).toString('base64url') }), { code: 'invalid_cursor' });
      const events = [
        { sessionId: 'a', turnId: 't', seq: 1, data: { type: 'turn_started' } },
        { sessionId: 'a', turnId: 't', seq: 2, data: { type: 'turn_ended', reason: 'cancelled' } },
      ];
      for (let count = 1; count <= events.length; count++) {
        await backend.write({ schemaVersion: 2, sessionId: 'a', events: events.slice(0, count) }, count - 1);
      }
      const history = await store.readHistory('a', { limit: 1 });
      assert.deepEqual(history.records[0].event, events[0]);
      await store.renameSession('a', 'new title', 2);
      assert.deepEqual((await store.readHistory('a', { limit: 1, cursor: history.nextCursor })).records[0].event, events[1]);
      assert.deepEqual((await store.query('a', { after: 1, limit: 1 })).records[0].event, events[1]);
      const other = createSessionStore(createMemorySessionBackend());
      try {
        await assert.rejects(other.readHistory('a', { limit: 1, cursor: history.nextCursor }), { code: 'invalid_cursor' });
      } finally { await other.close(); }
      await store.close();
    }
    const store = createSessionStore(createSqliteSessionBackend(file));
    owned.push(store);
    let calls = 0;
    owner = createExecutionOwner({ store, maxSteps: 1, agent: recorder => createAgent({
      recorder, tools: [], provider: { async complete() {
        calls++;
        return { kind: 'final', content: 'answer' };
      } },
    }) });
    await owner.submit('b', 'hello');
    const evidence = await owner.settle('b');
    const saved = await store.load('b');
    let page = await store.readHistory('b', { limit: 2 });
    const records = [...page.records];
    const cursor = page.nextCursor;
    while (page.nextCursor !== null) {
      page = await store.readHistory('b', { limit: 2, cursor: page.nextCursor });
      records.push(...page.records);
    }
    assert.deepEqual(records.map(x => x.event), saved.document.events);
    assert.equal(calls, 1);
    assert.equal((await owner.read('b', 0, 2)).activeTurnId, null);
    await assert.rejects(store.readHistory('a', { limit: 2, cursor }), { code: 'invalid_cursor' });
    await assert.rejects(store.readHistory('b', { limit: 3, cursor }), { code: 'invalid_cursor' });
    const directoryPage = await store.listSessions({ limit: 1 });
    await owner.close(); owner = undefined;
    await store.close(); // All old connections closed, not only wrapper replaced.
    const reopened = createSessionStore(createSqliteSessionBackend(file));
    owned.push(reopened);
    assert.equal((await reopened.listSessions({ limit: 1, cursor: directoryPage.nextCursor })).items[0].sessionId, 'b');
    assert.equal((await reopened.getSessionInfo('b')).title, 'Same title');
    assert.equal((await reopened.load('b')).digest, evidence.receipt.digest);
    assert.equal((await reopened.readHistory('b', { limit: 2, cursor })).records[0].revision, 3);
    owner = createExecutionOwner({ store: reopened, maxSteps: 1, agent: recorder => createAgent({
      recorder, tools: [], provider: { async complete(request) {
        assert.deepEqual(request.messages.map(x => x.content), ['hello', 'answer', 'again']);
        return { kind: 'final', content: 'continued' };
      } },
    }) });
    await owner.submit('b', 'again');
    assert.equal((await owner.settle('b')).result.reason, 'completed');
    await assert.rejects(reopened.readHistory('b', { limit: 2, cursor }), { code: 'cursor_stale' });
  } finally {
    await owner?.close();
    await Promise.all(owned.map(store => store.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('metadata two-connection CAS and ambiguous acknowledgements never overwrite history or retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-metadata-'));
  const stores = [];
  try {
    const file = join(directory, 'sessions.sqlite');
    const a = createSessionStore(createSqliteSessionBackend(file));
    const b = createSessionStore(createSqliteSessionBackend(file));
    stores.push(a, b);
    await a.create('s');
    const oldReceipt = await a.load('s');
    const competing = await Promise.allSettled([
      a.renameSession('s', 'one', 0), b.renameSession('s', 'two', 0),
    ]);
    assert.equal(competing.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(competing.find(x => x.status === 'rejected').reason.code, 'revision_conflict');
    assert.equal((await a.load('s')).digest, oldReceipt.digest);
    const named = await a.getSessionInfo('s');
    await a.renameSession('s', named.title, named.metadataRevision);
    assert.equal((await b.getSessionInfo('s')).metadataRevision, 1);
    await a.append({ sessionId: 's', turnId: 't', seq: 1, data: { type: 'turn_started' } }, 0);
    await b.renameSession('s', 'after append', 1);
    assert.equal((await a.load('s')).revision, 1);
    assert.equal((await a.getSessionInfo('s')).title, 'after append');
    await a.close(); await b.close();

    const backend = createMemorySessionBackend();
    let attempts = 0;
    const store = createSessionStore({ ...backend, catalog: {
      ...backend.catalog,
      async renameSession(...args) {
        attempts++;
        const saved = await backend.catalog.renameSession(...args);
        throw new Error(`acknowledgement lost after revision ${saved.metadataRevision}`);
      },
      async listSessions() { throw new Error('read unavailable'); },
    } });
    stores.push(store);
    await store.create('s');
    await assert.rejects(store.renameSession('s', 'committed', 0), error =>
      error.code === 'metadata_save_failed' && error.effect === 'unknown'
        && error.expectedMetadataRevision === 0 && error.title === 'committed');
    assert.equal(attempts, 1);
    assert.equal((await store.getSessionInfo('s')).metadataRevision, 1);
    assert.equal((await store.getSessionInfo('s')).title, 'committed');
    await assert.rejects(store.listSessions(), { code: 'read_failed' });
    await store.close();
    await assert.rejects(store.getSessionInfo('s'), { code: 'closed' });
  } finally {
    await Promise.all(stores.map(store => store.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('v2 -> layout 3 preserves receipts and large history; invalid migration rolls back all rows and DDL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-layout-'));
  let db, store;
  try {
    const events = [
      { sessionId: 's', turnId: 't', seq: 1, data: { type: 'turn_started' } },
      { sessionId: 's', turnId: 't', seq: 2, data: { type: 'message_appended',
        message: { role: 'user', content: 'x'.repeat(900_000) } } },
      { sessionId: 's', turnId: 't', seq: 3, data: { type: 'step_started', step: 1 } },
      { sessionId: 's', turnId: 't', seq: 4, data: { type: 'message_appended', step: 1,
        message: { role: 'assistant', content: 'z'.repeat(900_000), toolCalls: [{ id: 'call', name: 'write', arguments: {} }] } } },
      { sessionId: 's', turnId: 't', seq: 5, data: { type: 'tool_started', step: 1, toolCallId: 'call', name: 'write' } },
      { sessionId: 's', turnId: 't', seq: 6, data: { type: 'message_appended', step: 1,
        message: { role: 'tool', toolCallId: 'call', name: 'write', outcome: { ok: true, content: 'y'.repeat(900_000) } },
        settlement: { started: true, status: 'succeeded', cancellationRequested: false, cleanup: { status: 'released' } } } },
      { sessionId: 's', turnId: 't', seq: 7, data: { type: 'step_ended', step: 1 } },
      { sessionId: 's', turnId: 't', seq: 8, data: { type: 'turn_ended', reason: 'cancelled' } },
    ];
    const text = JSON.stringify({ schemaVersion: 2, sessionId: 's', events });
    const digest = createHash('sha256').update(text).digest('hex');
    for (const corrupt of [true, false]) {
      const file = join(directory, `${corrupt}.sqlite`);
      db = new Database(file);
      const schema = 'CREATE TABLE sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL, digest TEXT NOT NULL)';
      db.exec(schema);
      db.pragma('application_id = 1312903985');
      db.pragma('user_version = 2');
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('s', events.length, text, digest);
      if (corrupt) db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('z', 0, '{}', 'invalid');
      db.close(); db = undefined;
      if (corrupt) {
        assert.throws(() => createSqliteSessionBackend(file), { code: 'corrupt_session' });
        db = new Database(file);
        assert.equal(db.pragma('user_version', { simple: true }), 2);
        assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all(), [{ sql: schema }]);
        assert.equal(db.prepare("SELECT document FROM sessions WHERE id='s'").get().document, text);
        assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 2);
        db.close(); db = undefined;
      } else {
        store = createSessionStore(createSqliteSessionBackend(file));
        assert.equal((await store.getSessionInfo('s')).digest, digest);
        const loaded = await store.load('s');
        assert.deepEqual(loaded.document.events, events);
        assert.equal(loaded.recovery.calls[0].settlement.cleanup.status, 'released');
        const bulk = await store.readHistory('s', { limit: 100 });
        assert.ok(bulk.records.length < events.length); // Byte cap, not only count cap.
        assert.ok(Buffer.byteLength(JSON.stringify(bulk)) <= 2 * 1024 * 1024);
        let page = await store.readHistory('s', { limit: 2 });
        const records = [...page.records];
        while (page.nextCursor !== null) {
          page = await store.readHistory('s', { limit: 2, cursor: page.nextCursor });
          assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2 * 1024 * 1024);
          records.push(...page.records);
        }
        assert.deepEqual(records.map(x => x.event), events);
        await store.close(); store = undefined;
        db = new Database(file);
        assert.equal(db.pragma('user_version', { simple: true }), 3);
        assert.equal(db.prepare("SELECT document FROM sessions WHERE id='s'").get().document, text);
        db.pragma('user_version = 99');
        db.close(); db = undefined;
        assert.throws(() => createSqliteSessionBackend(file), { code: 'unsupported_format' });
      }
    }
  } finally {
    db?.close(); await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
