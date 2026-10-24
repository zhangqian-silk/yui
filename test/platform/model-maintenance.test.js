import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readlinkSync, existsSync, unlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeModelMaintenance, validateMaintenanceInput } from "../../dist/models/modelMaintenance.js";
import { createModelManagement } from "../../dist/models/modelManagement.js";
import { modelDigest, modelJsonFile, replaceModelFile } from "../../dist/models/modelManagementFiles.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createJobDefinitionControl } from "../../dist/controller/jobDefinitionControl.js";
import { readLinuxProcessIdentity } from "../../dist/runtime/sessionOwnerIdentity.js";
import { fileURLToPath } from "node:url";

test("component update pins a remote commit, preserves dirty sources/config and refuses failed builds", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-maintenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), releases = join(root, "releases");
  mkdirSync(source, { mode: 0o700 }); mkdirSync(releases, { mode: 0o700 });
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  writeFileSync(join(source, "version"), "one");
  git("add", "."); git("commit", "-m", "one");
  const commit = git("rev-parse", "HEAD");
  writeFileSync(join(source, "version"), "dirty");
  const config = join(root, "config.json");
  writeFileSync(config, '{"host":"127.0.0.1","port":18418}', { mode: 0o600 });
  const spec = { repository: source, ref: "refs/heads/main", directory: releases,
    build: [{ argv: [process.execPath, "-e", "require('fs').writeFileSync('built','ok')"], timeoutMs: 5000 }],
    verify: [{ argv: [process.execPath, "-e", "if(!require('fs').existsSync('built'))process.exit(1)"], timeoutMs: 5000 }],
    configFiles: [config], migration: "none", service: null };
  const base = { moduleId: "bridge", moduleRevision: "a".repeat(64), spec, exclusiveWriter: true, impactAcknowledged: true };
  const check = await executeModelMaintenance({ ...base, operation: "check-update" }, join(root, "check"));
  assert.equal(check.commit, commit);
  assert.equal(check.source, source);
  const installed = await executeModelMaintenance({ ...base, operation: "update", commit }, join(root, "install"));
  assert.equal(installed.status, "succeeded", JSON.stringify(installed));
  assert.equal(installed.runtimeVersion, "unknown");
  const first = readlinkSync(join(releases, "current"));
  assert.equal(readFileSync(join(releases, first, "version"), "utf8"), "one");
  assert.equal(readFileSync(join(source, "version"), "utf8"), "dirty");
  assert.equal(readFileSync(join(installed.backupDirectory, "0"), "utf8"), readFileSync(config, "utf8"));
  const failed = await executeModelMaintenance({ ...base, operation: "update", commit,
    spec: { ...spec, build: [{ argv: [process.execPath, "-e", "process.exit(1)"], timeoutMs: 5000 }] } }, join(root, "failed"));
  assert.equal(failed.status, "failed");
  assert.equal(readlinkSync(join(releases, "current")), first);
  const again = await executeModelMaintenance({ ...base, operation: "update", commit }, join(root, "again"));
  assert.equal(again.previous, first);
  assert.ok(existsSync(join(releases, first)));
  const rolledBack = await executeModelMaintenance({ ...base, operation: "rollback" }, join(root, "rollback"));
  assert.equal(rolledBack.status, "succeeded");
  assert.equal(readlinkSync(join(releases, "current")), first);
  assert.equal(rolledBack.configRestored, false);
  const missing = await executeModelMaintenance({ ...base, operation: "check-update",
    spec: { ...spec, ref: "refs/heads/absent" } }, join(root, "missing"));
  assert.equal(missing.status, "failed");
  assert.equal(readlinkSync(join(releases, "current")), first);
  assert.throws(() => validateMaintenanceInput({ ...base, operation: "restart" }), /service/);
  const handoff = await executeModelMaintenance({ ...base, operation: "handoff" }, join(root, "handoff"));
  assert.equal(handoff.stopped, false);
  assert.equal(readlinkSync(join(releases, "current")), first);
  const dangling = `release-${commit}-00000000-0000-0000-0000-000000000000`;
  unlinkSync(join(releases, "current")); symlinkSync(dangling, join(releases, "current"));
  const damaged = await executeModelMaintenance({ ...base, operation: "update", commit }, join(root, "damaged"));
  assert.equal(damaged.status, "failed");
  assert.equal(readlinkSync(join(releases, "current")), dangling, "do not normalize a damaged installation into a fresh one");
});

