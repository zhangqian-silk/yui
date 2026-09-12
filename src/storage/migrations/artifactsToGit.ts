import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  externalProgramConfigViolations,
  managedGitSync,
  managedGitSyncSucceeds,
  requireCommitId
} from "../../artifacts/managedGit.js";
import {
  safePathSegment,
  safeRelativeArtifactPath,
  taskArtifactRepoPath,
  taskArtifactsRoot
} from "../../artifacts/artifactPaths.js";
import { migrateSubmitIntent } from "./submitIntent.js";

/**
 * Storage 18 -> 19: retire the DB-owned immutable Artifact table and move every
 * historical Artifact into its Task's LOCAL Git artifact repository, then
 * rewrite the Candidate/completion references that pointed at them so they pin
 * an exact `commit + relativePath` instead of a mutable DB id.
 *
 * Two-class ownership (§3.1/§3.7): after v19 the DB is no longer an authority
 * for file/directory artifacts — the per-Task repo at
 * `<YUI_HOME>/task-artifacts/<task-id>/` is. This migration is the ONE-TIME
 * bridge: it reads the soon-to-be-dropped `artifacts` table, reconstructs the
 * bytes/descriptor as deterministic Git history, and leaves NO dual read/write
 * surface behind (the table is dropped in the same transaction).
 *
 * Determinism & crash-safety. `migrateData` runs INSIDE the outer
 * `db.transaction`, which better-sqlite3 requires to be synchronous, so this
 * builds repositories with the synchronous managed-Git runner. Every commit
 * (including the empty root) is pinned to a date derived purely from the
 * Artifact data, and identity/message/tree are fixed, so rebuilding the same
 * table produces byte-identical commit ids. The DB half is atomic (the upgrade
 * orchestrator backs up `yui.db` and rolls back on any throw); the Git repos
 * are the only non-transactional side effect, so each Task repo is built in a
 * staging directory and atomically renamed into place, and a leftover from a
 * previously rolled-back attempt is replaced by an identical rebuild.
 *
 * Boundaries. Managed Git is fully isolated (no remote, no hooks/filters, no
 * network/file transport, no ambient config — see managedGit). This migration
 * NEVER re-accesses a Job receipt tool and NEVER fetches a reference locator: it
 * moves exactly the bytes/descriptor already frozen in the DB. Reference-kind
 * Artifacts are preserved as history but are never a reference target (they were
 * never fixed results). Completion strings that are not Artifact ids (e.g.
 * `turn:<id>` or an explicit URL) are preserved verbatim.
 */

/** The single managed branch, mirroring taskArtifactRepository. */
const ARTIFACT_BRANCH = "main";

/** Staging root for in-progress repository builds (hidden; never a Task id). */
const MIGRATION_STAGING = ".yui-artifact-migration";

/** The old immutable Artifact record, exactly as persisted at v18. */
type StoredArtifact = Readonly<{
  schemaVersion: 1;
  id: string;
  taskId: string;
  displayName: string;
  mediaType: string;
  provenance: string;
  createdAt: string;
  kind: "content" | "external-version" | "receipt" | "reference";
  content?: string;
  digest?: string;
  jobId?: string;
  receiptRef?: string;
  resourceId?: string;
  version?: string;
  verification?: string;
  locator?: string;
  observedAt?: string;
}>;

/** Where a migrated Artifact now lives, and the frozen reference to it. */
type MigratedRef = Readonly<{ commit: string; relativePath: string; digest?: string }>;

/** Deterministic key for the id->reference map (task id + Artifact id). */
function refKey(taskId: string, artifactId: string): string {
  return `${taskId}\u0000${artifactId}`;
}

/** Stable JSON: object keys sorted at every depth, so bytes (and thus commit ids) are deterministic. */
function stableJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") {
      const source = input as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) result[key] = canonical(source[key]);
      return result;
    }
    return input;
  };
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

/** The metadata record written for every migrated Artifact (content lives beside it, if any). */
function artifactRecord(artifact: StoredArtifact): Record<string, unknown> {
  const { content: _content, ...rest } = artifact;
  return { ...rest, migratedFrom: { store: "artifacts", storageVersion: 18 } };
}

