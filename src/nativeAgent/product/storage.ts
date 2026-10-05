import { mkdir, chmod, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createSessionStore, createSqliteSessionBackend, SessionError,
  SessionMetadataSaveError, type SessionStore } from '../index.js';
import { ProductError } from './config.js';

/** Only fixed producer codes reach diagnostics; never title/cursor/cause text. */
export function storageFailure(error: unknown): ProductError {
  if (error instanceof ProductError) return error;
  const codes = ['cursor_stale', 'invalid_cursor', 'not_found', 'revision_conflict',
    'read_failed', 'unsupported_format', 'corrupt_session', 'invalid_title', 'closed', 'metadata_save_failed'];
  const field = error instanceof SessionError && codes.includes(error.code) ? error.code : 'catalog';
  const next = field === 'cursor_stale' || field === 'invalid_cursor'
    ? 'Restart from the first page with the same store, Session ID and page limit.'
    : error instanceof SessionMetadataSaveError
      ? `Read Session ${error.sessionId}'s exact title and metadata revision before another write; do not blindly retry.`
      : 'Inspect the exact selected store and Session facts; no automatic retry or replay.';
  return new ProductError('agent_storage', field, next,
    error instanceof SessionMetadataSaveError ? 'unknown' : undefined,
    error instanceof SessionMetadataSaveError ? error.sessionId : undefined);
}

/** A browsing command opens an existing file only; execution may create it.
 * Both use the real producer's supported migration chain, never another ledger. */
export async function openProductStore(directory: string, create: boolean): Promise<SessionStore> {
  let store: SessionStore | undefined;
  try {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    const filename = join(await realpath(directory), 'sessions.sqlite');
    if (!create) {
      const file = await lstat(filename);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error();
    }
    store = createSessionStore(createSqliteSessionBackend(filename));
    if (create) await chmod(filename, 0o600);
    return store;
  } catch (error) {
    await store?.close();
    if (error instanceof SessionError) throw storageFailure(error);
    throw new ProductError('agent_storage', 'stateDir',
      'Select a controlled state directory with a supported Agent database; browsing never creates one.');
  }
}
