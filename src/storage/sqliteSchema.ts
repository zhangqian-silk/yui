import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { BASELINE_SCHEMA_SQL, SQLITE_SCHEMA_TABLES } from "./baselineSchema.js";
import { migrateTaskMainWorkspaces } from "./upgrade/taskMainWorkspaceMigration.js";
import { migrateProjectKnowledge } from "./upgrade/projectKnowledgeMigration.js";
import {
  CURRENT_STORAGE_VERSION, MIN_SUPPORTED_STORAGE_VERSION, STORAGE_FORMAT,
  isMinorStorageUpgrade, isStorageVersion, storageVersionParts, type StorageVersion
} from "./storageVersions.js";

export { BASELINE_SCHEMA_SQL, SQLITE_SCHEMA_TABLES };
export const TELEMETRY_KEEP_PER_RUN = 200;
export const TELEMETRY_RUN_CAP = 50_000;
export const CURRENT_SCHEMA_CHECKSUM = createHash("sha256").update(BASELINE_SCHEMA_SQL).digest("hex");

export class SqliteSchemaError extends Error {
  constructor(detail: string, readonly code: "STORAGE_SCHEMA_INVALID" | "STORAGE_FORMAT_UNSUPPORTED" = "STORAGE_SCHEMA_INVALID") {
    super(`SQLite storage schema cannot be opened: ${detail}`);
  }
}

export type StorageMinorUpgrade = Readonly<{
  fromVersion: StorageVersion;
  toVersion: StorageVersion;
  name: string;
  introducedIn: string;
  sourceChecksum: string;
  targetChecksum: string;
  sql: string;
  dataMigration?: "task-main-workspace" | "project-knowledge";
}>;

// Only explicit, contiguous minor changes in this baseline may be added here.
const MINOR_UPGRADES: readonly StorageMinorUpgrade[] = Object.freeze([{
  fromVersion: "1.0",
  toVersion: "1.1",
  name: "task-main-workspace",
  introducedIn: "1.1.0",
  sourceChecksum: CURRENT_SCHEMA_CHECKSUM,
  targetChecksum: CURRENT_SCHEMA_CHECKSUM,
  sql: "",
  dataMigration: "task-main-workspace"
}, {
  fromVersion: "1.1",
  toVersion: "1.2",
  name: "task-authorization-source",
  introducedIn: "next",
  sourceChecksum: CURRENT_SCHEMA_CHECKSUM,
  targetChecksum: CURRENT_SCHEMA_CHECKSUM,
  // New grants can carry source evidence. Valid historical Operator grants
  // remain unchanged; migration must not invent authorization provenance.
  sql: ""
}, {
  fromVersion: "1.2",
  toVersion: "1.3",
  name: "selected-session-input",
  introducedIn: "next",
  sourceChecksum: CURRENT_SCHEMA_CHECKSUM,
  targetChecksum: CURRENT_SCHEMA_CHECKSUM,
  // Optional explicit Session fences apply only to new inputs. Preserve old
  // Role-addressed messages; never infer a historical user's Session choice.
  sql: ""
}, {
  fromVersion: "1.3",
  toVersion: "1.4",
  name: "project-knowledge-applicability",
  introducedIn: "next",
  sourceChecksum: CURRENT_SCHEMA_CHECKSUM,
  targetChecksum: CURRENT_SCHEMA_CHECKSUM,
  sql: "",
  dataMigration: "project-knowledge"
}]);

export function storageMinorUpgradePlan(from: StorageVersion): readonly StorageMinorUpgrade[] | null {
  if (from === CURRENT_STORAGE_VERSION) return [];
  if (!isMinorStorageUpgrade(from, CURRENT_STORAGE_VERSION)) return null;
  const result: StorageMinorUpgrade[] = [];
  let current = from;
  while (current !== CURRENT_STORAGE_VERSION) {
    const step = MINOR_UPGRADES.find(candidate => candidate.fromVersion === current);
    if (step === undefined || !isMinorStorageUpgrade(step.fromVersion, step.toVersion)
      || storageVersionParts(step.toVersion).minor !== storageVersionParts(current).minor + 1) return null;
    result.push(step);
    current = step.toVersion;
  }
  return result;
}