export function migrateArtifactsToGit(db: Database.Database): void {
  const home = dirname(db.name);
  // A pure in-memory database (tests) has no Home to host repositories; there
  // are no rows to move in that case, so treat it as an empty migration.
  const rows = db.prepare("SELECT task_id, id, payload FROM artifacts").all() as Array<{
    task_id: string;
    id: string;
    payload: string;
  }>;

  const migrated = new Map<string, MigratedRef>();
  if (rows.length > 0) {
    if (db.name === ":memory:" || db.name.length === 0) {
      throw new Error("Cannot migrate Artifacts to Git without an on-disk Home.");
    }
    const byTask = new Map<string, StoredArtifact[]>();
    for (const row of rows) {
      const artifact = JSON.parse(row.payload) as StoredArtifact;
      const list = byTask.get(row.task_id) ?? [];
      list.push(artifact);
      byTask.set(row.task_id, list);
    }
    // Deterministic Task order, then deterministic Artifact order within a Task.
    for (const taskId of [...byTask.keys()].sort()) {
      const artifacts = byTask.get(taskId)!.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      buildTaskRepository(home, taskId, artifacts, migrated);
    }
    // Every Task repo has been atomically renamed out of staging; remove the now
    // empty staging root so it never masquerades as an entry under task-artifacts.
    rmSync(join(taskArtifactsRoot(home), MIGRATION_STAGING), { recursive: true, force: true });
  }

  rewriteCandidateRefs(db, migrated);
  rewriteCompletionRefs(db, migrated);

  // No dual surface: the DB is no longer an authority for file artifacts.
  db.exec("DROP TABLE artifacts");

  // Requirement A's independent, deterministic, idempotent backfill runs LAST,
  // inside this same outer transaction. It touches only events + id_sequences.
  migrateSubmitIntent(db);
}

/**
 * Build one Task's artifact repository from its historical Artifacts and record
 * a frozen reference for each. Built in staging, then atomically swapped in.
 */
function buildTaskRepository(
  home: string,
  taskId: string,
  artifacts: readonly StoredArtifact[],
  migrated: Map<string, MigratedRef>
): void {
  const root = taskArtifactsRoot(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stagingRoot = join(root, MIGRATION_STAGING);
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const staging = join(stagingRoot, safePathSegment(taskId, "Task id"));
  // Discard any partial staging from a previously interrupted attempt.
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });

  // Root commit date: the earliest Artifact timestamp, so the whole history is a
  // pure function of the data (no wall-clock, reproducible commit ids).
  const rootDate = artifacts.reduce(
    (earliest, artifact) => (artifact.createdAt < earliest ? artifact.createdAt : earliest),
    artifacts[0]!.createdAt
  );
  managedGitSync(staging, ["init", "-b", ARTIFACT_BRANCH]);
  managedGitSync(staging, ["commit", "--allow-empty", "-m", "init artifact repo"], {
    commitDates: { author: rootDate, committer: rootDate }
  });
  assertManagedBoundary(taskId, staging);

  for (const artifact of artifacts) {
    const ref = commitArtifact(staging, artifact);
    migrated.set(refKey(taskId, artifact.id), ref);
  }
  const builtHead = requireCommitId(managedGitSync(staging, ["rev-parse", "HEAD^{commit}"]));

  // Adopt the freshly built repository WITHOUT ever destroying unknown data.
  const finalPath = taskArtifactRepoPath(home, taskId);
  adoptBuiltRepository(taskId, staging, finalPath, builtHead);
}

/**
 * Move the freshly built repository into place WITHOUT ever clearing an unknown
 * existing directory (fail-closed; no auto-repair).
 *
 * - No existing dir: atomic rename — there is nothing to lose.
 * - Existing dir that is PROVABLY this exact build: a remnant of a previously
 *   rolled-back attempt. Keep it and discard the redundant staging build. Proof
 *   is its HEAD commit id (a hash over the whole tree AND commit history,
 *   reproducible only by this deterministic builder from this exact data), plus
 *   a clean working tree and the managed boundary (no remote / no
 *   external-program config) — so a dir with extra or modified files is NOT a
 *   remnant even if HEAD coincides.
 * - Anything else: STOP. Preserve the existing directory and the staging build
 *   untouched and throw, so the outer transaction rolls the DB back and an
 *   operator can inspect. Never overwrite, clear, or auto-repair.
 */
function adoptBuiltRepository(taskId: string, staging: string, finalPath: string, builtHead: string): void {
  if (!existsSync(finalPath)) {
    renameSync(staging, finalPath);
    assertManagedBoundary(taskId, finalPath);
    return;
  }
  if (isProvenIdenticalRemnant(finalPath, builtHead)) {
    // The existing repo already IS the intended, verified result; drop the build.
    rmSync(staging, { recursive: true, force: true });
    return;
  }
  throw new Error(
    `Refusing to overwrite existing artifact directory for ${taskId} at ${finalPath}: it is not a ` +
      `proven byte-identical remnant of this migration (different HEAD, working-tree changes, or an ` +
      `external remote/config). No data was modified; resolve it manually and re-run the upgrade.`
  );
}

