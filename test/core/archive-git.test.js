import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeGitWorkspace, worktreeIdentity, integrationWorktreeIdentity } from "../../dist/repository/gitWorkspace.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

test("archive cleanup distinguishes a missing directory from exact Git metadata and refuses unsafe clone deletion", async t => {
  const container = mkdtempSync(join(tmpdir(), "yui-archive-git-"));
  t.after(() => rmSync(container, { recursive: true, force: true }));
  const taskSegment = "task-1-1234abcd";
  const mainIdentity = worktreeIdentity(taskSegment, "main");
  const root = join(container, "bound-app");
  mkdirSync(root, { recursive: true });
  const env = { ...sanitizedTestEnv(), GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", mainIdentity.branch);
  git("commit", "--allow-empty", "-m", "isolated baseline");
  const workspace = new NodeGitWorkspace();
  const missing = await workspace.ensureWorktree({
    repositoryPath: root, container, directory: "work-item-1-app", taskSegment, roleName: "work-item-1", baseRef: "HEAD"
  });
  const foreign = await workspace.ensureWorktree({
    repositoryPath: root, container, directory: "work-item-2-app", taskSegment, roleName: "work-item-2", baseRef: "HEAD"
  });
  rmSync(missing.path, { recursive: true });
  rmSync(foreign.path, { recursive: true });
  const clone = { path: root, container, directory: "bound-app", taskSegment, branch: mainIdentity.branch };
  await assert.rejects(workspace.removeTaskClone(clone), /registrations/);
  assert.equal(await workspace.removeWorktree({
    repositoryPath: root, container, directory: "work-item-1-app", taskSegment, roleName: "work-item-1", deleteBranch: true
  }), "missing");
  const records = git("worktree", "list", "--porcelain");
  assert.ok(!records.includes(missing.path));
  assert.ok(records.includes(foreign.path), "exact cleanup must not prune another owner's missing registration");
  assert.equal(await workspace.refExists(root, missing.branch), false);
  assert.equal(await workspace.removeWorktree({
    repositoryPath: root, container, directory: "work-item-1-app", taskSegment, roleName: "work-item-1", deleteBranch: true
  }), "missing", "repeated removal is idempotent");
  await workspace.removeWorktree({
    repositoryPath: root, container, directory: "work-item-2-app", taskSegment, roleName: "work-item-2", deleteBranch: true
  });
  writeFileSync(join(root, "keep.txt"), "uncommitted user data");
  assert.equal(await workspace.removeTaskClone(clone), "dirty");
  assert.equal(existsSync(join(root, "keep.txt")), true);
  await assert.rejects(workspace.removeTaskClone({ ...clone, taskSegment: "task-2-1234abcd" }), /identity/);
  git("add", "keep.txt");
  git("commit", "-m", "preserved commit");
  assert.equal(await workspace.removeTaskClone(clone), "removed");
  assert.equal(await workspace.removeTaskClone(clone), "missing");
});

test("cleanup tolerates a missing owner container and inspects exact detached Integration ownership", async t => {
  const container = mkdtempSync(join(tmpdir(), "yui-cleanup-recovery-"));
  t.after(() => rmSync(container, { recursive: true, force: true }));
  const root = join(container, "repo");
  mkdirSync(root);
  const env = { ...sanitizedTestEnv(), GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const git = (path, ...args) => execFileSync("git", ["-C", path, ...args], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  git(root, "init", "-b", "main");
  git(root, "commit", "--allow-empty", "-m", "base");
  const workspace = new NodeGitWorkspace();
  const input = { repositoryPath: root, container: join(container, "work-item"), directory: "app",
    taskSegment: "task-1-token", roleName: "work-item-1", baseRef: "HEAD", deleteBranch: true };
  await workspace.ensureWorktree(input);
  rmSync(input.container, { recursive: true });
  assert.equal(await workspace.inspectWorktree(input), "missing");
  assert.equal(await workspace.removeWorktree(input), "missing");
  assert.equal(await workspace.removeWorktree(input), "missing");
  const branch = integrationWorktreeIdentity(input.taskSegment, "integration-1").branch;
  const integration = { ...input, container: join(container, "integration"), expectedBranch: branch };
  mkdirSync(integration.container);
  const path = join(integration.container, "app");
  git(root, "worktree", "add", "-b", branch, path, "HEAD");
  git(path, "checkout", "--detach");
  assert.equal(await workspace.inspectWorktree(integration), "clean");
  rmSync(integration.container, { recursive: true });
  assert.equal(await workspace.inspectWorktree(integration), "missing");
  assert.equal(await workspace.removeIntegrationWorktree({
    ...integration, integrationId: "integration-1"
  }), "missing");
  assert.equal(await workspace.refExists(root, branch), false);
});
