import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProcessPathRefs } from "../../dist/resources/liveReferences.js";
import { acquireHandoverLock } from "../../dist/release/runtimeRelease.js";
import { captureBackupIdentity, recordSuccessfulBackup, retainMigrationBackups } from "../../dist/storage/upgrade/backupRetention.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";

test("actual open descriptors protect a backup and linked roots cannot reach another Home", t => {
  const scratch = mkdtempSync(join(tmpdir(), "yui-backup-ownership-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const home = join(scratch, "home");
  const other = join(scratch, "other");
  mkdirSync(join(home, "backups"), { recursive: true, mode: 0o700 });
  mkdirSync(join(other, "backups"), { recursive: true, mode: 0o700 });
  const fence = acquireHandoverLock(home);
  t.after(() => fence.release());
  const paths = [1, 2].map(day => {
    const path = join(home, "backups", `pre-storage-v1.34-2026-10-0${day}T00-00-00.000Z.db`);
    writeFileSync(path, "backup", { mode: 0o600 });
    recordSuccessfulBackup(home, "home-fixture", path, captureBackupIdentity(path));
    return path;
  });
  const fd = openSync(paths[0], "r");
  t.after(() => closeSync(fd));
  const scan = scanProcessPathRefs([paths[0]], { strictSameUser: true });
  assert.ok(scan.refs.get(paths[0])?.length, "The real OS inventory must observe this process's open fd.");
  const report = retainMigrationBackups({ home, homeId: "home-fixture", keep: 1, protectedPaths: [] });
  assert.deepEqual(report.deleted, []);
  assert.ok(report.protected.some(item => item.path === paths[0] && /open file/.test(item.reason)));
  assert.ok(paths.every(existsSync));

  const victim = join(other, "backups", "pre-storage-v1.34-2026-10-01T00-00-00.000Z.db");
  writeFileSync(victim, "other Home", { mode: 0o600 });
  const linkedHome = join(scratch, "linked-home");
  mkdirSync(linkedHome, { mode: 0o700 });
  symlinkSync(join(other, "backups"), join(linkedHome, "backups"));
  assert.throws(() => recordSuccessfulBackup(linkedHome, "home-fixture", victim, captureBackupIdentity(victim)), /root|Home/);
  assert.equal(readFileSync(victim, "utf8"), "other Home");
});

test("filesystem permission errors preserve sets and a later cleanup can retry safely", {
  skip: process.getuid?.() === 0 ? "root bypasses directory write permissions" : false
}, t => {
  const home = mkdtempSync(join(tmpdir(), "yui-backup-permissions-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "backups");
  mkdirSync(root, { mode: 0o700 });
  const fence = acquireHandoverLock(home);
  t.after(() => fence.release());
  const paths = [1, 2, 3].map(day => {
    const path = join(root, `pre-storage-v1.34-2026-10-0${day}T00-00-00.000Z.db`);
    writeFileSync(path, "backup", { mode: 0o600 });
    recordSuccessfulBackup(home, "home-fixture", path, captureBackupIdentity(path));
    return path;
  });
  const input = { home, homeId: "home-fixture", keep: 1, protectedPaths: [paths[2]],
    scanProcesses: () => ({ refs: new Map(), diagnostics: [] }) };
  chmodSync(root, 0o500);
  try {
    const report = retainMigrationBackups(input);
    assert.deepEqual(report.deleted, []);
    assert.equal(report.warnings.length, 2);
    assert.ok(report.warnings.every(item => /EACCES|permission denied/.test(item.message)));
    assert.ok(paths.every(existsSync));
  } finally { chmodSync(root, 0o700); }
  const retry = retainMigrationBackups(input);
  assert.deepEqual(retry.deleted, [paths[1], paths[0]]);
  assert.equal(retry.retained, 1);
  assert.equal(existsSync(paths[2]), true);
});

test("the update migration child retains the direct parent's maintenance owner through cleanup", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-backup-update-owner-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  try { store.databaseHandle().prepare("UPDATE storage_schema SET minor=34").run(); }
  finally { store.close(); }
  const fence = acquireHandoverLock(home);
  t.after(() => fence.release());
  const moduleUrl = new URL("../../dist/cli/upgradeCommand.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { runUpgradeCommand } from ${JSON.stringify(moduleUrl)};
    const result = await runUpgradeCommand(["--update-apply"], process.argv[1], {
      YUI_UPDATE_HANDOVER_OWNER_PID: String(process.ppid)
    });
    process.stdout.write(JSON.stringify(result.data));
  `, home], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.outcome, "upgraded");
  assert.equal(result.report.backupRetention.retained, 1);
  assert.deepEqual(result.report.backupRetention.warnings, []);
  assert.equal(existsSync(result.report.backupPath), true);
});
