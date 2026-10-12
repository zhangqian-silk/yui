import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Release CI exercises these same contracts against the freshly installed
// consumer, including whichever optional candidates that platform can load.
const root = resolve(process.env.YUI_INSTALLED_ROOT ?? fileURLToPath(new URL("../..", import.meta.url)));
const { default: Database, createSqliteDriverSelector, selectSqliteDriver, SQLITE_CANDIDATES } =
  await import(pathToFileURL(join(root, "dist/sqlite/driver.js")));
const { initializeSqliteSchema, validateSqliteSchema } =
  await import(pathToFileURL(join(root, "dist/storage/sqliteSchema.js")));

function fixture(failures = {}) {
  const calls = [];
  const closed = [];
  const select = createSqliteDriverSelector((candidate) => {
    calls.push(candidate.name);
    if (failures[candidate.name]?.load) throw failures[candidate.name].load;
    return class {
      constructor(filename) {
        if (filename !== ":memory:") throw new Error("real Home failure");
        if (failures[candidate.name]?.open) throw failures[candidate.name].open;
      }
      prepare() {
        if (failures[candidate.name]?.sql) throw failures[candidate.name].sql;
        return { get: () => ({ version: "test-engine", value: 1 }) };
      }
      close() { closed.push(candidate.name); }
    };
  });
  return { select, calls, closed };
}

test("SQLite selection probes once, closes connections, and never retries real Home errors", () => {
  const f = fixture();
  const selected = f.select();
  assert.equal(selected.name, "sqlite-modern");
  assert.equal(f.select(), selected);
  assert.deepEqual(f.calls, ["sqlite-modern"]);
  assert.deepEqual(f.closed, ["sqlite-modern"]);
  assert.throws(() => new selected.Database("/real/home.db"), /real Home failure/);
  assert.equal(f.select(), selected);
  assert.deepEqual(f.calls, ["sqlite-modern"]);
});

test("only identified native installation failures allow the fixed compatibility candidate", () => {
  const unavailable = [
    Object.assign(new Error("Cannot find module 'sqlite-modern'\nRequire stack:\n- driver.js"), { code: "MODULE_NOT_FOUND" }),
    Object.assign(new Error("Could not locate the bindings file. Tried:\n → /app/node_modules/sqlite-modern/build/Release/better_sqlite3.node"), {
      tries: ["/app/node_modules/sqlite-modern/build/Release/better_sqlite3.node"]
    }),
    Object.assign(new Error("The module '/app/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version requires NODE_MODULE_VERSION 137."), { code: "ERR_DLOPEN_FAILED" }),
    Object.assign(new Error("/lib/libm.so.6: version `GLIBC_2.29' not found (required by /app/better_sqlite3.node)"), { code: "ERR_DLOPEN_FAILED" }),
    Object.assign(new Error("libstdc++.so.6: cannot open shared object file: No such file or directory"), { code: "ERR_DLOPEN_FAILED" })
  ];
  for (const error of unavailable) {
    const f = fixture({ "sqlite-modern": { open: error } });
    const selected = f.select();
    assert.equal(selected.name, "sqlite-compat");
    assert.equal(selected.fallbackReason, error.message);
    assert.deepEqual(f.calls, ["sqlite-modern", "sqlite-compat"]);
    assert.deepEqual(f.closed, ["sqlite-compat"]);
    assert.equal(f.select(), selected);
  }
});

test("unknown load/SQL errors do not fall back, and dual failure preserves both causes", () => {
  for (const error of [
    new Error("unknown bug"),
    Object.assign(new Error("Cannot find module 'transitive-package'"), { code: "MODULE_NOT_FOUND" }),
    Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
    Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" }),
    Object.assign(new Error("permission denied"), { code: "EACCES" })
  ]) {
    const f = fixture({ "sqlite-modern": { load: error } });
    assert.throws(f.select, (caught) => caught === error);
    assert.deepEqual(f.calls, ["sqlite-modern"]);
  }
  const sqlError = new Error("bad business SQL");
  const sql = fixture({ "sqlite-modern": { sql: sqlError } });
  assert.throws(sql.select, (caught) => caught === sqlError);
  assert.deepEqual(sql.closed, ["sqlite-modern"]);
  assert.deepEqual(sql.calls, ["sqlite-modern"]);
  const missing = (name) => Object.assign(new Error(`Cannot find module '${name}'`), { code: "MODULE_NOT_FOUND" });
  const both = fixture({
    "sqlite-modern": { load: missing("sqlite-modern") },
    "sqlite-compat": { load: missing("sqlite-compat") }
  });
  assert.throws(both.select, (error) => {
    assert.match(error.message, /sqlite-modern@12\.11\.1/);
    assert.match(error.message, /sqlite-compat@10\.1\.0/);
    assert.match(error.message, /optional/);
    assert.equal(error.errors.length, 2);
    return true;
  });
  const unknownCompat = fixture({
    "sqlite-modern": { load: missing("sqlite-modern") },
    "sqlite-compat": { sql: sqlError }
  });
  assert.throws(unknownCompat.select, (error) => {
    assert.equal(error.errors[1], sqlError);
    assert.match(error.message, /Cannot find module 'sqlite-modern'/);
    assert.match(error.message, /bad business SQL/);
    return true;
  });
  assert.deepEqual(unknownCompat.closed, ["sqlite-compat"]);
});

for (const candidate of SQLITE_CANDIDATES) {
  test(`${candidate.name} real native SQL, transactions, WAL and backup`, async t => {
    const require = createRequire(join(root, "package.json"));
    let Driver;
    try {
      Driver = require(candidate.name);
      const probe = new Driver(":memory:");
      probe.close();
    } catch (error) {
      // Optional native candidates need not support every supported Node ABI.
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
  const root = mkdtempSync(join(tmpdir(), "yui-sqlite-errors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const selected = selectSqliteDriver();
  const path = join(root, "database.db");
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
  assert.throws(() => new Database(join(root, "missing", "file.db")));
  assert.throws(() => db.exec("invalid SQL"));
  writeFileSync(join(root, "bad.db"), "not a sqlite database");
  const bad = new Database(join(root, "bad.db"));
  try { assert.throws(() => bad.exec("SELECT * FROM sqlite_master"), { code: "SQLITE_NOTADB" }); }
  finally { bad.close(); }
  assert.equal(selectSqliteDriver(), selected);
});
