import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { parseResourceRegistryState } from "../../dist/resources/resourceRegistry.js";
import { createResourceRecord } from "../../dist/resources/resourceTypes.js";
import { createUpdatePorts } from "../../dist/cli/updatePorts.js";
import { runUpdate } from "../../dist/cli/updateOrchestrator.js";
import { renderUpdateResult } from "../../dist/cli/updateCommand.js";
import { reconcileControllerResourcesForUpdate } from "../../dist/controller/updateReconciliation.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask } from "../../dist/task/task.js";
import { createProject } from "../../dist/repository/project.js";
import { requestTaskActivation } from "../../dist/task/taskActivationService.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

const env = sanitizedTestEnv({
  GIT_AUTHOR_NAME: "Yui Test", GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Yui Test", GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null"
});
for (const [key, value] of Object.entries(env)) {
  if (key.startsWith("GIT_")) process.env[key] = value;
}
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

test("failed worktree removal preserves the exact checkout; standalone clone deletion is explicit", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-cleanup-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repositoryPath = join(root, "repository");
  git(root, "init", "--initial-branch=main", repositoryPath);
  writeFileSync(join(repositoryPath, "file"), "retained content\n");
  git(repositoryPath, "add", "file");
  git(repositoryPath, "commit", "-m", "initial");
  const workspace = new NodeGitWorkspace();
  const identity = { container: join(root, "lane"), directory: "Repo",
    taskSegment: "task-1", roleName: "lane-1" };
  const prepared = await workspace.ensureWorktree({ ...identity, repositoryPath, baseRef: "main" });
  const cleanup = { ...identity, expectedCommit: prepared.baseCommit, deleteBranch: true };
  git(repositoryPath, "worktree", "lock", "--reason", "retain this checkout", prepared.path);
  await assert.rejects(workspace.removeStrandedWorktree(prepared.path, cleanup), /locked/i);
  assert.equal(existsSync(join(prepared.path, "file")), true);
  git(repositoryPath, "worktree", "unlock", prepared.path);
  assert.equal(await workspace.removeStrandedWorktree(prepared.path, cleanup), "removed");
  assert.equal(git(repositoryPath, "branch", "--list", prepared.branch), "");

  const container = join(root, "main");
  mkdirSync(container);
  const path = join(container, "Repo");
  await workspace.clone({ remoteUrl: repositoryPath, destination: path, localBranch: "yui/task-1/main" });
  await assert.rejects(workspace.removeStrandedWorktree(path, {
    container, directory: "Repo", taskSegment: "task-1", roleName: "main", expectedCommit: prepared.baseCommit
  }), /standalone|linked worktree/i);
  assert.equal(existsSync(path), true);
  assert.equal(await workspace.removeTaskClone({
    path, container, directory: "Repo", taskSegment: "task-1",
    branch: "yui/task-1/main", expectedCommit: prepared.baseCommit
  }), "removed");
});

test("current resource records reject malformed safety facts without normalizing them", () => {
  const record = createResourceRecord({
    kind: "runtime-artifact", path: "/fixture/runtime",
    owner: { home: "/fixture/home", basis: "durable-record", taskId: "task-1" },
    cleanliness: "n/a", activeRefs: ["session:owned"], disposition: "active"
  }, new Date("2026-09-17T00:00:00Z"));
  const parse = entry => parseResourceRegistryState({ schemaVersion: 1, records: { [record.id]: entry } });
  assert.deepEqual(parse(record).records[record.id], record);
  for (const broken of [
    { ...record, cleanliness: undefined },
    { ...record, activeRefs: ["session:owned", 7] },
    { ...record, kind: "unknown-kind" },
    { ...record, owner: { ...record.owner, basis: "guessed" } },
    { ...record, quarantine: { path: "/other", method: "move" } }
  ]) {
    assert.throws(() => parse(broken), /Resource registry record/);
  }
});

test("update controller status only observes; reconciliation is a separate effect", () => {
  const calls = [];
  const ports = createUpdatePorts(env, (_command, args) => {
    const script = args.join(" ");
    calls.push(script);
    if (args.includes("live-identity")) return {
      status: 5, stdout: Buffer.alloc(0),
      stderr: Buffer.from(JSON.stringify({ ok: false, code: "CONTROLLER_NOT_RUNNING" }))
    };
    const data = script.includes("reconcileControllerResourcesForUpdate")
      ? { cleaned: [] }
      : { resources: [], warnings: [] };
    return { status: 0, stdout: Buffer.from(JSON.stringify({ ok: true, data })), stderr: Buffer.alloc(0) };
  });
  assert.deepEqual(ports.controllerStatus("/fixture/home"), { running: false });
  assert.equal(calls.some(call => call.includes("reconcileControllerResourcesForUpdate")), false);
  assert.equal(typeof ports.reconcileController, "function");
});

