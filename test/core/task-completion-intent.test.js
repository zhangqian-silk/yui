import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createProject } from "../../dist/repository/project.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { integrationTmuxSocketRoot } from "../../dist/storage/homeLayout.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { projectNextAction } from "../../dist/task/nextAction.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

const now = new Date("2026-09-17T00:00:00Z");

test("dependency conflicts require judgment, preserve valid edges and never prescribe clearing all dependencies", () => {
  const task = createTask("task-1", "Dependency intent", now);
  const item = (id, dependsOn = []) => createWorkItem(id, task.id, { title: id, dependsOn }, now);
  for (const workItems of [
    [item("work-item-1", ["work-item-2", "work-item-3"]), item("work-item-2")],
    [item("work-item-1", ["work-item-2"]), item("work-item-2", ["work-item-1"])]
  ]) {
    const facts = { task, workItems, changeSets: [], integrations: [], reviewRounds: [],
      reviewConfig: null, openInputRequests: [], activeRuns: [], leaderRuns: [] };
    const before = structuredClone(facts);
    const action = projectNextAction(facts);
    assert.equal(action.kind, "repair-protocol-inconsistency");
    assert.ok(action.conflicts.length >= 2);
    assert.ok(action.judgmentRequired);
    assert.ok(action.alternatives.length > 0);
    assert.doesNotMatch(JSON.stringify(action), /--clear-dependencies/);
    assert.match(action.recommendedCommand, /work show/);
    assert.deepEqual(facts, before, "decision support cannot mutate dependency intent");
  }
  const cyclic = { task: activateTask(task, now),
    workItems: [item("work-item-1", ["work-item-2"]), item("work-item-2", ["work-item-1"])],
    changeSets: [], integrations: [], reviewRounds: [], reviewConfig: null,
    openInputRequests: [], activeRuns: [], leaderRuns: [] };
  const action = projectNextAction(cyclic);
  assert.match(action.reason, /cycle/);
  assert.equal(new Set(action.conflicts.map(ref => ref.id)).size, 2, "report the actual cycle edge, not a fabricated self-dependency");
  assert.ok(action.judgmentRequired);
  assert.doesNotMatch(JSON.stringify(action), /--clear-dependencies/);
  assert.equal(projectNextAction({ ...cyclic, task,
    workItems: [item("work-item-1", ["work-item-2"]), item("work-item-2")]
  }).recommendedCommand, "yui task activate task-1", "valid Draft dependencies do not require execution before activation");
});

test("completion is offline by default; explicit remote refresh observes without rebasing or creating execution", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-completion-intent-"));
  const home = join(root, "home");
  const env = sanitizedTestEnv({
    HOME: root, YUI_HOME: home, YUI_STORE_WORKER: "false",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@local",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@local"
  });
  let store;
  t.after(() => {
    // A regression can start a Controller/Job before an assertion fails.
    // Register shutdown before the first CLI call and retain evidence on failure.
    try {
      if (existsSync(join(home, "runtime/controller.json"))) {
        const stopped = spawnSync(process.execPath, [resolve("dist/cli.js"), "controller", "stop"],
          { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stopped.status, 0, `Fixture retained at ${root}: ${stopped.stderr}`);
      }
      const socket = `yui-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 24)}`;
      const tmux = spawnSync("tmux", ["-L", socket, "kill-server"], { env, encoding: "utf8" });
      if (tmux.status !== 0 && tmux.error?.code !== "ENOENT") {
        assert.match(tmux.stderr, /no server running|No such file or directory/);
      }
      try { rmdirSync(integrationTmuxSocketRoot(home)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    } finally { store?.close(); }
    rmSync(root, { recursive: true, force: true });
  });
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  const remote = join(root, "remote");
  mkdirSync(remote);
  git(remote, "init", "-b", "main");
  const commit = name => {
    writeFileSync(join(remote, name), name);
    git(remote, "add", name);
    git(remote, "commit", "-m", name);
    return git(remote, "rev-parse", "HEAD");
  };
  const base = commit("base");
  const reference = join(root, "reference");
  git(root, "clone", remote, reference);
  store = new SqliteTaskStore(home);
  store.saveConfig({ ...store.getConfig(), defaultWorkspace: join(root, "workspaces") });
  store.saveProject(createProject("project-1", "app", reference,
    { stable: "main", development: "main" }, now, { remoteUrl: remote }));
  const preparer = new FileTaskWorkspacePreparer(home, store);
  for (const id of ["task-1", "task-2"]) {
    store.saveTask(createTask(id, "Local completion", now, {
      projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "main" }]
    }));
    runTaskCommand(["activation", "request", id, "--request-id", `start-${id}`,
      "--environment", "empty"], store, { environment: env, now: () => now });
    await preparer.activateTaskWorkspace(id, env);
  }
  const remoteHead = commit("upstream");
  for (const [id, flags] of [["task-2", ["--refresh-remote"]], ["task-1", []]]) {
    const path = store.getTaskWorkspace(id).entries[0].path;
    const result = spawnSync(process.execPath,
      [resolve("dist/cli.js"), "task", "complete", id, "--summary", "Local evidence", ...flags, "--json"],
      { env, encoding: "utf8", timeout: 15000 });
    assert.equal(git(path, "rev-parse", "HEAD"), base, "refresh must not change the accepted delivery head");
    assert.deepEqual(store.listIntegrationAttempts(id), []);
    assert.deepEqual(store.listDurableJobs(id), []);
    assert.deepEqual(store.listReviewRounds(id), []);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const response = JSON.parse(result.stdout);
    assert.equal(response.data.task.status, "completed");
    assert.equal(response.data.stage, "completed");
    assert.deepEqual(response.data.projectHeads, [{ projectId: "project-1", commit: base }]);
    assert.equal(response.data.baseFreshness.refreshed, flags.length > 0);
    if (flags.length > 0) {
      assert.equal(response.data.baseFreshness.entries[0].trackedCommit, remoteHead);
      assert.equal(response.data.baseFreshness.entries[0].status, "behind");
    } else {
      const object = spawnSync("git", ["-C", path, "cat-file", "-e", remoteHead], { env });
      assert.notEqual(object.status, 0, "default completion cannot fetch a new remote object");
    }
  }
  assert.equal(git(reference, "rev-parse", "HEAD"), base, "the stable checkout stays untouched");
});