test("failed service restart is unknown, no guessed takeover or automatic retry", async t => {
  const directory = mkdtempSync(join(tmpdir(), "yui-maintenance-unit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const unit = join(directory, "unit.service");
  writeFileSync(unit, "[Service]\nExecStart=/fixture/program\n", { mode: 0o600 });
  const spec = { repository: "/fixture/repository", ref: "refs/heads/main", directory,
    build: [], verify: [{ argv: ["/fixture/preflight"], timeoutMs: 1000 }], configFiles: [], migration: "none",
    service: { manager: "systemd-user", unit: "fixture.service", fragmentPath: unit,
      fragmentRevision: modelDigest(readFileSync(unit, "utf8")) } };
  const input = { moduleId: "bridge", moduleRevision: "a".repeat(64), spec, operation: "restart",
    exclusiveWriter: true, impactAcknowledged: true };
  let restarts = 0;
  const command = async (file, args) => {
    if (args.includes("show")) return `Id=fixture.service\nFragmentPath=${unit}\nDropInPaths=\nActiveState=active\nSubState=running\nMainPID=1\n`;
    if (args.includes("restart")) { restarts++; throw new Error("command-failed"); }
    return "";
  };
  const result = await executeModelMaintenance(input, directory, { command });
  assert.equal(result.status, "unknown");
  assert.equal(restarts, 1);
  assert.equal(result.cleanup.lock, "released");
  writeFileSync(unit, "[Service]\nExecStart=/other/program\n", { mode: 0o600 });
  const refused = await executeModelMaintenance(input, directory, { command });
  assert.equal(refused.status, "failed");
  assert.equal(restarts, 1);
  writeFileSync(unit, "[Service]\nExecStart=/fixture/program\n", { mode: 0o600 });
  const unknown = await executeModelMaintenance(input, directory, { command: async (file, args, ...rest) => {
    if (args.includes("restart")) throw Error("command-outcome-unknown");
    return command(file, args, ...rest);
  } });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.cleanup.lock, "retained-unknown");
  assert.ok(existsSync(join(directory, ".maintenance-lock", "owner.json")));
});

test("timed-out component Job stops inherited-pipe descendants and retains unknown evidence",
  { skip: process.platform !== "linux", timeout: 10_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), "yui-maintenance-timeout-"));
    let store, child;
    t.after(() => {
      if (child && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
      store?.close();
      rmSync(root, { recursive: true, force: true });
    });
    const source = join(root, "source"), releases = join(root, "releases"), marker = join(root, "descendant");
    mkdirSync(source, { mode: 0o700 }); mkdirSync(releases, { mode: 0o700 });
    const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
    git("init", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
    writeFileSync(join(source, "version"), "one"); git("add", "."); git("commit", "-m", "one");
    store = new SqliteTaskStore(join(root, "home"));
    const module = { id: "bridge", kind: "metabridge", version: "fixture", managementUrl: "",
      configFile: "", managementKeyFile: "", maintenance: "external", quotaAdapter: "none" };
    store.saveConfig({ ...store.getConfig(), modelManagement: { modules: [module], endpoints: [], bindings: [], receipts: [] } });
    const descendant = `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
    const input = { moduleId: module.id, moduleRevision: modelDigest(module), operation: "update",
      commit: git("rev-parse", "HEAD"), exclusiveWriter: true, impactAcknowledged: true,
      spec: { repository: source, ref: "refs/heads/main", directory: releases,
        build: [{ argv: [process.execPath, "-e",
          `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000)`], timeoutMs: 500 }],
        verify: [{ argv: [process.execPath, "-e", ""], timeoutMs: 1000 }],
        configFiles: [], migration: "none", service: null } };
    const control = createJobDefinitionControl(store, store.rootDirectory());
    const base = { scope: { kind: "global" }, id: "timeout-fixture", caller: { scope: "user" } };
    control({ ...base, op: "define", title: "Timeout fixture",
      configuration: { kind: "builtin", action: "models.maintenance", input } }, new Date());
    const { run } = control({ ...base, op: "run", trigger: { source: "manual", key: "timeout-once" } }, new Date());
    store.saveGlobalJobRun({ ...run, operation: { ...run.operation, effect: "possible" } });
    const artifacts = join(store.rootDirectory(), run.artifactsLocator);
    mkdirSync(artifacts, { recursive: true, mode: 0o700 });
    child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/models/modelMaintenanceRunner.js", import.meta.url)),
      store.rootDirectory(), run.id], { detached: true, stdio: "ignore", env: run.env });
    const terminal = await new Promise((accept, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => accept({ code, signal }));
    });
    assert.equal(terminal.signal, "SIGKILL");
    const result = JSON.parse(readFileSync(join(artifacts, "business-result.json"), "utf8"));
    assert.equal(result.outcome, "unknown-needs-attention");
    assert.equal(result.data.error, "command-outcome-unknown");
    assert.equal(result.data.cleanup.lock, "retained-unknown");
    assert.ok(existsSync(join(releases, ".maintenance-lock", "owner.json")));
    const pid = Number(readFileSync(marker, "utf8"));
    // A dead child may remain a zombie until its external reaper runs.
    const identity = readLinuxProcessIdentity(pid);
    assert.ok(identity === undefined || identity.state === "Z", "no descendant can continue building after the receipt");
    assert.equal(existsSync(join(releases, "current")), false);
  });

test("versioned native JSON examples preserve unrelated fields and refresh the authority digest", async t => {
  const directory = mkdtempSync(join(tmpdir(), "yui-native-doc-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const kind of ["metabridge", "cliproxyapi"]) {
    const file = join(directory, `${kind}.json`);
    const value = kind === "metabridge" ? { host: "127.0.0.1", port: 18418, catalogTtlMs: 1000, backends: [] }
      : { "config-version": 8, routing: { strategy: "round-robin" }, access: { "api-keys": ["ISOLATED"] } };
    writeFileSync(file, JSON.stringify({ ...value, unrelated: { keep: true } }, null, 2) + "\n", { mode: 0o600 });
    const module = { id: kind, kind, version: "fixture", configFile: file, managementUrl: "", managementKeyFile: "",
      maintenance: "external", quotaAdapter: "none" };
    const config = { schemaVersion: 1, modelManagement: { modules: [module], endpoints: [], bindings: [], receipts: [] } };
    const service = createModelManagement({ getConfig: () => config });
    const input = { revision: service.readRegistry().revision, resourceId: kind, kind: "status" };
    const before = await service.refresh(input);
    const old = modelJsonFile(file), backup = join(directory, `${kind}.backup`);
    writeFileSync(backup, old.raw, { flag: "wx", mode: 0o600 });
    replaceModelFile(old, kind === "metabridge" ? { ...old.value, catalogTtlMs: 60000 }
      : { ...old.value, routing: { ...old.value.routing, strategy: "fill-first" } });
    assert.equal(service.readStatus(kind).items[0].configurationRevision, before.items[0].configurationRevision, "cached read never refreshes");
    const after = await service.refresh(input);
    assert.notEqual(after.items[0].configurationRevision, before.items[0].configurationRevision);
    assert.equal(after.items[0].runtime, "unknown");
    assert.equal(modelJsonFile(file).value.unrelated.keep, true);
    replaceModelFile(modelJsonFile(file), JSON.parse(readFileSync(backup, "utf8")));
    assert.equal((await service.refresh(input)).items[0].configurationRevision, before.items[0].configurationRevision);
  }
});

test("explicit service identity, separate readiness and conservative redacted logs", async () => {
  const spec = { repository: "/fixture/repository", ref: "refs/heads/main", directory: "/fixture/releases",
    build: [], verify: [], configFiles: [], migration: "none",
    service: { manager: "systemd-user", unit: "fixture.service", fragmentPath: "/fixture/unit", fragmentRevision: "b".repeat(64) } };
  const calls = [];
  const execute = async (file, args) => {
    calls.push([file, args]);
    if (file === "journalctl") return "safe text\nAuthorization: Bearer SECRET\nunstructured SECRET\n";
    return "Id=fixture.service\nFragmentPath=/fixture/unit\nActiveState=active\nSubState=running\nMainPID=123\n";
  };
  const input = { moduleId: "bridge", moduleRevision: "a".repeat(64), spec, operation: "status" };
  const result = await executeModelMaintenance(input, "/unused", { command: execute, fragmentDigest: () => "b".repeat(64) });
  assert.equal(result.serviceState, "active");
  assert.equal(result.readiness, "unverified");
  assert.equal(result.inference, "not-tested");
  assert.equal(calls.length, 1);
  const logs = await executeModelMaintenance({ ...input, operation: "logs" }, "/unused",
    { command: execute, fragmentDigest: () => "b".repeat(64) });
  assert.ok(!JSON.stringify(logs).includes("SECRET"));
  assert.ok(!calls.some(([, args]) => args.some(a => /health|models|quota/.test(a))));
});
