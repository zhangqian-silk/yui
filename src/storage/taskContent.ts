import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { requireIdentity } from "../domain/validation.js";
import {
  CONTEXT_SNAPSHOT_MAX_RESOURCE_BYTES, contextContentDigest,
  validateContextSnapshot, validateContextSnapshotMetadata, type ContextSnapshot, type ContextSnapshotMetadata
} from "../context/contextSnapshot.js";
import { writeTextFileAtomically } from "./durableFile.js";

/** Storage 1.34: the database owns snapshot membership and identity; immutable
 * resource bytes belong to the Task, independently of its execution worktrees.
 * No shared blob pool: deleting A's content cannot remove B's frozen evidence.
 */
export type StoredContextSnapshot = ContextSnapshotMetadata;
export type ContextSnapshotQuery = Readonly<{
  scope: ContextSnapshot["scope"];
  scopeRef?: string;
  limit: number;
  descending?: boolean;
  rootOnly?: boolean;
}>;

export type ContentMigrationEffects = {
  files: string[];
  directories: string[];
};

export function taskContentRoot(home: string, taskId: string): string {
  if (requireIdentity(taskId, "Task content owner") !== taskId) throw new Error("Invalid Task content owner.");
  return join(resolve(home), "task-data", taskId);
}

function contentDirectory(home: string, taskId: string, create: boolean, effects?: ContentMigrationEffects): string {
  // Check every Home-relative ancestor; accepting a directory prefix alone
  // would permit writing through a symlink into another Task or a checkout.
  const root = taskContentRoot(home, taskId);
  for (const path of [join(resolve(home), "task-data"), root, join(root, "context-values")]) {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(path, { mode: 0o700 });
      effects?.directories.push(path);
      const parent = openSync(resolve(path, ".."), constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(parent); } finally { closeSync(parent); }
      stat = lstatSync(path);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe Task content directory: ${path}.`);
  }
  return join(root, "context-values");
}

function readValue(path: string, digest: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > CONTEXT_SNAPSHOT_MAX_RESOURCE_BYTES) {
      throw new Error(`Invalid Task content file: ${path}.`);
    }
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (contextContentDigest(value) !== digest) throw new Error(`Task content digest mismatch: ${path}.`);
    return value;
  } finally { closeSync(fd); }
}

/** Called under the existing SQLite writer/maintenance fence. Publish all
 * fsynced content before committing its metadata. A rollback may leave an
 * unreferenced immutable object, never an authoritative partial snapshot.
 */
export function storeSnapshotContent(
  home: string, snapshot: ContextSnapshot, effects?: ContentMigrationEffects
): StoredContextSnapshot {
  validateContextSnapshot(snapshot);
  if (snapshot.resources.length > 0) {
    const directory = contentDirectory(home, snapshot.taskId, true, effects);
    for (const { ref, value } of snapshot.resources) {
      const path = join(directory, `${ref.digest}.json`);
      try { readValue(path, ref.digest); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // The writer fence excludes other supported saves and cleanup. Never
        // overwrite corrupt or externally edited evidence.
        effects?.files.push(path);
        writeTextFileAtomically(path, JSON.stringify(value));
      }
    }
  }
  const { resources: _resources, ...metadata } = snapshot;
  return metadata;
}

export function validateStoredSnapshotMetadata(value: unknown): StoredContextSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.hasOwn(value, "resources")) {
    throw new Error("Invalid stored Context Snapshot metadata; storage upgrade is required.");
  }
  return validateContextSnapshotMetadata(value as StoredContextSnapshot);
}

export function loadSnapshotContent(home: string, value: unknown): ContextSnapshot {
  const metadata = validateStoredSnapshotMetadata(value);
  const directory = metadata.refs.length > 0
    ? contentDirectory(home, metadata.taskId, false) : undefined;
  const resources = metadata.refs.map(ref => {
    if (!/^[a-f0-9]{64}$/.test(ref.digest)) throw new Error("Invalid Task content digest.");
    return { ref, value: readValue(join(directory!, `${ref.digest}.json`), ref.digest) };
  });
  return validateContextSnapshot({ ...metadata, resources });
}
