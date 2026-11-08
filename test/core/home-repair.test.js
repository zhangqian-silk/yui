import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { runRepairCommand } from "../../dist/cli/repairCommand.js";
import { validateCurrentTaskStore } from "../../dist/storage/currentTaskStore.js";
import { installDevLauncher } from "../../scripts/manage-dev-launcher.mjs";
import { createTask } from "../../dist/task/task.js";

test("offline config repair is previewed, exact, atomic and does not reset unrelated data", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-home-repair-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const db = store.databaseHandle();
  const task = createTask(store.nextTaskId(), "Preserved history", new Date("2026-11-08T00:00:00Z"));
  store.saveTask(task);
  const original = { ...store.getConfig(), timeZone: "UTC", telemetryEnabled: "broken" };
  db.prepare("UPDATE config SET payload=? WHERE id=1").run(JSON.stringify(original));
  const patch = join(home, "patch.json");
  writeFileSync(patch, JSON.stringify({ set: { telemetryEnabled: false } }));
  const inspection = await runRepairCommand(["inspect"], home, {});
  assert.equal(inspection.data.config.status, "invalid");
  const launcher = fileURLToPath(new URL("../../output/dev/bin/yui", import.meta.url));
  installDevLauncher();
  const cli = JSON.parse(execFileSync(launcher, ["--json", "repair", "inspect"], {
    env: { PATH: process.env.PATH, HOME: home, YUI_HOME: home }, encoding: "utf8"
  }));
  assert.equal(cli.ok, true);
  assert.equal(cli.data.config.status, "invalid", "public entry works with broken config and no Controller");
  await assert.rejects(runRepairCommand(["inspect"], home, {
    YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1", YUI_ROLE: "leader", YUI_NATIVE_SESSION_ID: "unregistered"
  }), /identity|Role|registered|Session|session|caller/i);
  const preview = await runRepairCommand(["config", "--patch", patch], home, {});
  assert.equal(preview.data.effect, "preview");
  assert.deepEqual(JSON.parse(db.prepare("SELECT payload FROM config").get().payload), original);
  writeFileSync(patch, JSON.stringify({ set: { telemetryEnabled: "still-invalid" } }));
  await assert.rejects(runRepairCommand(["config", "--patch", patch], home, {}), /boolean/);
  assert.deepEqual(JSON.parse(db.prepare("SELECT payload FROM config").get().payload), original);
  writeFileSync(patch, JSON.stringify({ set: { telemetryEnabled: false } }));
  const args = ["config", "--patch", patch, "--apply", "--expect", preview.data.digest];
  db.prepare("UPDATE config SET payload=? WHERE id=1").run(JSON.stringify({ ...original, timeZone: "Asia/Shanghai" }));
  await assert.rejects(runRepairCommand(args, home, {}), /changed|digest/i);
  const refreshed = await runRepairCommand(["config", "--patch", patch], home, {});
  mkdirSync(join(home, "runtime"), { recursive: true });
  const discovery = join(home, "runtime/controller.json");
  writeFileSync(discovery, "{}");
  await assert.rejects(runRepairCommand([...args.slice(0, -1), refreshed.data.digest], home, {}), /Controller presence/);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM config").get().payload).telemetryEnabled, "broken");
  rmSync(discovery);
  const applied = JSON.parse(execFileSync(launcher, ["--json", "repair", ...args.slice(0, -1), refreshed.data.digest], {
    env: { PATH: process.env.PATH, HOME: home, YUI_HOME: home }, encoding: "utf8"
  }));
  assert.equal(applied.data.effect, "applied");
  assert.deepEqual(store.getTask(task.id), task);
  assert.equal(store.getConfig().timeZone, "Asia/Shanghai");
  assert.equal(store.getConfig().telemetryEnabled, false);
  assert.doesNotThrow(() => validateCurrentTaskStore(home));
  await assert.rejects(runRepairCommand(args, home, {}), /valid|changed|digest/i);
  assert.equal(existsSync(join(home, "runtime/controller.json")), false);
  db.prepare("UPDATE config SET payload=? WHERE id=1").run('{"secret":"DO-NOT-ECHO"');
  const broken = await runRepairCommand(["inspect"], home, {});
  assert.doesNotMatch(JSON.stringify(broken), /DO-NOT-ECHO/);
  await assert.rejects(runRepairCommand(["config", "--patch", patch], home, {}), /invalid JSON/);
  assert.equal(db.prepare("SELECT payload FROM config").get().payload, '{"secret":"DO-NOT-ECHO"');
  db.prepare("DELETE FROM config WHERE id=1").run();
  assert.equal((await runRepairCommand(["inspect"], home, {})).data.config.status, "invalid");
  await assert.rejects(runRepairCommand(["config", "--patch", patch], home, {}), /singleton/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM config").get().n, 0);
});

test("identity repair requires surviving ownership and a matching original backup", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-identity-repair-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const original = store.getHomeIdentity();
  const backup = join(home, "original.db");
  await store.databaseHandle().backup(backup);
  const bad = { ...original, entropy: "broken" };
  const update = value => store.databaseHandle().prepare("UPDATE home_meta SET home_identity=? WHERE id=1")
    .run(JSON.stringify(value));
  update(bad);
  const args = ["identity", "--from-backup", backup];
  const preview = await runRepairCommand(args, home, {});
  assert.deepEqual(store.getHomeIdentity(), bad);
  await runRepairCommand([...args, "--apply", "--expect", preview.data.digest], home, {});
  assert.deepEqual(store.getHomeIdentity(), original);
  update({ ...bad, createdAt: "2020-01-01T00:00:00.000Z" });
  await assert.rejects(runRepairCommand(args, home, {}), /conflicts/);
  update({ ...bad, homeId: "home-0000000000000000" });
  await assert.rejects(runRepairCommand(args, home, {}), /Home|identity|match/i);
  update({ entropy: "broken" });
  await assert.rejects(runRepairCommand(args, home, {}), /Home|identity/i);
  assert.deepEqual(store.getHomeIdentity(), { entropy: "broken" });
});
