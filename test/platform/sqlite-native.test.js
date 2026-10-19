import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve both code and native dependencies from the installed consumer in
// release CI. Pure selection/error-classification cases live in test/core.
const root = resolve(process.env.YUI_INSTALLED_ROOT ?? fileURLToPath(new URL("../..", import.meta.url)));
const { default: Database, selectSqliteDriver, SQLITE_CANDIDATES } =
  await import(pathToFileURL(join(root, "dist/sqlite/driver.js")));
const { initializeSqliteSchema, validateSqliteSchema } =
  await import(pathToFileURL(join(root, "dist/storage/sqliteSchema.js")));

test("selected SQLite driver survives allocation-driven statement collection", () => {
  // Explicit global.gc() does not reproduce context-less ObjectWrap teardown.
  const result = spawnSync(process.execPath, ["--max-semi-space-size=1", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import Database from ${JSON.stringify(pathToFileURL(join(root, "dist/sqlite/driver.js")).href)};
    const db = new Database(":memory:");
    let junk = [];
    try {
      for (let i = 0; i < 10000; i++) {
        assert.equal(db.prepare("SELECT ? AS value").get(i).value, i);
        junk.push({ i, text: "x".repeat(1000) });
        if (junk.length > 1000) junk = [];
      }
    } finally { db.close(); }
    console.log("sqlite-gc-ok");
  `], { encoding: "utf8", timeout: 10000, maxBuffer: 64 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `signal=${result.signal}\n${result.stderr}`);
  assert.equal(result.stdout.trim(), "sqlite-gc-ok");
});

for (const candidate of SQLITE_CANDIDATES) {
  test(`${candidate.name} real native SQL, transactions, WAL and backup`, async t => {
    if (candidate.name === "sqlite-modern" && Number(process.versions.napi ?? 0) < 10) {
      t.skip("sqlite-modern requires Node-API 10; do not invoke an incompatible native constructor");
      return;
    }
    const require = createRequire(join(root, "package.json"));
    let Driver;
    try {
      Driver = require(candidate.name);
      const probe = new Driver(":memory:");
      probe.close();
    } catch (error) {
      t.skip(`${candidate.name} unavailable on ${process.version}: ${error.message}`);
      return;
    }
    assert.equal(require(`${candidate.name}/package.json`).version, candidate.version);
    const scratch = mkdtempSync(join(tmpdir(), "yui-sqlite-driver-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const db = new Driver(join(scratch, "native.db"));
    t.after(() => { if (db.open) db.close(); });
    assert.equal(db.pragma("journal_mode=WAL", { simple: true }), "wal");
    initializeSqliteSchema(db);
    validateSqliteSchema(db);
    db.exec("CREATE TABLE probe(id INTEGER PRIMARY KEY, payload TEXT)");
    const insert = db.prepare("INSERT INTO probe(payload) VALUES (?) RETURNING id");
    assert.equal(db.transaction(() => insert.get('{"value":42}'))().id, 1);
    assert.throws(db.transaction(() => { insert.get("{}"); throw new Error("rollback"); }), /rollback/);
    assert.equal(db.prepare("SELECT count(*) AS n, json_extract(payload, '$.value') AS value FROM probe").get().n, 1);
    assert.equal(db.prepare("SELECT json_extract(payload, '$.value') AS value FROM probe").get().value, 42);
    await db.backup(join(scratch, "backup.db"));
    const backup = new Driver(join(scratch, "backup.db"), { readonly: true });
    try { assert.equal(backup.prepare("SELECT count(*) AS n FROM probe").get().n, 1); }
    finally { backup.close(); }
  });
}

test("real database corruption, readonly writes and locks leave the process driver unchanged", t => {
  const scratch = mkdtempSync(join(tmpdir(), "yui-sqlite-errors-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const selected = selectSqliteDriver();
  const path = join(scratch, "database.db");
  const db = new Database(path, { timeout: 0 });
  const other = new Database(path, { timeout: 0 });
  t.after(() => { other.close(); db.close(); });
  db.exec("CREATE TABLE probe(value)");
  db.exec("BEGIN EXCLUSIVE");
  try { assert.throws(() => other.exec("INSERT INTO probe VALUES(1)"), { code: "SQLITE_BUSY" }); }
  finally { db.exec("ROLLBACK"); }
  const ro = new Database(path, { readonly: true });
  try { assert.throws(() => ro.exec("INSERT INTO probe VALUES(1)"), { code: "SQLITE_READONLY" }); }
  finally { ro.close(); }
  assert.throws(() => new Database(join(scratch, "missing", "file.db")));
  assert.throws(() => db.exec("invalid SQL"));
  writeFileSync(join(scratch, "bad.db"), "not a sqlite database");
  const bad = new Database(join(scratch, "bad.db"));
  try { assert.throws(() => bad.exec("SELECT * FROM sqlite_master"), { code: "SQLITE_NOTADB" }); }
  finally { bad.close(); }
  assert.equal(selectSqliteDriver(), selected);
});
