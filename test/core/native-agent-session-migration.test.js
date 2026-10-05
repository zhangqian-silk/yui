import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { createSessionStore, createSqliteSessionBackend } from '../../dist/nativeAgent/session/index.js';

test('declared v1 migration preserves original facts; corrupt source rolls back without invented settlements', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-migration-'));
  let db, store;
  try {
    for (const corrupt of [true, false]) {
      const file = join(directory, `${corrupt}.sqlite`);
      db = new Database(file);
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL, digest TEXT NOT NULL)');
      db.pragma('application_id = 1312903985'); // Literal NAS1, not implementation-derived.
      db.pragma('user_version = 1');
      const events = [{ sessionId: 's', turnId: 't', seq: 1, data: { type: 'turn_started' } },
        { sessionId: 's', turnId: 't', seq: 2, data: { type: 'turn_ended', reason: 'cancelled' } }];
      const text = JSON.stringify({ schemaVersion: 1, sessionId: 's', events });
      const hash = createHash('sha256').update(text).digest('hex');
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('s', 2, text, hash);
      if (corrupt) db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('z-bad', 0, '{}', 'bad');
      db.close(); db = undefined;
      if (corrupt) {
        assert.throws(() => createSqliteSessionBackend(file));
        db = new Database(file);
        assert.equal(db.pragma('user_version', { simple: true }), 1);
        assert.equal(db.prepare("SELECT document FROM sessions WHERE id='s'").get().document, text);
        db.close(); db = undefined;
      } else {
        store = createSessionStore(createSqliteSessionBackend(file));
        const loaded = await store.load('s');
        assert.equal(loaded.document.schemaVersion, 2);
        assert.deepEqual(loaded.document.events, events);
        assert.equal(loaded.revision, 2);
        assert.equal(loaded.recovery.disposition, 'ready');
        assert.equal((await store.getSessionInfo('s')).location, null);
        assert.notEqual(loaded.digest, hash);
        await store.close(); store = undefined;
      }
    }
  } finally {
    db?.close(); await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
