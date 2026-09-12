import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  migrateSqliteSchema,
  inspectSqliteSchemaMigrations
} from "../../dist/storage/sqliteSchema.js";
import { inspectStorageSchema } from "../../dist/storage/storageSchema.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { CURRENT_STORAGE_VERSION } from "../../dist/storage/storageVersions.js";
import {
  createContextSnapshot,
  validateContextSnapshot,
  contextContentDigest
} from "../../dist/context/contextSnapshot.js";
import { openTaskArtifactRepository } from "../../dist/artifacts/taskArtifactRepository.js";
import { parseGitArtifactRef, isGitArtifactRefString } from "../../dist/artifacts/gitArtifactRef.js";

/**
 * Faithful 18->19 upgrade regression that builds a GENUINE storage-version-18
 * Home from the baseline THROUGH THE REAL MIGRATION REGISTRY, then drives it to
 * 19 through the REAL registry apply loop and the REAL upgrade orchestrator.
 *
 * The sibling artifacts-to-git-migration.test.js hand-seeds a simplified v18
 * table shape and calls `migrateArtifactsToGit(db)` directly. This test instead:
 *
 *   1. applies migrations 1..18 via `migrateSqliteSchema(db, {mode:"apply",
 *      throughVersion:18})`, so the v18 schema, the checksum ledger, and every
 *      table are produced by the real, frozen migration definitions — no
 *      hand-written DDL;
 *   2. proves the real orchestrator recognizes the Home as a legitimate,
 *      inspectable, migration-ready v18 (`inspectStorageSchema` +
 *      `runStorageUpgrade` dry-run report the plan without mutating anything);
 *   3. performs the 18->19 transition through `migrateSqliteSchema(db,
 *      {mode:"apply"})` — the real apply loop that runs the v19 entry's `sql`
 *      then its `migrateData` (migrateArtifactsToGit) and records the ledger
 *      row — rather than calling the migration function in isolation.
 *
 * It then verifies the whole v19 contract surface: the Artifact table is gone,
 * the moved bytes are readable in the Task's local Git repo with their frozen
 * digest, Candidate and completion references are rewritten to self-certifying
 * `commit + relativePath`, and an INDEPENDENT frozen Context (context_snapshots,
 * untouched by the migration) is still byte-for-byte readable with a digest that
 * still validates AFTER the `artifacts` table is dropped.
 */

const TASK = "task-upgrade-1";
const T0 = "2026-02-01T00:00:00.000Z";
const T1 = "2026-02-02T00:00:00.000Z";
const T2 = "2026-02-03T00:00:00.000Z";
const CONTENT_A = "plan body A";

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Build a genuine v18 Home purely through the real migration registry. */
function buildRealV18Home(home) {
  const db = new Database(join(home, "yui.db"));
  db.pragma("foreign_keys = ON");
  // The real registry, stopped at v18: real DDL for every table + a real,
  // checksum-validated ledger. `throughVersion` is honored only in apply mode.
  migrateSqliteSchema(db, { mode: "apply", throughVersion: 18 });
  assert.equal(
    inspectSqliteSchemaMigrations(db).currentVersion,
    18,
    "expected the real registry to produce a genuine v18 Home"
  );
  return db;
}

/** Seed realistic v18 rows (raw JSON payloads into the real v18 tables). */
function seedV18Rows(db) {
  const digestA = sha256Hex(CONTENT_A);

  // FK order: the Task row first (artifacts / task_records / context_snapshots
  // all reference tasks_catalog under `foreign_keys = ON`).
  db.prepare(
    "INSERT INTO tasks_catalog (task_id, status, lifecycle, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?)"
  ).run(TASK, "active", "delivery", 1, T0, T0);

  // A content Artifact in the soon-to-be-retired table.
  db.prepare("INSERT INTO artifacts (task_id, id, payload) VALUES (?, ?, ?)").run(
    TASK,
    "artifact-a",
    JSON.stringify({
      schemaVersion: 1, id: "artifact-a", taskId: TASK, displayName: "artifact-a",
      mediaType: "text/plain", provenance: "test", createdAt: T1, kind: "content",
      content: CONTENT_A, digest: digestA
    })
  );

  // A WorkItem whose candidate points at the old DB artifact id.
  db.prepare(
    "INSERT INTO work_items (task_id, work_item_id, status, payload, updated_at) VALUES (?,?,?,?,?)"
  ).run(TASK, "wi-1", "delivered", JSON.stringify({
    workItemId: "wi-1", taskId: TASK,
    candidates: [
      { candidateId: "cand-1", artifactRefs: [{ taskId: TASK, artifactId: "artifact-a", kind: "content", digest: digestA }] }
    ]
  }), T2);

  // Completion refs: one artifact id (rewritten) + one non-artifact (preserved).
  db.prepare("INSERT INTO task_records (task_id, payload, updated_at) VALUES (?,?,?)").run(
    TASK,
    JSON.stringify({ taskId: TASK, completionArtifactRefs: ["artifact-a", "turn:final"] }),
    T2
  );

  // A frozen Context, INDEPENDENT of the artifacts table. Built with the real
  // snapshot constructor so its digest is authentic, then stored as a real row.
  const value = { note: "frozen original bytes" };
  const refDigest = contextContentDigest(value);
  const snapshot = createContextSnapshot({
    id: "ctx-1", taskId: TASK, scope: "task", sequence: 1,
    refs: [{ layer: "L1", store: "brief", refId: "brief-1", revision: "1", digest: refDigest }],
    resources: [{ ref: { layer: "L1", store: "brief", refId: "brief-1", revision: "1", digest: refDigest }, value }],
    acceptRefs: [],
    frozenAt: new Date(T0),
    frozenBy: "leader"
  });
  const snapshotPayload = JSON.stringify(snapshot);
  db.prepare(
    "INSERT INTO context_snapshots (task_id, snapshot_id, scope, scope_ref, sequence, digest, payload, frozen_at) " +
      "VALUES (?,?,?,?,?,?,?,?)"
  ).run(TASK, snapshot.id, snapshot.scope, null, snapshot.sequence, snapshot.digest, snapshotPayload, snapshot.frozenAt);

  return { digestA, snapshotPayload, snapshotDigest: snapshot.digest };
}

