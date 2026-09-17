import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { scanLiveReferences } from "../../dist/resources/liveReferences.js";
import { readResourceGcState } from "../../dist/resources/resourceGc.js";
import { createSessionOwnerIdentity, readLinuxProcessIdentity } from "../../dist/runtime/sessionOwnerIdentity.js";
import { renderCompletion } from "../../dist/cli/completion.js";
import { normalizeVerificationPlan } from "../../dist/verification/verificationPlan.js";
import { createIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import { FileCompletionManager } from "../../dist/completion/fileCompletionManager.js";
import { uninstallCompletion } from "../../dist/completion/completionInstaller.js";
import {
  materializeSessionBootstrap, refreshManagedSessionCliWrappers
} from "../../dist/context/sessionBootstrapManifest.js";
import { createFileReleaseIdempotencyStore } from "../../dist/release/releaseIdempotencyStore.js";
import { runUpdate } from "../../dist/cli/updateOrchestrator.js";

test("only current CLI and verification contracts are accepted", () => {
  const cli = resolve("dist/cli.js");
  const old = spawnSync(process.execPath, [cli, "task", "turn", "--help"], { encoding: "utf8" });
  assert.notEqual(old.status, 0, "The retired Task turn alias must not dispatch.");
  assert.match(execFileSync(process.execPath, [cli, "task", "run", "--help"], { encoding: "utf8" }), /AgentRun/);
  assert.match(renderCompletion("bash"), /complete -F _yui yui/);
  assert.doesNotMatch(renderCompletion("bash", "yui-dev"), /yui-dev|_yui_dev/,
    "An obsolete second argument cannot select another completion identity.");
  const plan = { schemaVersion: 2, kind: "verification-plan", id: "checks", version: "1",
    bootstrap: [], l2: { steps: [{ name: "check", argv: ["true"] }] } };
  assert.equal(Object.hasOwn(normalizeVerificationPlan(plan), "l1"), false);
  assert.throws(() => normalizeVerificationPlan({ ...plan, l1: { categories: [] } }), /retired|L1|l1/);
  assert.throws(() => createIntegrationAttempt({ id: "integration-1", taskId: "task-1", projectId: "project-1",
    targetRef: "main", beforeCommit: "a".repeat(40),
    source: { kind: "historical-change-sets", changeSetIds: ["change-set-1"] }
  }, new Date()), /source/i);
});

test("GC reads exact process custody from SQLite and ignores the retired JSON source", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-current-owner-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const runtimeRoot = join(home, "owned-runtime");
  mkdirSync(runtimeRoot);
  const processIdentity = readLinuxProcessIdentity(process.pid);
  assert.ok(processIdentity);
  const owner = createSessionOwnerIdentity({
    owner: { scope: "global", roleName: "operator" }, agentId: "fixture", adapterId: "codex",
    tmux: { serverName: "fixture", socketPath: join(home, "no-server.sock"), sessionName: "fixture", windowName: "operator" },
    providerRoot: { pid: process.pid, startIdentity: processIdentity.startIdentity, attribution: "pane-pid" },
    runtimeRoot, recordedAt: new Date()
  });
  store.saveSessionOwner(owner);
  // This file is not an ownership authority, even when it is malformed.
  const oldDirectory = join(home, "runtime", "session-owners");
  mkdirSync(oldDirectory, { recursive: true });
  writeFileSync(join(oldDirectory, "unrelated.json"), "not JSON");
  const scan = await scanLiveReferences({ home, paths: [runtimeRoot],
    sessionOwners: store.listSessionOwners(),
    ports: { processCwdRefs: () => new Map(), tmuxPaneCwds: async () => [] } });
  assert.ok(scan.refsByPath.get(runtimeRoot).some(ref => ref.startsWith("session-owner:")));
  assert.deepEqual(scan.diagnostics, []);
  assert.equal(readResourceGcState(store).sessionOwners.length, 1);
  assert.throws(() => store.saveSessionOwner({ ...owner,
    providerRoot: { ...owner.providerRoot, attribution: "launch-env" }
  }), /attribution/i);
});

