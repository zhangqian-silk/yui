import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { nativeExecutable } from "../../dist/runtime/nativeExecutable.js";

import {
  currentProcessStartIdentity, processGenerationIsLive, processOwnerIsLive,
  readProcessStartIdentity
} from "../../dist/core/fileLockOwner.js";
import {
  createEphemeralDomainIdentity, writeEphemeralDomainIdentity
} from "../../dist/controller/domainIdentity.js";
import { scanControllerResourceInventory } from "../../dist/controller/resourceInventoryLinux.js";
import { cleanControllerResource } from "../../dist/controller/resourceCleanupLinux.js";
import { controllerSocketPath } from "../../dist/core/controllerEndpoint.js";
import { scanProcessPathRefs } from "../../dist/resources/liveReferences.js";
import { yuiTmuxServerName } from "../../dist/tmux/tmuxManager.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { readHomeFilesystemId } from "../../dist/core/homeFilesystemIdentity.js";
import {
  findLiveControllerProcessForHome, inspectLiveControllerProcess
} from "../../dist/core/controllerProcessIdentity.js";
import { activateRelease, ControllerStartUnconfirmedError } from "../../dist/release/releaseHandover.js";
import { runHandoverCandidate } from "../../dist/controller/handoverCandidate.js";
import {
  SessionOwnerReconciliation, observeSessionOwnerPhysical
} from "../../dist/controller/sessionOwnerReconciliation.js";
import {
  readActiveReleasePointer, readCandidateDiscovery, readHandoverFence,
  readHandoverReceipt, writeCandidateDiscovery, writeHandoverFence
} from "../../dist/release/runtimeRelease.js";

test("process custody compares a kernel generation, including on macOS", () => {
  const identity = currentProcessStartIdentity();
  assert.equal(readProcessStartIdentity(process.pid), identity);
  assert.equal(processGenerationIsLive(process.pid, identity), true);
  const wrong = (BigInt(identity) + 1n).toString();
  assert.equal(processGenerationIsLive(process.pid, wrong), false);
  assert.equal(processOwnerIsLive(process.pid, wrong), false);
  if (process.platform === "darwin") assert.notEqual(identity, String(process.pid));
});

