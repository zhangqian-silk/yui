import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createProject } from "../../dist/repository/project.js";
import { createTask, activateTask, bindTaskWorkspaceIdentity } from "../../dist/task/task.js";
import { generateTaskWorkspaceIdentity } from "../../dist/repository/taskWorkspaceIdentity.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import { GitIntegrationService } from "../../dist/integration/gitIntegrationService.js";
import { createDurableJob, startDurableJob, completeDurableJob, durableJobIdempotencyKey } from "../../dist/job/durableJob.js";

const now = new Date("2026-09-12T00:00:00Z");
const git = (path, ...args) => execFileSync("git", ["-C", path, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
}).trim();

export function integrationFixture(t, strategy = "merge") {
  const root = mkdtempSync(join(tmpdir(), "yui-integration-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@local");
  writeFileSync(join(repo, "file"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-b", "source");
  writeFileSync(join(repo, "file"), "source\n");
  git(repo, "commit", "-am", "source");
  const source = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "main");
  writeFileSync(join(repo, "file"), "target\n");
  git(repo, "commit", "-am", "target");
  const before = git(repo, "rev-parse", "HEAD");
  const store = new SqliteTaskStore(home);
  store.saveConfig({ ...store.getConfig(), defaultWorkspace: join(root, "worktrees") });
  store.saveProject({ ...createProject("project-1", "app", join(root, "stable"),
    { stable: "main", development: "main" }, now), remoteUrl: repo });
  const task = activateTask(bindTaskWorkspaceIdentity(createTask("task-1", "Integrate", now, {
    cwd: repo, projectBindings: [{
      projectId: "project-1", directory: "app", baseRef: "main",
      baseCommit: base, currentCommit: before
    }]
  }), generateTaskWorkspaceIdentity({
    home: store.getHomeIdentity(), taskId: "task-1", now, entropy: Buffer.alloc(16, 9)
  }), now), now);
  store.saveTask(task);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id }, root: repo,
    entries: [{
      projectId: "project-1", directory: "app", access: "write", path: repo,
      branch: "main", baseRef: "main", baseCommit: before
    }]
  }, now));
  store.saveIntegrationAttempt(task.id, createIntegrationAttempt({
    id: "integration-1", taskId: task.id, projectId: "project-1", targetRef: "main",
    beforeCommit: before, checkCommands: ["true"],
    source: strategy === "rebase"
      ? { kind: "upstream", branch: "source", remoteCommit: source, taskBaseCommit: base, strategy }
      : { kind: "work-item", workItemId: "work-item-1", startCommit: base, resultCommit: source, strategy }
  }, now));
  let starts = 0;
  const jobs = {
    async startCheckJob(input) {
      const admitted = store.getIntegrationAttempt(input.taskId, input.integrationId);
      assert.equal(admitted.status, "running");
      assert.equal(admitted.candidateCommit, input.head);
      assert.equal(admitted.checkInputDigest, durableJobIdempotencyKey({
        ...input, owner: { kind: "integration-attempt", integrationAttemptId: input.integrationId }
      }));
      const old = store.listDurableJobs(task.id)[0];
      if (old) return old;
      starts++;
      const job = createDurableJob({
        id: "job-1", taskId: input.taskId,
        owner: { kind: "integration-attempt", integrationAttemptId: input.integrationId },
        projectId: input.projectId, head: input.head, workspace: input.workspace,
        env: input.env, steps: input.steps, artifactsLocator: "artifacts/job-1"
      }, now);
      store.saveDurableJob(task.id, job);
      return job;
    },
    async getJob(taskId, id) { return store.getDurableJob(taskId, id); },
    async cancelJob() {}
  };
  const service = () => new GitIntegrationService(home, store, undefined, () => now,
    { PATH: process.env.PATH }, undefined, jobs);
  t.after(() => {
    // Fake Jobs never launch processes. Remove only each fixture's exact
    // marked runtime, including checks intentionally left unfinished.
    const isolation = service().runtimeIsolation;
    for (const attempt of store.listIntegrationAttempts(task.id)) {
      const workspace = store.getIntegrationWorkspace(task.id, attempt.id);
      if (workspace !== null) isolation.cleanup(isolation.preflight({
        workspace, allowExactActive: true
      }), "completion");
    }
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, home, repo, store, service, jobs, base, source, before,
    starts: () => starts,
    finishJob() {
      const queued = store.getDurableJob(task.id, "job-1");
      const job = startDurableJob(queued, { pid: 99999999, startIdentity: "fixture-only" }, now);
      store.saveDurableJob(task.id, job);
      store.saveDurableJob(task.id, completeDurableJob(job, {
          outcome: "succeeded", exitCode: 0, signal: null,
          steps: job.steps.map(step => ({
            name: step.name, head: job.head, exitCode: 0, signal: null,
            timedOut: false, durationMs: 1, logPath: `${step.name}.log`
          }))
      }, now));
    },
    git: (...args) => git(repo, ...args),
    resolve(path) {
      writeFileSync(join(path, "file"), "resolved\n");
      git(path, "add", "file");
    }
  };
}

