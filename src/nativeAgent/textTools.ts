import { constants, realpathSync, statSync } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Json, Tool, ToolError, ToolOutcome } from './contracts.js';

class FileFault extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): ToolError => ({ code, message, effect: 'none' });

/** Controlled local directories only. Path checks are NOT an adversarial sandbox. */
export function createTextTools({ root, maxBytes = 64 * 1024 }: { root: string; maxBytes?: number }): Tool[] {
  if (!path.isAbsolute(root)) throw new Error('An explicit absolute workspace root is required');
  const workspace = realpathSync(root);
  if (!statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024) {
    throw new Error('maxBytes must be an integer in [1, 65536]');
  }
  const validate = (args: Json, write: boolean): ToolError | null => {
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || typeof args.path !== 'string' || !args.path.trim()
      || Object.keys(args).some(k => k !== 'path' && !(write && k === 'content'))
      || (write && typeof args.content !== 'string')) return fail('invalid_arguments', 'Expected path and, for write, content');
    if (args.path.includes('\0') || path.isAbsolute(args.path) || args.path.split(/[\\/]/).includes('..')) {
      return fail('path_out_of_scope', 'Expected a relative path without parent traversal');
    }
    if (write && Buffer.byteLength(args.content as string) > maxBytes) return fail('too_large', 'Text exceeds byte limit');
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
  return ['read', 'write'].map(name => {
    const writing = name === 'write';
    return {
      definition: {
        name,
        description: writing ? 'Replace a workspace UTF-8 text file' : 'Read a bounded workspace UTF-8 text file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' },
          ...(writing ? { content: { type: 'string' } } : {}) },
        required: writing ? ['path', 'content'] : ['path'], additionalProperties: false },
      },
      validate: (args: Json) => validate(args, writing),
      async execute(args, _scope, signal): Promise<ToolOutcome> {
        const invalid = validate(args, writing);
        if (invalid) return { ok: false, error: invalid };
        const { path: relative, content } = args as { path: string; content?: string };
        let temporary: string | undefined;
        let committed = false;
        let result: ToolOutcome;
        try {
          signal.throwIfAborted();
          const target = await check(relative, writing);
          if (!writing) {
            const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const stat = await file.stat();
              if (!stat.isFile() || stat.nlink > 1) throw new FileFault('not_regular_file', 'Expected single-link regular file');
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
              let text;
              try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes)); }
              catch { throw new FileFault('invalid_utf8', 'File is not valid UTF-8'); }
              result = { ok: true, content: JSON.stringify({ path: relative, text, bytes }) };
            } finally { await file.close(); }
          } else {
            const candidate = path.join(path.dirname(target), `.agent-${randomUUID()}.tmp`);
            const file = await open(candidate, 'wx', 0o600);
            temporary = candidate;
            try { await file.writeFile(content!, { encoding: 'utf8', signal }); }
            finally { await file.close(); }
            await check(relative, true);
            signal.throwIfAborted();
            await rename(temporary, target);
            committed = true;
            temporary = undefined;
            result = { ok: true, content: JSON.stringify({ path: relative, bytes: Buffer.byteLength(content!) }) };
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
            return { ok: false, error: { code: 'cleanup_failed',
              message: `Owned temporary file remains: ${path.relative(workspace, temporary)}; targetCommitted=${committed}`,
              effect: 'unknown' } };
          }
        }
        return result;
      },
    };
  });
}
