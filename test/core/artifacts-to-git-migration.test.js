import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { migrateArtifactsToGit } from "../../dist/storage/migrations/artifactsToGit.js";
import { openTaskArtifactRepository } from "../../dist/artifacts/taskArtifactRepository.js";
import { taskArtifactRepoPath } from "../../dist/artifacts/artifactPaths.js";
import { parseGitArtifactRef, isGitArtifactRefString } from "../../dist/artifacts/gitArtifactRef.js";

/**
 * Deterministic regression for the storage 18->19 migration that retires the
 * DB-owned immutable Artifact table and moves every historical Artifact into
 * its Task's local Git repository, rewriting the Candidate/completion refs that
 * pointed at them into self-certifying `commit + relativePath`.
 *
 * The migration runs inside the schema runner's outer `db.transaction`, so the
 * function under test is synchronous. These tests drive it directly against a
 * hand-seeded v18-shape database (the frozen migration registry always upgrades
 * a real Home to head, so a v18 snapshot cannot be produced through the normal
 * runner). Only the tables the migration reads or writes are created.
 */

/** Minimal v18-shape schema: exactly the tables migrateArtifactsToGit touches. */
function seedV18Database(home) {
  const db = new Database(join(home, "yui.db"));
  db.exec(`
    CREATE TABLE tasks_catalog (
      task_id TEXT PRIMARY KEY, status TEXT NOT NULL, lifecycle TEXT NOT NULL,
      is_active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE artifacts (
      task_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (task_id, id)
    );
    CREATE TABLE work_items (
      task_id TEXT NOT NULL, work_item_id TEXT NOT NULL, status TEXT NOT NULL,
      payload TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, work_item_id)
    );
    CREATE TABLE work_item_candidates (
      task_id TEXT NOT NULL, candidate_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
      payload TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, candidate_id)
    );
    CREATE TABLE task_records (
      task_id TEXT PRIMARY KEY, payload TEXT NOT NULL, brief TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      task_id TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL,
      occurred_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (task_id, event_id)
    );
    CREATE TABLE id_sequences (
      task_id TEXT NOT NULL, kind TEXT NOT NULL, high_water INTEGER NOT NULL,
      PRIMARY KEY (task_id, kind)
    );
  `);
  return db;
}

const TASK = "task-mig-1";
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";

function insertContentArtifact(db, taskId, id, content, createdAt) {
  const digest = createHashHex(content);
  db.prepare("INSERT INTO artifacts (task_id, id, payload) VALUES (?, ?, ?)").run(
    taskId,
    id,
    JSON.stringify({
      schemaVersion: 1, id, taskId, displayName: id, mediaType: "text/plain",
      provenance: "test", createdAt, kind: "content", content, digest
    })
  );
  return digest;
}

