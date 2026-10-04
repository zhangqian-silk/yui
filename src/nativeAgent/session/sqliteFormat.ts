import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { SessionDocument } from './contracts.js';
import { encode, inspectDocument, migrateSessionDocument, revision, SessionError, sessionLimits } from './format.js';

export const applicationId = 0x4e415331; // NAS1, independent of Yui Home.
export const oldSchema = 'CREATE TABLE sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL, digest TEXT NOT NULL)';
const tables = [
  'CREATE TABLE sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL, digest TEXT NOT NULL, title TEXT, metadata_revision INTEGER NOT NULL)',
  'CREATE TABLE session_events (session_id TEXT NOT NULL REFERENCES sessions(id), revision INTEGER NOT NULL, event TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (session_id, revision))',
  'CREATE TABLE session_catalog (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, revision INTEGER NOT NULL)',
  // Cover every lightweight read without traversing the document's overflow
  // pages. SQLite maintains this index; it is not a separately writable catalog.
  'CREATE INDEX session_info ON sessions (id, title, metadata_revision, revision, digest)',
];
export type Row = { id: string; revision: number; document: string; digest: string };
export function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function digest(document: SessionDocument): string { return hash(encode(document)); }
export function decode(row: Row): SessionDocument {
  try {
    if (Buffer.byteLength(row.document) > sessionLimits.documentBytes) throw new Error('Oversized document');
    const document = inspectDocument(JSON.parse(row.document)).document;
    if (row.id !== document.sessionId || row.revision !== revision(document) || row.digest !== digest(document)) {
      throw new Error('Stored identity, revision or digest mismatch');
    }
    return document;
  } catch (cause) {
    throw new SessionError('corrupt_session', 'Stored Session is malformed; preserve the file for diagnosis', { cause });
  }
}
/** One centralized, atomic layout chain: v1 document -> v2 settlement format ->
 * v3 catalog/projection layout. Document v2 and its existing receipts stay intact.
 * This is called only on the caller-selected independent database. */
export function initializeSessionDatabase(db: Database.Database): void {
  db.transaction(() => {
    const id = db.pragma('application_id', { simple: true });
    const version = db.pragma('user_version', { simple: true });
    const objects = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY sql").all() as { sql: string }[];
    const sql = objects.map(x => x.sql);
    const unsupported = () => { throw new SessionError('unsupported_format', 'Not a supported Session database layout/version; no migration applied'); };
    const create = () => {
      for (const table of tables) db.exec(table);
      db.prepare('INSERT INTO session_catalog VALUES (1, ?, 0)').run(randomUUID());
    };
    if (id === 0 && version === 0 && !objects.length) {
      create();
      db.pragma(`application_id = ${applicationId}`);
      db.pragma('user_version = 3');
      return;
    }
    if (id !== applicationId || ![1, 2, 3].includes(version as number)) unsupported();
    if (version === 3) {
      if (JSON.stringify(sql) !== JSON.stringify([...tables].sort())) unsupported();
      const rows = db.prepare('SELECT id, revision FROM session_catalog').all() as { id: string; revision: number }[];
      if (rows.length !== 1 || !/^[0-9a-f-]{36}$/.test(rows[0].id)
        || !Number.isSafeInteger(rows[0].revision) || rows[0].revision < 0) unsupported();
      return;
    }
    if (objects.length !== 1 || sql[0] !== oldSchema) unsupported();
    // DDL and all data transformations share this transaction. A rejected row or
    // failed insert rolls back even the table rename and the version transition.
    db.exec('ALTER TABLE sessions RENAME TO source_sessions');
    create();
    const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, 0)');
    const eventInsert = db.prepare('INSERT INTO session_events VALUES (?, ?, ?, ?)');
    const next = db.prepare('SELECT id, revision, document, digest FROM source_sessions WHERE id > ? COLLATE BINARY ORDER BY id COLLATE BINARY LIMIT 1');
    let row = db.prepare('SELECT id, revision, document, digest FROM source_sessions ORDER BY id COLLATE BINARY LIMIT 1').get() as Row | undefined;
    while (row) {
      let document: SessionDocument;
      if (version === 1) {
        if (Buffer.byteLength(row.document) > sessionLimits.documentBytes) throw new SessionError('corrupt_session', 'Oversized version-1 document');
        const original = JSON.parse(row.document);
        if (row.id !== original.sessionId || row.revision !== original.events?.length || row.digest !== hash(JSON.stringify(original))) {
          throw new SessionError('corrupt_session', 'Version-1 identity, revision or digest mismatch');
        }
        document = migrateSessionDocument(original);
        row = { ...row, document: encode(document), digest: digest(document) };
      } else document = decode(row);
      insert.run(row.id, row.revision, row.document, row.digest);
      for (const [index, event] of document.events.entries()) {
        const text = JSON.stringify(event);
        eventInsert.run(row.id, index + 1, text, hash(text));
      }
      row = next.get(row.id) as Row | undefined;
    }
    db.exec('DROP TABLE source_sessions');
    db.pragma('user_version = 3');
  }).immediate();
}
