import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../../dist/sqlite/driver.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { acquireHandoverLock } from "../../dist/release/runtimeRelease.js";
import { captureBackupIdentity, recordSuccessfulBackup, retainMigrationBackups } from "../../dist/storage/upgrade/backupRetention.js";
import { runConfigCommand } from "../../dist/commands/configCommands.js";
import { configDefinition } from "../../dist/config/configCatalog.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-backup-retention-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  const homeId = store.getHomeIdentity().homeId;
  store.close();
  const fence = acquireHandoverLock(home);
  t.after(() => fence.release());
  return { home, homeId, fence };
}

async function migrate(home, day = 1) {
  const db = new Database(join(home, "yui.db"));
  db.prepare("UPDATE storage_schema SET minor=34").run();
  db.close();
  return runStorageUpgrade({ home, mode: "execute", now: new Date(`2026-10-${String(day).padStart(2, "0")}T00:00:00Z`) });
}

const idleProcesses = () => ({ refs: new Map(), diagnostics: [] });
function retain(home, homeId, keep = 3, rest = {}) {
  return retainMigrationBackups({ home, homeId, keep, protectedPaths: [], scanProcesses: idleProcesses, ...rest });
}
function backup(home, homeId, day, version = "1.34") {
  mkdirSync(join(home, "backups"), { recursive: true, mode: 0o700 });
  const path = join(home, "backups", `pre-storage-v${version}-2026-10-${String(day).padStart(2, "0")}T00-00-00.000Z.db`);
  writeFileSync(path, `backup ${day}`, { mode: 0o600 });
  recordSuccessfulBackup(home, homeId, path, captureBackupIdentity(path));
  return path;
}

test("retention counts sets, orders by creation rather than version, and repeats safely", t => {
  const { home, homeId } = fixture(t);
  const paths = [backup(home, homeId, 1, "1.99"), backup(home, homeId, 2, "1.2")];
  assert.equal(retain(home, homeId).deleted.length, 0, "Fewer than the limit.");
  paths.push(backup(home, homeId, 3, "1.9"));
  assert.equal(retain(home, homeId).deleted.length, 0, "Exactly the limit.");
  paths.push(backup(home, homeId, 4));
  const report = retain(home, homeId);
  assert.deepEqual(report.deleted, [paths[0]], "A larger version is not a newer backup.");
  assert.equal(report.retained, 3);
  assert.equal(existsSync(`${paths[0]}.retention.json`), false);
  assert.ok(paths.slice(1).every(existsSync));
  const referenced = retain(home, homeId, 1, { protectedPaths: [paths[1]] });
  assert.equal(referenced.retained, 2, "A current recovery reference wins even outside the newest set.");
  assert.equal(existsSync(paths[1]), true);
  assert.equal(retain(home, homeId, 1).retained, 1, "Custom count uses the same policy.");
  assert.deepEqual(retain(home, homeId, 1).deleted, [], "Repeated cleanup is inert.");
});

test("successful migration publishes a receipt; config and all read-only modes never prune", async t => {
  const { home } = fixture(t);
  const first = await migrate(home);
  assert.equal(first.outcome, "upgraded");
  const path = first.report.backupPath;
  assert.equal(JSON.parse(readFileSync(`${path}.retention.json`)).outcome, "validated");
  assert.equal(first.report.backupRetention.keep, 3);
  const before = readdirSync(join(home, "backups"));
  const store = new SqliteTaskStore(home);
  try {
    assert.equal(runConfigCommand("resources", ["show"], store).data.migrationBackupKeep, 3);
    assert.equal(configDefinition("migration-backup-keep").domain, "resources");
    for (const invalid of ["0", "-1", "1.5", "1001", "NaN"]) {
      assert.throws(() => runConfigCommand("resources", ["set", "migration-backup-keep", invalid], store));
    }
    assert.throws(() => store.saveConfig({ ...store.getConfig(), migrationBackupKeep: "3" }), /integer/);
    runConfigCommand("resources", ["set", "migration-backup-keep", "1"], store);
    assert.equal(runConfigCommand("resources", ["show"], store).data.migrationBackupKeep, 1);
    assert.deepEqual(readdirSync(join(home, "backups")), before);
    runConfigCommand("resources", ["clear", "migration-backup-keep"], store);
    assert.equal(runConfigCommand("resources", ["show"], store).data.migrationBackupKeep, 3);
    runConfigCommand("resources", ["set", "migration-backup-keep", "1"], store);
  } finally { store.close(); }
  const db = new Database(join(home, "yui.db"));
  db.prepare("UPDATE storage_schema SET minor=34").run();
  db.close();
  assert.equal((await runStorageUpgrade({ home, mode: "dry-run" })).outcome, "upgrade-plan");
  assert.equal((await runStorageUpgrade({ home, mode: "update-preflight" })).outcome, "update-preflight");
  assert.deepEqual(readdirSync(join(home, "backups")), before);
  const result = await migrate(home, 2);
  assert.equal(result.outcome, "upgraded");
  assert.equal(result.report.backupRetention.keep, 1);
  // Real process inventories can be inaccessible on hardened hosts. A failed
  // observation must protect the old set, never fabricate successful deletion.
  const report = result.report.backupRetention;
  if (report.deleted.length === 0) {
    assert.ok(report.warnings.some(item => /Process inventory incomplete/.test(item.message)));
    assert.ok(report.protected.some(item => item.path === path && /process|open/.test(item.reason)));
    assert.equal(existsSync(path), true);
  } else {
    assert.deepEqual(report.deleted, [path]);
    assert.equal(existsSync(path), false);
  }
  assert.equal(existsSync(result.report.backupPath), true);
  const after = readdirSync(join(home, "backups"));
  assert.equal((await runStorageUpgrade({ home, mode: "execute" })).outcome, "already-current");
  assert.deepEqual(readdirSync(join(home, "backups")), after);
});