test("18->19 upgrade via the real registry: v18 built from baseline, orchestrator plans it", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-upgrade-registry-"));
  try {
    const db = buildRealV18Home(home);
    seedV18Rows(db);
    db.close();

    // The real orchestrator sees a legitimate, inspectable, migration-ready v18.
    const state = inspectStorageSchema(home);
    assert.equal(state.status, "upgradeable");
    assert.equal(state.currentVersion, 18);
    assert.equal(state.latestVersion, CURRENT_STORAGE_VERSION);

    // A dry run reports the real plan to head WITHOUT mutating the Home.
    const dryRun = await runStorageUpgrade({ home, mode: "dry-run" });
    assert.equal(dryRun.outcome, "upgrade-plan");
    assert.equal(dryRun.report.sourceVersion, 18);
    assert.equal(dryRun.report.targetVersion, CURRENT_STORAGE_VERSION);
    assert.equal(dryRun.report.steps.at(-1)?.toVersion, CURRENT_STORAGE_VERSION);

    // The dry run must not have advanced the on-disk version.
    assert.equal(inspectStorageSchema(home).currentVersion, 18);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("18->19 upgrade via the real registry: applies to head, moves artifacts, rewrites refs, preserves frozen Context", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-upgrade-registry-run-"));
  try {
    const build = buildRealV18Home(home);
    const { digestA, snapshotPayload, snapshotDigest } = seedV18Rows(build);
    build.close();

    // Drive 18->19 through the REAL apply loop (v19 sql + migrateData wiring +
    // ledger row), not a direct migrateArtifactsToGit() call.
    const db = new Database(join(home, "yui.db"));
    db.pragma("foreign_keys = ON");
    const result = migrateSqliteSchema(db, { mode: "apply" });
    assert.equal(result.version, CURRENT_STORAGE_VERSION);
    assert.ok(result.applied.includes(19), "the v19 migration must have been applied by the registry");
    assert.equal(inspectSqliteSchemaMigrations(db).currentVersion, CURRENT_STORAGE_VERSION);

    // The DB is no longer an authority for file artifacts: the table is dropped.
    const artifactsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'")
      .all();
    assert.equal(artifactsTable.length, 0);

    // The Candidate ref is now a self-certifying commit + relativePath.
    const workItem = JSON.parse(
      db.prepare("SELECT payload FROM work_items WHERE work_item_id = 'wi-1'").get().payload
    );
    const candidateRef = workItem.candidates[0].artifactRefs[0];
    assert.equal(candidateRef.taskId, TASK);
    assert.match(candidateRef.commit, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
    assert.equal(candidateRef.relativePath, "migrated/artifact-a/content");
    assert.equal(Object.hasOwn(candidateRef, "artifactId"), false);

    // The completion ref id becomes a git: string; the non-artifact one survives.
    const taskRecord = JSON.parse(
      db.prepare("SELECT payload FROM task_records WHERE task_id = ?").get(TASK).payload
    );
    assert.equal(taskRecord.completionArtifactRefs.length, 2);
    assert.ok(isGitArtifactRefString(taskRecord.completionArtifactRefs[0]));
    assert.equal(parseGitArtifactRef(taskRecord.completionArtifactRefs[0], TASK).relativePath, "migrated/artifact-a/content");
    assert.equal(taskRecord.completionArtifactRefs[1], "turn:final");

    // The INDEPENDENT frozen Context survived the artifacts drop byte-for-byte,
    // and its digest still validates through the real integrity checker.
    const snapRow = db.prepare("SELECT payload, digest FROM context_snapshots WHERE snapshot_id = 'ctx-1'").get();
    assert.equal(snapRow.payload, snapshotPayload, "frozen Context payload bytes must be unchanged");
    assert.equal(snapRow.digest, snapshotDigest);
    const snapshot = JSON.parse(snapRow.payload);
    validateContextSnapshot(snapshot); // throws if the original bytes/digest drifted
    assert.equal(snapshot.digest, snapshotDigest);
    db.close();

    // The moved bytes are readable in the Task's local Git repo with the digest.
    const content = await openTaskArtifactRepository(home, TASK).read("migrated/artifact-a/content");
    assert.equal(content.bytes.toString("utf8"), CONTENT_A);
    assert.equal(content.digest, digestA);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
