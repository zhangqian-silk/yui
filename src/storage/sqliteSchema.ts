import { createHash } from "node:crypto";
import Database from "../sqlite/driver.js";
import { BASELINE_SCHEMA_SQL, SQLITE_SCHEMA_TABLES as BASELINE_SCHEMA_TABLES } from "./baselineSchema.js";
import { migrateTaskMainWorkspaces } from "./upgrade/taskMainWorkspaceMigration.js";
import { migrateProjectKnowledge } from "./upgrade/projectKnowledgeMigration.js";
import { JOB_SCHEMA_SQL } from "./jobSchema.js";
import { SCHEDULE_SCHEMA_SQL } from "./scheduleSchema.js";
import { GLOBAL_SESSION_TABLE_SQL, SESSION_HISTORY_UPGRADE_SQL } from "./sessionHistorySchema.js";
import { migrateJobDefinitions } from "./upgrade/jobDefinitionMigration.js";
import { migrateJobBusinessResults } from "./upgrade/jobBusinessResultMigration.js";
import {
  CURRENT_STORAGE_VERSION, MIN_SUPPORTED_STORAGE_VERSION, STORAGE_FORMAT,
  isMinorStorageUpgrade, isStorageVersion, storageVersionParts, type StorageVersion
} from "./storageVersions.js";

export { BASELINE_SCHEMA_SQL };
export const SQLITE_SCHEMA_TABLES = [...BASELINE_SCHEMA_TABLES, "job_definitions", "global_job_runs", "schedules"] as const;
export const TELEMETRY_KEEP_PER_RUN = 200;
export const TELEMETRY_RUN_CAP = 50_000;
export const BASELINE_SCHEMA_CHECKSUM = createHash("sha256").update(BASELINE_SCHEMA_SQL).digest("hex");
export const JOB_SCHEMA_CHECKSUM = createHash("sha256").update(BASELINE_SCHEMA_SQL + JOB_SCHEMA_SQL).digest("hex");
export const SCHEDULE_SCHEMA_SQL_COMPLETE = BASELINE_SCHEMA_SQL + JOB_SCHEMA_SQL + SCHEDULE_SCHEMA_SQL;
export const SCHEDULE_SCHEMA_CHECKSUM = createHash("sha256").update(SCHEDULE_SCHEMA_SQL_COMPLETE).digest("hex");
// Fresh Homes create the final layout directly; published baseline SQL stays immutable.
export const CURRENT_SCHEMA_SQL = SCHEDULE_SCHEMA_SQL_COMPLETE.replace(
  /CREATE TABLE global_role_session_sets \([\s\S]*?\n\);/, GLOBAL_SESSION_TABLE_SQL);
export const CURRENT_SCHEMA_CHECKSUM = createHash("sha256").update(CURRENT_SCHEMA_SQL).digest("hex");

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
  dataMigration?: "task-main-workspace" | "project-knowledge" | "job-definitions" | "job-business-results";
}>;

