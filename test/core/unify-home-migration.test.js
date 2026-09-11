import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import {
  managedRuntimeRoot,
  managedTaskRoot,
  managedWorktreeRoot,
  storageBackupRoot
} from "../../dist/storage/homeLayout.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import {
  CURRENT_STORAGE_VERSION,
  MIN_SUPPORTED_STORAGE_VERSION
} from "../../dist/storage/storageVersions.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRun, validateRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

const PRIOR_VERSION = CURRENT_STORAGE_VERSION - 1;

const gitEnv = sanitizedTestEnv({
  GIT_AUTHOR_NAME: "Yui Test",
  GIT_AUTHOR_EMAIL: "yui-test@example.com",
  GIT_COMMITTER_NAME: "Yui Test",
  GIT_COMMITTER_EMAIL: "yui-test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null"
});

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
}

/**
 * A Home whose SQLite schema is bootstrapped to the current version, then its
 * migration ledger truncated back to the prior version so the real runner has
 * exactly the 18->19 step pending. Foreign keys are OFF on this raw connection
 * (the store enables them per-connection), so old-layout rows can be seeded
 * without a full domain graph.
 */
function openPriorVersionHome(t, prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // Bootstrap the real schema + singleton rows, then close.
  new SqliteTaskStore(home).close();
  const db = new Database(join(home, "yui.db"));
  t.after(() => db.close());
  db.prepare("DELETE FROM schema_migrations WHERE version > ?").run(PRIOR_VERSION);
  const head = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(head.version, PRIOR_VERSION, "ledger truncated to the prior version");
  return { home, db };
}

/** Point the singleton config at an out-of-Home workspace root. */
function setDefaultWorkspace(db, workspace) {
  const row = db.prepare("SELECT payload FROM config WHERE id = 1").get();
  const config = JSON.parse(row.payload);
  config.defaultWorkspace = workspace;
  db.prepare("UPDATE config SET payload = ? WHERE id = 1").run(JSON.stringify(config));
}

/** Insert the catalog row a task-scoped record needs. */
function seedTask(db, taskId) {
  db.prepare(
    `INSERT OR IGNORE INTO tasks_catalog
       (task_id, status, lifecycle, is_active, created_at, updated_at)
     VALUES (?, 'active', 'active', 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`
  ).run(taskId);
}

/**
 * Build a real managed clone + linked worktree under an out-of-Home workspace,
 * exactly as the preparer lays them out: `<ws>/worktree/<project>/<dir>`.
 * Returns the two absolute paths.
 */
function seedWorktrees(workspace, projectName, mainDir, linkedDir) {
  const remote = join(workspace, "remote.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=master", remote], {
    env: gitEnv
  });
  const container = join(workspace, "worktree", projectName);
  mkdirSync(container, { recursive: true });
  const mainPath = join(container, mainDir);
  execFileSync("git", ["clone", remote, mainPath], { env: gitEnv });
  writeFileSync(join(mainPath, "README.md"), "# managed\n");
  git(["add", "."], mainPath);
  git(["commit", "-m", "managed base"], mainPath);
  git(["push", "origin", "master"], mainPath);
  const linkedPath = join(container, linkedDir);
  git(["worktree", "add", "--detach", linkedPath, "HEAD"], mainPath);
  // An uncommitted edit in the linked worktree must survive the relocation.
  writeFileSync(join(linkedPath, "DIRTY.txt"), "uncommitted\n");
  return { remote, mainPath, linkedPath };
}

function managedWorkspacePayload(owner, root, entries) {
  return {
    schemaVersion: 2,
    owner,
    root,
    entries,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  };
}

