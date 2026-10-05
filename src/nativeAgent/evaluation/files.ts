import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export type Entry = { kind: 'file' | 'directory' | 'symlink' | 'other'; digest: string; text?: string };
export type Files = ReadonlyMap<string, Entry>;
/** Bounded inspection includes untracked files, links, and empty directories.
 * Links are recorded, never followed. A failed read is not an empty diff.
 */
export async function inspectFiles(root: string): Promise<Files> {
  const files = new Map<string, Entry>();
  async function visit(relative: string): Promise<void> {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const key = relative ? `${relative}/${name}` : name;
      if (files.size >= 64 || Buffer.byteLength(key) > 1024) throw Error('Snapshot limit');
      const filename = path.join(root, key);
      const stat = await lstat(filename);
      if (stat.isSymbolicLink()) files.set(key, { kind: 'symlink', digest: sha256(await readlink(filename)) });
      else if (stat.isDirectory()) {
        files.set(key, { kind: 'directory', digest: sha256('directory') });
        await visit(key);
      } else if (stat.isFile() && stat.nlink === 1 && stat.size <= 64 * 1024) {
        const bytes = await readFile(filename);
        if (bytes.length > 64 * 1024) throw Error('Snapshot limit');
        const text = bytes.toString('utf8');
        if (!Buffer.from(text).equals(bytes)) throw Error('Snapshot encoding');
        files.set(key, { kind: 'file', digest: sha256(bytes), text });
      } else files.set(key, { kind: 'other', digest: sha256('unsupported') });
    }
  }
  await visit('');
  return files;
}
export function filesDigest(files: Files): string {
  return sha256(JSON.stringify([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => [key, value.kind, value.digest])));
}
export function compareFiles(before: Files, after: Files) {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(key => {
    const a = before.get(key), b = after.get(key);
    if (a?.kind === b?.kind && a?.digest === b?.digest) return [];
    return [{
      path: key, kind: !a ? 'added' as const : !b ? 'deleted' as const : 'modified' as const,
      before: a?.digest ?? null, after: b?.digest ?? null,
      regular: (!a || a.kind === 'file') && (!b || b.kind === 'file'),
    }];
  });
}
