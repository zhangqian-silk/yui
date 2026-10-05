import type { PageOptions, SessionPage } from './contracts.js';
import { SessionError, sessionLimits } from './format.js';

export const catalogLimits = Object.freeze({
  defaultPageSize: 20, pageSize: 100, titleCharacters: 200, cursorBytes: 4096,
  // Every legal event (<=1 MiB) fits with its record wrapper and page envelope.
  historyBytes: 2 * 1024 * 1024,
});
type Cursor = {
  v: 1; store: string; kind: 'sessions' | 'history';
  limit: number; revision: number; after: string | number; session?: string;
};
const invalid = (): never => { throw new SessionError('invalid_cursor', 'Invalid cursor for this store, target or page size'); };
export function pageLimit(options: PageOptions): number {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['limit', 'cursor'].includes(key))) {
    throw new SessionError('invalid_query', 'Expected page options containing only limit and cursor');
  }
  const limit = options.limit === undefined ? catalogLimits.defaultPageSize : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > catalogLimits.pageSize) {
    throw new SessionError('invalid_query', 'Page limit must be an integer in 1..100');
  }
  return limit;
}
export function readCursor(options: PageOptions, store: string, kind: Cursor['kind'], session?: string): Cursor | undefined {
  if (options.cursor === undefined) return undefined;
  const text = options.cursor;
  if (typeof text !== 'string' || !text.length || Buffer.byteLength(text) > catalogLimits.cursorBytes
    || !/^[A-Za-z0-9_-]+$/.test(text)) return invalid();
  try {
    const raw = Buffer.from(text, 'base64url');
    if (raw.toString('base64url') !== text) return invalid();
    const c = JSON.parse(raw.toString('utf8')) as Cursor;
    if (!c || Array.isArray(c) || c.v !== 1 || c.store !== store || c.kind !== kind
      || c.limit !== pageLimit(options) || !Number.isSafeInteger(c.revision) || c.revision < 0
      || Object.keys(c).some(key => !['v', 'store', 'kind', 'limit', 'revision', 'after', 'session'].includes(key))
      || (kind === 'sessions' ? c.session !== undefined || typeof c.after !== 'string'
        || !c.after.trim() || c.after.length > 256
        : c.session !== session || !Number.isSafeInteger(c.after) || Number(c.after) < 1
          || Number(c.after) >= c.revision)) return invalid();
    return c;
  } catch { return invalid(); }
}
export function nextCursor(store: string, kind: Cursor['kind'], limit: number, revision: number,
  after: string | number, session?: string): string {
  return Buffer.from(JSON.stringify({ v: 1, store, kind, limit, revision, after,
    ...(session === undefined ? {} : { session }) })).toString('base64url');
}
export function currentCursor(cursor: Cursor | undefined, revision: number): void {
  if (cursor && cursor.revision !== revision) {
    throw new SessionError('cursor_stale', 'Saved data changed; restart pagination from the first page');
  }
}
export function normalizeTitle(title: string | null): string | null {
  if (title === null) return null;
  if (typeof title !== 'string') throw new SessionError('invalid_title', 'Title must be text or null');
  const text = title.trim();
  if (!text || [...text].length > catalogLimits.titleCharacters || /[\p{Cc}\p{Cs}]/u.test(text)) {
    throw new SessionError('invalid_title', 'Title must contain 1..200 Unicode characters without controls or lone surrogates');
  }
  return text;
}
export function metadataRevision(expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new SessionError('revision_conflict', 'Expected metadata revision must be a nonnegative integer');
  }
}
export function increment(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
    throw new SessionError('revision_exhausted', 'Stored revision cannot be incremented safely');
  }
  return value + 1;
}
export function queryBounds(after: number, limit: number): void {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit)
    || limit < 1 || limit > sessionLimits.pageSize) {
    throw new SessionError('invalid_query', 'Cursor must be nonnegative; page limit must be 1..100');
  }
}
/** Reads at most limit + 1 individual bounded records, never a whole log.
 * Reserve 64 KiB for escaped identities, file source and the <=4 KiB cursor;
 * this also leaves every legal <=1 MiB event readable in a 2 MiB page. */
export function historyRecords(after: number, revision: number, limit: number,
  read: (revision: number) => SessionPage['records'][number]): SessionPage['records'] {
  const records: { revision: number; event: SessionPage['records'][number]['event'] }[] = [];
  let bytes = 64 * 1024;
  for (let at = after + 1; at <= revision && records.length < limit; at++) {
    const item = read(at);
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > catalogLimits.historyBytes) break;
    bytes += size;
    records.push(item);
  }
  return records;
}