/**
 * True ONLY if `finalPath` is a managed Git repo whose HEAD equals `builtHead`,
 * whose working tree is clean, and which is within the managed boundary. Any
 * failure (not a repo, differing HEAD, dirty tree, remote/external config) means
 * "not a remnant", so the caller fails closed rather than deleting it. Read-only.
 *
 * ORDER MATTERS: the managed-boundary check (remote + config scan — reads that
 * never run a filter) runs BEFORE `git status`. `git status` re-hashes a
 * same-size modified file through a `clean` filter to decide if it really
 * differs, so running status first on a tampered repo could execute an external
 * program before we ever reject it. The boundary scan also rejects config
 * INCLUSION entry points, so a filter hidden behind `include.*` is refused here
 * too — before status can follow the include.
 */
function isProvenIdenticalRemnant(finalPath: string, builtHead: string): boolean {
  if (!managedGitSyncSucceeds(finalPath, ["rev-parse", "--is-inside-work-tree"])) return false;
  // Fail closed on any remote or external-program/inclusion config BEFORE the
  // first working-tree inspection, so no `clean`/`smudge` filter can run.
  if (!isWithinManagedBoundary(finalPath)) return false;
  let head: string;
  try {
    head = requireCommitId(managedGitSync(finalPath, ["rev-parse", "HEAD^{commit}"]));
  } catch {
    return false;
  }
  // A matching HEAD proves the entire committed history; a clean tree proves
  // nothing was added or modified on top of that history. Only now that the
  // boundary is proven is it safe to let `git status` touch the working tree.
  if (head !== builtHead) return false;
  if (managedGitSync(finalPath, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]).length > 0) {
    return false;
  }
  return true;
}

/** Write one Artifact's files, commit exactly them, and return its frozen reference. */
function commitArtifact(repoPath: string, artifact: StoredArtifact): MigratedRef {
  const idSegment = safePathSegment(artifact.id, "Artifact id");
  const base = `migrated/${idSegment}`;
  const recordPath = safeRelativeArtifactPath(`${base}/record.json`);

  const files: Array<{ relativePath: string; bytes: Buffer }> = [
    { relativePath: recordPath, bytes: Buffer.from(stableJson(artifactRecord(artifact)), "utf8") }
  ];

  let target = recordPath;
  let digest: string | undefined;
  if ((artifact.kind === "content" || artifact.kind === "receipt") && typeof artifact.content === "string") {
    const contentPath = safeRelativeArtifactPath(`${base}/content`);
    const bytes = Buffer.from(artifact.content, "utf8");
    files.push({ relativePath: contentPath, bytes });
    target = contentPath;
    // sha256 of the exact committed bytes; equals the old ref's content digest.
    digest = createHash("sha256").update(bytes).digest("hex");
  }

  for (const file of files) {
    const absolute = join(repoPath, file.relativePath);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    writeFileSync(absolute, file.bytes, { mode: 0o600 });
  }
  const pathspecs = files.map((file) => file.relativePath);
  managedGitSync(repoPath, ["add", "--", ...pathspecs]);
  managedGitSync(repoPath, ["commit", "--only", "-m", `migrate artifact ${artifact.id}`, "--", ...pathspecs], {
    commitDates: { author: artifact.createdAt, committer: artifact.createdAt }
  });
  const commit = requireCommitId(managedGitSync(repoPath, ["rev-parse", "HEAD^{commit}"]));

  // A reference target is never a reference-kind Artifact (those were never
  // fixed results), but such Artifacts are still preserved above as history.
  return artifact.kind === "reference"
    ? { commit, relativePath: recordPath }
    : { commit, relativePath: target, ...(digest === undefined ? {} : { digest }) };
}

/** Verify a freshly built repository is within the managed boundary; throw otherwise. */
function assertManagedBoundary(taskId: string, repoPath: string): void {
  const remotes = managedGitSync(repoPath, ["remote"]).split("\n").map((line) => line.trim()).filter(Boolean);
  if (remotes.length > 0) {
    throw new Error(`Migrated artifact repository for ${taskId} unexpectedly has a remote: ${remotes.join(", ")}.`);
  }
  const configViolations = externalProgramConfigViolations(
    managedGitSync(repoPath, ["config", "--local", "--list", "-z"])
  );
  if (configViolations.length > 0) {
    throw new Error(
      `Migrated artifact repository for ${taskId} has repo-local config that can run external ` +
        `programs: ${configViolations.join(", ")}.`
    );
  }
  // A managed repo must respond to a trivial plumbing query; fail closed otherwise.
  if (!managedGitSyncSucceeds(repoPath, ["rev-parse", "--is-inside-work-tree"])) {
    throw new Error(`Migrated artifact repository for ${taskId} did not initialize correctly.`);
  }
}

