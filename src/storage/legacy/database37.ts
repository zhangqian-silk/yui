import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Database from "../../sqlite/driver.js";
import { applySqliteMinorUpgrades, BASELINE_SCHEMA_SQL, validateSqliteSchemaObjects } from "../sqliteSchema.js";
import {
  convertLegacy37Brief, convertLegacy37Record, finalizeLegacy37Project, LEGACY37_RECORD_TABLES
} from "./records37.js";

// Frozen published integer-37 physical schema and ordered migration definitions.
// Provenance: v0.16.2; independently captured by baseline-cutover at b560cce.
const SCHEMA_DIGEST = "32cc8cd0a1eb47c5a08f0b3767245da3bde1e262b949b5a299e31c1e67e9f1f4";
const LEDGER_DIGEST = "dc424f9f4ae3fde05641a194e3000bb277576c9b23457dfe89a78414bf7105a5";
const TARGET_1_0_CHECKSUM = "7769f5166fe10c7a93b4bf2f9db65031a9cd53bfa612ebfbe048f61b051bf1aa";
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Source validation only. Activity/lifecycle fencing belongs to the updater. */
export function validateLegacy37Database(db: Database.Database): void {
  const objects = db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name`).all();
  if (digest(objects) !== SCHEMA_DIGEST) {
    throw new Error("The legacy:37 physical schema differs from its published definition.");
  }
  const ledger = db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
  if (digest(ledger) !== LEDGER_DIGEST) {
    throw new Error("The legacy:37 migration ledger differs from its published definition.");
  }
  validateIntegrity(db);
}

/**
 * Convert inside the existing upgrade's transaction, after backup and runtime
 * quiescence. Never infers delivery, ends a Session, or clears active pointers.
 * Performs the complete 37 -> 1.0 -> current chain. Intermediate Knowledge
 * envelopes are private to this transaction, not valid business-reader state.
 * The caller must validate current domain records before admitting the Home. Its backup
 * and this per-row archive preserve obsolete authority and rewritten records.
 */
export function upgradeLegacy37Database(
  db: Database.Database, home: string, createdWorkspaceDirectories: string[], now: Date
): void {
  if (!db.inTransaction) throw new Error("Legacy conversion requires the caller-owned migration transaction.");
  if (createHash("sha256").update(BASELINE_SCHEMA_SQL).digest("hex") !== TARGET_1_0_CHECKSUM) {
    throw new Error("The immutable storage-1.0 conversion target definition is unavailable.");
  }
  validateLegacy37Database(db);
  const archive = db.prepare(`INSERT INTO storage_migration_archive
    (migration_version,family,record_key,payload,content) VALUES(37,?,?,?,NULL)`);
  archive.run("legacy:37/ledger", "all",
    JSON.stringify(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()));
  for (const [table, keys] of [
    ["coordination_locks", ["lock_key"]],
    ["work_item_candidates", ["task_id", "candidate_id"]]
  ] as const) {
    for (const row of db.prepare(`SELECT * FROM ${quote(table)}`).all() as Record<string, unknown>[]) {
      archive.run(`legacy:37/retired-table/${table}`, JSON.stringify(keys.map(key => row[key])), JSON.stringify(row));
    }
    db.exec(`DROP TABLE ${quote(table)}`);
  }
  db.exec("DROP INDEX idx_input_open");
  for (const table of LEGACY37_RECORD_TABLES) {
    const primary = (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { pk: number; name: string }[])
      .filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
    if (primary.length === 0) throw new Error(`No exact record identity for ${table}.`);
    const update = db.prepare(`UPDATE ${quote(table)} SET payload=?
      WHERE ${primary.map(key => `${quote(key)}=?`).join(" AND ")}`);
    for (const row of db.prepare(`SELECT * FROM ${quote(table)}`).all() as
      (Record<string, string | number | null> & { payload: string })[]) {
      const original: unknown = JSON.parse(row.payload);
      const converted = convertLegacy37Record(table, original);
      if (isDeepStrictEqual(original, converted)) continue;
      const key = primary.map(column => row[column]!);
      archive.run(`legacy:37/${table}`, JSON.stringify(key), row.payload);
      update.run(JSON.stringify(converted), ...key);
    }
  }
  for (const row of db.prepare("SELECT task_id,brief FROM task_records WHERE brief IS NOT NULL").all() as
    { task_id: string; brief: string }[]) {
    const brief = convertLegacy37Brief(JSON.parse(row.brief));
    archive.run("legacy:37/task-brief", row.task_id, row.brief);
    db.prepare("UPDATE task_records SET brief=? WHERE task_id=?").run(JSON.stringify(brief), row.task_id);
  }
  // Obtain identity DDL from the unchanged baseline itself. Old ledger rows are
  // archived, never relabelled as a same-major migration.
  const reference = new Database(":memory:");
  let identitySql: string;
  try {
    reference.exec(BASELINE_SCHEMA_SQL);
    identitySql = (reference.prepare("SELECT sql FROM sqlite_master WHERE name='storage_schema'").get() as
      { sql: string }).sql;
  } finally { reference.close(); }
  db.exec("DROP TABLE schema_migrations");
  db.exec(identitySql);
  db.prepare("INSERT INTO storage_schema (id,format,major,minor,checksum,created_at) VALUES(1,?,?,?,?,?)")
    .run("yui-home", 1, 0, TARGET_1_0_CHECKSUM, now.toISOString());
  validateSqliteSchemaObjects(db);
  applySqliteMinorUpgrades(db, home, createdWorkspaceDirectories);
  // 1.3 -> 1.4 derives applicability/provenance from the exact old body pair.
  // Only after that association is preserved may the active plan be converted.
  for (const row of db.prepare("SELECT id,payload FROM projects").all() as { id: string; payload: string }[]) {
    db.prepare("UPDATE projects SET payload=? WHERE id=?")
      .run(JSON.stringify(finalizeLegacy37Project(JSON.parse(row.payload))), row.id);
  }
  validateIntegrity(db);
}

function validateIntegrity(db: Database.Database): void {
  if (db.pragma("quick_check", { simple: true }) !== "ok"
    || (db.pragma("foreign_key_check") as unknown[]).length !== 0) {
    throw new Error("Legacy SQLite integrity or references are invalid; preserve the source.");
  }
}
