import { createHash } from "node:crypto";
import { usageError } from "../errors/cliError.js";

export const READ_PAGE_BYTES = 32 * 1024;
export const INLINE_DOCUMENT_BYTES = 16 * 1024;
export type ReadPageOptions = Readonly<{ cursor?: string; limit?: number }>;
type Cursor = { source: string; digest: string; offset: number };

function assertSource(source: string): void {
  if (Buffer.byteLength(source) > 1024) throw usageError("Read source identity exceeds its 1024-byte budget.");
}

export function readDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A save receipt is not another read of the submitted body. Keep the exact
 * delivery/control facts and identity; body/history are read on demand.
 */
export function messageReceipt<T extends { id: string; body: string }>(message: T) {
  const { body: _body, ...facts } = message;
  return { ...facts, digest: readDigest(message), bodyBytes: Buffer.byteLength(message.body) };
}

export function encodeReadCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeReadCursor(raw: string, source: string, digest: string): number {
  let cursor: Cursor;
  try {
    if (raw.length > 4096) throw new Error();
    cursor = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (cursor.source !== source || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
      || typeof cursor.digest !== "string") throw new Error();
  } catch { throw usageError("Invalid read cursor for this source/scope."); }
  if (cursor.digest !== digest) throw usageError("Read source changed; restart the read instead of mixing versions.");
  return cursor.offset;
}

export function readLimit(value?: number): number {
  const limit = value ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw usageError("Read limit must be between 1 and 100.");
  }
  return limit;
}

/** For small in-memory authorized collections. Authorize/filter BEFORE calling.
 * Cursors bind the selected collection, never grant access, and store no state.
 */
export function recordPage<T>(records: readonly T[], source: string, options: ReadPageOptions = {}) {
  assertSource(source);
  const limit = readLimit(options.limit);
  const digest = readDigest(records);
  const offset = options.cursor === undefined ? 0 : decodeReadCursor(options.cursor, source, digest);
  if (offset > records.length) throw usageError("Read cursor exceeds this collection.");
  const items: T[] = [];
  // Reserve room for identities, counts and continuation. Oversized individual
  // records belong in a document read, not silently truncated list metadata.
  let bytes = 0;
  for (const record of records.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (size > READ_PAGE_BYTES / 2) throw usageError("List entry exceeds its summary budget; read the exact record.");
    if (bytes + size > READ_PAGE_BYTES - 4096) break;
    items.push(record);
    bytes += size;
  }
  const end = offset + items.length;
  return {
    source, digest, items, total: records.length, complete: end === records.length,
    nextCursor: end < records.length ? encodeReadCursor({ source, digest, offset: end }) : null,
    limits: { items: limit, bytes: READ_PAGE_BYTES }
  };
}

/** Small exact details stay native JSON. Large details explicitly become a
 * contentPage. Concatenate text in order, then JSON.parse once, never each chunk.
 * JSON character offsets (not bytes) preserve Unicode and escaped controls.
 * The source is an exact authorized read identity; reauthorize every page.
 */
export function boundedDocument<T>(value: T, source: string, cursor?: string): T | {
  contentPage: {
    source: string; digest: string; encoding: "json"; offset: number;
    totalCharacters: number; totalBytes: number; text: string;
    complete: boolean; nextCursor: string | null;
  };
} {
  assertSource(source);
  const text = JSON.stringify(value);
  const totalBytes = Buffer.byteLength(text);
  if (cursor === undefined && totalBytes <= INLINE_DOCUMENT_BYTES) return value;
  const digest = readDigest(value);
  const offset = cursor === undefined ? 0 : decodeReadCursor(cursor, source, digest);
  if (offset >= text.length && offset !== 0) throw usageError("Read cursor exceeds this document.");
  let end = Math.min(offset + 4096, text.length);
  // Never cut between UTF-16 surrogate halves.
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
  return { contentPage: {
    source, digest, encoding: "json", offset, totalCharacters: text.length,
    totalBytes, text: text.slice(offset, end), complete: end === text.length,
    nextCursor: end < text.length ? encodeReadCursor({ source, digest, offset: end }) : null
  } };
}

/** Shared parser for list/detail command tails; no options reach mutations. */
export function readOptions(args: readonly string[], flags: readonly string[] = ["--cursor", "--limit"]) {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    if (!flags.includes(arg) || values.has(arg) || args[i + 1] === undefined || args[i + 1]!.startsWith("--")) {
      throw usageError(`Invalid read option: ${arg}.`);
    }
    values.set(arg, args[++i]!);
  }
  return { positionals, values, cursor: values.get("--cursor"),
    ...(values.has("--limit") ? { limit: Number(values.get("--limit")) } : {}) };
}