function insertManagedWorkspace(db, ownerKind, ownerId, taskId, workspace) {
  db.prepare(
    `INSERT INTO managed_workspaces
       (owner_kind, owner_id, task_id, path, payload, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(
    ownerKind,
    ownerId,
    taskId,
    workspace.root,
    JSON.stringify(workspace),
    workspace.createdAt,
    workspace.updatedAt
  );
}

function projectEntry(projectId, path, directory) {
  return {
    projectId,
    directory,
    access: "write",
    path,
    branch: "yui/task",
    baseRef: "master",
    baseCommit: "0".repeat(40)
  };
}

/** Run the real 18->19 migration through the transaction-wrapping runner. */
function runMigration(db) {
  return migrateSqliteSchema(db, { mode: "apply" });
}

test("storage floor and head bracket the unify-home migration", () => {
  assert.equal(MIN_SUPPORTED_STORAGE_VERSION, 1);
  assert.equal(PRIOR_VERSION + 1, CURRENT_STORAGE_VERSION);
});

test("unify-home relocates managed trees into Home and rewrites live pointers", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-relocate-");
  const workspace = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  setDefaultWorkspace(db, workspace);

  const taskId = "task-1";
  seedTask(db, taskId);
  const { mainPath, linkedPath } = seedWorktrees(
    workspace,
    "app",
    "main-abcd",
    "work-item-1-efgh"
  );

  const oldTaskView = join(workspace, "tasks", taskId, "main");
  const oldWorkItemView = join(workspace, "tasks", taskId, "work-items", "work-item-1");
  mkdirSync(oldTaskView, { recursive: true });
  mkdirSync(oldWorkItemView, { recursive: true });

  // Authoritative registry rows: task main + a work-item worktree.
  insertManagedWorkspace(
    db,
    "task",
    `task:${taskId}`,
    taskId,
    managedWorkspacePayload({ type: "task", taskId }, oldTaskView, [
      projectEntry("app", mainPath, "app")
    ])
  );
  insertManagedWorkspace(
    db,
    "work-item",
    `work-item:${taskId}:work-item-1`,
    taskId,
    managedWorkspacePayload(
      { type: "work-item", taskId, workItemId: "work-item-1" },
      oldWorkItemView,
      [projectEntry("app", linkedPath, "app")]
    )
  );

  // An active AgentRun mirrors the task workspace (live launch pointer) and also
  // carries frozen Git evidence that must be preserved byte-for-byte.
  const frozenSnapshot = {
    root: mainPath,
    entries: [{ projectId: "app", path: mainPath }]
  };
  const activeRun = {
    id: "run-1",
    status: "active",
    workspace: managedWorkspacePayload({ type: "task", taskId }, oldTaskView, [
      projectEntry("app", mainPath, "app")
    ]),
    result: { systemEvidence: { workspaceSnapshot: frozenSnapshot } }
  };
  db.prepare(
    `INSERT INTO turns (task_id, turn_id, role_name, status, payload, updated_at)
     VALUES (?, 'run-1', 'worker', 'active', ?, '2026-09-01T00:00:00.000Z')`
  ).run(taskId, JSON.stringify(activeRun));

  // A terminal AgentRun is frozen evidence: its workspace must not be rewritten.
  const terminalRun = {
    id: "run-0",
    status: "completed",
    workspace: managedWorkspacePayload({ type: "task", taskId }, oldTaskView, [
      projectEntry("app", mainPath, "app")
    ])
  };
  db.prepare(
    `INSERT INTO turns (task_id, turn_id, role_name, status, payload, updated_at)
     VALUES (?, 'run-0', 'worker', 'completed', ?, '2026-09-01T00:00:00.000Z')`
  ).run(taskId, JSON.stringify(terminalRun));

  // A review round whose owner registry row is still live -> rewritten.
  insertManagedWorkspace(
    db,
    "review-round",
    `review-round:${taskId}:review-1`,
    taskId,
    managedWorkspacePayload(
      { type: "review-round", taskId, reviewRoundId: "review-1" },
      join(workspace, "tasks", taskId, "reviews", "review-1"),
      [projectEntry("app", linkedPath, "app")]
    )
  );
  const liveReviewRound = {
    id: "review-1",
    workspace: managedWorkspacePayload(
      { type: "review-round", taskId, reviewRoundId: "review-1" },
      join(workspace, "tasks", taskId, "reviews", "review-1"),
      [projectEntry("app", linkedPath, "app")]
    )
  };
  db.prepare(
    `INSERT INTO review_rounds (task_id, review_round_id, status, payload, updated_at)
     VALUES (?, 'review-1', 'active', ?, '2026-09-01T00:00:00.000Z')`
  ).run(taskId, JSON.stringify(liveReviewRound));

  // A review round with NO registry row -> orphaned frozen evidence, preserved.
  const orphanReviewWorkspace = managedWorkspacePayload(
    { type: "review-round", taskId, reviewRoundId: "review-0" },
    join(workspace, "tasks", taskId, "reviews", "review-0"),
    [projectEntry("app", join(workspace, "worktree", "app", "gone"), "app")]
  );
  db.prepare(
    `INSERT INTO review_rounds (task_id, review_round_id, status, payload, updated_at)
     VALUES (?, 'review-0', 'completed', ?, '2026-09-01T00:00:00.000Z')`
  ).run(taskId, JSON.stringify(orphanReviewWorkspace));

  // A Draft planning Role pointing at the old runtime sibling -> rewritten.
  const planningCwd = join(`${home}.task-runtimes`, "planning", taskId);
  const planningRole = { name: "leader", workspace: planningCwd };
  db.prepare(
    `INSERT INTO task_roles (task_id, role_name, payload, updated_at)
     VALUES (?, 'leader', ?, '2026-09-01T00:00:00.000Z')`
  ).run(taskId, JSON.stringify(planningRole));

  // A Role whose cwd is outside every relocated root -> left as-is.
  const externalRole = { name: "observer", workspace: "/opt/external/cwd" };
  db.prepare(
    `INSERT INTO task_roles (task_id, role_name, payload, updated_at)
     VALUES (?, 'observer', ?, '2026-09-01T00:00:00.000Z')`
  ).run(taskId, JSON.stringify(externalRole));

  // A frozen context snapshot whose payload names the old path must not change.
  const snapshotPayload = JSON.stringify({ note: `ran under ${mainPath}` });
  db.prepare(
    `INSERT INTO context_snapshots
       (task_id, snapshot_id, scope, scope_ref, sequence, digest, payload, frozen_at)
     VALUES (?, 'snap-1', 'task', NULL, 1, ?, ?, '2026-09-01T00:00:00.000Z')`
  ).run(taskId, "a".repeat(64), snapshotPayload);

  // A terminal durable job that recorded where it ran -> frozen, not rewritten,
  // and not treated as in-flight.
  const terminalJob = {
    id: "job-0",
    workspace: linkedPath,
    steps: [{ cwd: linkedPath }]
  };
  db.prepare(
    `INSERT INTO durable_jobs
       (job_id, task_id, status, payload, created_at, updated_at)
     VALUES ('job-0', ?, 'succeeded', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`
  ).run(taskId, JSON.stringify(terminalJob));

  const oldRuntime = `${home}.task-runtimes`;
  mkdirSync(join(oldRuntime, "planning", taskId), { recursive: true });
  writeFileSync(join(oldRuntime, "cache.bin"), "cache\n");

  const result = runMigration(db);
  assert.deepEqual(result.applied, [CURRENT_STORAGE_VERSION]);

  // (1) The durable worktree tree is COPIED into Home; the original is PRESERVED
  // as the rollback anchor. The disposable runtime and the regenerable task views
  // are pointer-only — their trees are never physically moved by the migration.
  const newWorktreeRoot = managedWorktreeRoot(home);
  const newMain = join(newWorktreeRoot, "app", "main-abcd");
  const newLinked = join(newWorktreeRoot, "app", "work-item-1-efgh");
  assert.equal(existsSync(newMain), true, "main clone copied into Home");
  assert.equal(existsSync(newLinked), true, "linked worktree copied into Home");
  assert.equal(
    existsSync(join(workspace, "worktree", "app", "main-abcd")),
    true,
    "original worktree tree preserved as the rollback anchor"
  );
  assert.equal(
    existsSync(managedRuntimeRoot(home)),
    false,
    "runtime is pointer-only: the migration never fabricates the new runtime tree"
  );
  assert.equal(existsSync(oldRuntime), true, "old runtime sibling preserved (pointer-only)");
  assert.equal(
    existsSync(join(workspace, "tasks")),
    true,
    "old task views preserved (pointer-only, rebuilt at next launch)"
  );

  // Uncommitted content survived the move and git worktree repair reconnected it.
  assert.equal(readFileSync(join(newLinked, "DIRTY.txt"), "utf8"), "uncommitted\n");
  assert.equal(
    git(["-C", newLinked, "rev-parse", "--is-inside-work-tree"]),
    "true",
    "relocated linked worktree is a valid git work tree"
  );
  assert.match(
    git(["-C", newLinked, "status", "--porcelain"]),
    /DIRTY\.txt/u,
    "uncommitted edit still tracked as a change after repair"
  );

  // (2) Authoritative registry rewritten (path column + payload.root + entries).
  const taskRow = db
    .prepare("SELECT path, payload FROM managed_workspaces WHERE owner_kind = 'task'")
    .get();
  assert.equal(taskRow.path, join(managedTaskRoot(home), taskId, "main"));
  const taskWorkspace = JSON.parse(taskRow.payload);
  assert.equal(taskWorkspace.root, join(managedTaskRoot(home), taskId, "main"));
  assert.equal(taskWorkspace.entries[0].path, newMain);
  assert.equal(
    taskWorkspace.entries[0].baseCommit,
    "0".repeat(40),
    "untouched entry metadata preserved"
  );

  const workItemRow = db
    .prepare("SELECT payload FROM managed_workspaces WHERE owner_kind = 'work-item'")
    .get();
  assert.equal(JSON.parse(workItemRow.payload).entries[0].path, newLinked);

  // Active run mirror rewritten; frozen systemEvidence untouched.
  const activeRunRow = db
    .prepare("SELECT payload FROM turns WHERE turn_id = 'run-1'")
    .get();
  const migratedRun = JSON.parse(activeRunRow.payload);
  assert.equal(migratedRun.workspace.entries[0].path, newMain);
  assert.deepEqual(
    migratedRun.result.systemEvidence.workspaceSnapshot,
    frozenSnapshot,
    "frozen Git evidence preserved byte-for-byte"
  );

  // Terminal run workspace preserved (frozen).
  const terminalRunRow = db
    .prepare("SELECT payload FROM turns WHERE turn_id = 'run-0'")
    .get();
  assert.equal(
    JSON.parse(terminalRunRow.payload).workspace.entries[0].path,
    mainPath,
    "terminal run workspace is frozen evidence"
  );

  // Live review round rewritten; orphaned review round preserved.
  const liveRoundRow = db
    .prepare("SELECT payload FROM review_rounds WHERE review_round_id = 'review-1'")
    .get();
  assert.equal(JSON.parse(liveRoundRow.payload).workspace.entries[0].path, newLinked);
  const orphanRoundRow = db
    .prepare("SELECT payload FROM review_rounds WHERE review_round_id = 'review-0'")
    .get();
  assert.deepEqual(
    JSON.parse(orphanRoundRow.payload),
    orphanReviewWorkspace,
    "orphaned review round (no live owner) is preserved"
  );

  // Draft planning Role rewritten into the unified runtime root; external left.
  const planningRow = db
    .prepare("SELECT payload FROM task_roles WHERE role_name = 'leader'")
    .get();
  assert.equal(
    JSON.parse(planningRow.payload).workspace,
    join(managedRuntimeRoot(home), "planning", taskId)
  );
  const observerRow = db
    .prepare("SELECT payload FROM task_roles WHERE role_name = 'observer'")
    .get();
  assert.equal(JSON.parse(observerRow.payload).workspace, "/opt/external/cwd");

  // Frozen snapshot payload byte-preserved.
  const snapshotRow = db
    .prepare("SELECT payload FROM context_snapshots WHERE snapshot_id = 'snap-1'")
    .get();
  assert.equal(snapshotRow.payload, snapshotPayload);

  // Recovery manifest finalized with the single worktree relocation completed.
  // Only the durable worktree tree is a physical move; the runtime and task
  // views are pointer-only and are not manifest entries.
  const manifestPath = join(storageBackupRoot(home), "unify-home-migration.json");
  assert.equal(existsSync(manifestPath), true);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.version, CURRENT_STORAGE_VERSION);
  assert.equal(
    manifest.moves.every((move) => move.state === "completed"),
    true,
    "all planned moves recorded completed"
  );
  assert.equal(manifest.moves.length, 1, "only the durable worktree tree is a physical move");
  assert.equal(
    manifest.moves[0].from,
    join(workspace, "worktree"),
    "manifest records the worktree tree as the sole relocation source"
  );
  assert.equal(manifest.moves[0].to, newWorktreeRoot);

  // Ledger advanced to head.
  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, CURRENT_STORAGE_VERSION);
});

test("unify-home refuses when a non-terminal durable Job is under a relocating root", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-refuse-");
  const workspace = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  setDefaultWorkspace(db, workspace);

  const taskId = "task-1";
  seedTask(db, taskId);
  const { mainPath } = seedWorktrees(workspace, "app", "main-abcd", "linked-efgh");

  insertManagedWorkspace(
    db,
    "task",
    `task:${taskId}`,
    taskId,
    managedWorkspacePayload(
      { type: "task", taskId },
      join(workspace, "tasks", taskId, "main"),
      [projectEntry("app", mainPath, "app")]
    )
  );

  // A running Job whose step cwd is under the worktree root about to relocate.
  const runningJob = {
    id: "job-1",
    workspace: mainPath,
    steps: [{ cwd: mainPath }]
  };
  db.prepare(
    `INSERT INTO durable_jobs
       (job_id, task_id, status, payload, created_at, updated_at)
     VALUES ('job-1', ?, 'running', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`
  ).run(taskId, JSON.stringify(runningJob));

  assert.throws(
    () => runMigration(db),
    /queued or running durable Job/u,
    "refuses to relocate a tree a live Job is bound to"
  );

  // Fail-closed: nothing moved, nothing rewritten, ledger unchanged.
  assert.equal(existsSync(join(workspace, "worktree")), true, "trees untouched on refusal");
  assert.equal(existsSync(managedWorktreeRoot(home)), false, "no partial relocation");
  const row = db
    .prepare("SELECT path FROM managed_workspaces WHERE owner_kind = 'task'")
    .get();
  assert.equal(
    row.path,
    join(workspace, "tasks", taskId, "main"),
    "registry pointer unchanged after refusal"
  );
  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, PRIOR_VERSION, "ledger stays at prior version");
  assert.equal(
    existsSync(join(storageBackupRoot(home), "unify-home-migration.json")),
    false,
    "no recovery manifest written on up-front refusal"
  );
});

test("unify-home is idempotent across a repeated upgrade", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-idempotent-");
  const workspace = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  setDefaultWorkspace(db, workspace);

  const taskId = "task-1";
  seedTask(db, taskId);
  const { mainPath } = seedWorktrees(workspace, "app", "main-abcd", "linked-efgh");
  insertManagedWorkspace(
    db,
    "task",
    `task:${taskId}`,
    taskId,
    managedWorkspacePayload(
      { type: "task", taskId },
      join(workspace, "tasks", taskId, "main"),
      [projectEntry("app", mainPath, "app")]
    )
  );

  runMigration(db);
  const afterFirst = db
    .prepare("SELECT path, payload FROM managed_workspaces WHERE owner_kind = 'task'")
    .get();
  const newMain = join(managedWorktreeRoot(home), "app", "main-abcd");
  assert.equal(JSON.parse(afterFirst.payload).entries[0].path, newMain);

  // Simulate a re-run of the same forward migration (as a fenced retry would):
  // drop the ledger row and invoke the data step again. It must be a no-op that
  // neither throws nor corrupts already-migrated pointers.
  db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(CURRENT_STORAGE_VERSION);
  const second = runMigration(db);
  assert.deepEqual(second.applied, [CURRENT_STORAGE_VERSION]);
  const afterSecond = db
    .prepare("SELECT path, payload FROM managed_workspaces WHERE owner_kind = 'task'")
    .get();
  assert.deepEqual(
    JSON.parse(afterSecond.payload),
    JSON.parse(afterFirst.payload),
    "second run leaves the already-rewritten registry unchanged"
  );
  assert.equal(existsSync(newMain), true, "relocated tree still present after re-run");
});

test("unify-home is a no-op on an already-unified Home and writes no manifest", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-noop-");
  // No defaultWorkspace configured and no runtime sibling on disk: nothing to
  // relocate. (The runtime relocation pair still differs by name, so the guard
  // must key off on-disk presence, not the pair list.)
  const result = runMigration(db);
  assert.deepEqual(result.applied, [CURRENT_STORAGE_VERSION]);
  assert.equal(
    existsSync(join(storageBackupRoot(home), "unify-home-migration.json")),
    false,
    "fresh/unified Home leaves no spurious recovery manifest"
  );
  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, CURRENT_STORAGE_VERSION);
});

// ---------------------------------------------------------------------------
// Real-path verification: drive the ACTUAL upgrade orchestrator (backup +
// migrate + post-migration gate + restore-on-failure) and the REAL AgentRun
// constructors, not hand-built payloads. The post-migration gate replays
// `validateRun` over every run, whose cross-field guard requires
// `run.effective.workspace` to stay identical to `run.workspace`. A migration
// that rewrote only one of the two would make the gate throw and the whole
// upgrade roll back — so an `outcome: "upgraded"` here is the load-bearing proof
// that both frozen launch pointers were moved together (criterion 3, Gap 4).
// ---------------------------------------------------------------------------

const RUN_CLOCK = new Date("2026-09-01T00:00:00.000Z");

/** A bootstrapped Home left exactly at the prior version, opened as a live store. */
function openPriorVersionStore(t, prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  return { home, store };
}

/** Truncate the migration ledger back to the prior version on a live store. */
function rewindLedgerToPriorVersion(store) {
  const db = store.databaseHandle();
  db.prepare("DELETE FROM schema_migrations WHERE version > ?").run(PRIOR_VERSION);
  const head = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  assert.equal(head.version, PRIOR_VERSION, "ledger rewound to the prior version");
}

/**
 * Seed, through the real domain constructors and store APIs, an active
 * execution AgentRun that owns a task workspace rooted at an OLD external path.
 * `resolveEffectiveLaunch` derives `effective.workspace` from the same managed
 * workspace, so the persisted run satisfies `validateRun` before the migration
 * and is a faithful subject for the post-migration gate.
 */
function seedActiveRunAtOldWorkspace(store, taskId, oldRoot, oldEntryPath) {
  const task = activateTask(createTask(taskId, "Unify home real path", RUN_CLOCK, {
    cwd: oldRoot
  }), RUN_CLOCK);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(taskId, "worker", [binding], binding.agentId, oldRoot, RUN_CLOCK);
  store.saveRole(taskId, role);
  const workspace = createManagedWorkspace({
    owner: { type: "task", taskId },
    root: oldRoot,
    entries: [{
      projectId: "app",
      directory: "app",
      access: "write",
      path: oldEntryPath,
      branch: "yui/task",
      baseRef: "master",
      baseCommit: "0".repeat(40)
    }]
  }, RUN_CLOCK);
  store.saveManagedWorkspace(workspace);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution", workspace });
  const run = createRun(
    "run-1",
    taskId,
    role.name,
    "new",
    createRunInput({
      source: { type: "yui", channel: "task-dispatch" },
      directive: "Continue the Task.",
      deltaRefIds: []
    }),
    RUN_CLOCK,
    { workspace, effective }
  );
  // The run is legal at the OLD path: both launch pointers agree pre-migration.
  validateRun(run);
  assert.equal(run.effective.workspace.root, oldRoot);
  assert.equal(run.workspace.root, oldRoot);
  store.saveActiveRun(run);
  return { workspace };
}

test("real upgrade path: active run effective+workspace move together and pass the gate", async (t) => {
  const { home, store } = openPriorVersionStore(t, "yui-unify-real-gate-");
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));

  const config = store.getConfig();
  store.saveConfig({ ...config, defaultWorkspace: workspaceRoot });

  const taskId = "task-1";
  const { mainPath } = seedWorktrees(workspaceRoot, "app", "main-abcd", "linked-efgh");
  const oldTaskRoot = join(workspaceRoot, "tasks", taskId, "main");
  seedActiveRunAtOldWorkspace(store, taskId, oldTaskRoot, mainPath);

  // Rewind so the real orchestrator sees exactly the 18->19 step pending, then
  // drive the ACTUAL upgrade (backup + migrate + gate). Close our handle first
  // so the orchestrator opens the database cleanly.
  rewindLedgerToPriorVersion(store);
  store.close();

  const result = await runStorageUpgrade({ home, mode: "execute", now: RUN_CLOCK });
  assert.equal(
    result.outcome,
    "upgraded",
    `post-migration gate passed (validateRun accepted every run): ${JSON.stringify(result)}`
  );

  // Reopen and confirm the persisted run advanced BOTH launch pointers to the new
  // Home path, still mutually consistent (the exact invariant the gate enforces).
  const reopened = new SqliteTaskStore(home);
  t.after(() => reopened.close());
  const migrated = reopened.getRun(taskId, "run-1");
  const newTaskRoot = join(managedTaskRoot(home), taskId, "main");
  const newMain = join(managedWorktreeRoot(home), "app", "main-abcd");
  assert.equal(migrated.effective.workspace.root, newTaskRoot, "effective.workspace root rewritten");
  assert.equal(migrated.workspace.root, newTaskRoot, "workspace root rewritten");
  assert.equal(migrated.effective.workspace.entries[0].path, newMain);
  assert.equal(migrated.workspace.entries[0].path, newMain);
  assert.equal(
    migrated.effective.workspace.root,
    migrated.workspace.root,
    "both launch pointers stay identical after migration"
  );
  assert.deepEqual(
    migrated.effective.workspace.entries,
    migrated.workspace.entries,
    "both launch pointer entries stay identical after migration"
  );
  // A second, independent validateRun mirrors the in-gate check.
  validateRun(migrated);
});

// ---------------------------------------------------------------------------
// Fault injection: the relocation is copy-verify-preserve (Gap 1) behind a
// fail-closed recovery boundary (Gap 2). These drive real, deterministic faults
// — a foreign directory sitting at the target, an interrupted publish, a fatal
// `git worktree repair`, and a corrupt recovery manifest — and assert the
// migration refuses or rolls back WITHOUT destroying the preserved source or
// heuristically repairing over the damage. No real models or shared resources
// are touched: every fixture is a private disposable Home + local Git remote.
// ---------------------------------------------------------------------------

/** The single durable worktree tree the migration copies, old + new roots. */
function worktreeRoots(workspace, home) {
  return {
    oldWorktreeRoot: join(workspace, "worktree"),
    newWorktreeRoot: managedWorktreeRoot(home)
  };
}

test("target conflict: a foreign directory at the relocation target is refused, source untouched", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-conflict-");
  const workspace = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  setDefaultWorkspace(db, workspace);

  const taskId = "task-1";
  seedTask(db, taskId);
  const { mainPath } = seedWorktrees(workspace, "app", "main-abcd", "linked-efgh");
  insertManagedWorkspace(
    db,
    "task",
    `task:${taskId}`,
    taskId,
    managedWorkspacePayload({ type: "task", taskId }, join(workspace, "tasks", taskId, "main"), [
      projectEntry("app", mainPath, "app")
    ])
  );

  // Plant a FOREIGN directory exactly at the relocation target. It is not a
  // completed manifest entry and its content differs from the source, so the
  // migration must refuse rather than overwrite or adopt it.
  const { oldWorktreeRoot, newWorktreeRoot } = worktreeRoots(workspace, home);
  mkdirSync(newWorktreeRoot, { recursive: true });
  writeFileSync(join(newWorktreeRoot, "SOMEONE-ELSES-FILE.txt"), "not ours\n");

  assert.throws(
    () => runMigration(db),
    /relocation target already exists and does not match the source content/u,
    "refuses to publish over a foreign directory at the target"
  );

  // Source preserved byte-for-byte; foreign target left exactly as planted.
  assert.equal(existsSync(join(oldWorktreeRoot, "app", "main-abcd")), true, "source clone untouched");
  assert.equal(
    readFileSync(join(mainPath, "README.md"), "utf8"),
    "# managed\n",
    "source content intact after refusal"
  );
  assert.equal(
    readFileSync(join(newWorktreeRoot, "SOMEONE-ELSES-FILE.txt"), "utf8"),
    "not ours\n",
    "foreign target left as-is, not clobbered"
  );
  // Fail-closed: ledger stays at the prior version, pointer unchanged.
  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, PRIOR_VERSION, "ledger stays at prior version on conflict");
  const row = db
    .prepare("SELECT path FROM managed_workspaces WHERE owner_kind = 'task'")
    .get();
  assert.equal(row.path, join(workspace, "tasks", taskId, "main"), "registry pointer unchanged");
});

test("interrupted publish: an identical target left by a crash is adopted, not re-copied or refused", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-adopt-");
  const workspace = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  setDefaultWorkspace(db, workspace);

  const taskId = "task-1";
  seedTask(db, taskId);
  const { mainPath } = seedWorktrees(workspace, "app", "main-abcd", "linked-efgh");
  insertManagedWorkspace(
    db,
    "task",
    `task:${taskId}`,
    taskId,
    managedWorkspacePayload({ type: "task", taskId }, join(workspace, "tasks", taskId, "main"), [
      projectEntry("app", mainPath, "app")
    ])
  );

  // Simulate a crash AFTER the atomic publish but BEFORE the manifest recorded
  // completion: an identical copy of the source tree is already at the target,
  // and no recovery manifest exists. The migration must recognise the byte-for
  // -byte match by digest and ADOPT it (idempotent), never re-copy or refuse.
  const { oldWorktreeRoot, newWorktreeRoot } = worktreeRoots(workspace, home);
  mkdirSync(dirname(newWorktreeRoot), { recursive: true });
  cpSync(oldWorktreeRoot, newWorktreeRoot, { recursive: true, verbatimSymlinks: true });
  assert.equal(
    existsSync(join(home, "backups", "unify-home-migration.json")),
    false,
    "precondition: no manifest yet (crash before the record)"
  );

  const result = runMigration(db);
  assert.deepEqual(result.applied, [CURRENT_STORAGE_VERSION], "adopts the identical target and completes");

  // No `.incoming` staging left behind: an adoption does not re-copy.
  assert.equal(existsSync(`${newWorktreeRoot}.incoming`), false, "no staging dir: target adopted, not re-copied");
  assert.equal(existsSync(join(newWorktreeRoot, "app", "main-abcd")), true, "adopted target present");
  assert.equal(existsSync(join(oldWorktreeRoot, "app", "main-abcd")), true, "source still preserved");
  // Manifest finalized recording the adopted move as completed.
  const manifest = JSON.parse(
    readFileSync(join(home, "backups", "unify-home-migration.json"), "utf8")
  );
  assert.equal(manifest.moves.length, 1);
  assert.equal(manifest.moves[0].state, "completed", "adopted move recorded completed");
  // Pointer rewritten to the adopted target.
  const row = db
    .prepare("SELECT payload FROM managed_workspaces WHERE owner_kind = 'task'")
    .get();
  assert.equal(
    JSON.parse(row.payload).entries[0].path,
    join(newWorktreeRoot, "app", "main-abcd"),
    "pointer rewritten to the adopted target"
  );
});

test("interrupted copy: a stale .incoming staging dir is discarded and re-copied cleanly", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-staging-");
  const workspace = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  setDefaultWorkspace(db, workspace);

  const taskId = "task-1";
  seedTask(db, taskId);
  const { mainPath } = seedWorktrees(workspace, "app", "main-abcd", "linked-efgh");
  insertManagedWorkspace(
    db,
    "task",
    `task:${taskId}`,
    taskId,
    managedWorkspacePayload({ type: "task", taskId }, join(workspace, "tasks", taskId, "main"), [
      projectEntry("app", mainPath, "app")
    ])
  );

  // Simulate a crash DURING the copy: a partial, corrupt `.incoming` staging
  // directory is left next to the (never-published) target. The migration must
  // discard the stale staging and re-copy from the preserved source, not adopt
  // the partial content.
  const { oldWorktreeRoot, newWorktreeRoot } = worktreeRoots(workspace, home);
  const staging = `${newWorktreeRoot}.incoming`;
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "PARTIAL-GARBAGE.txt"), "half a copy\n");

  const result = runMigration(db);
  assert.deepEqual(result.applied, [CURRENT_STORAGE_VERSION], "recovers by re-copying from source");

  assert.equal(existsSync(staging), false, "stale staging discarded");
  assert.equal(
    existsSync(join(newWorktreeRoot, "PARTIAL-GARBAGE.txt")),
    false,
    "partial garbage never published to the target"
  );
  assert.equal(existsSync(join(newWorktreeRoot, "app", "main-abcd")), true, "clean re-copy published");
  assert.equal(existsSync(join(oldWorktreeRoot, "app", "main-abcd")), true, "source preserved throughout");
});

test("fatal repair: an unrepairable worktree aborts the migration and rolls the ledger back", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-repairfail-");
  const workspace = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  setDefaultWorkspace(db, workspace);

  const taskId = "task-1";
  seedTask(db, taskId);
  // A "main" clone whose directory is NOT a git repository: `git worktree
  // repair` run from it exits 128 (fatal). This is the deterministic stand-in
  // for a worktree whose administrative links cannot be reconnected after the
  // move — a real integrity failure the migration must treat as fatal.
  const container = join(workspace, "worktree", "app");
  const brokenMain = join(container, "main-abcd");
  mkdirSync(brokenMain, { recursive: true });
  writeFileSync(join(brokenMain, "content.txt"), "durable but not a git repo\n");
  insertManagedWorkspace(
    db,
    "task",
    `task:${taskId}`,
    taskId,
    managedWorkspacePayload({ type: "task", taskId }, join(workspace, "tasks", taskId, "main"), [
      projectEntry("app", brokenMain, "app")
    ])
  );

  assert.throws(
    () => runMigration(db),
    /worktree repair|Command failed|git/u,
    "a fatal repair aborts the migration"
  );

  // Rolled back: ledger at prior version, live pointer unchanged, source intact.
  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, PRIOR_VERSION, "ledger rolled back to prior version");
  const row = db
    .prepare("SELECT path FROM managed_workspaces WHERE owner_kind = 'task'")
    .get();
  assert.equal(
    row.path,
    join(workspace, "tasks", taskId, "main"),
    "registry pointer NOT advanced over an unrepaired worktree"
  );
  assert.equal(
    readFileSync(join(brokenMain, "content.txt"), "utf8"),
    "durable but not a git repo\n",
    "source content preserved after the abort"
  );
});

test("corrupt manifest: an unparseable recovery record is refused fail-closed", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-badmanifest-");
  const workspace = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  setDefaultWorkspace(db, workspace);

  const taskId = "task-1";
  seedTask(db, taskId);
  const { mainPath } = seedWorktrees(workspace, "app", "main-abcd", "linked-efgh");
  insertManagedWorkspace(
    db,
    "task",
    `task:${taskId}`,
    taskId,
    managedWorkspacePayload({ type: "task", taskId }, join(workspace, "tasks", taskId, "main"), [
      projectEntry("app", mainPath, "app")
    ])
  );

  // A recovery manifest already on disk that is not valid JSON: the migration
  // must refuse rather than guess at what a prior interrupted run did.
  const manifestPath = join(home, "backups", "unify-home-migration.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, "{ this is not valid json");

  assert.throws(
    () => runMigration(db),
    /recovery manifest at .* is not valid JSON/u,
    "unparseable manifest is refused fail-closed"
  );
  // Nothing published, ledger unchanged, source intact.
  const { newWorktreeRoot } = worktreeRoots(workspace, home);
  assert.equal(existsSync(join(newWorktreeRoot, "app", "main-abcd")), false, "nothing published");
  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, PRIOR_VERSION, "ledger stays at prior version");

  // A structurally wrong manifest (valid JSON, wrong shape) is likewise refused.
  writeFileSync(manifestPath, JSON.stringify({ version: 7, moves: "nope" }));
  assert.throws(
    () => runMigration(db),
    /recovery manifest at .* is not a recognised storage-19 record/u,
    "wrong-shape manifest is refused fail-closed"
  );
});
