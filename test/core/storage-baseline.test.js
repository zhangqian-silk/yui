import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import * as schema from "../../dist/storage/sqliteSchema.js";
import * as versions from "../../dist/storage/storageVersions.js";

test("fresh storage has one distinct 1.0 baseline, never a historical migration ledger", () => {
  assert.equal(versions.CURRENT_STORAGE_VERSION, "1.0");
  const db = new Database(":memory:");
  try {
    schema.initializeSqliteSchema(db);
    assert.equal(schema.inspectSqliteSchema(db).currentVersion, "1.0");
    assert.equal(db.prepare("SELECT count(*) AS n FROM storage_schema").get().n, 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(), undefined);
    assert.throws(() => schema.initializeSqliteSchema(db), /empty/i);
    schema.validateSqliteSchema(db);
    db.exec("CREATE TABLE sqliteX_extra(value TEXT)");
    assert.throws(() => schema.validateSqliteSchema(db), /unexpected schema objects/);
    db.exec("DROP TABLE sqliteX_extra");
    db.exec("DROP INDEX idx_mailboxes_ready");
    assert.throws(() => schema.validateSqliteSchema(db), /idx_mailboxes_ready/);
  } finally { db.close(); }
});

test("old numeric v1 is not new baseline 1.0 and cannot be initialized over", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, checksum TEXT)");
    db.exec("INSERT INTO schema_migrations VALUES(1,'v0.15.0-baseline','old')");
    const before = db.serialize();
    assert.throws(() => schema.inspectSqliteSchema(db), /baseline|format|storage_schema/i);
    assert.throws(() => schema.initializeSqliteSchema(db), /empty/i);
    assert.deepEqual(db.serialize(), before);
  } finally { db.close(); }
});

test("default storage upgrades advance only the minor version of the same major", () => {
  assert.equal(versions.isMinorStorageUpgrade("1.0", "1.1"), true);
  assert.equal(versions.isMinorStorageUpgrade("1.9", "1.10"), true);
  assert.equal(versions.isMinorStorageUpgrade("1.0", "2.0"), false);
  assert.equal(versions.isMinorStorageUpgrade("2.0", "1.9"), false);
  assert.equal(versions.isMinorStorageUpgrade("1.1", "1.0"), false);
  assert.equal(versions.isMinorStorageUpgrade("1.0", "1.0"), false);
  for (const value of [1, 37, "1", "01.0", "1.-1", "1.0.0", "0.1"]) {
    assert.equal(versions.isStorageVersion(value), false);
  }
});
