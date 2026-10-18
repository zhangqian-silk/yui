import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, retireProject } from "../../dist/repository/project.js";
import { projectRefreshTargetDigest, refreshRegisteredProject } from "../../dist/repository/projectRefresh.js";
import { acquireProjectMaintenanceLock } from "../../dist/repository/projectMaintenanceLock.js";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createJobDefinitionControl, authorizeGlobalJobStart } from "../../dist/controller/jobDefinitionControl.js";
import { createScheduleControl, reconcileSchedules } from "../../dist/controller/scheduleControl.js";
import { DurableJobSupervisor, createFileArtifactPort } from "../../dist/controller/jobSupervisor.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";
import { startDurableJob } from "../../dist/job/durableJob.js";
import { reconcileProjectSync } from "../../dist/job/projectSync.js";

test("automatic refresh shares the manual maintenance fence and rejects changed or external targets", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-refresh-domain-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let project = createProject("project-1", "fixture", join(home, "projects", "project-1"),
    { stable: "main", development: "main" }, new Date(),
    { ownership: "managed", remoteUrl: join(home, "remote.git") });
  const store = { rootDirectory: () => home, listProjects: () => [project] };
  const digest = projectRefreshTargetDigest(project);
  const release = await acquireProjectMaintenanceLock(home, project.id);
  t.after(release);
  const pending = refreshRegisteredProject(store, project.id, {
    expectedDigest: digest, automatic: true,
    git: { refresh: async () => assert.fail("stale target must not reach Git") }
  });
  project = { ...project, remoteUrl: join(home, "replacement.git") };
  release();
  await assert.rejects(pending, /changed/);
  project = { ...project, ownership: "external" };
  await assert.rejects(refreshRegisteredProject(store, project.id, { automatic: true }), /managed/);
});