// Only explicit, contiguous minor changes in this baseline may be added here.
const MINOR_UPGRADES: readonly StorageMinorUpgrade[] = Object.freeze([{
  fromVersion: "1.0",
  toVersion: "1.1",
  name: "task-main-workspace",
  introducedIn: "1.1.0",
  sourceChecksum: BASELINE_SCHEMA_CHECKSUM,
  targetChecksum: BASELINE_SCHEMA_CHECKSUM,
  sql: "",
  dataMigration: "task-main-workspace"
}, {
  fromVersion: "1.1",
  toVersion: "1.2",
  name: "task-authorization-source",
  introducedIn: "next",
  sourceChecksum: BASELINE_SCHEMA_CHECKSUM,
  targetChecksum: BASELINE_SCHEMA_CHECKSUM,
  // New grants can carry source evidence. Valid historical Operator grants
  // remain unchanged; migration must not invent authorization provenance.
  sql: ""
}, {
  fromVersion: "1.2",
  toVersion: "1.3",
  name: "selected-session-input",
  introducedIn: "next",
  sourceChecksum: BASELINE_SCHEMA_CHECKSUM,
  targetChecksum: BASELINE_SCHEMA_CHECKSUM,
  // Optional explicit Session fences apply only to new inputs. Preserve old
  // Role-addressed messages; never infer a historical user's Session choice.
  sql: ""
}, {
  fromVersion: "1.3",
  toVersion: "1.4",
  name: "project-knowledge-applicability",
  introducedIn: "next",
  sourceChecksum: BASELINE_SCHEMA_CHECKSUM,
  targetChecksum: BASELINE_SCHEMA_CHECKSUM,
  sql: "",
  dataMigration: "project-knowledge"
}, {
  fromVersion: "1.4",
  toVersion: "1.5",
  name: "frozen-skill-packages",
  introducedIn: "next",
  sourceChecksum: BASELINE_SCHEMA_CHECKSUM,
  targetChecksum: BASELINE_SCHEMA_CHECKSUM,
  // Additive effective-launch/manifest package evidence. Historical envelopes
  // and their digests remain unchanged: absence explicitly means entrypoint-only
  // provenance, not an invitation to invent packages from today's source files.
  // Existing Hosts retain their original inputs. Restoring such a Session fails
  // with a bounded new-Session instruction; ordinary readers never backfill it.
  sql: ""
}, {
  fromVersion: "1.5",
  toVersion: "1.6",
  name: "runtime-cost-evidence",
  introducedIn: "next",
  sourceChecksum: BASELINE_SCHEMA_CHECKSUM,
  targetChecksum: BASELINE_SCHEMA_CHECKSUM,
  // Optional sourced monetary observations; historical missing costs stay unknown.
  sql: ""
}, {
  fromVersion: "1.6",
  toVersion: "1.7",
  name: "agent-inbox-consumption",
  introducedIn: "next",
  sourceChecksum: BASELINE_SCHEMA_CHECKSUM,
  targetChecksum: BASELINE_SCHEMA_CHECKSUM,
  // Additive handling receipts on canonical Messages and wakes. Never invent
  // historical processing or Provider acceptance; existing records stay intact.
  sql: ""
}, {
  fromVersion: "1.7",
  toVersion: "1.8",
  name: "model-management-connection",
  introducedIn: "next",
  sourceChecksum: BASELINE_SCHEMA_CHECKSUM,
  targetChecksum: BASELINE_SCHEMA_CHECKSUM,
  // Optional non-secret connection references. Existing Homes remain unconfigured;
  // never infer local credentials or adopt an existing external service.
  sql: ""
}, {
  fromVersion: "1.8",
  toVersion: "1.9",
  name: "job-definitions-and-runs",
  introducedIn: "next",
  sourceChecksum: BASELINE_SCHEMA_CHECKSUM,
  targetChecksum: JOB_SCHEMA_CHECKSUM,
  sql: JOB_SCHEMA_SQL,
  dataMigration: "job-definitions"
}, {
  fromVersion: "1.9",
  toVersion: "1.10",
  name: "persistent-schedules",
  introducedIn: "next",
  sourceChecksum: JOB_SCHEMA_CHECKSUM,
  targetChecksum: SCHEDULE_SCHEMA_CHECKSUM,
  sql: SCHEDULE_SCHEMA_SQL
}, {
  fromVersion: "1.10",
  toVersion: "1.11",
  name: "activation-input-provenance",
  introducedIn: "next",
  sourceChecksum: SCHEDULE_SCHEMA_CHECKSUM,
  targetChecksum: SCHEDULE_SCHEMA_CHECKSUM,
  // Activation event payloads may now name an exact input or contain attributed
  // native input text. Existing events remain immutable; missing old provenance
  // stays explicitly missing. No historical source is guessed from timestamps.
  // New Task Job semantic writes also append job.state-changed events; no old
  // Job history is backfilled and the SQL layout remains unchanged.
  sql: ""
}, {
  fromVersion: "1.11",
  toVersion: "1.12",
  name: "project-delivery-scope",
  introducedIn: "next",
  sourceChecksum: SCHEDULE_SCHEMA_CHECKSUM,
  targetChecksum: SCHEDULE_SCHEMA_CHECKSUM,
  // New append-only Project scope decisions use Task events. Preserve all old
  // completion, binding and publication records; absence still means required.
  sql: ""
}, {
  fromVersion: "1.12",
  toVersion: "1.13",
  name: "inbox-turn-handling",
  introducedIn: "next",
  sourceChecksum: SCHEDULE_SCHEMA_CHECKSUM,
  targetChecksum: SCHEDULE_SCHEMA_CHECKSUM,
  // Claims may name their exact current attempt; explicit Global retirement
  // and terminal-check notices preserve original records. Never backfill
  // historical turn ownership, handling evidence or acknowledgements.
  sql: ""
}, {
  fromVersion: "1.13",
  toVersion: "1.14",
  name: "retained-session-identity",
  introducedIn: "next",
  sourceChecksum: SCHEDULE_SCHEMA_CHECKSUM,
  targetChecksum: CURRENT_SCHEMA_CHECKSUM,
  // Preserve every payload byte. No identity or authorization is inferred.
  sql: SESSION_HISTORY_UPGRADE_SQL
}, {
  fromVersion: "1.14",
  toVersion: "1.15",
  name: "job-business-results",
  introducedIn: "next",
  sourceChecksum: CURRENT_SCHEMA_CHECKSUM,
  targetChecksum: CURRENT_SCHEMA_CHECKSUM,
  sql: "",
  dataMigration: "job-business-results"
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
const schemaObjectsByChecksum = new Map<string, readonly SchemaObject[]>();
export function validateSqliteSchemaObjects(db: Database.Database, version: StorageVersion = CURRENT_STORAGE_VERSION): void {
  // Maintenance authenticates before migration. Validate the declared source
  // layout, not current-only tables that the migration has yet to create.
  const checksum = version === CURRENT_STORAGE_VERSION
    ? CURRENT_SCHEMA_CHECKSUM : storageMinorUpgradePlan(version)?.[0]?.sourceChecksum;
  const sql = checksum === CURRENT_SCHEMA_CHECKSUM ? CURRENT_SCHEMA_SQL
    : checksum === SCHEDULE_SCHEMA_CHECKSUM ? SCHEDULE_SCHEMA_SQL_COMPLETE
    : checksum === JOB_SCHEMA_CHECKSUM ? BASELINE_SCHEMA_SQL + JOB_SCHEMA_SQL
    : checksum === BASELINE_SCHEMA_CHECKSUM ? BASELINE_SCHEMA_SQL : undefined;
  if (sql === undefined || checksum === undefined) throw new SqliteSchemaError(`unsupported schema definition for storage ${version}.`);
  let expectedObjects = schemaObjectsByChecksum.get(checksum);
  if (expectedObjects === undefined) {
    const reference = new Database(":memory:");
    try {
      reference.exec(sql);
      expectedObjects = objects(reference);
      schemaObjectsByChecksum.set(checksum, expectedObjects);
    }
    finally { reference.close(); }
  }
  const actual = objects(db);
  for (const expected of expectedObjects) {
    const found = actual.find(object => object.type === expected.type && object.name === expected.name);
    if (found?.sql !== expected.sql) throw new SqliteSchemaError(`required ${expected.type} '${expected.name}' differs from the storage ${version} definition.`);
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
  if (version === CURRENT_STORAGE_VERSION) validateSqliteSchemaObjects(db);
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
    db.exec(CURRENT_SCHEMA_SQL);
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
      if (step.dataMigration === "job-definitions") migrateJobDefinitions(db);
      if (step.dataMigration === "job-business-results") migrateJobBusinessResults(db);
      const { major, minor } = storageVersionParts(step.toVersion);
      db.prepare("UPDATE storage_schema SET major=?,minor=?,checksum=? WHERE id=1")
        .run(major, minor, step.targetChecksum);
    }
    validateSqliteSchema(db);
  })();
}