test("ordinary conflict continues without resolve and consumes one exact check Job", async t => {
  const f = integrationFixture(t);
  const conflict = await f.service().integrate("task-1", "integration-1");
  assert.equal(conflict.status, "conflicted");
  assert.equal(f.store.getTask("task-1").executionGate.state, "enabled");
  assert.equal(f.starts(), 0);
  assert.equal((await f.service().integrate("task-1", "integration-1")).status, "conflicted");
  assert.equal(f.starts(), 0);
  f.resolve(conflict.workspace.path);
  const checking = await f.service().integrate("task-1", "integration-1");
  assert.equal(checking.status, "checks-running", checking.attempt.summary);
  assert.equal(checking.attempt.status, "running");
  assert.equal(checking.attempt.candidateCommit, checking.job.head);
  f.finishJob();
  const done = await f.service().integrate("task-1", "integration-1");
  assert.equal(done.status, "committed");
  assert.equal(f.git("rev-parse", "HEAD"), done.attempt.afterCommit);
  assert.equal(f.starts(), 1);
});

test("interrupted rebase receipt and successful unbound Job resume without replay", async t => {
  const f = integrationFixture(t, "rebase");
  const conflict = await f.service().integrate("task-1", "integration-1");
  assert.equal(conflict.status, "conflicted", conflict.attempt.summary);
  f.resolve(conflict.workspace.path);
  const save = f.store.saveIntegrationAttempt.bind(f.store);
  let interruptGit = true;
  let interruptBind = true;
  f.store.saveIntegrationAttempt = (taskId, attempt) => {
    if (interruptGit && attempt.sourceProgress?.completedSteps === 1) {
      interruptGit = false;
      throw new Error("fixture: Git finished before cursor save");
    }
    if (interruptBind && attempt.jobId !== undefined) {
      interruptBind = false;
      f.finishJob();
      throw new Error("fixture: successful Job before binding");
    }
    save(taskId, attempt);
  };
  const interrupted = await f.service().integrate("task-1", "integration-1");
  assert.match(interrupted.attempt.summary ?? JSON.stringify(interrupted), /Git finished before cursor save/);
  const appliedHead = git(conflict.workspace.path, "rev-parse", "HEAD");
  assert.notEqual(appliedHead, f.before);
  assert.equal(f.starts(), 0);
  const unbound = await f.service().integrate("task-1", "integration-1");
  assert.match(unbound.attempt.summary, /successful Job before binding/);
  assert.equal(unbound.attempt.jobId, undefined);
  assert.equal(unbound.attempt.candidateCommit, appliedHead);
  const done = await f.service().integrate("task-1", "integration-1");
  assert.equal(done.status, "committed", done.attempt.summary);
  assert.equal(done.attempt.candidateCommit, appliedHead);
  assert.equal(f.starts(), 1);
});

test("storage 20 classifies old Git conflicts without fabricating recovery evidence", () => {
  const db = new Database(":memory:");
  try {
    migrateSqliteSchema(db, { mode: "apply", throughVersion: 19 });
    const base = createIntegrationAttempt({
      id: "integration-1", taskId: "task-1", projectId: "project-1",
      targetRef: "main", beforeCommit: "a".repeat(40),
      source: { kind: "upstream", strategy: "rebase", remoteCommit: "b".repeat(40), taskBaseCommit: "c".repeat(40), branch: "main" }
    }, now);
    const old = {
      ...base, status: "blocked", conflict: { affectedPaths: ["file"], summary: "Upstream rebase conflicts in main." },
      resolution: { action: "manual-resolution", rationale: "resolved", decidedBy: "leader", decidedAt: now.toISOString() }
    };
    const insert = db.prepare("INSERT INTO integration_attempts VALUES (?, ?, ?, ?, ?)");
    const payloads = [
      old,
      { ...old, id: "integration-2", conflict: { affectedPaths: [], summary: "Target moved" } },
      { ...old, id: "integration-3",
        source: { kind: "work-item", workItemId: "work-item-1", startCommit: "a".repeat(40), resultCommit: "b".repeat(40), strategy: "manual" },
        conflict: { affectedPaths: [], summary: "Manual WorkItem integration" } }
    ];
    for (const value of payloads) insert.run("task-1", value.id, "blocked", JSON.stringify(value), now.toISOString());
    const result = migrateSqliteSchema(db, { mode: "apply" });
    assert.deepEqual(result.applied, [20]);
    const rows = db.prepare("SELECT status, payload FROM integration_attempts ORDER BY integration_id").all();
    assert.deepEqual(rows.map(row => row.status), ["conflicted", "blocked", "blocked"]);
    assert.deepEqual(rows.map(row => JSON.parse(row.payload)), [
      { ...old, status: "conflicted" }, payloads[1], payloads[2]
    ]);
    assert.deepEqual(migrateSqliteSchema(db, { mode: "apply" }).applied, []);
  } finally { db.close(); }
});
