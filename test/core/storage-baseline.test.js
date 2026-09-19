import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import * as schema from "../../dist/storage/sqliteSchema.js";
import * as versions from "../../dist/storage/storageVersions.js";

test("fresh storage creates only the current 1.0 contract", () => {
  assert.equal(versions.CURRENT_STORAGE_VERSION, "1.0");
  const db = new Database(":memory:");
  try {
    schema.initializeSqliteSchema(db);
    assert.equal(schema.inspectSqliteSchema(db).currentVersion, "1.0");
    assert.equal(db.prepare("SELECT count(*) AS n FROM storage_schema").get().n, 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(), undefined);
    for (const name of ["coordination_locks", "work_item_candidates", "idx_input_open"]) {
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name), undefined);
    }
    assert.throws(() => schema.initializeSqliteSchema(db), /empty/i);
    schema.validateSqliteSchema(db);
    db.exec("CREATE TABLE sqliteX_extra(value TEXT)");
    assert.throws(() => schema.validateSqliteSchema(db), /unexpected schema objects/);
    db.exec("DROP TABLE sqliteX_extra");
    db.exec("DROP INDEX idx_mailboxes_ready");
    assert.throws(() => schema.validateSqliteSchema(db), /idx_mailboxes_ready/);
  } finally { db.close(); }
});

test("foreign non-empty SQLite state cannot be initialized over", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE unrelated_state(id INTEGER PRIMARY KEY, payload TEXT)");
    db.exec("INSERT INTO unrelated_state VALUES(1,'preserve-me')");
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
  for (const value of [1, -1, "1", "01.0", "1.-1", "1.0.0", "0.1"]) {
    assert.equal(versions.isStorageVersion(value), false);
  }
});
