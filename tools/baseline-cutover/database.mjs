import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { RECORD_TABLES, convertBrief, convertRecord } from "./records.mjs";

const ledger = JSON.parse(readFileSync(new URL("./legacy-ledger.json", import.meta.url), "utf8"));
const SCHEMA_DIGEST = "32cc8cd0a1eb47c5a08f0b3767245da3bde1e262b949b5a299e31c1e67e9f1f4";
const quote = value => `"${value.replaceAll('"', '""')}"`;
// v37 Homes can retain an equivalent, differently indented home_meta DDL.
// This table has no quoted strings; only leading/trailing line whitespace is
// ignored. Every field, token and constraint still matches the frozen schema.
const HOME_META_SQL = `CREATE TABLE home_meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  home_identity TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
)`;
const withoutIndentation = sql => sql.split("\n").map(line => line.trim()).join("\n");

export function inspectLegacyDatabase(db) {
  const objects = db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name`).all();
  const comparable = objects.map(object => object.type === "table" && object.name === "home_meta"
    && withoutIndentation(object.sql) === withoutIndentation(HOME_META_SQL)
    ? { ...object, sql: HOME_META_SQL } : object);
  const digest = createHash("sha256").update(JSON.stringify(comparable)).digest("hex");
  if (digest !== SCHEMA_DIGEST) throw new Error("Expected the exact 0.16.2 v37 schema. Use the frozen bridge for older formats; never repair or guess a source.");
  const actual = db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
  if (!isDeepStrictEqual(actual, ledger)) throw new Error("The v37 ledger differs from the frozen 0.16.2 contract.");
  if (db.pragma("quick_check", { simple: true }) !== "ok" || db.pragma("foreign_key_check").length !== 0) {
    throw new Error("Source SQLite integrity or references are invalid.");
  }
  const blockers = [
    ["active AgentRun", "SELECT 1 FROM turns WHERE status='active' LIMIT 1"],
    ["active Run pointer", "SELECT 1 FROM active_turns LIMIT 1"],
    ["active Session projection", "SELECT 1 FROM runtime_session_candidates LIMIT 1"],
    ["pending outbox operation", "SELECT 1 FROM outbox WHERE state <> 'applied' LIMIT 1"],
    ["running Job", "SELECT 1 FROM durable_jobs WHERE status IN ('queued','running') LIMIT 1"],
    ["unconfirmed Job", "SELECT 1 FROM durable_jobs WHERE status='unknown-needs-attention' AND json_type(payload,'$.acknowledgedAt') IS NULL LIMIT 1"],
    ["claimed mailbox", "SELECT 1 FROM mailboxes WHERE processing <> 'null' LIMIT 1"],
    ["in-flight Integration verification", "SELECT 1 FROM integration_attempts WHERE status IN ('running','validating') LIMIT 1"]
  ];
  for (const [label, sql] of blockers) {
    if (db.prepare(sql).get()) throw new Error(`Cutover blocked by ${label}; settle it with 0.16.2 without fabricating success.`);
  }
  for (const table of ["role_session_sets", "global_role_session_sets"]) {
    for (const { payload } of db.prepare(`SELECT payload FROM ${table}`).iterate()) {
      const set = JSON.parse(payload);
      if (Object.values(set.sessions).some(session => session.status !== "ended")
        || ["waiting", "in-flight"].includes(set.providerBinding?.retry?.status)
        || ["submitting", "accepted", "delivery-unknown"].includes(set.providerBinding?.run?.status)) {
        throw new Error(`Cutover blocked by unsettled Session in ${table}. Stop it with the old release.`);
      }
    }
  }
  return { source: "legacy:37", target: "1.0", ledgerEntries: ledger.length };
}

/** In-place SQL transaction only; filesystem/runtime lifecycle belongs to cli.mjs. */
export function convertDatabase(db, runtime) {
  if (!db.inTransaction) throw new Error("Conversion requires a caller-owned transaction and offline fence.");
  inspectLegacyDatabase(db);
  const archive = db.prepare(`INSERT INTO storage_migration_archive
    (migration_version,family,record_key,payload,content) VALUES(37,?,?,?,NULL)`);
  archive.run("baseline-v37/ledger", "all", JSON.stringify(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()));
  // These tables have no current runtime authority. Preserve complete original
  // rows without interpreting their payloads as active Candidates or locks.
  let retiredRows = 0;
  for (const [table, keys] of [
    ["coordination_locks", ["lock_key"]],
    ["work_item_candidates", ["task_id", "candidate_id"]]
  ]) {
    for (const row of db.prepare(`SELECT * FROM ${quote(table)}`).all()) {
      archive.run(`baseline-v37/retired-table/${table}`,
        JSON.stringify(keys.map(key => row[key])), JSON.stringify(row));
      retiredRows++;
    }
    db.exec(`DROP TABLE ${quote(table)}`);
  }
  db.exec("DROP INDEX idx_input_open");
  let changedRecords = 0;
  for (const table of RECORD_TABLES) {
    const primary = db.prepare(`PRAGMA table_info(${quote(table)})`).all()
      .filter(column => column.pk > 0).sort((a,b) => a.pk-b.pk).map(column => column.name);
    if (primary.length === 0) throw new Error(`No exact record identity for ${table}.`);
    const update = db.prepare(`UPDATE ${quote(table)} SET payload=? WHERE ${primary.map(key => `${quote(key)}=?`).join(" AND ")}`);
    // Materialize before updating so iteration cannot revisit a modified row.
    for (const row of db.prepare(`SELECT * FROM ${quote(table)}`).all()) {
      const original = JSON.parse(row.payload);
      const converted = convertRecord(table, original);
      runtime.validateRecord(table, converted);
      if (isDeepStrictEqual(original, converted)) continue;
      const key = primary.map(column => row[column]);
      archive.run(`baseline-v37/${table}`, JSON.stringify(key), row.payload);
      update.run(JSON.stringify(converted), ...key);
      changedRecords++;
    }
  }
  for (const row of db.prepare("SELECT task_id,brief FROM task_records WHERE brief IS NOT NULL").all()) {
    const brief = convertBrief(JSON.parse(row.brief));
    runtime.validateBrief(brief);
    archive.run("baseline-v37/task-brief", row.task_id, row.brief);
    db.prepare("UPDATE task_records SET brief=? WHERE task_id=?").run(JSON.stringify(brief),row.task_id);
    changedRecords++;
  }
  const homeMetaSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='home_meta'").get().sql;
  if (homeMetaSql !== HOME_META_SQL) {
    archive.run("baseline-v37/schema", "home_meta", homeMetaSql);
    const original = db.prepare("SELECT * FROM home_meta ORDER BY id").all();
    db.exec("ALTER TABLE home_meta RENAME TO baseline_old_home_meta");
    db.exec(HOME_META_SQL);
    db.exec(`INSERT INTO home_meta (id,home_identity,revision,created_at,updated_at)
      SELECT id,home_identity,revision,created_at,updated_at FROM baseline_old_home_meta`);
    if (!isDeepStrictEqual(db.prepare("SELECT * FROM home_meta ORDER BY id").all(), original)) {
      throw new Error("Home identity changed during DDL canonicalization.");
    }
    db.exec("DROP TABLE baseline_old_home_meta");
  }
  // The new baseline supplies its own identity DDL; none of the historical
  // ledger is re-labelled as a current minor upgrade.
  db.exec("DROP TABLE schema_migrations");
  db.exec(runtime.identitySql);
  db.prepare("INSERT INTO storage_schema (id,format,major,minor,checksum,created_at) VALUES(1,?,?,?,?,?)")
    .run("yui-home",1,0,runtime.checksum,new Date().toISOString());
  runtime.validateSchema(db);
  if (db.pragma("quick_check", { simple: true }) !== "ok" || db.pragma("foreign_key_check").length !== 0) {
    throw new Error("Converted SQLite integrity or references are invalid.");
  }
  return { source: "legacy:37", target: "1.0", changedRecords, retiredRows };
}
