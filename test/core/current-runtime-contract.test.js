import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { scanLiveReferences } from "../../dist/resources/liveReferences.js";
import { readResourceGcState } from "../../dist/resources/resourceGc.js";
import { createSessionOwnerIdentity, readLinuxProcessIdentity } from "../../dist/runtime/sessionOwnerIdentity.js";
import { renderCompletion } from "../../dist/cli/completion.js";
import { normalizeVerificationPlan } from "../../dist/verification/verificationPlan.js";
import { createIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import { FileCompletionManager } from "../../dist/completion/fileCompletionManager.js";
import { uninstallCompletion } from "../../dist/completion/completionInstaller.js";

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
