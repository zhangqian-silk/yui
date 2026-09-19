import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  inspectSqliteSchema,
  storageMinorUpgradePlan,
  SqliteSchemaError
} from "./sqliteSchema.js";
import {
  compareStorageVersions, type StorageVersion,
  CURRENT_STORAGE_VERSION,
  MIN_SUPPORTED_STORAGE_VERSION
} from "./storageVersions.js";

export {
  CURRENT_STORAGE_VERSION,
  MIN_SUPPORTED_STORAGE_VERSION
} from "./storageVersions.js";

export const CURRENT_DATABASE_FILENAME = "yui.db";

type StorageVersionFields = Readonly<{
  currentVersion: StorageVersion;
  latestVersion: StorageVersion;
  minimumSupportedVersion: StorageVersion;
  databasePath: string;
}>;

export type StorageSchemaState =
  | Readonly<{
      status: "uninitialized";
      latestVersion: StorageVersion;
      minimumSupportedVersion: StorageVersion;
      databasePath: string;
    }>
  | (StorageVersionFields & Readonly<{ status: "current" }>)
  | (StorageVersionFields & Readonly<{
      status: "upgradeable";
      pendingVersions: readonly StorageVersion[];
    }>)
  | (StorageVersionFields & Readonly<{
      status: "unsupported";
      direction: "older" | "newer";
    }>)
  | Readonly<{
      status: "invalid";
      latestVersion: StorageVersion;
      minimumSupportedVersion: StorageVersion;
      databasePath: string;
      detail: string;
      reason?: "format" | "corruption";
    }>;

export class StorageSchemaError extends Error {
  readonly code:
    | "STORAGE_UNINITIALIZED"
    | "STORAGE_SCHEMA_INVALID"
    | "STORAGE_SCHEMA_UNSUPPORTED";

  constructor(
    code: StorageSchemaError["code"],
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "StorageSchemaError";
    this.code = code;
  }
}

/**
 * Inspect the one authoritative SQLite migration head without changing it.
 *
 * Extra files never override the SQLite authority. A missing database in a
 * non-empty Home is unverified, not permission to initialize over its evidence.
 */
export function inspectStorageSchema(rootDir: string): StorageSchemaState {
  const databasePath = join(rootDir, CURRENT_DATABASE_FILENAME);
  if (!existsSync(databasePath)) {
    if (existsSync(rootDir)) {
      try {
        if (readdirSync(rootDir).length > 0) {
          return invalid(
            databasePath,
            new Error("The authoritative yui.db is missing from a non-empty Home.")
          );
        }
      } catch (error) {
        return invalid(databasePath, error);
      }
    }
    return {
      status: "uninitialized",
      latestVersion: CURRENT_STORAGE_VERSION,
      minimumSupportedVersion: MIN_SUPPORTED_STORAGE_VERSION,
      databasePath
    };
  }

  let database: Database.Database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    return invalid(databasePath, error);
  }

  try {
    const migration = inspectSqliteSchema(database);
    const fields: StorageVersionFields = {
      currentVersion: migration.currentVersion,
      latestVersion: CURRENT_STORAGE_VERSION,
      minimumSupportedVersion: MIN_SUPPORTED_STORAGE_VERSION,
      databasePath
    };
    if (migration.currentVersion === CURRENT_STORAGE_VERSION) {
      return { status: "current", ...fields };
    }
    if (compareStorageVersions(migration.currentVersion, CURRENT_STORAGE_VERSION) > 0) {
      return { status: "unsupported", direction: "newer", ...fields };
    }
    if (compareStorageVersions(migration.currentVersion, MIN_SUPPORTED_STORAGE_VERSION) < 0) {
      return { status: "unsupported", direction: "older", ...fields };
    }
    const plan = storageMinorUpgradePlan(migration.currentVersion);
    if (plan === null) {
      return {
        status: "invalid",
        latestVersion: CURRENT_STORAGE_VERSION,
        minimumSupportedVersion: MIN_SUPPORTED_STORAGE_VERSION,
        databasePath,
        detail:
          `Storage migration registry has no complete path from `
          + `${migration.currentVersion} to ${CURRENT_STORAGE_VERSION}.`
      };
    }
    return {
      status: "upgradeable",
      pendingVersions: plan.map(({ toVersion }) => toVersion),
      ...fields
    };
  } catch (error) {
    return invalid(databasePath, error);
  } finally {
    database.close();
  }
}

/** Require the current storage contract without normalizing unsupported data. */
export function requireCurrentStorageSchema(rootDir: string): void {
  const state = inspectStorageSchema(rootDir);
  switch (state.status) {
    case "current":
      return;
    case "uninitialized":
      throw new StorageSchemaError(
        "STORAGE_UNINITIALIZED",
        "Yui storage is not initialized. Run `yui setup`."
      );
    case "invalid":
      throw new StorageSchemaError(
        "STORAGE_SCHEMA_INVALID",
        `Invalid storage at ${state.databasePath}: ${state.detail}`
      );
    case "upgradeable":
      throw new StorageSchemaError(
        "STORAGE_SCHEMA_UNSUPPORTED",
        `Storage version ${state.currentVersion} requires an explicit upgrade to `
          + `${state.latestVersion}. Run \`yui upgrade\` or \`yui update\`.`
      );
    case "unsupported":
      throw new StorageSchemaError(
        "STORAGE_SCHEMA_UNSUPPORTED",
        state.direction === "newer"
          ? `Storage version ${state.currentVersion} is newer than supported `
            + `${state.latestVersion}; use a newer Yui release.`
          : `Storage version ${state.currentVersion} is older than the minimum supported `
            + `${state.minimumSupportedVersion}.`
      );
  }
}

function invalid(databasePath: string, error: unknown): StorageSchemaState {
  return {
    status: "invalid",
    latestVersion: CURRENT_STORAGE_VERSION,
    minimumSupportedVersion: MIN_SUPPORTED_STORAGE_VERSION,
    databasePath,
    detail: error instanceof Error ? error.message : String(error),
    reason: error instanceof SqliteSchemaError && error.code === "STORAGE_FORMAT_UNSUPPORTED" ? "format" : "corruption"
  };
}