test("one completion identity installs and removes only its own shell block", t => {
  const root = mkdtempSync(join(tmpdir(), "yui-current-completion-"));
  const store = new SqliteTaskStore(join(root, "home"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const environment = { HOME: root, SHELL: "/bin/bash", YUI_CLI_NAME: "yui-dev" };
  const manager = new FileCompletionManager(store, environment);
  const overview = manager.inspect();
  assert.equal(overview.identity, "yui");
  const installation = overview.states.find(state => state.shell === "bash").suggested;
  assert.equal(installation.scriptPath.endsWith("/yui"), true);
  writeFileSync(installation.activationPath, "export FIXTURE_KEEP=1\n");
  manager.install({ shell: "bash", installation, activate: true });
  assert.equal(manager.inspect().states.find(state => state.shell === "bash").status, "Installed");
  assert.match(readFileSync(installation.activationPath, "utf8"), /FIXTURE_KEEP/);
  uninstallCompletion(store, "bash");
  assert.equal(existsSync(installation.scriptPath), false);
  assert.equal(readFileSync(installation.activationPath, "utf8"), "export FIXTURE_KEEP=1\n");
});

test("Session CLI refresh retargets only the current two-argument wrapper and preserves its Manifest", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-current-wrapper-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bootstrap = materializeSessionBootstrap({
    yuiHome: home,
    role: { name: "leader", launchRevision: 1, defaultAccess: "write" },
    owner: { scope: "task", taskId: "task-1" }, roleKind: "leader", skills: [],
    entryPoint: { executable: "/fixture/node's binary", cliEntry: "/fixture/previous path/dist/cli.js" }
  });
  const manifest = readFileSync(bootstrap.manifestPath, "utf8");
  const target = { executable: "/fixture/node", cliEntry: "/fixture/current/dist/cli.js" };
  const current = '#!/bin/sh\nexec \'/fixture/node\' \'/fixture/current/dist/cli.js\' "$@"\n';
  assert.deepEqual(refreshManagedSessionCliWrappers(home, target), { refreshed: 1, current: 0, skipped: 0 });
  assert.equal(readFileSync(bootstrap.sessionCliPath, "utf8"), current);
  assert.equal(statSync(bootstrap.sessionCliPath).mode & 0o777, 0o700);
  assert.equal(readFileSync(bootstrap.manifestPath, "utf8"), manifest);
  assert.deepEqual(refreshManagedSessionCliWrappers(home, target), { refreshed: 0, current: 1, skipped: 0 });
  const unsupported = '#!/bin/sh\nexec \'/fixture/node\' \'/fixture/cli.js\' \'unexpected-argument\' "$@"\n';
  writeFileSync(bootstrap.sessionCliPath, unsupported);
  assert.deepEqual(refreshManagedSessionCliWrappers(home, target), { refreshed: 0, current: 0, skipped: 1 });
  assert.equal(readFileSync(bootstrap.sessionCliPath, "utf8"), unsupported);
});

test("current release receipts replay success and reject invalid records without discarding evidence", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-current-release-receipt-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const key = "task-1/workflow-1/step";
  const store = createFileReleaseIdempotencyStore(home);
  const effect = { outcome: "succeeded", externalId: "confirmed-effect" };
  assert.equal(await store.load(key), undefined);
  await store.recordSuccess(key, effect);
  assert.deepEqual(await createFileReleaseIdempotencyStore(home).load(key), effect);
  await assert.rejects(store.recordSuccess(key, { outcome: "unknown" }), /only records succeeded/);
  const path = join(home, "release-idempotency", `${encodeURIComponent(key)}.json`);
  const corrupt = { ...JSON.parse(readFileSync(path, "utf8")), key: "another-operation" };
  const original = JSON.stringify(corrupt);
  writeFileSync(path, original);
  await assert.rejects(store.load(key), /does not match/);
  assert.equal(readFileSync(path, "utf8"), original);
});

test("a quiesced storage blocker restores the captured Controller without activating or migrating", () => {
  const effects = [];
  let preflights = 0;
  const update = runUpdate({
    stage: () => ({ binaryPath: "/fixture/target", version: "0.16.1" }),
    preflight: () => ++preflights === 1
      ? { status: "migration-ready", stepCount: 1 }
      : { status: "blocked", message: "Storage changed during drain", action: "Preserve evidence" },
    beginControllerHandover: () => () => {},
    reconcileController: () => {
      effects.push("reconcile");
      return { home: "/fixture/home", cleaned: ["old"], attempts: [], remaining: [] };
    },
    controllerStatus: () => ({ running: true, pid: 42, identity: {
      executablePath: "/fixture/node", args: ["/fixture/controllerMain.js"], version: "0.16.1"
    } }),
    stopController: (_home, pid) => { effects.push("stop"); return { stopped: true, pid }; },
    activateBinary: () => effects.push("activate"),
    migrateStorage: () => { effects.push("migrate"); return {}; },
    verify: () => effects.push("verify"),
    startController: () => effects.push("start"),
    restoreController: () => effects.push("restore"),
    cleanup: () => {}
  }, { home: "/fixture/home" });
  assert.equal(update.outcome, "aborted");
  assert.deepEqual(effects, ["reconcile", "stop", "restore"]);
  assert.deepEqual(update.controllerReconciliation.cleaned, ["old"]);
  assert.equal(update.controllerRestore.outcome, "restored");
  assert.equal(update.sceneUnchanged, undefined);
});
