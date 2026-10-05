import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  createSessionStore, createMemorySessionBackend, createSqliteSessionBackend,
} from '../../dist/nativeAgent/index.js';

const location = { root: '/caller-controlled/not-probed', cwd: '/caller-controlled/not-probed/src' };
const hash = text => createHash('sha256').update(text).digest('hex');
const empty = id => ({ schemaVersion: 2, sessionId: id, events: [] });
const closedTurn = id => [
  { sessionId: id, turnId: 't', seq: 1, data: { type: 'turn_started' } },
  { sessionId: id, turnId: 't', seq: 2, data: { type: 'turn_ended', reason: 'cancelled' } },
];

test('immutable creation location: real backends, bounded ID detail, input isolation and all-connections restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-location-'));
  const owned = [];
  try {
    const file = join(directory, 'sessions.sqlite');
    for (const make of [createMemorySessionBackend, () => createSqliteSessionBackend(file)]) {
      const backend = make();
      let fullRead = true;
      const store = createSessionStore({ ...backend, async read(id) {
        if (!fullRead) throw new Error('No full load in bounded detail');
        return backend.read(id);
      } });
      owned.push(store);
      await store.create('old');
      assert.equal((await store.getSessionInfo('old')).location, null);
      const input = { ...location };
      const receipt = await store.create('s', input);
      input.cwd = '/changed';
      const detail = await store.getSessionInfo('s');
      assert.deepEqual(detail.location, location);
      assert.ok(Object.isFrozen(detail.location));
      assert.equal(detail.digest, receipt.digest);
      // No new history fact or rewritten document digest; same empty document.
      assert.deepEqual((await store.load('s')).document, empty('s'));
      const direct = await backend.catalog.getSessionInfo('s');
      direct.location.cwd = '/changed-again';
      assert.deepEqual((await store.getSessionInfo('s')).location, location);
      await store.renameSession('s', 'name is not a path', 0);
      for (const [at, event] of closedTurn('s').entries()) await store.append(event, at);
      assert.deepEqual((await store.getSessionInfo('s')).location, location);
      await assert.rejects(store.create('s', { root: '/other', cwd: '/other' }),
        error => error.effect === 'unknown' && error.cause.code === 'revision_conflict');
      await assert.rejects(backend.createWithLocation(empty('s'), { root: '/other', cwd: '/other' }),
        { code: 'revision_conflict' });
      assert.deepEqual((await store.getSessionInfo('s')).location, location);
      const first = await store.readHistory('s', { limit: 1 });
      await store.renameSession('s', 'new title', 1);
      assert.deepEqual((await store.readHistory('s', { limit: 1, cursor: first.nextCursor })).records[0].event,
        closedTurn('s')[1]);
      // Detail contract does not invoke read(), even when document load is unavailable.
      fullRead = false;
      assert.deepEqual((await store.getSessionInfo('s')).location, location);
      fullRead = true;
      const page = await store.listSessions({ limit: 1 });
      assert.equal(Object.hasOwn(page.items[0], 'location'), false);
      const saved = await store.load('s');
      await store.close();
      if (make !== createMemorySessionBackend) {
        const reopened = createSessionStore(createSqliteSessionBackend(file));
        owned.push(reopened);
        assert.deepEqual((await reopened.getSessionInfo('s')).location, location);
        assert.equal((await reopened.load('s')).digest, saved.digest);
        assert.equal((await reopened.listSessions({ limit: 1, cursor: page.nextCursor })).items[0].sessionId, 's');
        assert.equal((await reopened.readHistory('s', { limit: 1, cursor: first.nextCursor })).records[0].revision, 2);
        await reopened.close();
      }
    }
  } finally {
    await Promise.all(owned.map(store => store.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('location refusal, transaction failure, competing creates and lost acknowledgement never replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-location-failure-'));
  const owned = [];
  let db;
  try {
    const file = join(directory, 'sessions.sqlite');
    for (const make of [createMemorySessionBackend, () => createSqliteSessionBackend(file)]) {
      const backend = make();
      const store = createSessionStore(backend);
      owned.push(store);
      const bad = [null, [], {}, { ...location, grant: 'not metadata' },
        { root: 'relative', cwd: '/a' }, { root: '/a', cwd: '/ab' },
        { root: '/a', cwd: '/a/../outside' }, { root: '/a', cwd: '/a/' },
        { root: '/a', cwd: '/a/\0' }, { root: '/a', cwd: '/a/\ud800' },
        { root: '/a', cwd: '/a/' + 'x'.repeat(4096) }];
      for (const value of bad) {
        await assert.rejects(store.create('bad', value), { code: 'invalid_location' });
        await assert.rejects(backend.createWithLocation(empty('bad'), value), { code: 'invalid_location' });
      }
      assert.equal((await store.listSessions()).items.length, 0);
      await store.close();
      const { createWithLocation: omitted, ...minimal } = createMemorySessionBackend();
      const legacy = createSessionStore(minimal);
      owned.push(legacy);
      await assert.rejects(legacy.create('unsupported', location), { code: 'unsupported_location' });
      await legacy.create('compatible');
      assert.equal((await legacy.getSessionInfo('compatible')).location, null);
      await legacy.close();
      const lostBackend = make();
      let writes = 0;
      const lost = createSessionStore({ ...lostBackend, async createWithLocation(...args) {
        writes++;
        await lostBackend.createWithLocation(...args);
        throw new Error('commit succeeded but acknowledgement lost');
      } });
      owned.push(lost);
      await assert.rejects(lost.create('lost', location), error =>
        error.code === 'save_failed' && error.effect === 'unknown'
        && error.sessionId === 'lost' && error.expectedRevision === null
        && JSON.stringify(error.location) === JSON.stringify(location));
      assert.equal(writes, 1);
      assert.deepEqual((await lost.getSessionInfo('lost')).location, location);
      assert.deepEqual((await lost.load('lost')).document, empty('lost'));
      assert.equal(writes, 1);
      await lost.close();
    }
    const a = createSessionStore(createSqliteSessionBackend(file));
    const b = createSessionStore(createSqliteSessionBackend(file));
    owned.push(a, b);
    const competing = await Promise.allSettled([a.create('race', location), b.create('race', { root: '/b', cwd: '/b' })]);
    assert.equal(competing.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(competing.find(x => x.status === 'rejected').reason.cause.code, 'revision_conflict');
    assert.deepEqual((await a.getSessionInfo('race')).location, location);
    db = new Database(file);
    // Fail after Session insert, when its catalog update would commit.
    db.exec("CREATE TRIGGER fail_create BEFORE UPDATE ON session_catalog BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END");
    const before = await a.listSessions();
    await assert.rejects(a.create('rollback', location), { code: 'save_failed', effect: 'unknown' });
    await assert.rejects(b.getSessionInfo('rollback'), { code: 'not_found' });
    assert.deepEqual(await b.listSessions(), before);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sessions WHERE id='rollback'").get().n, 0);
    db.exec('DROP TRIGGER fail_create');
    await a.close(); await b.close();
    db.close(); db = undefined;
    const reopen = createSessionStore(createSqliteSessionBackend(file));
    owned.push(reopen);
    assert.deepEqual((await reopen.getSessionInfo('lost')).location, location);
    await assert.rejects(reopen.getSessionInfo('rollback'), { code: 'not_found' });
  } finally {
    db?.close();
    await Promise.all(owned.map(store => store.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

// Literal published layout 3, independent of current initializer constants.
const layout3 = [
  'CREATE TABLE sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL, digest TEXT NOT NULL, title TEXT, metadata_revision INTEGER NOT NULL)',
  'CREATE TABLE session_events (session_id TEXT NOT NULL REFERENCES sessions(id), revision INTEGER NOT NULL, event TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (session_id, revision))',
  'CREATE TABLE session_catalog (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, revision INTEGER NOT NULL)',
  'CREATE INDEX session_info ON sessions (id, title, metadata_revision, revision, digest)',
];
test('layout 3 -> 4 preserves bytes, settlement and catalog identity; corrupt history rolls back added column/index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-location-migration-'));
  let db, store;
  try {
    for (const corrupt of [true, false]) {
      const file = join(directory, `${corrupt}.sqlite`);
      db = new Database(file);
      for (const sql of layout3) db.exec(sql);
      db.pragma('application_id = 1312903985');
      db.pragma('user_version = 3');
      const storeId = '12345678-1234-1234-1234-123456789abc';
      db.prepare('INSERT INTO session_catalog VALUES (1, ?, 7)').run(storeId);
      const events = [
        ...closedTurn('s').slice(0, 1),
        { sessionId: 's', turnId: 't', seq: 2, data: { type: 'message_appended', message: { role: 'user', content: 'input' } } },
        { sessionId: 's', turnId: 't', seq: 3, data: { type: 'step_started', step: 1 } },
        { sessionId: 's', turnId: 't', seq: 4, data: { type: 'message_appended', step: 1, message: {
          role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'write', arguments: {} }] } } },
        { sessionId: 's', turnId: 't', seq: 5, data: { type: 'tool_started', step: 1, toolCallId: 'call', name: 'write' } },
        { sessionId: 's', turnId: 't', seq: 6, data: { type: 'message_appended', step: 1, message: {
          role: 'tool', toolCallId: 'call', name: 'write', outcome: { ok: false, error: { code: 'uncertain', message: 'unknown', effect: 'unknown' } } },
        settlement: { started: true, status: 'unknown', cancellationRequested: false, cleanup: { status: 'released' } } } },
        { sessionId: 's', turnId: 't', seq: 7, data: { type: 'step_ended', step: 1 } },
        { sessionId: 's', turnId: 't', seq: 8, data: { type: 'turn_ended', reason: 'error', errorCode: 'uncertain' } },
      ];
      // Whitespace is legitimate original document bytes, not a reason to rewrite.
      const document = { schemaVersion: 2, sessionId: 's', events };
      const text = JSON.stringify(document, null, 2);
      const digest = hash(JSON.stringify(document));
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('s', events.length, text, digest, 'original title', 3);
      const insert = db.prepare('INSERT INTO session_events VALUES (?, ?, ?, ?)');
      for (const [at, event] of events.entries()) {
        const json = JSON.stringify(event);
        insert.run('s', at + 1, json, hash(json));
      }
      if (corrupt) db.prepare("UPDATE session_events SET digest='bad' WHERE revision=8").run();
      const schemaBefore = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY sql").all();
      const dataBefore = db.prepare('SELECT * FROM sessions').all();
      const eventsBefore = db.prepare('SELECT * FROM session_events').all();
      db.close(); db = undefined;
      if (corrupt) {
        assert.throws(() => createSqliteSessionBackend(file), { code: 'corrupt_session' });
      } else {
        store = createSessionStore(createSqliteSessionBackend(file));
        const detail = await store.getSessionInfo('s');
        assert.equal(detail.location, null);
        assert.equal(detail.storeId, storeId);
        assert.equal(detail.metadataRevision, 3);
        assert.equal(detail.title, 'original title');
        assert.equal(detail.digest, digest);
        assert.equal((await store.listSessions()).catalogRevision, 7);
        const loaded = await store.load('s');
        assert.equal(loaded.recovery.disposition, 'unknown-effects');
        assert.deepEqual(loaded.recovery.calls[0].settlement, events[5].data.settlement);
        await assert.rejects(store.recorder('s'), { code: 'recovery_required' });
        assert.deepEqual((await store.readHistory('s', { limit: 100 })).records.map(x => x.event), events);
        await store.close(); store = undefined;
      }
      db = new Database(file);
      assert.equal(db.pragma('user_version', { simple: true }), corrupt ? 3 : 4);
      assert.deepEqual(db.prepare('SELECT id, revision, document, digest, title, metadata_revision FROM sessions').all(), dataBefore);
      assert.deepEqual(db.prepare('SELECT * FROM session_events').all(), eventsBefore);
      if (corrupt) assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY sql").all(), schemaBefore);
      else {
        // Unknown location damage is diagnosed, not normalized or used as a path.
        db.prepare("UPDATE sessions SET location='{\"root\":\"/a\",\"cwd\":\"/outside\"}'").run();
        db.close(); db = undefined;
        store = createSessionStore(createSqliteSessionBackend(file));
        await assert.rejects(store.getSessionInfo('s'), { code: 'corrupt_session' });
        await store.close(); store = undefined;
      }
      db?.close(); db = undefined;
    }
  } finally {
    db?.close(); await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
