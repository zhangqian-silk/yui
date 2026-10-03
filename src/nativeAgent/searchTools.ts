import { constants, realpathSync, statSync } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { Json, Tool, ToolError, ToolOutcome } from './index.js';

export type SearchToolOptions = {
  root: string;
  maxEntries?: number;
  maxResults?: number;
  maxOutputBytes?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
};
class SearchFault extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): ToolError => ({ code, message, effect: 'none' });
const limit = () => new SearchFault('limit_exceeded', 'Search incomplete: scan, depth, file, result or output budget exceeded; narrow the path or query');

/** Read-only tools for controlled local directories, not an adversarial filesystem sandbox. */
export function createSearchTools(options: SearchToolOptions): Tool[] {
  if (!path.isAbsolute(options.root)) throw new Error('An explicit absolute workspace root is required');
  const root = realpathSync(options.root);
  if (!statSync(root).isDirectory()) throw new Error('Workspace must be a directory');
  const defaults = {
    maxEntries: 10_000, maxResults: 200, maxOutputBytes: 64 * 1024,
    maxFileBytes: 64 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxDepth: 32,
  };
  const limits = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const value = options[key] ?? defaults[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > defaults[key]) {
      throw new Error(`${key} must be an integer in [1, ${defaults[key]}]`);
    }
    limits[key] = value;
  }
  const validate = (args: Json, query: boolean): ToolError | null => {
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || typeof args.path !== 'string' || !args.path.trim() || args.path.length > 4096
      || Object.keys(args).some(k => k !== 'path' && !(query && k === 'query'))
      || (query && (typeof args.query !== 'string' || !args.query.length || args.query.length > 4096
        || args.query.includes('\n') || args.query.includes('\r')))) {
      return fail('invalid_arguments', 'Expected path (use "." for root) and a nonempty single-line literal query for find/search');
    }
    if (args.path.includes('\0') || path.isAbsolute(args.path) || args.path.split(/[\\/]/).includes('..')) {
      return fail('path_out_of_scope', 'Expected a relative path without parent traversal');
    }
    return null;
  };
  const inspect = async (target: string) => {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new SearchFault('symlink_denied', 'Search incomplete: symlinks are not allowed');
    if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) {
      throw new SearchFault('not_regular_file', 'Search incomplete: expected directories or single-link regular files');
    }
    return info;
  };
  return (['list', 'find', 'search'] as const).map(name => ({
    definition: {
      name,
      description: name === 'list'
        ? 'List immediate directory entries; path "." selects root. Errors on unsafe entries or budget exhaustion.'
        : name === 'find'
          ? 'Recursively find regular files by case-sensitive literal basename substring, not glob. Errors if traversal is incomplete.'
          : 'Recursively search UTF-8 files for a case-sensitive single-line literal substring; return matching lines. Errors if any file cannot be safely fully searched.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, ...(name !== 'list' ? { query: { type: 'string' } } : {}) },
        required: name === 'list' ? ['path'] : ['path', 'query'], additionalProperties: false,
      },
    },
    validate: (args: Json) => validate(args, name !== 'list'),
    async execute(args, _scope, signal): Promise<ToolOutcome> {
      const invalid = validate(args, name !== 'list');
      if (invalid) return { ok: false, error: invalid };
      const { path: relative, query } = args as { path: string; query?: string };
      try {
        signal.throwIfAborted();
        const start = path.resolve(root, relative);
        const rel = path.relative(root, start);
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
          throw new SearchFault('path_out_of_scope', 'Path is outside workspace');
        }
        // Recheck the root and every component on each execution; never traverse symlinks.
        let current = root;
        for (const part of ['', ...rel.split(path.sep).filter(Boolean)]) {
          current = path.join(current, part);
          signal.throwIfAborted();
          if (!(await inspect(current)).isDirectory()) {
            throw new SearchFault('not_directory', 'Expected a directory path');
          }
        }
        const results: Json[] = [];
        let outputBytes = Buffer.byteLength('{"results":[],"complete":true}');
        let scanned = 0;
        let totalBytes = 0;
        const append = (entry: Json) => {
          outputBytes += Buffer.byteLength(JSON.stringify(entry)) + (results.length ? 1 : 0);
          if (results.length >= limits.maxResults || outputBytes > limits.maxOutputBytes) throw limit();
          results.push(entry);
        };
        const scan = async (directory: string, depth: number): Promise<void> => {
          signal.throwIfAborted();
          if (depth > limits.maxDepth) throw limit();
          // Streaming directory iteration bounds allocation even for very large directories.
          const dir = await opendir(directory);
          for await (const entry of dir) {
            signal.throwIfAborted();
            if (++scanned > limits.maxEntries) throw limit();
            const target = path.join(directory, entry.name);
            const info = await inspect(target);
            const display = path.relative(root, target);
            if (name === 'list') {
              append({ path: display, type: info.isDirectory() ? 'directory' : 'file' });
            } else if (info.isDirectory()) {
              await scan(target, depth + 1);
            } else if (name === 'find') {
              if (entry.name.includes(query!)) append({ path: display });
            } else {
              const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
              try {
                const opened = await file.stat();
                if (!opened.isFile() || opened.nlink !== 1) {
                  throw new SearchFault('not_regular_file', 'Search incomplete: expected single-link regular file');
                }
                if (opened.size > limits.maxFileBytes || totalBytes + opened.size > limits.maxTotalBytes) throw limit();
                const buffer = Buffer.alloc(Math.min(limits.maxFileBytes, limits.maxTotalBytes - totalBytes) + 1);
                let bytes = 0;
                while (bytes < buffer.length) {
                  signal.throwIfAborted();
                  const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
                  if (!read.bytesRead) break;
                  bytes += read.bytesRead;
                }
                totalBytes += bytes;
                if (bytes > limits.maxFileBytes || totalBytes > limits.maxTotalBytes) throw limit();
                let text: string;
                try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes)); }
                catch { throw new SearchFault('invalid_utf8', 'Search incomplete: encountered a file that is not valid UTF-8'); }
                let line = 0;
                for (const textLine of text.split('\n')) {
                  signal.throwIfAborted();
                  line++;
                  if (textLine.includes(query!)) append({ path: display, line, text: textLine });
                }
              } finally { await file.close(); }
            }
          }
        };
        await scan(start, 0);
        signal.throwIfAborted();
        if (outputBytes > limits.maxOutputBytes) throw limit();
        return { ok: true, content: JSON.stringify({ results, complete: true }) };
      } catch (error) {
        const code = error instanceof SearchFault ? error.code : signal.aborted ? 'cancelled'
          : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'io_error';
        return { ok: false, error: fail(code, error instanceof SearchFault ? error.message : `Search incomplete (${code})`) };
      }
    },
  }));
}