test("a live macOS ephemeral Host remains protected after the grace period", async t => {
  if (process.platform !== "darwin") return t.skip("macOS inventory boundary");
  const home = mkdtempSync(join(tmpdir(), "yui-mac-host-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  new SqliteTaskStore(home).close();
  const createdAt = new Date(Date.now() - 10_000);
  writeEphemeralDomainIdentity(home, createEphemeralDomainIdentity({
    tmuxServer: yuiTmuxServerName(home), createdAt
  }));
  const inventory = await scanControllerResourceInventory({
    currentHome: home, scope: "current", now: () => new Date()
  });
  const domain = inventory.domains.find(record => record.yuiHome === home);
  assert.equal(domain?.liveness, "active");
  assert.equal(domain?.disposition, "protected");
  await assert.rejects(scanControllerResourceInventory({ currentHome: home, scope: "all" }),
    /requires cross-Home process discovery/);
});

test("macOS finds a Controller generation when its discovery record is absent", async t => {
  if (process.platform !== "darwin") return t.skip("macOS process discovery");
  const home = mkdtempSync(join(tmpdir(), "yui-mac-orphan-"));
  const child = spawn(process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "/tmp/controllerMain.js"],
    { env: { ...process.env, YUI_HOME: home }, stdio: "ignore" });
  t.after(() => { child.kill("SIGKILL"); rmSync(home, { recursive: true, force: true }); });
  const filesystemId = readHomeFilesystemId(home);
  let found;
  for (let attempt = 0; attempt < 20; attempt++) {
    found = findLiveControllerProcessForHome(filesystemId);
    if (found !== undefined) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(found?.pid, child.pid);
  assert.equal(inspectLiveControllerProcess(child.pid, filesystemId,
    (BigInt(found.processStartIdentity) + 1n).toString()), undefined);
});

test("a macOS handover candidate reads its generation before validating the fence", async t => {
  if (process.platform !== "darwin") return t.skip("macOS candidate identity");
  const home = mkdtempSync(join(tmpdir(), "yui-mac-candidate-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await assert.rejects(runHandoverCandidate(home, "missing-fence"),
    /Handover fence.*missing or does not match/);
});

test("macOS records and verifies a Host generation, and rejects pane-only stop proof", async t => {
  if (process.platform !== "darwin") return t.skip("macOS Session owner boundary");
  const home = mkdtempSync(join(tmpdir(), "yui-mac-owner-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
  t.after(() => { child.kill("SIGKILL"); rmSync(home, { recursive: true, force: true }); });
  const records = [];
  const store = {
    saveSessionOwner: record => records.push(record),
    listSessionOwnersForOwner: () => records,
    removeSessionOwner: () => {},
    getWorkMailbox: () => null,
    getGlobalRoleSessionSet: () => null
  };
  const tmux = { killRole: () => {}, probeRoleStatus: () => "exited" };
  const owner = { scope: "global", roleName: "operator" };
  const reconciler = new SessionOwnerReconciliation({ home, store, tmux });
  reconciler.recordHostOwner({ owner, agentId: "codex", adapterId: "codex", panePid: child.pid });
  assert.equal(records.length, 1);
  assert.equal(observeSessionOwnerPhysical(records[0])?.alive, true);
  const stopped = await reconciler.terminateOwner(owner, {
    gracefulGraceMs: 1000, forcedGraceMs: 500, pollMs: 20
  });
  assert.equal(stopped.outcome, "stop-confirmed");
  const withoutRecord = new SessionOwnerReconciliation({
    home, store: { ...store, listSessionOwnersForOwner: () => [] }, tmux
  });
  const uncertain = await withoutRecord.terminateOwner(owner);
  assert.equal(uncertain.outcome, "stop-blocked");
  assert.match(uncertain.verificationGap, /No recorded Host process identity/);
});

test("macOS GC observes a real process cwd without treating every path as unverified", async t => {
  if (process.platform !== "darwin") return t.skip("macOS process path inventory");
  const home = mkdtempSync(join(tmpdir(), "yui-mac-path-ref-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"],
    { cwd: home, stdio: "ignore" });
  t.after(() => { child.kill("SIGKILL"); rmSync(home, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const scan = scanProcessPathRefs([home]);
  assert.deepEqual(scan.diagnostics, []);
  assert.ok(scan.refs.get(home)?.some(token => token.includes(`:${child.pid}`)));
});

test("macOS removes only a stale Controller socket after probing its listener", async t => {
  if (process.platform !== "darwin") return t.skip("macOS Unix socket cleanup");
  const home = mkdtempSync(join(tmpdir(), "yui-mac-socket-cleanup-"));
  const store = new SqliteTaskStore(home);
  const socketPath = controllerSocketPath(store.getHomeIdentity().homeId);
  const homeId = store.getHomeIdentity().homeId;
  store.close();
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  t.after(() => {
    rmSync(socketPath, { force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const resource = () => {
    const stat = lstatSync(socketPath);
    return {
      id: "fixture-controller-socket", kind: "artifact", disposition: "review",
      yuiHome: home, homeId, processes: [],
      artifact: { artifactKind: "controller-socket", path: socketPath, active: false,
        fingerprint: [stat.dev, stat.ino, stat.mode, stat.size,
          Math.trunc(stat.mtimeMs)].join(":") }
    };
  };
  const stale = spawnSync(process.execPath, ["-e",
    "require('node:net').createServer().listen(process.argv[1],()=>process.exit(0))",
    socketPath], { encoding: "utf8", timeout: 5000 });
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(existsSync(socketPath), true);
  await cleanControllerResource(resource());
  assert.equal(existsSync(socketPath), false);
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await assert.rejects(cleanControllerResource(resource()), /Resource socket is active/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("failed first activation removes its new pointer", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-release-pointer-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = await activateRelease({
    call: async () => { throw Object.assign(new Error("not running"), { code: "CONTROLLER_NOT_RUNNING" }); },
    spawnCandidate: () => assert.fail("no old Controller"),
    startControllerFromRelease: async () => { throw new Error("fixture startup failure"); },
    runPreflight: () => {}, killOwnedProcess: () => {}, sleep: async () => {}, now: () => new Date()
  }, { home, releaseDir: home, manifest: {
    version: "1.0.1", buildId: "fixture", packageDigest: "a".repeat(64)
  } });
  assert.equal(result.outcome, "aborted");
  assert.equal(readActiveReleasePointer(home), null);
});

test("an uncertain spawned Controller retains the new pointer for inspection", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-release-uncertain-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const manifest = { version: "1.0.1", buildId: "fixture", packageDigest: "d".repeat(64) };
  const result = await activateRelease({
    call: async () => { throw Object.assign(new Error("not running"), { code: "CONTROLLER_NOT_RUNNING" }); },
    spawnCandidate: () => assert.fail("no old Controller"),
    startControllerFromRelease: async () => {
      throw new ControllerStartUnconfirmedError(process.pid, "fixture readiness timeout");
    },
    runPreflight: () => {}, killOwnedProcess: () => {}, sleep: async () => {}, now: () => new Date()
  }, { home, releaseDir: home, manifest });
  assert.equal(result.outcome, "aborted");
  assert.equal(result.recoverable, false);
  assert.equal(readActiveReleasePointer(home)?.releaseId,
    `${manifest.version}-${manifest.packageDigest}`);
});

test("a reachable Controller without a generation token cannot be bypassed", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-release-identity-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await assert.rejects(activateRelease({
    call: async () => ({ pid: process.pid }),
    spawnCandidate: () => assert.fail("unfenced handover"),
    startControllerFromRelease: async () => assert.fail("must not replace live Controller"),
    runPreflight: () => {}, killOwnedProcess: () => {}, sleep: async () => {}, now: () => new Date()
  }, { home, releaseDir: home, manifest: {
    version: "1.0.1", buildId: "fixture", packageDigest: "c".repeat(64)
  } }), /did not provide a process-generation identity/);
  assert.equal(readActiveReleasePointer(home), null);
});

test("macOS Claude owner reports a detached orphan as unconfirmed", async t => {
  if (process.platform !== "darwin") return t.skip("macOS child custody");
  const root = mkdtempSync(join(tmpdir(), "yui-mac-claude-owner-"));
  const pidFile = join(root, "detached.pid");
  const code = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'],",
    "  { detached: true, stdio: 'ignore' });",
    "writeFileSync(process.argv[1], String(child.pid));",
    "child.unref();"
  ].join("\n");
  const owner = spawn(nativeExecutable("claude-process-owner"),
    [process.execPath, "-e", code, pidFile], { stdio: "ignore" });
  let detachedPid;
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(pidFile), true);
    detachedPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(detachedPid) && detachedPid > 0);
    const exitCode = owner.exitCode === null ? await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Claude owner did not settle")), 3000);
      owner.once("exit", value => { clearTimeout(timeout); resolve(value); });
      owner.once("error", error => { clearTimeout(timeout); reject(error); });
    }) : owner.exitCode;
    assert.equal(exitCode, 125);
    assert.doesNotThrow(() => process.kill(detachedPid, 0));
  } finally {
    if (detachedPid !== undefined) {
      try { process.kill(detachedPid, "SIGKILL"); } catch {}
    }
    if (owner.exitCode === null) owner.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed candidate termination preserves its discovery and handover fence", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-release-rollback-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = { pid: process.pid, processStartIdentity: currentProcessStartIdentity(),
    buildId: "old", version: "1.0.0" };
  let rollbackCalled = false;
  const result = await activateRelease({
    call: async (_home, method, params) => {
      if (method === "controller.identity") return old;
      if (method === "controller.begin-handover") {
        const now = new Date().toISOString();
        writeHandoverFence(home, { schemaVersion: 1, handoverId: params.handoverId,
          phase: "fenced", old, candidate: null, fromReleaseId: null,
          toReleaseId: `1.0.1-${"b".repeat(64)}`, createdAt: now, updatedAt: now });
        return {};
      }
      rollbackCalled = true;
      return {};
    },
    spawnCandidate: () => writeCandidateDiscovery(home, {
      pid: process.pid, processStartIdentity: old.processStartIdentity
    }),
    startControllerFromRelease: async () => assert.fail("old Controller is present"),
    runPreflight: () => {},
    killOwnedProcess: () => { throw new Error("fixture termination denied"); },
    sleep: async () => {}, now: () => new Date()
  }, { home, releaseDir: home, manifest: {
    version: "1.0.1", buildId: "fixture", packageDigest: "b".repeat(64)
  }, candidateReadyTimeoutMs: 0 });
  assert.equal(result.outcome, "aborted");
  assert.match(result.message, /rollback is unconfirmed/);
  assert.equal(result.recoverable, false);
  assert.equal(rollbackCalled, false);
  assert.equal(readCandidateDiscovery(home)?.pid, process.pid);
  assert.equal(readHandoverFence(home)?.phase, "fenced");
  assert.equal(readHandoverReceipt(home), null);
  assert.equal(existsSync(join(home, "runtime", "controller-candidate.json")), true);
});
