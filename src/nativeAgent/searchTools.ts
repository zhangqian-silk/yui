import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Json, Tool, ToolError, ToolOutcome } from './contracts.js';
import { FileFault, bounded, workspaceRoot, validPath, checkPath, inspect, readSnapshot,
  digest, fits, cursor, readCursor, lines } from './fileToolsSupport.js';
import { glob, regex, type MatchBudget } from './filePatterns.js';

export type SearchToolOptions = {
  root: string; maxEntries?: number; maxResults?: number; maxOutputBytes?: number;
  maxFileBytes?: number; maxTotalBytes?: number; maxDepth?: number; maxPatternWork?: number;
};
type Request = {
  path: string; query?: string; mode?: 'literal' | 'glob' | 'regex'; cursor?: string;
  ignore?: boolean; generated?: boolean; hidden?: boolean; exclude?: string[];
};
type Rule = { base: string; directory: boolean; negate: boolean; basename: boolean;
  match: ReturnType<typeof glob> };
const fail = (code: string, message: string): ToolError => ({ code, message, effect: 'none' });
const limit = () => new FileFault('limit_exceeded', 'Scan incomplete: entry/depth/byte budget exceeded; narrow path or query');
const defaults = { maxEntries: 10_000, maxResults: 200, maxOutputBytes: 64 * 1024,
  maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, maxDepth: 32, maxPatternWork: 2_000_000 };

