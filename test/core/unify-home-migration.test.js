import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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
import { preflightUnifyHomeLayout } from "../../dist/storage/migrations/unifyHomeLayout.js";
import {
  createSessionOwnerIdentity,
  readLinuxProcessIdentity
} from "../../dist/runtime/sessionOwnerIdentity.js";
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

// ---------------------------------------------------------------------------
// P1 — in-flight execution write-safety. The upgrade fence quiesces the
// Controller's in-process loops, but a Provider/Agent Host runs DETACHED and
// survives that fence. Before copying a durable tree, the migration proves from
// the enumerable session-owner registry (concrete OS process custody) that no
// LIVE execution is bound under a relocating root; a live owner whose
// write-safety cannot be positively established is a fail-closed blocker.
//
// These fixtures use ONLY this test process's own /proc identity — never a real
// Agent, model, or shared resource. `process.pid` with its genuine start
// identity is unambiguously live; the same pid with a mismatched start identity
// exercises the PID-reuse-safe "not live" branch without racing a real spawn.
// ---------------------------------------------------------------------------

/** Absolute path of the session-owner custody directory inside a Home. */
function sessionOwnerDir(home) {
  return join(home, "runtime", "session-owners");
}

/** Persist one session-owner custody record exactly as the runtime writes it. */
function writeSessionOwnerRecord(home, record) {
  const dir = sessionOwnerDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${record.providerRoot.pid}-${record.providerRoot.startIdentity}.json`;
  writeFileSync(join(dir, name), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return join(dir, name);
}

/**
 * A validated session-owner record for this very test process, whose
 * `runtimeRoot` is placed under the OLD provider-runtime sibling that the
 * migration relocates. Because the pid is genuinely live and its runtime root
 * overlaps a relocating root, the migration must refuse.
 */
function liveSelfOwnerUnderOldRuntime(home, runtimeRoot) {
  const identity = readLinuxProcessIdentity(process.pid);
  assert.ok(identity !== undefined, "this platform exposes /proc for the test process");
  return createSessionOwnerIdentity({
    owner: { scope: "task", taskId: "task-1", roleName: "worker" },
    agentId: "codex",
    adapterId: "codex",
    tmux: {
      serverName: "yui",
      socketPath: "/tmp/yui.sock",
      sessionName: "s",
      windowName: "w"
    },
    providerRoot: {
      pid: process.pid,
      startIdentity: identity.startIdentity,
      ...(identity.processGroupId === undefined ? {} : { processGroupId: identity.processGroupId }),
      attribution: "pane-pid"
    },
    runtimeRoot,
    recordedAt: new Date()
  });
}

test("P1: a live execution with a runtime root under a relocating root refuses the migration", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-p1-live-");
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

  // A LIVE owner (this process) whose runtime root sits under the OLD provider
  // runtime sibling that the migration rewrites: an in-flight write overlap.
  const oldRuntime = `${home}.task-runtimes`;
  writeSessionOwnerRecord(
    home,
    liveSelfOwnerUnderOldRuntime(home, join(oldRuntime, "task-1", "data"))
  );

  // The read-only preflight reports the blocker with the stable machine tag...
  const preflight = preflightUnifyHomeLayout(db);
  assert.equal(preflight.noop, false);
  const liveBlockers = preflight.blockers.filter((b) => b.reason === "live-execution");
  assert.equal(liveBlockers.length, 1, "exactly one live-execution blocker surfaced");
  assert.match(
    liveBlockers[0].detail,
    new RegExp(`pid ${process.pid}`, "u"),
    "blocker names the offending live pid"
  );
  assert.match(liveBlockers[0].detail, /live runtime root/u);

  // ...and execute refuses fail-closed with the operator-facing message.
  assert.throws(
    () => runMigration(db),
    /a live Agent execution is still bound to a managed tree under relocation/u,
    "execute refuses while a live execution overlaps a relocating root"
  );

  // Nothing moved, ledger unchanged, pointer intact.
  assert.equal(existsSync(managedWorktreeRoot(home)), false, "no relocation on refusal");
  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, PRIOR_VERSION, "ledger stays at prior version");
  const row = db
    .prepare("SELECT path FROM managed_workspaces WHERE owner_kind = 'task'")
    .get();
  assert.equal(row.path, join(workspace, "tasks", taskId, "main"), "pointer unchanged");
});

test("P1: a dead/PID-reused owner record does not block the migration", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-p1-dead-");
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

  // A record for THIS pid but a deliberately wrong start identity: the
  // PID-reuse-safe liveness check reads /proc, sees the identity mismatch, and
  // treats the recorded process as ABSENT (its record is stale). Even though its
  // runtimeRoot overlaps a relocating root, a dead owner cannot write, so it is
  // not a blocker.
  const identity = readLinuxProcessIdentity(process.pid);
  assert.ok(identity !== undefined);
  const staleStart = String((Number(identity.startIdentity) || 1) + 1);
  const oldRuntime = `${home}.task-runtimes`;
  writeSessionOwnerRecord(home, createSessionOwnerIdentity({
    owner: { scope: "global", roleName: "leader" },
    agentId: "codex",
    adapterId: "codex",
    tmux: { serverName: "yui", socketPath: "/tmp/yui.sock", sessionName: "s", windowName: "w" },
    providerRoot: { pid: process.pid, startIdentity: staleStart, attribution: "pane-pid" },
    runtimeRoot: join(oldRuntime, "planning", taskId),
    recordedAt: new Date()
  }));

  const preflight = preflightUnifyHomeLayout(db);
  assert.equal(
    preflight.blockers.filter((b) => b.reason === "live-execution").length,
    0,
    "a dead/reused-pid owner is not a live-execution blocker"
  );

  const result = runMigration(db);
  assert.deepEqual(result.applied, [CURRENT_STORAGE_VERSION], "migration proceeds past a stale owner");
  assert.equal(existsSync(managedWorktreeRoot(home)), true, "relocation completed");
});

test("P1: a malformed session-owner record is a fail-closed registry-unreadable blocker", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-p1-malformed-");
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

  // A record whose provider-root identity is absent cannot rule a live execution
  // in or out: it must be treated as an unreadable custody signal (fail-closed),
  // never silently as "no live writer".
  const dir = sessionOwnerDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "broken.json"), JSON.stringify({ providerRoot: { pid: "nope" } }));

  const preflight = preflightUnifyHomeLayout(db);
  const unreadable = preflight.blockers.filter((b) => b.reason === "registry-unreadable");
  assert.equal(unreadable.length, 1, "one registry-unreadable blocker");
  assert.match(unreadable[0].detail, /no valid provider-root identity/u);

  assert.throws(
    () => runMigration(db),
    /a live Agent execution is still bound to a managed tree under relocation/u,
    "execute refuses fail-closed on an unreadable custody record"
  );
  assert.equal(existsSync(managedWorktreeRoot(home)), false, "no relocation on fail-closed refusal");
});

// ---------------------------------------------------------------------------
// P2 — a genuine, pre-checkable readiness signal. `yui upgrade --dry-run` and
// the updater's `--update-preflight` must reflect the SAME decisions the apply
// transaction would make (in-flight risk, target conflicts, corrupt manifest),
// not merely list schema steps. These drive the ACTUAL orchestrator entry point
// through both modes and assert the updater-facing contract shape.
// ---------------------------------------------------------------------------

test("P2: a clean migrating Home reports migration-ready with the unify step (update-preflight)", async (t) => {
  const { home, store } = openPriorVersionStore(t, "yui-unify-p2-ready-");
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  store.saveConfig({ ...store.getConfig(), defaultWorkspace: workspaceRoot });

  const taskId = "task-1";
  seedWorktrees(workspaceRoot, "app", "main-abcd", "linked-efgh");
  rewindLedgerToPriorVersion(store);
  store.close();

  const preflight = await runStorageUpgrade({ home, mode: "update-preflight", now: RUN_CLOCK });
  assert.equal(preflight.outcome, "update-preflight");
  assert.equal(preflight.status, "migration-ready");
  // The updater contract: stepCount must equal steps.length, and every step is a
  // proper single-version-forward migration step.
  assert.equal(preflight.stepCount, preflight.steps.length, "stepCount matches steps length");
  const unifyStep = preflight.steps.find((s) => s.name === "unify-home-layout");
  assert.ok(unifyStep !== undefined, "the unify-home-layout step is planned");
  assert.equal(unifyStep.toVersion, CURRENT_STORAGE_VERSION);
  assert.equal(unifyStep.fromVersion, PRIOR_VERSION);
  assert.equal(unifyStep.toVersion, unifyStep.fromVersion + 1, "single forward step");
});

test("P2: dry-run and update-preflight surface the same blockers as execute {reason,detail}", async (t) => {
  const { home, store } = openPriorVersionStore(t, "yui-unify-p2-blocked-");
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  store.saveConfig({ ...store.getConfig(), defaultWorkspace: workspaceRoot });

  seedWorktrees(workspaceRoot, "app", "main-abcd", "linked-efgh");

  // Plant a FOREIGN directory at the relocation target (differs from the source):
  // a real target conflict the preflight must detect WITHOUT touching the store.
  const newWorktreeRoot = managedWorktreeRoot(home);
  mkdirSync(newWorktreeRoot, { recursive: true });
  writeFileSync(join(newWorktreeRoot, "SOMEONE-ELSES-FILE.txt"), "not ours\n");

  rewindLedgerToPriorVersion(store);
  store.close();

  for (const mode of ["update-preflight", "dry-run"]) {
    const result = await runStorageUpgrade({ home, mode, now: RUN_CLOCK });
    assert.equal(result.outcome, "blocked", `${mode} is blocked by the target conflict`);
    assert.equal(result.stage, "in-flight");
    assert.equal(result.sceneUnchanged, true, `${mode} leaves the scene unchanged`);
    assert.ok(Array.isArray(result.blockers) && result.blockers.length >= 1, `${mode} carries blockers`);
    // Updater-compatible blocker shape: non-empty string reason, string detail.
    for (const blocker of result.blockers) {
      assert.equal(typeof blocker.reason, "string");
      assert.ok(blocker.reason.length > 0, "reason is a non-empty machine tag");
      assert.equal(typeof blocker.detail, "string");
      assert.ok(blocker.detail.length > 0, "detail is operator-facing text");
    }
    assert.ok(
      result.blockers.some((b) => b.reason === "target-conflict"),
      `${mode} reports the target-conflict reason`
    );
    assert.match(result.message, /not safe to relocate/u, `${mode} message explains the refusal`);
  }

  // The authoritative store was never advanced or mutated by the read-only checks.
  // (Open a raw connection: the typed store refuses a still-migratable Home.)
  const raw = new Database(join(home, "yui.db"), { readonly: true, fileMustExist: true });
  t.after(() => raw.close());
  const head = raw
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(head.version, PRIOR_VERSION, "preflight did not advance the ledger");
  assert.equal(
    readFileSync(join(newWorktreeRoot, "SOMEONE-ELSES-FILE.txt"), "utf8"),
    "not ours\n",
    "preflight did not touch the conflicting target"
  );
});

test("P2: an already-current Home reports already-current at the updater contract shape", async (t) => {
  // A fully bootstrapped Home is already at the head version: update-preflight
  // must report already-current with zero steps (stepCount === steps.length).
  const home = mkdtempSync(join(tmpdir(), "yui-unify-p2-current-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  new SqliteTaskStore(home).close();

  const preflight = await runStorageUpgrade({ home, mode: "update-preflight", now: RUN_CLOCK });
  assert.equal(preflight.outcome, "update-preflight");
  assert.equal(preflight.status, "already-current");
  assert.equal(preflight.stepCount, 0);
  assert.equal(preflight.steps.length, 0);
  assert.equal(preflight.stepCount, preflight.steps.length);
});

// ---------------------------------------------------------------------------
// P4 — the preserved OLD source keeps a fully independent, working Git. The
// migration copies the durable worktree tree verbatim, PRE-REWRITES the copy's
// cross-reference pointers OLD->NEW, and only then runs `git worktree repair`,
// so no native git command can chase a stale absolute pointer back into the OLD
// tree and mutate it. This test proves that empirically with a private
// disposable Git fixture: the OLD `.git` administrative content is byte-for-byte
// identical before and after the migration, and the OLD tree still reads HEAD,
// index, and status even after the NEW copy is hidden.
// ---------------------------------------------------------------------------

/**
 * A byte-content digest of a directory tree restricted to a `.git` administrative
 * area. Every regular file's relative path, size, and bytes are hashed in a
 * deterministic order, so any mutation `git worktree repair` might make to the
 * OLD source's `.git` files would change this digest. (We digest the OLD source
 * whole, including its pointer files — the point of P4 is that NOTHING in the OLD
 * tree changes, not even a pointer.)
 */
function gitAdminDigest(root) {
  const hash = createHash("sha256");
  const walk = (dir, rel) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        hash.update(`L ${relPath}\0${readlinkSync(abs)}\0`);
      } else if (stat.isDirectory()) {
        hash.update(`D ${relPath}\0`);
        walk(abs, relPath);
      } else if (stat.isFile()) {
        hash.update(`F ${relPath}\0${stat.size}\0`);
        hash.update(readFileSync(abs));
        hash.update("\0");
      } else {
        hash.update(`O ${relPath}\0`);
      }
    }
  };
  walk(root, "");
  return hash.digest("hex");
}

/** Digest the `.git` of a main clone (a directory) and a linked worktree (a file). */
function gitPointerState(mainPath, linkedPath) {
  return {
    mainGitDir: gitAdminDigest(join(mainPath, ".git")),
    // A linked worktree's `.git` is a stub FILE; capture its exact bytes.
    linkedGitFile: readFileSync(join(linkedPath, ".git"), "utf8"),
    // The main clone's back-pointer to the linked worktree.
    backPointer: (() => {
      const worktreesDir = join(mainPath, ".git", "worktrees");
      const names = existsSync(worktreesDir) ? readdirSync(worktreesDir) : [];
      return names.map((name) => ({
        name,
        gitdir: readFileSync(join(worktreesDir, name, "gitdir"), "utf8")
      }));
    })()
  };
}

test("P4: the preserved source keeps an independent, working Git after the migration", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-p4-git-");
  const workspace = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  setDefaultWorkspace(db, workspace);

  const taskId = "task-1";
  seedTask(db, taskId);
  const { mainPath, linkedPath } = seedWorktrees(workspace, "app", "main-abcd", "work-item-1-efgh");
  insertManagedWorkspace(
    db,
    "task",
    `task:${taskId}`,
    taskId,
    managedWorkspacePayload({ type: "task", taskId }, join(workspace, "tasks", taskId, "main"), [
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
      join(workspace, "tasks", taskId, "work-items", "work-item-1"),
      [projectEntry("app", linkedPath, "app")]
    )
  );

  // Capture the OLD source's full Git administrative state BEFORE the migration.
  const beforeMain = gitAdminDigest(join(mainPath, ".git"));
  const beforePointers = gitPointerState(mainPath, linkedPath);
  const beforeHead = git(["-C", mainPath, "rev-parse", "HEAD"]);

  const result = runMigration(db);
  assert.deepEqual(result.applied, [CURRENT_STORAGE_VERSION]);

  // The NEW copy exists and is a valid, repaired worktree pair.
  const newMain = join(managedWorktreeRoot(home), "app", "main-abcd");
  const newLinked = join(managedWorktreeRoot(home), "app", "work-item-1-efgh");
  assert.equal(existsSync(newMain), true, "main clone copied into Home");
  assert.equal(
    git(["-C", newLinked, "rev-parse", "--is-inside-work-tree"]),
    "true",
    "relocated linked worktree is valid"
  );

  // (1) The OLD source's `.git` is byte-for-byte UNCHANGED — repair never chased
  // a pointer back into it.
  assert.equal(
    gitAdminDigest(join(mainPath, ".git")),
    beforeMain,
    "OLD main clone .git is byte-for-byte unchanged after the migration"
  );
  const afterPointers = gitPointerState(mainPath, linkedPath);
  assert.deepEqual(
    afterPointers,
    beforePointers,
    "OLD cross-reference pointers (linked .git stub + main back-pointer) unchanged"
  );

  // (2) The OLD tree is fully independent: hide the NEW copy entirely, then prove
  // the OLD worktrees still read HEAD, index, and status without it.
  const hidden = `${managedWorktreeRoot(home)}.hidden`;
  renameSync(managedWorktreeRoot(home), hidden);
  t.after(() => rmSync(hidden, { recursive: true, force: true }));

  assert.equal(
    git(["-C", mainPath, "rev-parse", "HEAD"]),
    beforeHead,
    "OLD main clone still resolves HEAD with the NEW copy gone"
  );
  // The linked worktree still reads its index/status and sees its uncommitted edit.
  assert.equal(
    git(["-C", linkedPath, "rev-parse", "--is-inside-work-tree"]),
    "true",
    "OLD linked worktree still a valid work tree with the NEW copy gone"
  );
  assert.match(
    git(["-C", linkedPath, "status", "--porcelain"]),
    /DIRTY\.txt/u,
    "OLD linked worktree still reports its uncommitted edit"
  );
});

// ---------------------------------------------------------------------------
// P5 — trustworthy recovery/adoption verification. A `completed` manifest flag
// is only ever honoured after the record's identity is bound to the current plan
// AND the published tree is re-verified against the preserved source; a
// source-less target is refused rather than heuristically adopted. These drive
// the ACTUAL failure paths with private disposable fixtures.
//
// The recovery manifest version is FROZEN at 19 (the storage-19 migration), so
// these hand-authored manifests use the literal the migration recognises.
// ---------------------------------------------------------------------------

const RECOVERY_MANIFEST_VERSION = 19;

/** Write a recovery manifest at the canonical path inside a Home. */
function writeRecoveryManifest(home, manifest) {
  const manifestPath = join(home, "backups", "unify-home-migration.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifestPath;
}

test("P5: a completed target whose durable content diverged from the source is refused", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-p5-diverged-");
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

  // Publish a copy at the target, then corrupt a DURABLE (non-pointer) file so
  // its repair-invariant digest no longer matches the preserved source.
  const { oldWorktreeRoot, newWorktreeRoot } = worktreeRoots(workspace, home);
  mkdirSync(dirname(newWorktreeRoot), { recursive: true });
  cpSync(oldWorktreeRoot, newWorktreeRoot, { recursive: true, verbatimSymlinks: true });
  writeFileSync(
    join(newWorktreeRoot, "app", "main-abcd", "README.md"),
    "# tampered durable content\n"
  );

  // A manifest that correctly identifies this migration and records the move
  // COMPLETED: identity passes, so the completed-skip re-verification runs and
  // must catch the durable-content divergence.
  writeRecoveryManifest(home, {
    version: RECOVERY_MANIFEST_VERSION,
    startedAt: "2026-09-01T00:00:00.000Z",
    home,
    moves: [{ from: oldWorktreeRoot, to: newWorktreeRoot, state: "completed" }]
  });

  assert.throws(
    () => runMigration(db),
    /recorded complete but its durable content no longer matches the preserved source/u,
    "a completed target that diverged from the source is refused, not blindly skipped"
  );
  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, PRIOR_VERSION, "ledger stays at prior version");
});

test("P5: a source-less target with no completed record is refused, never heuristically adopted", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-p5-sourceless-");
  const workspace = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  // Point config at a workspace whose worktree tree does NOT exist (source-less).
  setDefaultWorkspace(db, workspace);

  const taskId = "task-1";
  seedTask(db, taskId);
  insertManagedWorkspace(
    db,
    "task",
    `task:${taskId}`,
    taskId,
    managedWorkspacePayload({ type: "task", taskId }, join(workspace, "tasks", taskId, "main"), [
      projectEntry("app", join(workspace, "worktree", "app", "main-abcd"), "app")
    ])
  );

  // A target directory exists at the relocation destination, but the source was
  // removed and NO manifest records this move completed. The migration cannot
  // prove the target is Yui's, so it must refuse rather than adopt it.
  const { oldWorktreeRoot, newWorktreeRoot } = worktreeRoots(workspace, home);
  assert.equal(existsSync(oldWorktreeRoot), false, "precondition: no source tree");
  mkdirSync(join(newWorktreeRoot, "app", "main-abcd"), { recursive: true });
  writeFileSync(join(newWorktreeRoot, "app", "main-abcd", "content.txt"), "unknown provenance\n");

  // A valid, plan-matching manifest that records the move as PLANNED (not
  // completed) is present so the relocation branch runs at all.
  writeRecoveryManifest(home, {
    version: RECOVERY_MANIFEST_VERSION,
    startedAt: "2026-09-01T00:00:00.000Z",
    home,
    moves: [{ from: oldWorktreeRoot, to: newWorktreeRoot, state: "planned" }]
  });

  assert.throws(
    () => runMigration(db),
    /the source tree .* is missing and the target .* is not recorded as a completed relocation/u,
    "a source-less, non-completed target is refused"
  );
  assert.equal(
    readFileSync(join(newWorktreeRoot, "app", "main-abcd", "content.txt"), "utf8"),
    "unknown provenance\n",
    "the unverifiable target is left untouched"
  );
});

test("P5: a recovery manifest for a different Home is refused as an identity mismatch", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-p5-identity-");
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

  const { oldWorktreeRoot, newWorktreeRoot } = worktreeRoots(workspace, home);

  // (a) Wrong Home: a structurally valid manifest that records a DIFFERENT home.
  writeRecoveryManifest(home, {
    version: RECOVERY_MANIFEST_VERSION,
    startedAt: "2026-09-01T00:00:00.000Z",
    home: "/some/other/home",
    moves: [{ from: oldWorktreeRoot, to: newWorktreeRoot, state: "completed" }]
  });
  assert.throws(
    () => runMigration(db),
    /does not match the migration now planned \(it records Home \/some\/other\/home/u,
    "a manifest for a different Home is refused"
  );

  // (b) Extra unplanned relocation: identity binding rejects a foreign move set.
  writeRecoveryManifest(home, {
    version: RECOVERY_MANIFEST_VERSION,
    startedAt: "2026-09-01T00:00:00.000Z",
    home,
    moves: [
      { from: oldWorktreeRoot, to: newWorktreeRoot, state: "completed" },
      { from: "/foreign/src", to: "/foreign/dst", state: "completed" }
    ]
  });
  assert.throws(
    () => runMigration(db),
    /does not match the migration now planned \(it records an unplanned relocation to \/foreign\/dst/u,
    "a manifest with an unplanned relocation is refused"
  );

  // (c) Wrong source for the planned target: the mapping is rejected.
  writeRecoveryManifest(home, {
    version: RECOVERY_MANIFEST_VERSION,
    startedAt: "2026-09-01T00:00:00.000Z",
    home,
    moves: [{ from: "/wrong/source", to: newWorktreeRoot, state: "completed" }]
  });
  assert.throws(
    () => runMigration(db),
    /does not match the migration now planned \(it maps .* from \/wrong\/source/u,
    "a manifest mapping the target from the wrong source is refused"
  );

  // Fail-closed throughout: nothing published, ledger unchanged.
  assert.equal(existsSync(join(newWorktreeRoot, "app", "main-abcd")), false, "nothing published");
  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, PRIOR_VERSION, "ledger stays at prior version");
});

// ---------------------------------------------------------------------------
// Preflight/execute lockstep: a published target that git has already RELINKED
// (its `.git` stub and `worktrees/<name>/gitdir` back-pointer repointed to the
// new location by an interrupted publish's repair) holds identical DURABLE
// content but different pointer bytes. Execute adopts it via the repair-invariant
// digest; the read-only preflight must reach the SAME verdict — reporting NO
// target-conflict — or a dry-run/update-preflight would falsely block a Home the
// apply transaction would cleanly complete. This guards the run-4 reconciliation
// that switched collectRelocationConflicts to the repair-invariant digest.
// ---------------------------------------------------------------------------

test("preflight adopts a relinked interrupted-publish target (no false target-conflict)", (t) => {
  const { home, db } = openPriorVersionHome(t, "yui-unify-relink-lockstep-");
  const workspace = mkdtempSync(join(tmpdir(), "yui-unify-external-ws-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  setDefaultWorkspace(db, workspace);

  const taskId = "task-1";
  seedTask(db, taskId);
  const { mainPath, linkedPath } = seedWorktrees(workspace, "app", "main-abcd", "work-item-1-efgh");
  insertManagedWorkspace(
    db,
    "task",
    `task:${taskId}`,
    taskId,
    managedWorkspacePayload({ type: "task", taskId }, join(workspace, "tasks", taskId, "main"), [
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
      join(workspace, "tasks", taskId, "work-items", "work-item-1"),
      [projectEntry("app", linkedPath, "app")]
    )
  );

  // Simulate an interrupted publish whose repair already ran: copy the tree to
  // the target, then run `git worktree repair` there so its pointer files are
  // repointed to the NEW location. The durable content is byte-identical to the
  // source; only the repair-variant pointer files differ.
  const { newWorktreeRoot } = worktreeRoots(workspace, home);
  mkdirSync(dirname(newWorktreeRoot), { recursive: true });
  cpSync(join(workspace, "worktree"), newWorktreeRoot, { recursive: true, verbatimSymlinks: true });
  const newMain = join(newWorktreeRoot, "app", "main-abcd");
  const newLinked = join(newWorktreeRoot, "app", "work-item-1-efgh");
  git(["-C", newMain, "worktree", "repair", newLinked]);

  // A plain inventory comparison WOULD differ now (pointer bytes changed), but
  // the repair-invariant preflight must report no target conflict.
  const preflight = preflightUnifyHomeLayout(db);
  assert.equal(
    preflight.blockers.filter((b) => b.reason === "target-conflict").length,
    0,
    "a relinked but durable-identical target is not a target-conflict"
  );

  // And execute completes by adopting it (the lockstep the preflight promised).
  const result = runMigration(db);
  assert.deepEqual(result.applied, [CURRENT_STORAGE_VERSION], "execute adopts the relinked target");
  assert.equal(existsSync(`${newWorktreeRoot}.incoming`), false, "adopted, not re-copied");
  const row = db
    .prepare("SELECT payload FROM managed_workspaces WHERE owner_kind = 'task'")
    .get();
  assert.equal(JSON.parse(row.payload).entries[0].path, newMain, "pointer rewritten to adopted target");
});