test("controlled Project Jobs fast-forward through the real runner and isolate refusal from another Project", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-refresh-jobs-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const env = sanitizedTestEnv({
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null"
  });
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"] }).trim();
  const remote = join(home, "remote.git"), seed = join(home, "seed");
  git(home, "init", "--bare", "--initial-branch=main", remote);
  git(home, "clone", remote, seed);
  git(seed, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(join(seed, "file"), "one\n");
  git(seed, "add", "file"); git(seed, "commit", "-m", "one"); git(seed, "push", "origin", "main");
  const before = git(seed, "rev-parse", "HEAD");
  mkdirSync(join(home, "projects"));
  // Keep injected admission times behind the real runner's terminal clock.
  const at = new Date(Date.now() - 10 * 60_000);
  let clock = at;
  for (const id of ["project-1", "project-2"]) {
    const path = join(home, "projects", id);
    git(home, "clone", remote, path);
    store.saveProject(createProject(id, `Fixture ${id}`, path, { stable: "main", development: "main" }, at,
      { ownership: "managed", remoteUrl: remote }));
  }
  writeFileSync(join(seed, "file"), "two\n");
  git(seed, "commit", "-am", "two"); git(seed, "push", "origin", "main");
  const after = git(seed, "rev-parse", "HEAD");
  const agent = createConfiguredAgent("codex", "codex", "false", [], [], at);
  store.saveConfiguredAgent(agent);
  const role = createGlobalRole("operator", [createRoleAgentBinding(agent)], agent.id, home, at);
  store.createGlobalRoleIfAbsent(role);
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "global", roleName: "operator" }, agent.id, at
  ), { agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: "refresh-test",
    status: "active", policy: "fixed", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, at));
  const control = createJobDefinitionControl(store, home);
  const call = (id, op, fields = {}) => control({ scope: { kind: "global" },
    caller: { scope: "global", role: "operator", nativeSessionId: "refresh-test" }, id, op, ...fields }, clock);
  const define = (id, projectId) => call(id, "define", { title: projectId,
    configuration: { kind: "builtin", action: "project.refresh", projectId, input: {} } });
  assert.throws(() => control({ scope: { kind: "global" }, id: "forbidden", op: "define",
    caller: { scope: "task", taskId: "task-1", role: "leader" }, title: "Forbidden",
    configuration: { kind: "builtin", action: "project.refresh", projectId: "project-1", input: {} }
  }, at), /Operator/);
  define("refresh-one", "project-1"); define("refresh-two", "project-2");
  assert.equal(define("refresh-one", "project-1").revision, 1);
  assert.throws(() => define("duplicate", "project-1"), /already exists: refresh-one/);
  let starts = 0;
  let cancelBeforeStep = false;
  let beforeSpawn = () => {};
  const supervisor = new DurableJobSupervisor({
    store: new FileSchedulerStoreAdapter(store), artifacts: createFileArtifactPort(home),
    authorizeStart: run => authorizeGlobalJobStart(store, run),
    onError: error => { throw error; },
    process: {
      spawnJobRunner(specPath) {
        starts++;
        beforeSpawn();
        if (starts === 2) {
          // The real Controller can adopt ready.json before the domain child
          // reads the Run. Both queued/possible and running/confirmed are live.
          const spec = JSON.parse(readFileSync(specPath, "utf8"));
          store.saveGlobalJobRun(startDurableJob(store.getGlobalJobRun(spec.jobId),
            { pid: 123, startIdentity: "adopted-fixture" }, new Date()));
        }
        if (cancelBeforeStep) writeFileSync(join(specPath, "..", "cancel"), "");
        const result = spawnSync(process.execPath,
          [fileURLToPath(new URL("../../dist/job/jobRunner.js", import.meta.url)), specPath],
          { env, timeout: 10000, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr || String(result.error));
        return JSON.parse(readFileSync(join(specPath, "..", "ready.json"), "utf8"));
      },
      processStartIdentity: () => undefined, isProcessAlive: () => false,
      signalIfOwned: () => assert.fail("synchronous fixture has no live process")
    }
  });
  const run = (id, key) => call(id, "run", { trigger: { source: "manual", key } }).run;
  const dirty = join(home, "projects/project-1/untracked");
  writeFileSync(dirty, "preserve");
  const failed = run("refresh-one", "dirty");
  const clean = run("refresh-two", "clean");
  supervisor.reconcile(new Date()); supervisor.reconcile(new Date());
  assert.equal(store.getGlobalJobRun(failed.id).status, "failed");
  assert.equal(store.getGlobalJobRun(clean.id).status, "succeeded",
    JSON.stringify(call("refresh-two", "logs", { runId: clean.id })));
  assert.equal(readFileSync(dirty, "utf8"), "preserve");
  assert.equal(git(join(home, "projects/project-1"), "rev-parse", "HEAD"), before);
  assert.equal(git(join(home, "projects/project-2"), "rev-parse", "HEAD"), after);
  const log = call("refresh-two", "logs", { runId: clean.id })[0].text;
  const evidence = JSON.parse(log.trim());
  assert.equal(evidence.refresh.fromCommit, before);
  assert.equal(evidence.refresh.toCommit, after);
  assert.deepEqual(evidence.remoteCheck, { status: "verified", commit: after });
  assert.equal(evidence.trigger.key, "clean");
  const business = call("refresh-two", "run-result", { runId: clean.id }).result;
  assert.equal(business.data.refresh.toCommit, after);
  assert.equal(business.evidence[0].sourceRun.runId, clean.id);
  assert.match(business.evidence[0].version, /^[a-f0-9]{64}$/);
  const schedules = createScheduleControl(store, home);
  const schedule = (op, extra = {}) => schedules({ scope: { kind: "global" },
    caller: { scope: "global", role: "operator", nativeSessionId: "refresh-test" },
    id: "periodic-refresh", op, ...extra }, at);
  const due = offset => new Date(at.getTime() + offset * 60_000);
  schedule("create", { jobId: "refresh-two",
    rule: { kind: "interval", everyMs: 60_000, anchor: due(1).toISOString() } });
  writeFileSync(join(seed, "file"), "three\n");
  git(seed, "commit", "-am", "three"); git(seed, "push", "origin", "main");
  const scheduledHead = git(seed, "rev-parse", "HEAD");
  const scheduledRuns = [];
  for (const offset of [5, 6]) {
    reconcileSchedules(store, home, due(offset), error => { throw error; });
    const current = schedule("show").schedule;
    assert.equal(current.nextDue, due(offset + 1).toISOString(), "missed periods coalesce");
    const scheduled = store.getGlobalJobRun(current.lastAttempt.runId);
    assert.equal(scheduled.trigger.source, "schedule");
    assert.equal(scheduled.definitionId, "refresh-two");
    supervisor.reconcile(new Date()); supervisor.reconcile(new Date());
    assert.equal(store.getGlobalJobRun(scheduled.id).status, "succeeded");
    scheduledRuns.push(scheduled.id);
  }
  assert.notEqual(scheduledRuns[0], scheduledRuns[1], "each period creates an independent Run");
  assert.equal(git(join(home, "projects/project-2"), "rev-parse", "HEAD"), scheduledHead);
  assert.equal(schedule("show").lastSuccess.id, scheduledRuns[1]);
  const scheduledCount = call("refresh-two", "runs").length;
  schedule("disable", { expectedRevision: schedule("show").schedule.revision });
  reconcileSchedules(store, home, due(100), error => { throw error; });
  assert.equal(call("refresh-two", "runs").length, scheduledCount, "disabled refresh does not admit");
  clock = new Date();
  const originalTarget = store.getProject("project-2");
  store.saveProject({ ...originalTarget, remoteUrl: seed });
  const rebind = revision => call("refresh-two", "update", { expectedRevision: revision, title: "Rebind",
    configuration: { kind: "builtin", action: "project.refresh", projectId: "project-2", input: {} } });
  rebind(1);
  assert.equal(call("refresh-two", "show").refresh.lastSuccessfulRefresh, null,
    "a new remote binding has no successful refresh observation");
  store.saveProject(originalTarget);
  rebind(2);
  const retired = run("refresh-two", "retired");
  store.saveProject(retireProject(store.getProject("project-2"), "fixture retirement", "operator", new Date()));
  supervisor.reconcile(new Date());
  assert.equal(store.getGlobalJobRun(retired.id).status, "failed");
  assert.equal(starts, 4, "retired target is rejected before spawn");
  assert.equal(call("refresh-two", "show").refresh.lastAttempt.runId, retired.id);
  assert.equal(call("refresh-two", "show").refresh.lastSuccessfulRefresh.runId, scheduledRuns[1]);
  assert.equal(store.listTasks().length, 0);
  call("refresh-one", "update", { expectedRevision: 1, title: "No longer maintenance",
    configuration: { kind: "builtin", action: "system.noop", input: {} } });
  const noop = run("refresh-one", "noop");
  supervisor.reconcile(new Date()); supervisor.reconcile(new Date());
  assert.equal(store.getGlobalJobRun(noop.id).status, "succeeded");
  call("refresh-one", "update", { expectedRevision: 2, title: "Maintenance again",
    configuration: { kind: "builtin", action: "project.refresh", projectId: "project-1", input: {} } });
  assert.equal(call("refresh-one", "show").refresh.lastSuccessfulRefresh, null,
    "a successful noop is not evidence of Project refresh");
  call("refresh-one", "update", { expectedRevision: 3, title: "No longer maintenance",
    configuration: { kind: "builtin", action: "system.noop", input: {} } });
  call("refresh-two", "update", { expectedRevision: 3, title: "Other target",
    configuration: { kind: "builtin", action: "project.refresh", projectId: "project-1", input: {} } });
  assert.equal(call("refresh-two", "show").refresh.lastSuccessfulRefresh, null,
    "a retargeted definition must not display another Project's success");
  assert.equal(call("refresh-two", "runs").length, 4, "old exact evidence remains readable");

  cancelBeforeStep = true;
  clock = new Date();
  const cancelled = run("refresh-two", "cancel-before-step");
  supervisor.reconcile(new Date()); supervisor.reconcile(new Date());
  assert.equal(call("refresh-two", "run-result", { runId: cancelled.id }).result.outcome, "cancelled");
  assert.deepEqual(call("refresh-two", "run-evidence", { runId: cancelled.id }).processResult.steps, []);
  cancelBeforeStep = false;

  // Losing business-result persistence after the Git effect is not a safely
  // retryable business failure, even with a successful process checkpoint.
  rmSync(dirty);
  clock = new Date();
  const lost = control({ scope: { kind: "global" }, caller: { scope: "user" },
    id: "refresh-two", op: "run", trigger: { source: "manual", key: "lost-business-receipt" } }, clock).run;
  supervisor.reconcile(new Date());
  rmSync(join(home, lost.artifactsLocator, "business-result.json"));
  supervisor.reconcile(new Date());
  assert.equal(git(join(home, "projects/project-1"), "rev-parse", "HEAD"), scheduledHead);
  assert.equal(call("refresh-two", "run-evidence", { runId: lost.id }).processResult.outcome, "succeeded");
  assert.equal(call("refresh-two", "run-result", { runId: lost.id }).result.outcome, "unknown-needs-attention");
  assert.equal(call("refresh-two", "run", { trigger: { source: "manual", key: "must-not-replay" } }).reason, "overlap");

  // Revocation after supervisor admission but before the domain child starts
  // is a known no-Git failure, not uncertain effects that fence all later Runs.
  const syncPath = join(home, "projects/project-8");
  git(home, "clone", remote, syncPath);
  store.saveProject(createProject("project-8", "Builtin", syncPath,
    { stable: "main", development: "main" }, at, { ownership: "managed", remoteUrl: remote }));
  reconcileProjectSync(store, at);
  const syncId = "project-sync-project-8";
  const syncControl = (op, fields = {}) => schedules({
    scope: { kind: "global" }, caller: { scope: "user" }, id: syncId, op,
    expectedRevision: store.getSchedule({ kind: "global" }, syncId).revision, ...fields
  }, at);
  syncControl("update", { rule: { kind: "interval", everyMs: 60000, anchor: due(1).toISOString() } });
  reconcileSchedules(store, home, due(1), error => { throw error; });
  const revoked = store.getSchedule({ kind: "global" }, syncId).lastAttempt.runId;
  writeFileSync(join(seed, "file"), "four\n");
  git(seed, "commit", "-am", "four"); git(seed, "push", "origin", "main");
  const resumedHead = git(seed, "rev-parse", "HEAD");
  beforeSpawn = () => syncControl("disable");
  supervisor.reconcile(new Date()); supervisor.reconcile(new Date());
  beforeSpawn = () => {};
  assert.equal(store.getGlobalJobRun(revoked).status, "failed");
  assert.match(call(syncId, "run-result", { runId: revoked }).result.summary, /revoked/);
  assert.equal(git(syncPath, "rev-parse", "HEAD"), scheduledHead, "revoked child did not run Git");
  syncControl("enable");
  reconcileSchedules(store, home, due(2), error => { throw error; });
  const resumed = store.getSchedule({ kind: "global" }, syncId).lastAttempt.runId;
  assert.notEqual(resumed, revoked);
  supervisor.reconcile(new Date()); supervisor.reconcile(new Date());
  assert.equal(store.getGlobalJobRun(resumed).status, "succeeded");
  assert.equal(git(syncPath, "rev-parse", "HEAD"), resumedHead);
  assert.equal(run(syncId, "manual-after-reenable").status, "queued");
  supervisor.reconcile(new Date()); supervisor.reconcile(new Date());

  // No processes are created in this concurrency probe. All artifacts/rows
  // belong to the fixture and are removed by the registered teardown.
  for (let index = 3; index <= 7; index++) {
    const id = `project-${index}`;
    store.saveProject(createProject(id, `Fixture ${id}`, join(home, "projects", id),
      { stable: "main", development: "main" }, at, { ownership: "managed", remoteUrl: remote }));
    define(`refresh-${index}`, id);
    run(`refresh-${index}`, "bounded");
  }
  let admitted = 0;
  const bounded = new DurableJobSupervisor({
    store: new FileSchedulerStoreAdapter(store), artifacts: createFileArtifactPort(home),
    authorizeStart: candidate => authorizeGlobalJobStart(store, candidate),
    onError: error => { throw error; },
    process: { spawnJobRunner: () => ({ pid: 100000 + ++admitted, startIdentity: "fixture" }),
      processStartIdentity: () => "fixture", isProcessAlive: () => true, signalIfOwned: () => {} }
  });
  bounded.reconcile(new Date());
  assert.equal(admitted, 4);
  assert.equal(store.listGlobalJobRuns().filter(candidate =>
    candidate.status === "queued" && candidate.operation.effect === "none").length, 1);
});