/** Bounded rescans, no index/daemon, no OS sandbox. .git is always excluded. */
export function createSearchTools(options: SearchToolOptions): Tool[] {
  const root = workspaceRoot(options.root);
  const limits = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) limits[key] = bounded(options[key], defaults[key], key);
  const validate = (args: Json, name: string): ToolError | null => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('invalid_arguments', 'Expected an argument object');
    if (!validPath(args.path)) return fail(typeof args.path === 'string' && (path.isAbsolute(args.path)
      || args.path.split(/[\\/]/).includes('..')) ? 'path_out_of_scope' : 'invalid_arguments', 'Expected a bounded relative path');
    if (Object.keys(args).some(key => !['path', 'query', 'mode', 'cursor', 'ignore', 'generated', 'hidden', 'exclude'].includes(key))
      || (name === 'list' && (args.query !== undefined || args.mode !== undefined))
      || (name !== 'list' && (typeof args.query !== 'string' || !args.query || args.query.length > 4096 || /[\0\r\n]/.test(args.query)))
      || (args.mode !== undefined && !['literal', 'glob', 'regex'].includes(args.mode as string))
      || (args.mode === 'regex' && name !== 'search') || (args.mode === 'glob' && name !== 'find')
      || ['ignore', 'generated', 'hidden'].some(key => args[key] !== undefined && typeof args[key] !== 'boolean')
      || (args.cursor !== undefined && (typeof args.cursor !== 'string' || !args.cursor || args.cursor.length > 2048))
      || (args.exclude !== undefined && (!Array.isArray(args.exclude) || args.exclude.length > 16
        || args.exclude.some(item => typeof item !== 'string')))) {
      return fail('invalid_arguments', 'Expected query mode, optional cursor and explicit discovery policy');
    }
    return null;
  };
  return (['list', 'find', 'search'] as const).map(name => ({
    definition: {
      name,
      description: name === 'list' ? 'List immediate entries with bounded pages and explicit discovery coverage'
        : name === 'find' ? 'Find literal basename substrings or bounded root-relative glob patterns; pages bind scan/policy'
          : 'Search literal substrings or restricted bounded regex; matching line snippets, real line numbers, explicit binary/policy coverage',
      inputSchema: { type: 'object', properties: { path: { type: 'string' },
        ...(name !== 'list' ? { query: { type: 'string' }, mode: { type: 'string', enum: name === 'find'
          ? ['literal', 'glob'] : ['literal', 'regex'] } } : {}),
        cursor: { type: 'string' }, ignore: { type: 'boolean' }, generated: { type: 'boolean' },
        hidden: { type: 'boolean' }, exclude: { type: 'array', maxItems: 16, items: { type: 'string' } } },
      required: name === 'list' ? ['path'] : ['path', 'query'], additionalProperties: false },
    },
    validate: args => validate(args, name),
    async execute(args, scope, signal): Promise<ToolOutcome> {
      const invalid = validate(args, name);
      if (invalid) return { ok: false, error: invalid };
      const request = args as unknown as Request;
      try {
        signal.throwIfAborted();
        const start = await checkPath(root, request.path);
        const startInfo = await inspect(start);
        if (path.relative(root, start).split(path.sep).includes('.git')) {
          throw new FileFault('git_metadata_denied', 'Discovery does not enter .git metadata, including explicit paths');
        }
        const budget: MatchBudget = { remaining: limits.maxPatternWork };
        const match = request.mode === 'glob' ? glob(request.query!) : request.mode === 'regex' ? regex(request.query!) : undefined;
        const excludes = (request.exclude ?? []).map(pattern => ({ pattern, match: glob(pattern) }));
        const policy = { ignore: request.ignore ?? true, generated: request.generated ?? true,
          hidden: request.hidden ?? true, exclude: request.exclude ?? [], gitMetadata: false };
        const binding = digest(JSON.stringify([name, request.path, request.query ?? null, request.mode ?? 'literal', policy, limits]));
        // Decode request binding before the scan; fingerprint is checked after the bounded full rescan.
        let offset = 0;
        let previousFingerprint: string | undefined;
        if (request.cursor) {
          let parsed;
          try { parsed = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')); }
          catch { throw new FileFault('invalid_cursor', 'Cursor cannot be decoded'); }
          if (!parsed || parsed.binding !== binding || typeof parsed.fingerprint !== 'string') {
            throw new FileFault('invalid_cursor', 'Cursor does not match request');
          }
          offset = readCursor(request.cursor, binding, parsed.fingerprint, Number.MAX_SAFE_INTEGER);
          previousFingerprint = parsed.fingerprint;
        }
        const fingerprint = createHash('sha256');
        let scanned = 0; let totalBytes = 0; let ruleCount = 0; let count = 0;
        const skipped = { gitMetadata: 0, ignored: 0, generated: 0, hidden: 0, excluded: 0, binary: 0 };
        const results: Json[] = [];
        const record = (target: string, info: Awaited<ReturnType<typeof inspect>>) => {
          fingerprint.update(JSON.stringify([path.relative(root, target), info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]));
        };
        const append = (result: Json) => {
          if (count >= offset && results.length <= limits.maxResults) results.push(result);
          count++;
        };
        const loadRules = async (directory: string, inherited: Rule[]): Promise<Rule[]> => {
          let rules = inherited;
          if (directory !== root) {
            try {
              const git = await lstat(path.join(directory, '.git'));
              if (git.isDirectory() || git.isFile()) rules = []; // Nested repository starts a new ignore scope.
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          if (!policy.ignore) return rules;
          const ignorePath = path.join(directory, '.gitignore');
          let content;
          try {
            await inspect(ignorePath);
            content = await readSnapshot(ignorePath, Math.min(64 * 1024, limits.maxFileBytes), signal);
          } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return rules; throw error; }
          totalBytes += content.bytes;
          if (totalBytes > limits.maxTotalBytes) throw limit();
          fingerprint.update(ignorePath + content.sha256 + content.identity);
          const base = path.relative(root, directory).split(path.sep).join('/');
          const added: Rule[] = [];
          for (let pattern of content.text.split(/\r?\n/)) {
            if (!pattern || pattern.startsWith('#')) continue;
            if (++ruleCount > 1024) throw new FileFault('pattern_limit', 'Too many ignore rules');
            const negate = pattern.startsWith('!');
            if (negate) pattern = pattern.slice(1);
            const directoryOnly = pattern.endsWith('/');
            if (directoryOnly) pattern = pattern.slice(0, -1);
            const anchored = pattern.startsWith('/');
            if (anchored) pattern = pattern.slice(1);
            added.push({ base, directory: directoryOnly, negate, basename: !anchored && !pattern.includes('/'), match: glob(pattern) });
          }
          return [...rules, ...added];
        };
        const omitted = (display: string, basename: string, directory: boolean, rules: Rule[]): boolean => {
          if (basename === '.git') { skipped.gitMetadata++; return true; }
          if (!policy.hidden && basename.startsWith('.')) { skipped.hidden++; return true; }
          if (policy.generated && directory && ['node_modules', 'dist', 'build', 'coverage'].includes(basename)) {
            skipped.generated++; return true;
          }
          if (excludes.some(rule => rule.match(rule.pattern.includes('/') ? display : basename, budget))) { skipped.excluded++; return true; }
          let ignored = false;
          for (const rule of rules) {
            if (rule.directory && !directory) continue;
            if (rule.base && !display.startsWith(rule.base + '/')) continue;
            const local = rule.base ? display.slice(rule.base.length + 1) : display;
            if (rule.match(rule.basename ? basename : local, budget)) ignored = !rule.negate;
          }
          if (ignored) skipped.ignored++;
          return ignored;
        };
        const fileResult = async (target: string, display: string): Promise<void> => {
          const info = await inspect(target); record(target, info);
          if (name === 'find') {
            if (match ? match(display, budget) : path.basename(target).includes(request.query!)) append({ path: display });
            return;
          }
          if (name === 'list') { append({ path: display, type: 'file' }); return; }
          if (info.size > limits.maxFileBytes || info.size + totalBytes > limits.maxTotalBytes) throw limit();
          const snapshot = await readSnapshot(target, limits.maxFileBytes, signal);
          totalBytes += snapshot.bytes;
          if (totalBytes > limits.maxTotalBytes) throw limit();
          fingerprint.update(snapshot.sha256 + snapshot.identity);
          if (snapshot.text.includes('\0')) { skipped.binary++; return; }
          let line = 0; let byteStart = 0;
          for (const raw of lines(snapshot.text)) {
            signal.throwIfAborted(); line++;
            const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
            const matches = match ? match(text, budget) : text.includes(request.query!);
            if (matches) {
              // Long matching lines are previews, not silently complete text.
              let end = Math.min(text.length, Math.max(1, Math.floor(limits.maxOutputBytes / 8)));
              if (/[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
              const snippet = text.slice(0, end);
              append(end === text.length ? { path: display, line, text } : { path: display, line, text: snippet,
                textTruncated: true, lineBytes: Buffer.byteLength(text), byteStart, sha256: snapshot.sha256 });
            }
            byteStart += Buffer.byteLength(raw);
          }
        };
        const scan = async (directory: string, depth: number, inherited: Rule[]): Promise<void> => {
          signal.throwIfAborted();
          if (depth > limits.maxDepth) throw limit();
          const before = await inspect(directory); record(directory, before);
          const rules = await loadRules(directory, inherited);
          const names: string[] = [];
          const dir = await opendir(directory);
          for await (const entry of dir) {
            if (++scanned > limits.maxEntries) throw limit();
            names.push(entry.name);
          }
          names.sort();
          for (const basename of names) {
            signal.throwIfAborted();
            const target = path.join(directory, basename);
            const info = await lstat(target);
            const display = path.relative(root, target).split(path.sep).join('/');
            record(target, info);
            if (omitted(display, basename, info.isDirectory(), rules)) continue;
            await inspect(target);
            if (info.isDirectory()) {
              if (name === 'list') append({ path: display, type: 'directory' });
              else await scan(target, depth + 1, rules);
            } else await fileResult(target, display);
          }
          const after = await inspect(directory);
          if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            throw new FileFault('edit_conflict', 'Directory changed during scan');
          }
        };
        let inherited: Rule[] = [];
        const relativeParts = path.relative(root, start).split(path.sep).filter(Boolean);
        let ancestor = root;
        for (const part of startInfo.isDirectory() ? relativeParts : []) {
          inherited = await loadRules(ancestor, inherited);
          ancestor = path.join(ancestor, part);
        }
        if (startInfo.isDirectory()) await scan(start, 0, inherited);
        else await fileResult(start, path.relative(root, start).split(path.sep).join('/')); // Explicit files bypass discovery filters.
        signal.throwIfAborted();
        const stamp = fingerprint.digest('hex');
        if (previousFingerprint !== undefined && previousFingerprint !== stamp) throw new FileFault('stale_cursor', 'Scan changed; restart query');
        if (offset > count) throw new FileFault('invalid_cursor', 'Cursor exceeds results');
        const page = results.slice(0, limits.maxResults);
        const make = (): ToolOutcome => {
          const complete = offset + page.length === count;
          return { ok: true, content: JSON.stringify({ results: page, complete, scanComplete: true,
            nextCursor: complete ? null : cursor(binding, stamp, offset + page.length),
            coverage: { complete: Object.values(skipped).every(value => value === 0), policy },
            skipped, budgets: { entries: scanned, bytes: totalBytes, patternWork: limits.maxPatternWork - budget.remaining },
            truncationReason: complete ? null : page.length < limits.maxResults ? 'output_bytes' : 'result_limit' }) };
        };
        while (page.length && !fits(make(), limits.maxOutputBytes, name, scope.toolCallId)) page.pop();
        if ((offset < count && !page.length) || !fits(make(), limits.maxOutputBytes, name, scope.toolCallId)) {
          throw new FileFault('limit_exceeded', 'Output cannot hold one result plus coverage metadata; increase budget or narrow path');
        }
        return make();
      } catch (error) {
        const code = error instanceof FileFault ? error.code === 'too_large' ? 'limit_exceeded' : error.code
          : signal.aborted ? 'cancelled' : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'io_error';
        return { ok: false, error: fail(code, error instanceof FileFault ? error.message : `Scan incomplete (${code})`) };
      }
    },
  }));
}
