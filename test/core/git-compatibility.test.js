import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { compatibleGitArguments, gitVersionSupport } from "../../dist/repository/gitCompatibility.js";
import { gitPath, readGitWorktrees } from "../../dist/repository/gitWorktreeInventory.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

test("Git compatibility preserves exact paths, locked missing registrations and fetch isolation", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-git-compat-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo space "中"\t ');
  mkdirSync(repo);
  const env = sanitizedTestEnv({
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
  });
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  git(repo, "init");
  git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(join(repo, "tracked"), "base\n");
  git(repo, "add", "tracked");
  git(repo, "commit", "-m", "base");
  const workspace = new NodeGitWorkspace();
  assert.equal((await workspace.inspect(repo)).root, repo);
  assert.equal(await gitPath(repo, ["--git-common-dir"]), join(repo, ".git"));
  // Before Git's built-in fsmonitor, "false" names a hook, not a boolean.
  const originalPath = process.env.PATH;
  const hooks = join(root, "hook-bin");
  const hookMarker = join(root, "hook-ran");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "false"), `#!/bin/sh\ntouch '${hookMarker}'\n`, { mode: 0o700 });
  try {
    process.env.PATH = `${hooks}:${originalPath}`;
    assert.equal(await workspace.inspectClean(repo), true);
    assert.equal(existsSync(hookMarker), false);
  } finally { process.env.PATH = originalPath; }
  const input = {
    repositoryPath: repo, container: join(root, "owner"), directory: 'linked "中"\t\n ',
    taskSegment: "task-1-token", roleName: "work-item-1", baseRef: "HEAD", deleteBranch: true
  };
  const linked = await workspace.ensureWorktree(input);
  assert.equal((await workspace.inspect(linked.path)).gitDirectory, join(repo, ".git"));
  assert.notEqual(await gitPath(linked.path, ["--git-dir"]), await gitPath(linked.path, ["--git-common-dir"]));
  git(repo, "worktree", "lock", "--reason", "keep", linked.path);
  assert.equal((await readGitWorktrees(repo)).find(entry => entry.path === linked.path).locked, true);
  rmSync(linked.path, { recursive: true });
  await assert.rejects(workspace.removeWorktree(input), /locked|ownership/);
  assert.equal((await readGitWorktrees(repo)).length, 2);
  git(repo, "worktree", "unlock", linked.path);
  assert.equal(await workspace.removeWorktree(input), "missing");
  assert.equal((await readGitWorktrees(repo)).length, 1);

  const clone = join(root, "clone");
  await workspace.clone({ remoteUrl: repo, destination: clone });
  git(clone, "config", "remote.origin.prune", "true");
  git(clone, "update-ref", "refs/remotes/origin/keep", "HEAD");
  const fetchHead = join(clone, ".git", "FETCH_HEAD");
  writeFileSync(fetchHead, "concurrent user's FETCH_HEAD\n");
  git(repo, "commit", "--allow-empty", "-m", "advance");
  const oldTracking = git(clone, "rev-parse", "refs/remotes/origin/main");
  const baseline = await workspace.resolveRemoteBaseline({
    repositoryPath: clone, remoteUrl: "origin", developmentRef: "main"
  });
  assert.equal(baseline.commit, git(repo, "rev-parse", "HEAD").trim());
  assert.equal(git(clone, "rev-parse", "refs/remotes/origin/main"), oldTracking);
  assert.equal(git(clone, "rev-parse", "refs/remotes/origin/keep"), oldTracking);
  assert.equal(readFileSync(fetchHead, "utf8"), "concurrent user's FETCH_HEAD\n");
  await assert.rejects(workspace.resolveTree(clone, "--output=oops"), /Unsafe Git revision/);
  assert.equal(existsSync(join(clone, "oops")), false);
});

test("minimum Git check stops an unsupported clone before creating its destination", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-git-preflight-"));
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; rmSync(root, { recursive: true, force: true }); });
  const log = join(root, "calls");
  // A mock here proves rejection ordering, not actual old Git compatibility.
  writeFileSync(join(root, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf 'git version 2.20.0\\n'\n`, { mode: 0o700 });
  process.env.PATH = `${root}:${path}`;
  const destination = join(root, "uncreated", "clone");
  await assert.rejects(new NodeGitWorkspace().clone({
    remoteUrl: "/not-contacted", destination
  }), /2\.29\.0.*|Select a supported Git/s);
  assert.equal(existsSync(join(root, "uncreated")), false);
  assert.equal(readFileSync(log, "utf8"), "--version\n");
  assert.equal(gitVersionSupport("git version 2.30.2").supported, true);
  assert.equal(gitVersionSupport("git version 2.29.0").supported, true);
  assert.equal(gitVersionSupport("nonsense").supported, false);
  assert.throws(() => compatibleGitArguments(["rev-parse", "--verify", "--end-of-options", "-q"]), /Unsafe/);
});