type SchemaObject = { type: string; name: string; sql: string };
function objects(db: Database.Database): SchemaObject[] {
  return db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name`).all() as SchemaObject[];
}
let expectedObjects: readonly SchemaObject[] | undefined;
function validateSchemaObjects(db: Database.Database): void {
  if (expectedObjects === undefined) {
    const reference = new Database(":memory:");
    try { reference.exec(BASELINE_SCHEMA_SQL); expectedObjects = objects(reference); }
    finally { reference.close(); }
  }
  const actual = objects(db);
  for (const expected of expectedObjects) {
    const found = actual.find(object => object.type === expected.type && object.name === expected.name);
    if (found?.sql !== expected.sql) throw new SqliteSchemaError(`required ${expected.type} '${expected.name}' differs from the current definition.`);
  }
  if (actual.length !== expectedObjects.length) throw new SqliteSchemaError("unexpected schema objects; preserve the database for diagnosis.");
}

export type SqliteSchemaState = Readonly<{
  currentVersion: StorageVersion;
  currentChecksum: string;
  targetVersion: StorageVersion;
  targetChecksum: string;
  minimumSupportedVersion: StorageVersion;
  pendingVersions: readonly StorageVersion[];
}>;

/** Read the one format identity. Missing metadata never authorizes initialization. */
export function inspectSqliteSchema(db: Database.Database): SqliteSchemaState {
  const table = db.prepare("SELECT type FROM sqlite_master WHERE name='storage_schema'").get() as { type?: string } | undefined;
  if (table?.type !== "table") {
    throw new SqliteSchemaError("storage_schema is missing: this is not the current baseline. Use the independent conversion tool for a different format.", "STORAGE_FORMAT_UNSUPPORTED");
  }
  const rows = db.prepare("SELECT * FROM storage_schema").all() as Array<{
    id: number; format: string; major: number; minor: number; checksum: string; created_at: string;
  }>;
  const row = rows[0];
  const version = row === undefined ? "" : `${row.major}.${row.minor}`;
  if (rows.length !== 1 || row?.id !== 1 || row.format !== STORAGE_FORMAT
    || !Number.isSafeInteger(row.major) || !Number.isSafeInteger(row.minor)
    || !isStorageVersion(version) || !/^[a-f0-9]{64}$/u.test(row.checksum)
    || !Number.isFinite(Date.parse(row.created_at))) {
    throw new SqliteSchemaError("invalid baseline identity.");
  }
  const plan = storageMinorUpgradePlan(version);
  const expectedChecksum = version === CURRENT_STORAGE_VERSION
    ? CURRENT_SCHEMA_CHECKSUM : plan?.[0]?.sourceChecksum;
  if (expectedChecksum !== undefined && row.checksum !== expectedChecksum) {
    throw new SqliteSchemaError("baseline checksum does not match its version.");
  }
  if (version === CURRENT_STORAGE_VERSION) validateSchemaObjects(db);
  return {
    currentVersion: version, currentChecksum: row.checksum,
    targetVersion: CURRENT_STORAGE_VERSION, targetChecksum: CURRENT_SCHEMA_CHECKSUM,
    minimumSupportedVersion: MIN_SUPPORTED_STORAGE_VERSION,
    pendingVersions: plan?.map(step => step.toVersion) ?? []
  };
}

export function validateSqliteSchema(db: Database.Database): SqliteSchemaState {
  const state = inspectSqliteSchema(db);
  if (state.currentVersion !== CURRENT_STORAGE_VERSION) {
    throw new SqliteSchemaError(`storage ${state.currentVersion} is not current ${CURRENT_STORAGE_VERSION}; ordinary opens never convert data.`);
  }
  return state;
}

/** Fresh initialization, never a replay of previous schema definitions. */
export function initializeSqliteSchema(db: Database.Database): SqliteSchemaState {
  if (db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get() !== undefined) {
    throw new SqliteSchemaError("initialization requires an empty database.");
  }
  const { major, minor } = storageVersionParts(CURRENT_STORAGE_VERSION);
  return db.transaction(() => {
    db.exec(BASELINE_SCHEMA_SQL);
    db.prepare("INSERT INTO storage_schema VALUES (1,?,?,?,?,?)")
      .run(STORAGE_FORMAT, major, minor, CURRENT_SCHEMA_CHECKSUM, new Date().toISOString());
    return validateSqliteSchema(db);
  })();
}

/** Called only after an explicit minor upgrade has obtained its maintenance fence. */
export function applySqliteMinorUpgrades(
  db: Database.Database,
  home: string,
  createdRoots: string[] = []
): void {
  db.transaction(() => {
    const before = inspectSqliteSchema(db);
    const plan = storageMinorUpgradePlan(before.currentVersion);
    if (plan === null) throw new SqliteSchemaError("cross-major or unknown storage upgrades are unsupported.");
    for (const step of plan) {
      const state = inspectSqliteSchema(db);
      if (state.currentVersion !== step.fromVersion || state.currentChecksum !== step.sourceChecksum) {
        throw new SqliteSchemaError("minor upgrade source changed.");
      }
      db.exec(step.sql);
      if (step.dataMigration === "task-main-workspace") {
        migrateTaskMainWorkspaces(db, home, createdRoots);
      }
      if (step.dataMigration === "project-knowledge") migrateProjectKnowledge(db);
      const { major, minor } = storageVersionParts(step.toVersion);
      db.prepare("UPDATE storage_schema SET major=?,minor=?,checksum=? WHERE id=1")
        .run(major, minor, step.targetChecksum);
    }
    validateSqliteSchema(db);
  })();
}
