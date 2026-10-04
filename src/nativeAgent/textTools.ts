import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Json, Tool, ToolError, ToolOutcome } from './contracts.js';
import { FileFault, bounded, workspaceRoot, validPath, checkPath, readSnapshot, digest,
  fits, cursor, readCursor, replace, diff, assertText, type Snapshot, type Replacement } from './fileToolsSupport.js';

export type TextToolsOptions = { root: string; maxBytes?: number; maxOutputBytes?: number };
type Edit = { oldText: string; newText: string };
type Target = { path: string; expectedSha256?: string; content?: string; edits?: Edit[] };
type ReadArgs = { path: string; startLine?: number; limit?: number; cursor?: string };
const fail = (code: string, message: string): ToolError => ({ code, message, effect: 'none' });
const object = (value: unknown): value is Record<string, Json> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Controlled directories only. Queues are same-pack, not cross-process CAS or a multi-file transaction. */
export function createTextTools(options: TextToolsOptions): Tool[] {
  const root = workspaceRoot(options.root);
  const maxBytes = bounded(options.maxBytes, 8 * 1024 * 1024, 'maxBytes');
  const maxOutputBytes = bounded(options.maxOutputBytes, 64 * 1024, 'maxOutputBytes');
  const writers = new Map<string, Promise<void>>();
  const targetsFor = (args: Record<string, Json>, name: string): Target[] => name === 'patch'
    ? args.files as unknown as Target[] : name === 'edit' ? [{
      path: args.path as string, expectedSha256: args.expectedSha256 as string,
      edits: [{ oldText: args.oldText as string, newText: args.newText as string }],
    }] : [args as unknown as Target];
  const validate = (args: Json, name: string): ToolError | null => {
    if (!object(args)) return fail('invalid_arguments', 'Expected an argument object');
    const keys = name === 'patch' ? ['files'] : name === 'read' ? ['path', 'startLine', 'limit', 'cursor']
      : name === 'edit' ? ['path', 'expectedSha256', 'oldText', 'newText'] : ['path', 'content', 'expectedSha256'];
    if (Object.keys(args).some(key => !keys.includes(key))) return fail('invalid_arguments', 'Unexpected tool fields');
    if (Buffer.byteLength(JSON.stringify(args)) > 64 * 1024) return fail('too_large', 'Arguments exceed 64 KiB');
    if (name === 'read') {
      if (!validPath(args.path)) return fail(typeof args.path === 'string' && (path.isAbsolute(args.path)
        || args.path.split(/[\\/]/).includes('..')) ? 'path_out_of_scope' : 'invalid_arguments', 'Expected a bounded relative file path');
      if (['startLine', 'limit'].some(key => args[key] !== undefined && (typeof args[key] !== 'number'
        || !Number.isSafeInteger(args[key]) || (args[key] as number) < 1 || (args[key] as number) > 1_000_000))
        || (args.cursor !== undefined && (typeof args.cursor !== 'string' || !args.cursor || args.cursor.length > 2048))) {
        return fail('invalid_arguments', 'Expected positive startLine/limit and an optional cursor');
      }
      return null;
    }
    if (name === 'patch' && (!Array.isArray(args.files) || !args.files.length || args.files.length > 16
      || !args.files.every(object))) return fail('invalid_arguments', 'patch expects 1..16 existing files');
    const targets = targetsFor(args, name);
    for (const target of targets) {
      if (!validPath(target.path)) return fail(typeof target.path === 'string' && (path.isAbsolute(target.path)
        || target.path.split(/[\\/]/).includes('..')) ? 'path_out_of_scope' : 'invalid_arguments', 'Expected bounded relative file paths');
      if (name === 'patch' && Object.keys(target).some(key => !['path', 'expectedSha256', 'edits'].includes(key))) {
        return fail('invalid_arguments', 'Unexpected patch file fields');
      }
      if (target.expectedSha256 !== undefined && (typeof target.expectedSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(target.expectedSha256))) return fail('invalid_arguments', 'Expected lowercase SHA-256');
      if (name === 'write') {
        if (typeof target.content !== 'string') return fail('invalid_arguments', 'Expected content');
        if (Buffer.byteLength(target.content) > maxBytes) return fail('too_large', 'Text exceeds byte limit');
      } else {
        if (typeof target.expectedSha256 !== 'string' || !Array.isArray(target.edits) || !target.edits.length
          || target.edits.length > 32 || target.edits.some(edit => !object(edit)
            || Object.keys(edit).some(key => !['oldText', 'newText'].includes(key))
            || typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string')) {
          return fail('invalid_arguments', 'Expected 1..32 exact edits and a SHA-256 precondition');
        }
        if (target.edits.some(edit => [edit.oldText, edit.newText].some(text => Buffer.byteLength(text) > maxBytes))) {
          return fail('too_large', 'Text exceeds byte limit');
        }
      }
    }
    return null;
  };
  const editSchema = { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' } },
    required: ['oldText', 'newText'], additionalProperties: false };
  return ['read', 'write', 'edit', 'patch'].map(name => ({
    definition: {
      name,
      description: name === 'read' ? 'Read UTF-8 pages with full-file SHA-256, exact byte offsets and request-bound cursor'
        : name === 'patch' ? 'Unique nonoverlapping original-text edits to existing files; preflight all, sequential commits, bounded actual diffs; partial failures stop'
          : name === 'edit' ? 'Replace one unique literal match with expected SHA-256 and actual diff'
            : 'Create or replace UTF-8 text with SHA-256 precondition and actual diff',
      inputSchema: { type: 'object', properties: name === 'patch' ? { files: { type: 'array', minItems: 1, maxItems: 16,
        items: { type: 'object', properties: { path: { type: 'string' }, expectedSha256: { type: 'string' },
          edits: { type: 'array', minItems: 1, maxItems: 32, items: editSchema } },
        required: ['path', 'expectedSha256', 'edits'], additionalProperties: false } } }
        : { path: { type: 'string' }, ...(name === 'read' ? { startLine: { type: 'integer' },
          limit: { type: 'integer' }, cursor: { type: 'string' } } : { expectedSha256: { type: 'string' },
          ...(name === 'edit' ? editSchema.properties : { content: { type: 'string' } }) }) } as Record<string, Json>,
      required: name === 'patch' ? ['files'] : name === 'read' ? ['path'] : name === 'edit'
        ? ['path', 'expectedSha256', 'oldText', 'newText'] : ['path', 'content'], additionalProperties: false },
    },
    validate: args => validate(args, name),
    async execute(args, scope, signal): Promise<ToolOutcome> {
      const invalid = validate(args, name);
      if (invalid) return { ok: false, error: invalid };
      const outcome = (value: unknown): ToolOutcome => ({ ok: true, content: JSON.stringify(value) });
      const fit = (result: ToolOutcome) => fits(result, maxOutputBytes, name, scope.toolCallId);
      const readText = async (target: string): Promise<Snapshot> => {
        const snapshot = await readSnapshot(target, maxBytes, signal);
        assertText(snapshot.text);
        return snapshot;
      };
      const held: { key: string; promise: Promise<void>; release: () => void }[] = [];
      const receipts: { path: string; status: string; beforeSha256: string | null; sha256: string | null;
        candidateSha256: string; bytes: number; diff: string }[] = [];
      let temporary: string | undefined;
      let committing = false;
      let index = 0;
      try {
        signal.throwIfAborted();
        if (name === 'read') {
          const request = args as unknown as ReadArgs;
          const snapshot = await readText(await checkPath(root, request.path));
          const binding = digest(JSON.stringify([request.path, request.startLine ?? 1, request.limit ?? 200, maxBytes, maxOutputBytes]));
          const fingerprint = snapshot.sha256 + ':' + snapshot.identity;
          let start = readCursor(request.cursor, binding, fingerprint, snapshot.text.length);
          if (!request.cursor) {
            for (let line = 1; line < (request.startLine ?? 1); line++) {
              const offset = snapshot.text.indexOf('\n', start);
              if (offset < 0) throw new FileFault('line_out_of_range', 'startLine is beyond EOF');
              start = offset + 1;
            }
          }
          if (start > 0 && /[\uDC00-\uDFFF]/.test(snapshot.text[start] ?? '')) throw new FileFault('invalid_cursor', 'Cursor splits a code point');
          let end = start;
          for (let count = 0; count < (request.limit ?? 200) && end < snapshot.text.length; count++) {
            const offset = snapshot.text.indexOf('\n', end);
            end = offset < 0 ? snapshot.text.length : offset + 1;
          }
          const requestedEnd = end;
          const lineAt = (offset: number) => {
            let line = 1;
            for (let i = 0; i < offset; i++) if (snapshot.text[i] === '\n') line++;
            return line;
          };
          const make = (stop: number) => outcome({ path: request.path, text: snapshot.text.slice(start, stop),
            bytes: Buffer.byteLength(snapshot.text.slice(start, stop)), fileBytes: snapshot.bytes, sha256: snapshot.sha256,
            byteStart: Buffer.byteLength(snapshot.text.slice(0, start)), byteEnd: Buffer.byteLength(snapshot.text.slice(0, stop)),
            startLine: lineAt(start), endLine: lineAt(Math.max(start, stop - 1)),
            complete: stop === snapshot.text.length, nextCursor: stop === snapshot.text.length ? null : cursor(binding, fingerprint, stop),
            truncationReason: stop < requestedEnd ? 'output_bytes' : stop < snapshot.text.length ? 'line_limit' : null });
          if (!fit(make(end))) {
            let low = start; let high = end;
            while (low < high) {
              let middle = Math.ceil((low + high) / 2);
              if (/[\uDC00-\uDFFF]/.test(snapshot.text[middle] ?? '')) middle--;
              if (middle <= low) break;
              if (fit(make(middle))) low = middle; else high = middle - 1;
            }
            end = low;
          }
          if ((end === start && start < snapshot.text.length) || !fit(make(end))) {
            throw new FileFault('output_limit', 'Budget cannot hold one code point and metadata');
          }
          return make(end);
        }
        const targets = targetsFor(args as Record<string, Json>, name);
        const keys = targets.map(target => path.resolve(root, target.path));
        if (new Set(keys).size !== keys.length) throw new FileFault('edit_conflict', 'Duplicate target paths');
        for (const key of [...keys].sort()) {
          const previous = writers.get(key);
          let release!: () => void;
          const promise = new Promise<void>(resolve => { release = resolve; });
          writers.set(key, promise);
          held.push({ key, promise, release });
          await previous;
          signal.throwIfAborted();
        }
        const snapshots: (Snapshot | undefined)[] = [];
        const candidates: string[] = [];
        const snapshot = async (target: Target): Promise<Snapshot | undefined> => {
          const absolute = await checkPath(root, target.path, name === 'write');
          if (absolute === root) throw new FileFault('not_regular_file', 'Expected a file');
          try { return await readText(absolute); }
          catch (error) {
            if (name === 'write' && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
          }
        };
        let totalBytes = 0;
        for (const target of targets) {
          signal.throwIfAborted();
          const before = await snapshot(target);
          if (target.expectedSha256 === undefined ? before !== undefined : before?.sha256 !== target.expectedSha256) {
            throw new FileFault('edit_conflict', 'File changed or exists without an expected SHA-256');
          }
          const edits: Replacement[] = target.edits ? target.edits.map(edit => {
            const start = before!.text.indexOf(edit.oldText);
            if (start < 0 || before!.text.indexOf(edit.oldText, start + 1) >= 0) {
              throw new FileFault('edit_conflict', 'oldText must match exactly once, including overlapping matches');
            }
            return { start, end: start + edit.oldText.length, text: edit.newText };
          }).sort((a, b) => a.start - b.start) : [{ start: 0, end: before?.text.length ?? 0, text: target.content! }];
          if (edits.some((edit, i) => i > 0 && edit.start < edits[i - 1].end)) throw new FileFault('edit_conflict', 'Edits overlap in original text');
          const next = replace(before?.text ?? '', edits);
          assertText(next);
          const bytes = Buffer.byteLength(next);
          totalBytes += bytes + (before?.bytes ?? 0);
          if (bytes > maxBytes || totalBytes > 32 * 1024 * 1024) throw new FileFault('too_large', 'Mutation snapshot byte budget exceeded');
          snapshots.push(before);
          candidates.push(next);
          receipts.push({ path: target.path, status: 'not_attempted', beforeSha256: before?.sha256 ?? null,
            sha256: null, candidateSha256: digest(next), bytes,
            diff: diff(target.path, before?.text ?? '', edits, next, before === undefined) });
        }
        const success = () => outcome(name === 'patch' ? { files: receipts, complete: true } : receipts[0]);
        const cleanupPath = targets.reduce((longest, target) => {
          const candidate = path.join(path.dirname(target.path), `.agent-${'0'.repeat(36)}.tmp`);
          return Buffer.byteLength(JSON.stringify(JSON.stringify(candidate))) > Buffer.byteLength(JSON.stringify(JSON.stringify(longest)))
            ? candidate : longest;
        }, '');
        const reserved = receipts.map(receipt => ({ ...receipt, status: 'not_attempted', sha256: receipt.candidateSha256 }));
        const partial: ToolOutcome = { ok: false, error: { code: 'cancelled_before_commit', effect: 'unknown',
          message: JSON.stringify({ complete: false, files: reserved, failedIndex: targets.length, cause: 'cancelled_before_commit',
            temporary: cleanupPath }) + ' '.repeat(256) } };
        // Include the most expensive doubly encoded cleanup path BEFORE touching any file.
        if (!fit(outcome(name === 'patch' ? { files: reserved, complete: true } : reserved[0])) || !fit(partial)) {
          throw new FileFault('output_limit', 'Encoded diff/receipt exceeds budget; no writes attempted');
        }
        committing = true;
        for (index = 0; index < targets.length; index++) {
          const target = targets[index];
          signal.throwIfAborted();
          const absolute = await checkPath(root, target.path, name === 'write');
          const candidate = path.join(path.dirname(absolute), `.agent-${randomUUID()}.tmp`);
          const file = await open(candidate, 'wx', 0o600);
          temporary = candidate;
          try { await file.writeFile(candidates[index], { encoding: 'utf8', signal }); }
          finally { await file.close(); }
          const after = await snapshot(target);
          if (snapshots[index]?.identity !== after?.identity || snapshots[index]?.sha256 !== after?.sha256) {
            throw new FileFault('edit_conflict', 'File changed before commit; no replacement was made');
          }
          signal.throwIfAborted();
          await rename(temporary, absolute);
          temporary = undefined;
          receipts[index].status = 'committed';
          receipts[index].sha256 = receipts[index].candidateSha256;
        }
        return success();
      } catch (error) {
        const code = error instanceof FileFault ? error.code : signal.aborted ? 'cancelled_before_commit'
          : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'io_error';
        let cleanupFailed = false;
        if (temporary) {
          try { await unlink(temporary); temporary = undefined; } catch { cleanupFailed = true; }
        }
        const committed = receipts.some(receipt => receipt.status === 'committed');
        if (committing && index < receipts.length) receipts[index].status = 'rejected';
        if (committed || cleanupFailed) return { ok: false, error: { code: cleanupFailed ? 'cleanup_failed' : code, effect: 'unknown',
          message: JSON.stringify({ complete: false, files: receipts, failedIndex: index, cause: code,
            temporary: temporary ? path.relative(root, temporary) : null }) } };
        return { ok: false, error: fail(code, error instanceof FileFault ? error.message : `File operation failed (${code})`) };
      } finally {
        for (const lock of held.reverse()) {
          lock.release();
          if (writers.get(lock.key) === lock.promise) writers.delete(lock.key);
        }
      }
    },
  }));
}
