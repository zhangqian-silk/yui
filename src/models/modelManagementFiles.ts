import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { WebRequestRejected } from "../web/webMutation.js";
import { modelObject } from "./modelManagementConfig.js";

export function modelDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function privateModelFile(path: string, secret = false): string {
  try {
    if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) throw new Error();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      const limit = secret ? 16384 : 2 * 1024 * 1024;
      if (!stat.isFile() || stat.size > limit
        || (process.getuid && stat.uid !== process.getuid())
        || (secret && (stat.mode & 0o077) !== 0)) throw new Error();
      const buffer = Buffer.alloc(limit + 1);
      let total = 0;
      while (total < buffer.length) {
        const count = readSync(fd, buffer, total, buffer.length - total, total);
        if (!count) break;
        total += count;
      }
      if (total > limit) throw new Error();
      return buffer.subarray(0, total).toString("utf8");
    } finally { closeSync(fd); }
  } catch { throw new WebRequestRejected(secret ? "Credential file unavailable; use an owned private regular file." : "Bridge configuration must be an owned, bounded, non-symlink JSON file."); }
}

export function modelKey(path: string): string {
  if (!path) return "";
  const key = privateModelFile(path, true).trim();
  if (!key || /[\0\r\n]/.test(key)) throw new WebRequestRejected("Credential file is empty or invalid.");
  return key;
}

export function modelJsonFile(path: string) {
  const raw = privateModelFile(path);
  try { return { path, raw, value: modelObject(JSON.parse(raw)) }; }
  catch { throw new WebRequestRejected("Bridge configuration is not a JSON object."); }
}

export type ModelFile = ReturnType<typeof modelJsonFile>;

/** Atomic replacement, with optimistic conflict detection against the read bytes. */
export function replaceModelFile(file: ModelFile, value: unknown): void {
  modelDirectory(dirname(file.path));
  if (privateModelFile(file.path) !== file.raw) throw new WebRequestRejected("Bridge configuration changed; read it again.");
  const temporary = join(dirname(file.path), `.yui-model-${randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    created = true;
    if (privateModelFile(file.path) !== file.raw) throw new WebRequestRejected("Bridge configuration changed; read it again.");
    renameSync(temporary, file.path);
    created = false;
  } finally { if (created) unlinkSync(temporary); }
}

export function newModelFile(directory: string, name: string, value: unknown): string {
  modelDirectory(directory);
  const filename = `yui-provider-${name}-${randomUUID()}.json`;
  writeFileSync(join(directory, filename), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return filename;
}

function modelDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (realpathSync(directory) !== resolve(directory) || !stat.isDirectory()
    || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new WebRequestRejected("Bridge configuration directory must be owned, non-symlink and not writable by other users.");
  }
}
