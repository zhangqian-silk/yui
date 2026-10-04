import { constants, realpathSync, statSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolOutcome } from './contracts.js';

// Private repository-pack helpers. These checks are not an adversarial sandbox.
export class FileFault extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
export function bounded(value: number | undefined, maximum: number, label: string): number {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error(`${label} must be in [1, ${maximum}]`);
  return result;
}
export function workspaceRoot(root: string): string {
  if (!path.isAbsolute(root)) throw new Error('An explicit absolute workspace root is required');
  const result = realpathSync(root);
  if (!statSync(result).isDirectory()) throw new Error('Workspace must be a directory');
  return result;
}
export function validPath(relative: unknown): boolean {
  return typeof relative === 'string' && !!relative.trim() && Buffer.byteLength(relative) <= 4096
    && !/[\0\r\n]/.test(relative) && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..');
}
export async function inspect(target: string) {
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new FileFault('symlink_denied', 'Symlinks are not allowed');
  if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new FileFault('not_regular_file', 'Expected directories or single-link files');
  return info;
}
export async function checkPath(root: string, relative: string, allowMissing = false): Promise<string> {
  if (!validPath(relative)) throw new FileFault('path_out_of_scope', 'Expected a relative path without parent traversal');
  const target = path.resolve(root, relative);
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  if (!(await inspect(root)).isDirectory()) throw new FileFault('not_directory', 'Workspace is not a directory');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let info;
    try { info = await inspect(current); }
    catch (error) {
      if (allowMissing && i === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return target;
      throw error;
    }
    if (i < parts.length - 1 && !info.isDirectory()) throw new FileFault('not_directory', 'Expected ordinary directories');
  }
  return target;
}
export type Snapshot = { text: string; bytes: number; sha256: string; identity: string };
// Shared, deliberately narrow binary classification; not general format detection.
export const isBinary = (text: string): boolean => text.includes('\0');
export function assertText(text: string): void {
  if (isBinary(text)) throw new FileFault('binary_file', 'NUL-bearing binary content is not supported by text tools');
}
export async function readSnapshot(target: string, maxBytes: number, signal: AbortSignal): Promise<Snapshot> {
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    const identity = (info: typeof before) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    if (!before.isFile() || before.nlink !== 1n) throw new FileFault('not_regular_file', 'Expected single-link regular file');
    if (before.size > maxBytes) throw new FileFault('too_large', 'File exceeds scan byte limit');
    const buffer = Buffer.alloc(Math.min(Number(before.size) + 1, maxBytes + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      signal.throwIfAborted();
      const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (bytes > maxBytes) throw new FileFault('too_large', 'File exceeds scan byte limit');
    if (identity(before) !== identity(after) || BigInt(bytes) !== before.size) throw new FileFault('edit_conflict', 'File changed while reading');
    const raw = buffer.subarray(0, bytes);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
    catch { throw new FileFault('invalid_utf8', 'File is not valid UTF-8'); }
    return { text, bytes, sha256: digest(raw), identity: identity(after) };
  } finally { await file.close(); }
}
// Include the escaped inner JSON in the outer outcome and ToolManager's message.
export function fits(outcome: ToolOutcome, maximum: number, name: string, toolCallId: string): boolean {
  return Buffer.byteLength(JSON.stringify(outcome)) <= maximum
    && Buffer.byteLength(JSON.stringify({ role: 'tool', name, toolCallId, outcome })) <= 512 * 1024;
}
export function cursor(binding: string, fingerprint: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, binding, fingerprint, offset })).toString('base64url');
}
export function readCursor(value: string | undefined, binding: string, fingerprint: string, maximum: number): number {
  if (!value) return 0;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw new FileFault('invalid_cursor', 'Cursor cannot be decoded'); }
  if (!parsed || parsed.v !== 1 || parsed.binding !== binding || !Number.isSafeInteger(parsed.offset)
    || parsed.offset < 0 || parsed.offset > maximum) throw new FileFault('invalid_cursor', 'Cursor does not match request');
  if (parsed.fingerprint !== fingerprint) throw new FileFault('stale_cursor', 'Files or coverage changed; restart query');
  return parsed.offset;
}
export const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
export type Replacement = { start: number; end: number; text: string };
export function replace(text: string, edits: Replacement[]): string {
  let result = text;
  for (const edit of [...edits].reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}
/** Edit-derived hunks, not a quadratic whole-file diff or a Git HEAD diff. */
export function diff(relative: string, before: string, edits: Replacement[], next: string, creating = false): string {
  if (before === next && !creating) return '';
  if (creating && !next) return `diff --git ${JSON.stringify(`a/${relative}`)} ${JSON.stringify(`b/${relative}`)}\nnew file mode 100600\n`;
  const oldLines = lines(before);
  const starts = [0];
  for (const line of oldLines) starts.push(starts[starts.length - 1] + line.length);
  const groups: { start: number; end: number }[] = [];
  for (const edit of edits) {
    let first = 0;
    while (first < oldLines.length && starts[first + 1] <= edit.start) first++;
    let last = first;
    while (last < oldLines.length && starts[last] < edit.end) last++;
    const group = { start: Math.max(0, first - 3), end: Math.min(oldLines.length, Math.max(first + 1, last) + 3) };
    const previous = groups[groups.length - 1];
    if (previous && group.start <= previous.end) previous.end = Math.max(previous.end, group.end);
    else groups.push(group);
  }
  let output = `--- ${creating ? '/dev/null' : JSON.stringify(`a/${relative}`)}\n+++ ${JSON.stringify(`b/${relative}`)}\n`;
  let lineDelta = 0;
  const print = (prefix: string, line: string) => prefix + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n');
  for (const group of groups) {
    const start = starts[group.start];
    const end = starts[group.end];
    const local = edits.filter(edit => edit.start >= start && edit.end <= end)
      .map(edit => ({ ...edit, start: edit.start - start, end: edit.end - start }));
    const old = oldLines.slice(group.start, group.end);
    const updated = lines(replace(before.slice(start, end), local));
    let prefix = 0;
    while (prefix < old.length && prefix < updated.length && old[prefix] === updated[prefix]) prefix++;
    let suffix = 0;
    while (suffix < old.length - prefix && suffix < updated.length - prefix
      && old[old.length - 1 - suffix] === updated[updated.length - 1 - suffix]) suffix++;
    output += `@@ -${old.length ? group.start + 1 : group.start},${old.length} +${updated.length ? group.start + lineDelta + 1 : group.start + lineDelta},${updated.length} @@\n`;
    for (const line of old.slice(0, prefix)) output += print(' ', line);
    for (const line of old.slice(prefix, old.length - suffix)) output += print('-', line);
    for (const line of updated.slice(prefix, updated.length - suffix)) output += print('+', line);
    for (const line of old.slice(old.length - suffix)) output += print(' ', line);
    lineDelta += updated.length - old.length;
  }
  return output;
}