test("bounded reconciliation retains exact partial effects through failed observation and update output", async () => {
  const home = "/fixture/home";
  const resource = (id, overrides = {}) => ({
    id, fingerprint: id, kind: "controller", state: "orphaned", disposition: "safe",
    reasonCode: "orphaned", yuiHome: home, owner: { kind: "controller-domain", yuiHome: home },
    processes: [{ pid: 41, startIdentity: id }], ...overrides
  });
  const a = resource("old-1"), b = resource("old-2");
  const current = resource("current", { state: "current", disposition: "protected" });
  const foreign = resource("foreign", { yuiHome: "/other/home" });
  const scans = [
    { currentHome: home, scope: "current", observedAt: "2026-09-17T00:00:00Z",
      warnings: [], resources: [a, b, current, foreign] },
    new Error("fixture inventory unavailable")
  ];
  const cleaned = [];
  let released = false;
  let failure;
  await assert.rejects(reconcileControllerResourcesForUpdate(home, {}, "/fixture/tmux", {
    acquireLock: async () => async () => { released = true; },
    scan: async input => {
      assert.equal(input.tmuxBin, "/fixture/tmux");
      const next = scans.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    clean: async entry => {
      cleaned.push(entry.id);
      if (entry.id === b.id) throw new Error("fixture signal failed after partial stop");
    }
  }), error => {
    failure = error;
    assert.deepEqual(error.result.cleaned, [a.id]);
    assert.equal(error.result.attempts[1].resource, b);
    assert.equal(error.result.attempts[1].outcome, "unknown");
    assert.match(error.result.attempts[1].error, /signal failed/);
    assert.match(error.result.observationError, /inventory unavailable/);
    assert.deepEqual(error.result.remaining.map(entry => entry.id), [b.id, current.id]);
    return true;
  });
  assert.deepEqual(cleaned, [a.id, b.id], "Current and foreign Controllers are never cleaned.");
  assert.equal(released, true);

  const child = createUpdatePorts(env, () => ({
    status: 5, stdout: Buffer.alloc(0),
    stderr: Buffer.from(JSON.stringify({ ok: false, message: failure.message, result: failure.result }))
  }));
  const effects = [];
  const result = runUpdate({
    stage: () => ({ binaryPath: "/fixture/target", version: "0.16.1" }),
    preflight: () => ({ status: "already-current" }),
    beginControllerHandover: () => () => { effects.push("release"); },
    reconcileController: child.reconcileController,
    controllerStatus: () => assert.fail("uncertain cleanup must stop the update"),
    activateBinary: () => assert.fail("must not activate"),
    verify: () => assert.fail("must not verify"),
    cleanup: () => { effects.push("staging-cleanup"); }
  }, { home });
  assert.equal(result.outcome, "aborted");
  assert.equal(result.recoverable, false);
  assert.equal(result.controllerOwnershipUnknown, true);
  assert.deepEqual(result.controllerReconciliation, failure.result);
  assert.deepEqual(effects, ["release", "staging-cleanup"]);
  assert.match(renderUpdateResult(result), /old-1.*old-2/s);
  assert.doesNotMatch(renderUpdateResult(result), /Home remain usable/);

  // The fixed multi-pass plan remains automatic: an exactly owned historical
  // Controller can go first, allowing its stale discovery to be classified.
  const artifact = resource("discovery", {
    kind: "artifact", state: "stale", processes: [],
    artifact: { artifactKind: "controller-discovery", path: "/fixture/discovery", fingerprint: "inode", active: false }
  });
  const inventory = resources => ({ currentHome: home, scope: "current",
    observedAt: "2026-09-17T00:01:00Z", resources, warnings: [] });
  const normalScans = [
    inventory([a, { ...artifact, state: "running", disposition: "protected" }, current]),
    inventory([artifact, current]), inventory([current])
  ];
  const normal = await reconcileControllerResourcesForUpdate(home, {}, undefined, {
    acquireLock: async () => async () => {},
    scan: async () => normalScans.shift(),
    clean: async entry => assert.ok([a.id, artifact.id].includes(entry.id))
  });
  assert.deepEqual(normal.cleaned, [a.id, artifact.id]);
  assert.deepEqual(normal.remaining, [current]);
});

test("activation compensates its unadopted clone and preserves the original failure", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-clone-compensation-"));
  let store;
  t.after(() => { store?.close(); rmSync(root, { recursive: true, force: true }); });
  const repositoryPath = join(root, "remote");
  git(root, "init", "--initial-branch=main", repositoryPath);
  git(repositoryPath, "commit", "--allow-empty", "-m", "initial");
  const home = join(root, "home");
  store = new SqliteTaskStore(home);
  const now = new Date("2026-09-17T00:00:00Z");
  const project = createProject("project-1", "fixture", repositoryPath,
    { stable: "main", development: "main" }, now, { remoteUrl: repositoryPath });
  store.saveProject(project);
  const task = createTask("task-1", "Clone compensation", now, {
    projectBindings: [{ projectId: project.id, directory: "Repo", baseRef: "main" }]
  });
  store.saveTask(task);
  requestTaskActivation(store, {
    taskId: task.id, requestId: "begin", actorId: "user:local", authorityRef: "test",
    environmentPlan: { kind: "empty" }
  }, now);
  let createdPath;
  class FailedPreparation extends NodeGitWorkspace {
    async clone(input) {
      createdPath = input.destination;
      return super.clone(input);
    }
    async headRef() { throw new Error("fixture post-clone inspection failed"); }
  }
  const preparer = new FileTaskWorkspacePreparer(home, store, new FailedPreparation(), () => now);
  await assert.rejects(preparer.activateTaskWorkspace(task.id), /fixture post-clone inspection failed.*compensation/s);
  assert.ok(createdPath);
  assert.equal(existsSync(createdPath), false);
  assert.equal(store.getTaskWorkspace(task.id), null);
  assert.equal(store.getTask(task.id).status, "draft");
  assert.equal(existsSync(repositoryPath), true);
});
