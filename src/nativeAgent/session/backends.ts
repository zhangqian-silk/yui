import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { existsSync, lstatSync } from 'node:fs';
import type { PageOptions, SessionBackend, SessionDetail, SessionDocument, SessionInfo, SessionLocation, SessionPage } from './contracts.js';
import { copyEvent, encode, identity, inspectDocument, revision, SessionError, sessionLimits } from './format.js';
import {
  currentCursor, historyRecords, increment, metadataRevision, nextCursor, normalizeTitle, pageLimit, queryBounds, readCursor,
} from './catalog.js';
import { decode, digest, hash, initializeSessionDatabase, type Row } from './sqliteFormat.js';
import { copyLocation, decodeLocation } from './location.js';

export { digest } from './sqliteFormat.js';
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

function missing(): never { throw new SessionError('not_found', 'Session not found'); }
function compareIds(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
function seek(ids: string[], after: string): number {
  let lo = 0, hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareIds(ids[mid], after) <= 0) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function createMemorySessionBackend(): SessionBackend {
  const source = Object.freeze({ id: `memory:${randomUUID()}`, durability: 'volatile' as const });
  const storeId = randomUUID();
  const documents = new Map<string, { document: SessionDocument; digest: string; location: SessionLocation | null }>();
  const metadata = new Map<string, SessionInfo>();
  const ids: string[] = [];
  let catalogRevision = 0;
  let closed = false;
  const check = (): void => { if (closed) throw new SessionError('closed', 'Session backend is closed'); };
  const info = (sessionId: string): SessionDetail => {
    check(); identity(sessionId);
    const stored = documents.get(sessionId) ?? missing();
    return { ...metadata.get(sessionId)!, revision: revision(stored.document), digest: stored.digest, source, storeId,
      location: stored.location === null ? null : { ...stored.location } };
  };
  const query = (sessionId: string, after: number, limit: number): SessionPage => {
    queryBounds(after, limit);
    const detail = info(sessionId);
    if (after > detail.revision) throw new SessionError('invalid_query', 'Cursor exceeds saved revision');
    const records = historyRecords(after, detail.revision, limit, at => ({
      revision: at, event: structuredClone(documents.get(sessionId)!.document.events[at - 1]),
    }));
    const end = records.at(-1)?.revision ?? after;
    return { sessionId, revision: detail.revision, digest: detail.digest, source, records,
      nextCursor: end < detail.revision ? end : null };
  };
  const write = (document: SessionDocument, expectedRevision: number | null, location: SessionLocation | null = null): void => {
    check();
    const next = inspectDocument(document).document;
    const previous = documents.get(next.sessionId);
    transition(previous?.document ?? null, next, expectedRevision);
    const nextDigest = digest(next);
    if (expectedRevision === null) {
      const nextRevision = increment(catalogRevision);
      metadata.set(next.sessionId, { sessionId: next.sessionId, title: null, metadataRevision: 0 });
      ids.splice(seek(ids, next.sessionId), 0, next.sessionId);
      catalogRevision = nextRevision;
    }
    documents.set(next.sessionId, { document: next, digest: nextDigest, location: previous?.location ?? location });
  };
  return {
    source,
    catalog: {
      async getSessionInfo(sessionId) { return info(sessionId); },
      async listSessions(options = {}) {
        check();
        const limit = pageLimit(options);
        const cursor = readCursor(options, storeId, 'sessions');
        currentCursor(cursor, catalogRevision);
        if (cursor && !metadata.has(cursor.after as string)) {
          throw new SessionError('invalid_cursor', 'Cursor does not identify a saved Session');
        }
        const start = cursor ? seek(ids, cursor.after as string) : 0;
        const selected = ids.slice(start, start + limit);
        return { storeId, catalogRevision, items: selected.map(id => ({ ...metadata.get(id)! })),
          nextCursor: start + selected.length < ids.length
            ? nextCursor(storeId, 'sessions', limit, catalogRevision, selected.at(-1)!) : null };
      },
      async renameSession(sessionId, title, expected) {
        const detail = info(sessionId);
        const nextTitle = normalizeTitle(title);
        metadataRevision(expected);
        if (detail.metadataRevision !== expected) throw new SessionError('revision_conflict', 'Metadata revision conflict; read current title');
        if (detail.title !== nextTitle) {
          const nextRevision = increment(catalogRevision);
          metadata.set(sessionId, { sessionId, title: nextTitle, metadataRevision: increment(expected) });
          catalogRevision = nextRevision;
        }
        return info(sessionId);
      },
      async readHistory(sessionId, options = {}) {
        check(); identity(sessionId);
        const limit = pageLimit(options);
        const cursor = readCursor(options, storeId, 'history', sessionId);
        const detail = info(sessionId);
        currentCursor(cursor, detail.revision);
        const page = query(sessionId, cursor ? cursor.after as number : 0, limit);
        return { ...page, storeId, nextCursor: page.nextCursor === null ? null
          : nextCursor(storeId, 'history', limit, detail.revision, page.nextCursor, sessionId) };
      },
    },
    async query(sessionId, options) { check(); return query(sessionId, options.after, options.limit); },
    async read(sessionId) {
      check(); identity(sessionId);
      return structuredClone(documents.get(sessionId)?.document ?? null);
    },
    async write(document, expectedRevision) {
      write(document, expectedRevision);
    },
    async createWithLocation(document, location) { write(document, null, copyLocation(location)); },
    async close() { closed = true; documents.clear(); metadata.clear(); ids.length = 0; },
  };
}

type InfoRow = { id: string; revision: number; digest: string; title: string | null; metadata_revision: number; location: string | null };
/** Caller-selected local file; no Yui Home discovery, global connection or daemon. */
export function createSqliteSessionBackend(filename: string): SessionBackend {
  if (!isAbsolute(filename) || (existsSync(filename)
    && (lstatSync(filename).isSymbolicLink() || !lstatSync(filename).isFile()))) {
    throw new SessionError('invalid_path', 'An absolute controlled regular-file path is required');
  }
  const db = new Database(filename, { timeout: 1000 });
  try {
    db.pragma('synchronous = FULL');
    const journal = db.pragma('journal_mode', { simple: true });
    if (journal !== 'delete') throw new SessionError('unsupported_format', 'Session database requires DELETE journal mode');
    initializeSessionDatabase(db);
  } catch (cause) {
    db.close();
    throw cause;
  }
  let closed = false;
  const check = (): void => { if (closed) throw new SessionError('closed', 'Session backend is closed'); };
  const source = Object.freeze({ id: `sqlite:${resolve(filename)}`, durability: 'persistent' as const });
  const catalogRow = db.prepare('SELECT id, revision FROM session_catalog WHERE singleton = 1');
  const catalogState = () => {
    const state = catalogRow.get() as { id: string; revision: number } | undefined;
    if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0) {
      throw new SessionError('corrupt_session', 'Invalid catalog state');
    }
    return state;
  };
  const storeId = catalogState().id;
  const readInfo = db.prepare('SELECT id, revision, digest, title, metadata_revision, location FROM sessions INDEXED BY session_info WHERE id = ?');
  const detail = (row: InfoRow): SessionDetail => {
    if (!Number.isSafeInteger(row.revision) || row.revision < 0 || row.revision > sessionLimits.events
      || !Number.isSafeInteger(row.metadata_revision) || row.metadata_revision < 0
      || normalizeTitle(row.title) !== row.title || !/^[0-9a-f]{64}$/.test(row.digest)) {
      throw new SessionError('corrupt_session', 'Malformed Session summary');
    }
    return { sessionId: row.id, revision: row.revision, digest: row.digest, title: row.title,
      metadataRevision: row.metadata_revision, storeId, source, location: decodeLocation(row.location) };
  };
  const info = (id: string) => { identity(id); return detail((readInfo.get(id) as InfoRow | undefined) ?? missing()); };
  const readRow = db.prepare('SELECT id, revision, document, digest FROM sessions WHERE id = ?');
  const readEvent = db.prepare('SELECT event, digest FROM session_events WHERE session_id = ? AND revision = ?');
  const query = (sessionId: string, after: number, limit: number): SessionPage => {
    queryBounds(after, limit);
    const saved = info(sessionId);
    if (after > saved.revision) throw new SessionError('invalid_query', 'Cursor exceeds the saved revision');
    const records = historyRecords(after, saved.revision, limit, at => {
      const row = readEvent.get(sessionId, at) as { event: string; digest: string } | undefined;
      if (!row || Buffer.byteLength(row.event) > sessionLimits.eventBytes || hash(row.event) !== row.digest) {
        throw new SessionError('corrupt_session', 'Missing or corrupt history projection; preserve the file');
      }
      const event = copyEvent(JSON.parse(row.event));
      if (event.sessionId !== sessionId) throw new SessionError('corrupt_session', 'History identity mismatch');
      return { revision: at, event };
    });
    const end = records.at(-1)?.revision ?? after;
    return { sessionId, revision: saved.revision, digest: saved.digest, source, records,
      nextCursor: end < saved.revision ? end : null };
  };
  const listFirst = db.prepare('SELECT id, title, metadata_revision FROM sessions INDEXED BY session_info ORDER BY id COLLATE BINARY LIMIT ?');
  const listNext = db.prepare('SELECT id, title, metadata_revision FROM sessions INDEXED BY session_info WHERE id > ? COLLATE BINARY ORDER BY id COLLATE BINARY LIMIT ?');
  const bumpCatalog = () => db.prepare('UPDATE session_catalog SET revision = ? WHERE singleton = 1').run(increment(catalogState().revision));
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, 0, ?)');
  const update = db.prepare('UPDATE sessions SET revision = ?, document = ?, digest = ? WHERE id = ?');
  const insertEvent = db.prepare('INSERT INTO session_events VALUES (?, ?, ?, ?)');
  const write = db.transaction((next: SessionDocument, expected: number | null, location: SessionLocation | null = null) => {
    const row = readRow.get(next.sessionId) as Row | undefined;
    transition(row ? decode(row) : null, next, expected);
    if (row) {
      update.run(revision(next), encode(next), digest(next), next.sessionId);
      const text = JSON.stringify(next.events.at(-1));
      insertEvent.run(next.sessionId, revision(next), text, hash(text));
    } else {
      insert.run(next.sessionId, revision(next), encode(next), digest(next), location === null ? null : JSON.stringify(location));
      bumpCatalog();
    }
  });
  const catalog = {
    async getSessionInfo(sessionId: string) { check(); return info(sessionId); },
    async listSessions(options: PageOptions = {}) {
      check();
      return db.transaction(() => {
        const limit = pageLimit(options);
        const state = catalogState();
        const cursor = readCursor(options, storeId, 'sessions');
        currentCursor(cursor, state.revision);
        if (cursor && !readInfo.get(cursor.after)) {
          throw new SessionError('invalid_cursor', 'Cursor does not identify a saved Session');
        }
        const rows = (cursor ? listNext.all(cursor.after, limit + 1) : listFirst.all(limit + 1)) as
          { id: string; title: string | null; metadata_revision: number }[];
        const selected = rows.slice(0, limit);
        const items = selected.map(row => {
          identity(row.id);
          metadataRevision(row.metadata_revision);
          if (normalizeTitle(row.title) !== row.title) throw new SessionError('corrupt_session', 'Invalid stored title');
          return { sessionId: row.id, title: row.title, metadataRevision: row.metadata_revision };
        });
        return { storeId, catalogRevision: state.revision, items,
          nextCursor: rows.length > limit ? nextCursor(storeId, 'sessions', limit, state.revision, items.at(-1)!.sessionId) : null };
      })();
    },
    async renameSession(sessionId: string, title: string | null, expected: number) {
      check(); identity(sessionId);
      const nextTitle = normalizeTitle(title);
      metadataRevision(expected);
      return db.transaction(() => {
        const current = info(sessionId);
        if (current.metadataRevision !== expected) throw new SessionError('revision_conflict', 'Metadata revision conflict; read current title');
        if (current.title !== nextTitle) {
          db.prepare('UPDATE sessions SET title = ?, metadata_revision = ? WHERE id = ?')
            .run(nextTitle, increment(expected), sessionId);
          bumpCatalog();
        }
        return info(sessionId);
      }).immediate();
    },
    async readHistory(sessionId: string, options: PageOptions = {}) {
      check(); identity(sessionId);
      return db.transaction(() => {
        const limit = pageLimit(options);
        const cursor = readCursor(options, storeId, 'history', sessionId);
        const saved = info(sessionId);
        currentCursor(cursor, saved.revision);
        const page = query(sessionId, cursor ? cursor.after as number : 0, limit);
        return { ...page, storeId, nextCursor: page.nextCursor === null ? null
          : nextCursor(storeId, 'history', limit, saved.revision, page.nextCursor, sessionId) };
      })();
    },
  };
  return {
    source, catalog,
    async query(sessionId, options) { check(); return db.transaction(() => query(sessionId, options.after, options.limit))(); },
    async read(sessionId) {
      check(); identity(sessionId);
      const row = readRow.get(sessionId) as Row | undefined;
      return row ? decode(row) : null;
    },
    async write(document, expectedRevision) {
      check();
      write.immediate(inspectDocument(document).document, expectedRevision);
    },
    async createWithLocation(document, location) {
      check();
      const selected = copyLocation(location);
      write.immediate(inspectDocument(document).document, null, selected);
    },
    async close() { if (!closed) { db.close(); closed = true; } },
  };
}