/** Read-only managed-boundary predicate (no remote, no external-program config). Never throws. */
function isWithinManagedBoundary(repoPath: string): boolean {
  const remotes = managedGitSync(repoPath, ["remote"]).split("\n").map((line) => line.trim()).filter(Boolean);
  if (remotes.length > 0) return false;
  return externalProgramConfigViolations(
    managedGitSync(repoPath, ["config", "--local", "--list", "-z"])
  ).length === 0;
}

/** An upgradable Candidate reference resolved to its exact commit and path. */
function upgradeCandidateRef(taskId: string, ref: unknown, migrated: Map<string, MigratedRef>): unknown {
  if (ref === null || typeof ref !== "object") return ref;
  const source = ref as Record<string, unknown>;
  // Already a commit-pinned Git reference (defensive; a fresh v18 row is never this).
  if (typeof source.commit === "string" && typeof source.relativePath === "string") return ref;
  const refTaskId = typeof source.taskId === "string" ? source.taskId : taskId;
  const artifactId = source.artifactId;
  if (typeof artifactId !== "string") {
    throw new Error("Candidate artifact reference has no artifact id to migrate.");
  }
  const found = migrated.get(refKey(refTaskId, artifactId));
  if (found === undefined) {
    throw new Error(`Candidate artifact reference has no migrated Artifact: ${refTaskId}/${artifactId}.`);
  }
  return {
    taskId: refTaskId,
    commit: found.commit,
    relativePath: found.relativePath,
    ...(found.digest === undefined ? {} : { digest: found.digest })
  };
}

/** Rewrite Candidate artifactRefs in work_items payloads (and the defensive candidate table). */
function rewriteCandidateRefs(db: Database.Database, migrated: Map<string, MigratedRef>): void {
  for (const row of db.prepare("SELECT task_id, work_item_id, payload FROM work_items").all() as Array<{
    task_id: string;
    work_item_id: string;
    payload: string;
  }>) {
    const item = JSON.parse(row.payload) as Record<string, unknown>;
    if (!Array.isArray(item.candidates)) continue;
    item.candidates = item.candidates.map((candidate) => {
      if (candidate === null || typeof candidate !== "object") return candidate;
      const record = candidate as Record<string, unknown>;
      if (!Array.isArray(record.artifactRefs)) return candidate;
      return {
        ...record,
        artifactRefs: record.artifactRefs.map((ref) => upgradeCandidateRef(row.task_id, ref, migrated))
      };
    });
    const next = JSON.stringify(item);
    if (next !== row.payload) {
      db.prepare("UPDATE work_items SET payload = ? WHERE task_id = ? AND work_item_id = ?")
        .run(next, row.task_id, row.work_item_id);
    }
  }

  // The dedicated candidate table is not written by the current runtime, but a
  // historical row must still migrate rather than be left with a stale shape.
  for (const row of db.prepare("SELECT task_id, candidate_id, payload FROM work_item_candidates").all() as Array<{
    task_id: string;
    candidate_id: string;
    payload: string;
  }>) {
    const candidate = JSON.parse(row.payload) as Record<string, unknown>;
    if (!Array.isArray(candidate.artifactRefs)) continue;
    candidate.artifactRefs = candidate.artifactRefs.map((ref) => upgradeCandidateRef(row.task_id, ref, migrated));
    const next = JSON.stringify(candidate);
    if (next !== row.payload) {
      db.prepare("UPDATE work_item_candidates SET payload = ? WHERE task_id = ? AND candidate_id = ?")
        .run(next, row.task_id, row.candidate_id);
    }
  }
}

/** Rewrite completion artifact refs (string ids) into commit-pinned Git strings. */
function rewriteCompletionRefs(db: Database.Database, migrated: Map<string, MigratedRef>): void {
  for (const row of db.prepare("SELECT task_id, payload FROM task_records").all() as Array<{
    task_id: string;
    payload: string;
  }>) {
    const task = JSON.parse(row.payload) as Record<string, unknown>;
    if (!Array.isArray(task.completionArtifactRefs)) continue;
    task.completionArtifactRefs = task.completionArtifactRefs.map((ref) => {
      if (typeof ref !== "string" || ref.startsWith("git:")) return ref;
      const found = migrated.get(refKey(row.task_id, ref));
      // Preserve non-Artifact completion strings (e.g. turn:<id> or a URL) verbatim.
      return found === undefined ? ref : `git:${found.commit}:${found.relativePath}`;
    });
    const next = JSON.stringify(task);
    if (next !== row.payload) {
      db.prepare("UPDATE task_records SET payload = ? WHERE task_id = ?").run(next, row.task_id);
    }
  }
}
