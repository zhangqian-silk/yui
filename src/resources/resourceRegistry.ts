/**
 * Persistent Resource registry (Issue 10).
 *
 * The registry lives only in `resource_registry` inside the current `yui.db`.
 * This module owns its value validation and quarantine paths, not persistence.
 */

import { join, resolve } from "node:path";

import {
  RESOURCE_REGISTRY_SCHEMA_VERSION,
  type ResourceRecord,
  type ResourceRegistryState
} from "./resourceTypes.js";

export const RESOURCE_REGISTRY_DIRECTORY = "resource-registry";
export const RESOURCE_QUARANTINE_DIRECTORY = "quarantine";

export function resourceQuarantineRoot(home: string): string {
  return join(
    resolve(home),
    "runtime",
    RESOURCE_REGISTRY_DIRECTORY,
    RESOURCE_QUARANTINE_DIRECTORY
  );
}

/** True when `path` lives in this Home's Resource GC quarantine namespace. */
export function isResourceQuarantinePath(home: string, path: string): boolean {
  const root = resolve(resourceQuarantineRoot(home));
  const resolved = resolve(path);
  return resolved === root || resolved.startsWith(`${root}/`);
}

export function emptyResourceRegistry(): ResourceRegistryState {
  return Object.freeze({
    schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
    records: Object.freeze({})
  });
}

export function upsertResourceRecord(
  state: ResourceRegistryState,
  record: ResourceRecord
): ResourceRegistryState {
  return Object.freeze({
    schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
    records: Object.freeze({ ...state.records, [record.id]: Object.freeze(record) })
  });
}

export function removeResourceRecord(
  state: ResourceRegistryState,
  id: string
): ResourceRegistryState {
  if (!(id in state.records)) return state;
  const records = { ...state.records };
  delete records[id];
  return Object.freeze({
    schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
    records: Object.freeze(records)
  });
}

export function listResourceRecords(state: ResourceRegistryState): ResourceRecord[] {
  return Object.values(state.records);
}

export function parseResourceRegistryState(value: unknown): ResourceRegistryState {
  if (!isRecord(value)) {
    throw new Error("Resource registry root is not an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RESOURCE_REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `Resource registry schemaVersion is ${String(record.schemaVersion)}; `
        + `expected ${RESOURCE_REGISTRY_SCHEMA_VERSION}.`
    );
  }
  if (!isRecord(record.records)) {
    throw new Error("Resource registry records is not an object.");
  }
  const records: Record<string, ResourceRecord> = {};
  for (const [key, entry] of Object.entries(record.records)) {
    const parsed = parseResourceRecord(entry, key);
    if (parsed.id !== key) {
      throw new Error(
        `Resource registry record key ${key} does not match id ${parsed.id}.`
      );
    }
    records[key] = parsed;
  }
  return Object.freeze({
    schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
    records: Object.freeze(records)
  });
}

function parseResourceRecord(value: unknown, key: string): ResourceRecord {
  const invalid = (field: string): never => {
    throw new Error(`Resource registry record ${key} is malformed at ${field}; stored evidence was not repaired.`);
  };
  const object = (value: unknown, field: string): Record<string, unknown> =>
    isRecord(value) ? value : invalid(field);
  const text = (value: unknown, field: string): void => {
    if (typeof value !== "string" || value.trim().length === 0) invalid(field);
  };
  const timestamp = (value: unknown, field: string): void => {
    text(value, field);
    if (!Number.isFinite(Date.parse(value as string))) invalid(field);
  };
  const member = (value: unknown, choices: readonly string[], field: string): void => {
    if (typeof value !== "string" || !choices.includes(value)) invalid(field);
  };
  const optionalText = (record: Record<string, unknown>, fields: readonly string[], prefix = ""): void => {
    for (const field of fields) {
      if (record[field] !== undefined) text(record[field], `${prefix}${field}`);
    }
  };
  const record = object(value, "record");
  if (record.schemaVersion !== RESOURCE_REGISTRY_SCHEMA_VERSION) invalid("schemaVersion");
  text(record.id, "id");
  text(record.path, "path");
  timestamp(record.updatedAt, "updatedAt");
  member(record.kind, ["worktree", "deployment", "runtime-artifact"], "kind");
  member(record.disposition, ["active", "releasable", "quarantined", "deleted",
    "retained-dirty", "retained-unowned", "retained-unproven", "cleanup-failed"], "disposition");
  member(record.cleanliness, ["clean", "dirty", "unknown", "n/a"], "cleanliness");
  if (!Array.isArray(record.activeRefs)) invalid("activeRefs");
  (record.activeRefs as unknown[]).forEach((ref, index) => text(ref, `activeRefs[${index}]`));
  const owner = object(record.owner, "owner");
  text(owner.home, "owner.home");
  member(owner.basis, ["durable-record", "marker", "descriptor", "naming-convention", "unattributed"], "owner.basis");
  optionalText(owner, ["projectId", "taskId", "workItemId", "reviewRoundId", "integrationAttemptId"], "owner.");
  for (const field of ["createdAt", "lastReferencedAt"]) {
    if (record[field] !== undefined) timestamp(record[field], field);
  }
  if (record.sizeBytes !== undefined
    && (typeof record.sizeBytes !== "number" || !Number.isFinite(record.sizeBytes) || record.sizeBytes < 0)) {
    invalid("sizeBytes");
  }
  if (record.blocker !== undefined && typeof record.blocker !== "string") invalid("blocker");
  if (record.git !== undefined) {
    const git = object(record.git, "git");
    text(git.repositoryPath, "git.repositoryPath");
    optionalText(git, ["commonDir", "branch", "head"], "git.");
  }
  if (record.quarantine !== undefined) {
    const quarantine = object(record.quarantine, "quarantine");
    text(quarantine.path, "quarantine.path");
    text(quarantine.originalPath, "quarantine.originalPath");
    timestamp(quarantine.movedAt, "quarantine.movedAt");
    member(quarantine.method, ["move", "git-worktree-remove"], "quarantine.method");
    if (quarantine.gitRestore !== undefined) {
      const restore = object(quarantine.gitRestore, "quarantine.gitRestore");
      text(restore.repositoryPath, "quarantine.gitRestore.repositoryPath");
      optionalText(restore, ["branch", "head"], "quarantine.gitRestore.");
    }
  }
  if (record.cleanupReceipt !== undefined) {
    const receipt = object(record.cleanupReceipt, "cleanupReceipt");
    timestamp(receipt.removedAt, "cleanupReceipt.removedAt");
    member(receipt.method, ["git-worktree-remove", "quarantine-purge", "runtime-cleanup"], "cleanupReceipt.method");
  }
  // Validation enforces the existing persisted contract, without defaults,
  // filtering, or a second historical reader. Constructors own new values.
  const parsed = record as ResourceRecord;
  return Object.freeze({
    ...parsed,
    owner: Object.freeze({ ...parsed.owner }),
    activeRefs: Object.freeze([...parsed.activeRefs]),
    ...(parsed.git === undefined ? {} : { git: Object.freeze({ ...parsed.git }) }),
    ...(parsed.quarantine === undefined ? {} : { quarantine: Object.freeze({
      ...parsed.quarantine,
      ...(parsed.quarantine.gitRestore === undefined ? {} : {
        gitRestore: Object.freeze({ ...parsed.quarantine.gitRestore })
      })
    }) }),
    ...(parsed.cleanupReceipt === undefined ? {} : { cleanupReceipt: Object.freeze({ ...parsed.cleanupReceipt }) })
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
