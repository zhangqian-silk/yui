import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { existsSync, lstatSync } from 'node:fs';
import type { SessionBackend, SessionDocument } from './contracts.js';
import { encode, identity, inspectDocument, migrateSessionDocument, revision, SessionError, sessionLimits } from './format.js';

export function digest(document: SessionDocument): string {
  return createHash('sha256').update(encode(document)).digest('hex');
}
function transition(previous: SessionDocument | null, next: SessionDocument, expected: number | null): void {
  if (expected === null ? previous !== null : !previous || revision(previous) !== expected) {
    throw new SessionError('revision_conflict', 'Session revision conflict; reload, do not replay uncertain effects');
  }
  if (expected === null ? next.events.length !== 0
    : next.events.length !== expected + 1
      || JSON.stringify(next.events.slice(0, -1)) !== JSON.stringify(previous!.events)) {
    throw new SessionError('invalid_append', 'Write must create an empty Session or append exactly one immutable fact');
  }
}

export function createMemorySessionBackend(): SessionBackend {
  const documents = new Map<string, SessionDocument>();
  let closed = false;
  const check = (): void => { if (closed) throw new SessionError('closed', 'Session backend is closed'); };
  return {
    source: Object.freeze({ id: `memory:${randomUUID()}`, durability: 'volatile' }),
    async read(sessionId) {
      check(); identity(sessionId);
      return structuredClone(documents.get(sessionId) ?? null);
    },
    async write(document, expectedRevision) {
      check();
      const next = inspectDocument(document).document;
      transition(documents.get(next.sessionId) ?? null, next, expectedRevision);
      documents.set(next.sessionId, next);
    },
    async close() { closed = true; documents.clear(); },
  };
}

const applicationId = 0x4e415331; // NAS1: independent native Agent Session format.
const schema = 'CREATE TABLE sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL, digest TEXT NOT NULL)';
type Row = { id: string; revision: number; document: string; digest: string };
function decode(row: Row): SessionDocument {
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

/** Caller-selected local file; no Yui Home discovery, global connection or daemon. */
export function createSqliteSessionBackend(filename: string): SessionBackend {
  if (!isAbsolute(filename) || (existsSync(filename)
    && (lstatSync(filename).isSymbolicLink() || !lstatSync(filename).isFile()))) {
    throw new SessionError('invalid_path', 'An absolute controlled regular-file path is required');
  }
  const db = new Database(filename, { timeout: 1000 });
  try {
    // No WAL/background writer: FULL rollback-journal commits own their durable
    // boundary; SQLite arbitrates simultaneous connections and CAS runs inside it.
    db.pragma('synchronous = FULL');
    // Refuse unsupported journal settings before initializing any schema.
    const journal = db.pragma('journal_mode', { simple: true });
    if (journal !== 'delete') throw new SessionError('unsupported_format', 'Session database requires DELETE journal mode');
    db.transaction(() => {
      const id = db.pragma('application_id', { simple: true });
      const version = db.pragma('user_version', { simple: true });
      const objects = db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as
        { name: string; sql: string }[];
      if (id === 0 && version === 0 && objects.length === 0) {
        db.exec(schema);
        db.pragma(`application_id = ${applicationId}`);
        db.pragma('user_version = 2');
      } else if (id !== applicationId || ![1, 2].includes(version as number) || objects.length !== 1 || objects[0].sql !== schema) {
        throw new SessionError('unsupported_format', 'Not a supported version-2 Session database; no migration applied');
      } else if (version === 1) {
        // Validate every original row and transform in the same transaction.
        // A corrupt row rolls back the entire declared migration.
        const update = db.prepare('UPDATE sessions SET document = ?, digest = ? WHERE id = ?');
        const nextRow = db.prepare('SELECT id, revision, document, digest FROM sessions WHERE id > ? ORDER BY id LIMIT 1');
        let row = db.prepare('SELECT id, revision, document, digest FROM sessions ORDER BY id LIMIT 1').get() as Row | undefined;
        while (row) {
          if (Buffer.byteLength(row.document) > sessionLimits.documentBytes) throw new Error('Oversized v1 document');
          const original = JSON.parse(row.document);
          if (row.id !== original.sessionId || row.revision !== original.events?.length
            || row.digest !== createHash('sha256').update(JSON.stringify(original)).digest('hex')) {
            throw new SessionError('corrupt_session', 'Version-1 identity, revision or digest mismatch');
          }
          const migrated = migrateSessionDocument(original);
          update.run(encode(migrated), digest(migrated), row.id);
          row = nextRow.get(row.id) as Row | undefined;
        }
        db.pragma('user_version = 2');
      }
    }).immediate();
  } catch (cause) {
    db.close();
    throw cause;
  }
  let closed = false;
  const check = (): void => { if (closed) throw new SessionError('closed', 'Session backend is closed'); };
  const readRow = db.prepare('SELECT id, revision, document, digest FROM sessions WHERE id = ?');
  const insert = db.prepare('INSERT INTO sessions (id, revision, document, digest) VALUES (?, ?, ?, ?)');
  const update = db.prepare('UPDATE sessions SET revision = ?, document = ?, digest = ? WHERE id = ?');
  const write = db.transaction((next: SessionDocument, expected: number | null) => {
    const row = readRow.get(next.sessionId) as Row | undefined;
    transition(row ? decode(row) : null, next, expected);
    if (row) update.run(revision(next), encode(next), digest(next), next.sessionId);
    else insert.run(next.sessionId, revision(next), encode(next), digest(next));
  });
  return {
    source: Object.freeze({ id: `sqlite:${resolve(filename)}`, durability: 'persistent' }),
    async read(sessionId) {
      check(); identity(sessionId);
      const row = readRow.get(sessionId) as Row | undefined;
      return row ? decode(row) : null;
    },
    async write(document, expectedRevision) {
      check();
      write.immediate(inspectDocument(document).document, expectedRevision);
    },
    async close() { if (!closed) { db.close(); closed = true; } },
  };
}