function createHashHex(content) {
  // Mirror projectResource.contentDigest so the test asserts the exact value.
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Seed one Task with two content artifacts, a candidate ref, and completion refs. */
function seedOneTask(db) {
  db.prepare(
    "INSERT INTO tasks_catalog (task_id, status, lifecycle, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?)"
  ).run(TASK, "active", "delivery", 1, T0, T0);

  const digestA = insertContentArtifact(db, TASK, "artifact-a", "plan body A", T1);
  const digestB = insertContentArtifact(db, TASK, "artifact-b", "chart body B", T2);

  // A WorkItem candidate whose artifactRefs point at the old DB artifact ids.
  db.prepare(
    "INSERT INTO work_items (task_id, work_item_id, status, payload, updated_at) VALUES (?,?,?,?,?)"
  ).run(TASK, "wi-1", "delivered", JSON.stringify({
    workItemId: "wi-1", taskId: TASK,
    candidates: [
      { candidateId: "cand-1", artifactRefs: [{ taskId: TASK, artifactId: "artifact-a", kind: "content", digest: digestA }] },
      { candidateId: "cand-2", artifactRefs: [] }
    ]
  }), T2);

  // The dedicated candidate table (defensively migrated).
  db.prepare(
    "INSERT INTO work_item_candidates (task_id, candidate_id, work_item_id, payload, created_at) VALUES (?,?,?,?,?)"
  ).run(TASK, "cand-1", "wi-1", JSON.stringify({
    candidateId: "cand-1", workItemId: "wi-1",
    artifactRefs: [{ taskId: TASK, artifactId: "artifact-b", kind: "content", digest: digestB }]
  }), T2);

  // Completion refs: one old artifact id (rewritten) plus a non-artifact string (preserved).
  db.prepare("INSERT INTO task_records (task_id, payload, updated_at) VALUES (?,?,?)").run(
    TASK,
    JSON.stringify({ taskId: TASK, completionArtifactRefs: ["artifact-a", "turn:t-final"] }),
    T2
  );

  return { digestA, digestB };
}

test("18->19 migration: moves content artifacts into the Task Git repo and drops the table", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-mig-artifacts-"));
  try {
    const db = seedV18Database(home);
    const { digestA } = seedOneTask(db);

    migrateArtifactsToGit(db);

    // The DB is no longer an authority for file artifacts: the table is gone.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'").all();
    assert.equal(tables.length, 0);
    db.close();

    // The migrated content is readable in the Task's local Git repo.
    const repo = openTaskArtifactRepository(home, TASK);
    assert.equal(repo.exists(), true);
    const content = await repo.read("migrated/artifact-a/content");
    assert.equal(content.bytes.toString("utf8"), "plan body A");
    assert.equal(content.digest, digestA);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("18->19 migration: rewrites candidate and completion refs to commit-pinned Git refs", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-mig-refs-"));
  try {
    const db = seedV18Database(home);
    seedOneTask(db);

    migrateArtifactsToGit(db);

    const workItem = JSON.parse(db.prepare("SELECT payload FROM work_items WHERE work_item_id = 'wi-1'").get().payload);
    const ref = workItem.candidates[0].artifactRefs[0];
    // No longer a mutable DB id: now a self-certifying commit + relativePath.
    assert.equal(ref.taskId, TASK);
    assert.match(ref.commit, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
    assert.equal(ref.relativePath, "migrated/artifact-a/content");
    assert.equal(Object.hasOwn(ref, "artifactId"), false);
    assert.equal(workItem.candidates[1].artifactRefs.length, 0);

    // The defensive candidate table is rewritten too.
    const cand = JSON.parse(db.prepare("SELECT payload FROM work_item_candidates WHERE candidate_id = 'cand-1'").get().payload);
    assert.equal(cand.artifactRefs[0].relativePath, "migrated/artifact-b/content");
    assert.match(cand.artifactRefs[0].commit, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);

    // Completion refs: the artifact id becomes a git: string; the turn: ref is preserved.
    const task = JSON.parse(db.prepare("SELECT payload FROM task_records WHERE task_id = ?").get(TASK).payload);
    assert.equal(task.completionArtifactRefs.length, 2);
    assert.ok(isGitArtifactRefString(task.completionArtifactRefs[0]));
    const parsed = parseGitArtifactRef(task.completionArtifactRefs[0], TASK);
    assert.equal(parsed.relativePath, "migrated/artifact-a/content");
    assert.equal(task.completionArtifactRefs[1], "turn:t-final");
    db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("18->19 migration: is deterministic — identical source data yields identical commits", () => {
  const homeA = mkdtempSync(join(tmpdir(), "yui-mig-detA-"));
  const homeB = mkdtempSync(join(tmpdir(), "yui-mig-detB-"));
  try {
    const dbA = seedV18Database(homeA);
    seedOneTask(dbA);
    migrateArtifactsToGit(dbA);
    const refA = JSON.parse(dbA.prepare("SELECT payload FROM task_records WHERE task_id = ?").get(TASK).payload)
      .completionArtifactRefs[0];
    dbA.close();

    const dbB = seedV18Database(homeB);
    seedOneTask(dbB);
    migrateArtifactsToGit(dbB);
    const refB = JSON.parse(dbB.prepare("SELECT payload FROM task_records WHERE task_id = ?").get(TASK).payload)
      .completionArtifactRefs[0];
    dbB.close();

    // Same source bytes + fixed identity + data-derived dates => same commit id.
    assert.equal(refA, refB);
  } finally {
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
  }
});

test("18->19 migration: an empty artifacts table is a no-op that still drops the table", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-mig-empty-"));
  try {
    const db = seedV18Database(home);
    // No artifacts, no tasks.
    migrateArtifactsToGit(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'").all();
    assert.equal(tables.length, 0);
    // No repository directory is created when there is nothing to move.
    assert.equal(existsSync(join(home, "task-artifacts")), false);
    db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("18->19 migration: re-running after a rolled-back attempt rebuilds identical history", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-mig-idem-"));
  try {
    // First attempt: build the repo, then simulate a DB rollback by discarding
    // the connection WITHOUT keeping its schema changes — the Git repo on disk
    // survives the rollback (it is a non-transactional side effect).
    const db1 = seedV18Database(home);
    const { digestA } = seedOneTask(db1);
    migrateArtifactsToGit(db1);
    const firstRef = JSON.parse(db1.prepare("SELECT payload FROM task_records WHERE task_id = ?").get(TASK).payload)
      .completionArtifactRefs[0];
    db1.close();
    // Discard the "applied" DB to mimic restore-from-backup after a failure.
    rmSync(join(home, "yui.db"), { force: true });

    // Second attempt: same source data, with a leftover repo already on disk.
    const db2 = seedV18Database(home);
    seedOneTask(db2);
    migrateArtifactsToGit(db2);
    const secondRef = JSON.parse(db2.prepare("SELECT payload FROM task_records WHERE task_id = ?").get(TASK).payload)
      .completionArtifactRefs[0];
    db2.close();

    // The rebuild is byte-identical, so refs are stable across a retried upgrade.
    assert.equal(secondRef, firstRef);

    const content = await openTaskArtifactRepository(home, TASK).read("migrated/artifact-a/content");
    assert.equal(content.digest, digestA);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("18->19 migration: fails closed on an UNKNOWN existing directory without overwriting it", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-mig-failclosed-"));
  try {
    const db = seedV18Database(home);
    seedOneTask(db);

    // A foreign, non-remnant directory already occupies the Task's repo path:
    // not a Git repo at all, holding a file the migration did not create. This
    // models an operator mistake or a stale unrelated directory — NOT a proven
    // byte-identical remnant of a rolled-back attempt.
    const finalPath = taskArtifactRepoPath(home, TASK);
    mkdirSync(finalPath, { recursive: true });
    const foreignFile = join(finalPath, "IMPORTANT.txt");
    const foreignBytes = "do not delete me\n";
    writeFileSync(foreignFile, foreignBytes);

    // The migration must STOP rather than clear the unknown directory, and it
    // must not have half-applied: the throw rolls back the DB in production, so
    // here we assert the DB is untouched (artifacts table still present).
    assert.throws(
      () => migrateArtifactsToGit(db),
      /Refusing to overwrite existing artifact directory/i
    );

    // Fail-closed: the foreign directory and its file are preserved byte-for-byte.
    assert.equal(existsSync(foreignFile), true);
    assert.equal(readFileSync(foreignFile, "utf8"), foreignBytes);

    // No auto-repair: the unknown directory was never turned into a Git repo.
    assert.equal(existsSync(join(finalPath, ".git")), false);

    // The DB authority is intact: the migration did not drop the table or rewrite
    // any ref before failing (the outer transaction would roll back regardless,
    // but the function itself must not have reached the drop).
    const artifactsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'")
      .all();
    assert.equal(artifactsTable.length, 1);
    db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("18->19 migration: a filter smuggled into a leftover repo never runs during the remnant probe", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-mig-remnant-filter-"));
  try {
    // First attempt: build a real, valid remnant, then simulate a rolled-back DB
    // by discarding only the connection (the on-disk repo survives, as in the
    // idempotent-rebuild test above).
    const db1 = seedV18Database(home);
    seedOneTask(db1);
    migrateArtifactsToGit(db1);
    db1.close();
    rmSync(join(home, "yui.db"), { force: true });

    // Tamper with the leftover repo so that a `git status` — the working-tree
    // inspection inside the remnant probe — WOULD execute an external program:
    //   1. a repo-local clean filter that drops a sentinel marker when it runs,
    //   2. a .gitattributes binding a tracked file to that filter,
    //   3. that tracked file modified in place to the SAME byte length with a
    //      future mtime, so git cannot short-circuit on size or the stat cache
    //      and must re-hash it (running the clean filter) to compare it.
    // With the safe-config/boundary check ordered BEFORE any working-tree Git
    // command, the probe rejects the repo on the filter config alone and never
    // reaches `git status`, so the marker is never written.
    const finalPath = taskArtifactRepoPath(home, TASK);
    const marker = join(home, "SENTINEL_RAN");
    const cleanCmd = `sh -c 'touch ${marker}; cat'`;
    execFileSync("git", ["-C", finalPath, "config", "--local", "filter.sneaky.clean", cleanCmd]);
    writeFileSync(join(finalPath, ".gitattributes"), "migrated/artifact-a/content filter=sneaky\n");
    const contentPath = join(finalPath, "migrated", "artifact-a", "content");
    const original = readFileSync(contentPath);
    const tampered = Buffer.alloc(original.length, 0x5a); // same size => no size short-circuit
    writeFileSync(contentPath, tampered);
    const future = new Date("2030-01-01T00:00:00Z");
    utimesSync(contentPath, future, future); // stale stat cache => git cannot skip the re-hash

    // Second attempt against the tampered leftover: it is no longer a proven
    // remnant (external-program config), so the migration must fail closed.
    const db2 = seedV18Database(home);
    seedOneTask(db2);
    assert.throws(
      () => migrateArtifactsToGit(db2),
      /Refusing to overwrite existing artifact directory/i
    );
    db2.close();

    // The clean filter NEVER ran: the boundary check rejected the repo before any
    // working-tree inspection could invoke it.
    assert.equal(existsSync(marker), false);

    // Nothing was deleted or auto-repaired: the offending config, the attribute
    // file, and the tampered content all remain exactly as they were left.
    const storedFilter = execFileSync(
      "git",
      ["-C", finalPath, "config", "--local", "--get", "filter.sneaky.clean"],
      { encoding: "utf8" }
    ).trim();
    assert.equal(storedFilter, cleanCmd);
    assert.equal(existsSync(join(finalPath, ".gitattributes")), true);
    assert.deepEqual(readFileSync(contentPath), tampered);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