test("legacy, recovery references, sidecars, process refs and unknown files remain protected beyond the limit", t => {
  const { home, homeId } = fixture(t);
  const paths = [1, 2, 3, 4].map(day => backup(home, homeId, day));
  const legacy = join(home, "backups", "pre-storage-v1.9-2020-01-01T00-00-00.000Z.db");
  writeFileSync(legacy, "unknown historical recovery material", { mode: 0o600 });
  writeFileSync(`${paths[0]}.pin`, "manual recovery");
  writeFileSync(`${paths[1]}-wal`, "unsettled WAL");
  const manual = join(home, "backups", "manual.db");
  writeFileSync(manual, "manual");
  const malformed = join(home, "backups", "pre-storage-unknown.db");
  writeFileSync(malformed, "unknown");
  const link = join(home, "backups", "pre-storage-v1.99-2019-01-01T00-00-00.000Z.db");
  symlinkSync(legacy, link);
  const report = retain(home, homeId, 1, { protectedPaths: [paths[3]], scanProcesses: () => ({
    refs: new Map([[paths[2], ["proc:fd:fixture"]]]), diagnostics: []
  }) });
  assert.equal(report.deleted.length, 0);
  assert.ok(paths.every(existsSync));
  assert.equal(readFileSync(legacy, "utf8"), "unknown historical recovery material");
  assert.equal(readFileSync(manual, "utf8"), "manual");
  assert.equal(readFileSync(malformed, "utf8"), "unknown");
  assert.ok(report.protected.some(item => item.reason.includes("pin")));
  assert.ok(report.protected.some(item => item.reason.includes("sidecar")));
  assert.ok(report.protected.some(item => item.reason.includes("open")));
  assert.ok(report.protected.some(item => item.reason.includes("receipt")));
  assert.ok(report.protected.some(item => item.reason.includes("regular")));
});

test("foreign Home, changed identities, hard links, incomplete receipts and scan failure cannot delete", t => {
  const { home, homeId, fence } = fixture(t);
  const paths = [1, 2, 3, 4].map(day => backup(home, homeId, day));
  const foreign = retain(home, "home-0000000000000000", 1);
  assert.equal(foreign.deleted.length, 0);
  assert.ok(paths.every(existsSync));
  writeFileSync(paths[0], "changed since successful migration");
  linkSync(paths[1], join(home, "backups", "hardlink.db"));
  writeFileSync(`${paths[2]}.retention.json`, "{partial");
  assert.equal(retain(home, homeId, 1).deleted.length, 0);
  paths.push(backup(home, homeId, 5), backup(home, homeId, 6));
  const unverified = retain(home, homeId, 1, { scanProcesses: () => ({
    refs: new Map(), diagnostics: [{ source: "proc", severity: "error", message: "permission denied" }]
  }) });
  assert.equal(unverified.deleted.length, 0);
  assert.ok(unverified.warnings.some(item => /Process inventory incomplete/.test(item.message)));
  assert.ok(paths.every(existsSync));
  // An interrupted DB-first deletion can leave an inert receipt; it is never
  // used to guess the ownership of a later replacement file.
  rmSync(paths[0]);
  assert.doesNotThrow(() => retain(home, homeId, 3));
  writeFileSync(paths[0], "replacement file", { mode: 0o600 });
  assert.equal(retain(home, homeId, 3).deleted.length, 0);
  fence.release();
  assert.throws(() => retain(home, homeId, 1), /fence/i);
});

test("a deletion-time identity race is observable and repeat cleanup stays safe", t => {
  const { home, homeId } = fixture(t);
  const paths = [1, 2, 3].map(day => backup(home, homeId, day));
  const report = retain(home, homeId, 1, { scanProcesses: () => {
    // Deterministic race/permission-equivalent failure, without depending on
    // chmod behavior for a root CI process.
    writeFileSync(paths[0], "changed after inventory");
    return idleProcesses();
  } });
  assert.equal(existsSync(paths[0]), true);
  assert.deepEqual(report.deleted, [paths[1]], "A failed candidate does not hide other outcomes.");
  assert.match(report.warnings[0].message, /identity changed/i);
  assert.equal(retain(home, homeId, 1).deleted.length, 0);
});

test("backup collisions and failed validation never prune previous recovery material", async t => {
  const { home, homeId } = fixture(t);
  const paths = [1, 2, 3, 4].map(day => backup(home, homeId, day));
  const collision = await migrate(home, 1);
  assert.equal(collision.outcome, "failed");
  assert.equal(collision.stage, "backup");
  assert.ok(paths.every(existsSync));
  assert.equal(readFileSync(paths[0], "utf8"), "backup 1");
  const db = new Database(join(home, "yui.db"));
  const original = db.prepare("SELECT payload FROM config").get().payload;
  db.prepare("UPDATE config SET payload=?").run(JSON.stringify({ ...JSON.parse(original), migrationBackupKeep: 0 }));
  db.close();
  const failure = await migrate(home, 5);
  assert.equal(failure.outcome, "failed");
  assert.equal(failure.stage, "migration");
  assert.equal(failure.sceneUnchanged, true);
  assert.ok(paths.every(existsSync));
  assert.equal(existsSync(failure.backupPath), true);
  assert.equal(existsSync(`${failure.backupPath}.retention.json`), false);
});
