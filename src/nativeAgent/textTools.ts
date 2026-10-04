import { constants, realpathSync, statSync } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Json, Tool, ToolError, ToolOutcome } from './contracts.js';

class FileFault extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): ToolError => ({ code, message, effect: 'none' });
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export type TextToolsOptions = { root: string; maxBytes?: number };

/** Controlled local directories only. Path checks are NOT an adversarial sandbox. */
export function createTextTools({ root, maxBytes = 64 * 1024 }: TextToolsOptions): Tool[] {
  if (!path.isAbsolute(root)) throw new Error('An explicit absolute workspace root is required');
  const workspace = realpathSync(root);
  if (!statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024) {
    throw new Error('maxBytes must be an integer in [1, 65536]');
  }
  const validate = (args: Json, name: string): ToolError | null => {
    const keys = name === 'read' ? ['path'] : name === 'write'
      ? ['path', 'content', 'expectedSha256'] : ['path', 'oldText', 'newText', 'expectedSha256'];
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || typeof args.path !== 'string' || !args.path.trim() || args.path.length > 4096
      || Object.keys(args).some(k => !keys.includes(k))
      || (name === 'write' && typeof args.content !== 'string')
      || (name === 'edit' && (typeof args.oldText !== 'string' || !args.oldText
        || typeof args.newText !== 'string' || typeof args.expectedSha256 !== 'string'))
      || (args.expectedSha256 !== undefined && (typeof args.expectedSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(args.expectedSha256)))) {
      return fail('invalid_arguments', 'Expected tool fields and a lowercase SHA-256 precondition for replacement/edit');
    }
    if (args.path.includes('\0') || path.isAbsolute(args.path) || args.path.split(/[\\/]/).includes('..')) {
      return fail('path_out_of_scope', 'Expected a relative path without parent traversal');
    }
    if (['content', 'oldText', 'newText'].some(key => typeof args[key] === 'string'
      && Buffer.byteLength(args[key] as string) > maxBytes)) return fail('too_large', 'Text exceeds byte limit');
    return null;
  };
  const check = async (relative: string, allowMissing: boolean): Promise<string> => {
    const target = path.resolve(workspace, relative);
    const rel = path.relative(workspace, target);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new FileFault('path_out_of_scope', 'Path is outside the file workspace');
    }
    const parts = rel.split(path.sep);
    let current = workspace;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const final = i === parts.length - 1;
      let stat;
      try { stat = await lstat(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && final && allowMissing) return target;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new FileFault('symlink_denied', 'Symlinks are not allowed');
      if (final ? !stat.isFile() || stat.nlink > 1 : !stat.isDirectory()) {
        throw new FileFault('not_regular_file', 'Expected ordinary directories and a single-link regular file');
      }
    }
    return target;
  };
  const readText = async (target: string, signal: AbortSignal): Promise<{ text: string; identity: string; bytes: number }> => {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink > 1n) throw new FileFault('not_regular_file', 'Expected single-link regular file');
      if (stat.size > maxBytes) throw new FileFault('too_large', 'File exceeds byte limit');
      const buffer = Buffer.alloc(maxBytes + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        signal.throwIfAborted();
        const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      if (bytes > maxBytes) throw new FileFault('too_large', 'File exceeds byte limit');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes)); }
      catch { throw new FileFault('invalid_utf8', 'File is not valid UTF-8'); }
      return { text, bytes, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` };
    } finally { await file.close(); }
  };
  // Prevent competing calls from this pack from both passing the same precondition.
  // External writers remain subject to the documented controlled-directory assumption.
  const writers = new Map<string, Promise<void>>();
  return ['read', 'write', 'edit'].map(name => {
    const writing = name !== 'read';
    const editing = name === 'edit';
    return {
      definition: {
        name,
        description: editing ? 'Replace exactly one literal match in a file with an expected SHA-256'
          : writing ? 'Create a UTF-8 file, or replace one only with its expected SHA-256'
            : 'Read bounded workspace UTF-8 text and its SHA-256',
        inputSchema: { type: 'object', properties: { path: { type: 'string' },
          ...(writing ? { expectedSha256: { type: 'string' } } : {}),
          ...(editing ? { oldText: { type: 'string' }, newText: { type: 'string' } }
            : writing ? { content: { type: 'string' } } : {}) },
        required: editing ? ['path', 'expectedSha256', 'oldText', 'newText'] : writing ? ['path', 'content'] : ['path'],
        additionalProperties: false },
      },
      validate: (args: Json) => validate(args, name),
      async execute(args, _scope, signal): Promise<ToolOutcome> {
        const invalid = validate(args, name);
        if (invalid) return { ok: false, error: invalid };
        const { path: relative, content, expectedSha256, oldText, newText } = args as {
          path: string; content?: string; expectedSha256?: string; oldText?: string; newText?: string;
        };
        const key = path.resolve(workspace, relative);
        const preceding = writers.get(key);
        let release: (() => void) | undefined;
        let held: Promise<void> | undefined;
        if (writing) {
          held = new Promise<void>(resolve => { release = resolve; });
          writers.set(key, held);
          await preceding;
        }
        let temporary: string | undefined;
        let committed = false;
        let result: ToolOutcome;
        try {
          signal.throwIfAborted();
          const target = await check(relative, writing);
          if (!writing) {
            const { text, bytes } = await readText(target, signal);
            result = { ok: true, content: JSON.stringify({ path: relative, text, bytes, sha256: digest(text) }) };
          } else {
            const snapshot = async () => {
              await check(relative, true);
              try { return await readText(target, signal); }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
                throw error;
              }
            };
            const before = await snapshot();
            if (expectedSha256 === undefined ? before !== undefined : !before || digest(before.text) !== expectedSha256) {
              throw new FileFault('edit_conflict', 'File changed or exists without an expected SHA-256; read it before replacing');
            }
            let next = content!;
            if (editing) {
              const offset = before!.text.indexOf(oldText!);
              if (offset < 0 || before!.text.indexOf(oldText!, offset + 1) >= 0) {
                throw new FileFault('edit_conflict', 'oldText must match exactly once, including overlapping matches');
              }
              next = before!.text.slice(0, offset) + newText! + before!.text.slice(offset + oldText!.length);
            }
            if (Buffer.byteLength(next) > maxBytes) throw new FileFault('too_large', 'Edited file exceeds byte limit');
            const candidate = path.join(path.dirname(target), `.agent-${randomUUID()}.tmp`);
            const file = await open(candidate, 'wx', 0o600);
            temporary = candidate;
            try { await file.writeFile(next, { encoding: 'utf8', signal }); }
            finally { await file.close(); }
            const after = await snapshot();
            if (before?.identity !== after?.identity || before?.text !== after?.text) {
              throw new FileFault('edit_conflict', 'File changed before commit; no replacement was made');
            }
            signal.throwIfAborted();
            await rename(temporary, target);
            committed = true;
            temporary = undefined;
            result = { ok: true, content: JSON.stringify({ path: relative, bytes: Buffer.byteLength(next), sha256: digest(next) }) };
          }
        } catch (error) {
          const code = error instanceof FileFault ? error.code
            : signal.aborted ? 'cancelled_before_commit'
              : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'io_error';
          result = { ok: false, error: fail(code, error instanceof FileFault ? error.message : `File operation failed (${code})`) };
        }
        if (temporary) {
          try { await unlink(temporary); }
          catch {
            result = { ok: false, error: { code: 'cleanup_failed',
              message: `Owned temporary file remains: ${path.relative(workspace, temporary)}; targetCommitted=${committed}`,
              effect: 'unknown' } };
          }
        }
        release?.();
        if (held && writers.get(key) === held) writers.delete(key);
        return result;
      },
    };
  });
}
