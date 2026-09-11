import { openTaskArtifactRepository, type ArtifactContent, type ArtifactEntry } from "./taskArtifactRepository.js";
import { requireCommitId } from "./managedGit.js";
import { safeRelativeArtifactPath } from "./artifactPaths.js";

/**
 * Commit-pinned reference to a file artifact in a Task's local Git repository.
 *
 * This is the identity of FROZEN evidence (§3.7): a Candidate's selected
 * results, Review evidence, completion evidence and frozen Context all pin the
 * exact bytes by `taskId + commit + relativePath`. The commit hash
 * cryptographically freezes the whole tree, so a pinned reference is
 * SELF-CERTIFYING: the bytes at `relativePath` in `commit` can never change
 * without changing `commit`. That is what lets the synchronous context
 * pipeline carry a pinned reference as a pointer WITHOUT reading Git at build
 * time, and read the bytes lazily on the asynchronous expand path.
 *
 * Ordinary (non-frozen) reads use `taskId + relativePath` at current HEAD and
 * are always asynchronous — see {@link listCurrentArtifacts} / {@link readCurrentArtifact}.
 *
 * `digest` is OPTIONAL recorded metadata (sha256 of the bytes) for display and
 * a fast equality check; the commit is the actual freeze, so a reference is
 * valid and self-certifying with or without it.
 */
export type GitArtifactRef = Readonly<{
  taskId: string;
  commit: string;
  relativePath: string;
  digest?: string;
}>;

/** Compact string form for reference lists that are plain strings (completion refs). */
const GIT_ARTIFACT_REF_PREFIX = "git:";

/**
 * Validate a {@link GitArtifactRef}'s shape (PURE; no I/O). Safe to call inside
 * a synchronous DB transaction and inside the synchronous context pipeline.
 * Returns a normalized copy (canonical POSIX relativePath, lowercased commit).
 */
export function validateGitArtifactRef(ref: GitArtifactRef): GitArtifactRef {
  if (!ref || typeof ref !== "object") throw new Error("Git artifact ref must be an object.");
  if (typeof ref.taskId !== "string" || ref.taskId.trim().length === 0) {
    throw new Error("Git artifact ref requires a taskId.");
  }
  const commit = requireCommitId(ref.commit);
  const relativePath = safeRelativeArtifactPath(ref.relativePath);
  if (ref.digest !== undefined && !/^[a-f0-9]{64}$/u.test(ref.digest)) {
    throw new Error("Git artifact ref digest must be a sha256 hex string.");
  }
  return Object.freeze({
    taskId: ref.taskId,
    commit,
    relativePath,
    ...(ref.digest === undefined ? {} : { digest: ref.digest })
  });
}

/** True when a plain string is a commit-pinned artifact reference. */
export function isGitArtifactRefString(value: string): boolean {
  return typeof value === "string" && value.startsWith(GIT_ARTIFACT_REF_PREFIX);
}

/**
 * Format a same-Task pinned reference as `git:<commit>:<relativePath>`. The
 * Task is implicit (the reference belongs to the referencing Task, e.g. a
 * completion ref of the completing Task). The digest is omitted: the commit is
 * the freeze, so the string form is already self-certifying.
 */
export function formatGitArtifactRef(ref: GitArtifactRef): string {
  const valid = validateGitArtifactRef(ref);
  return `${GIT_ARTIFACT_REF_PREFIX}${valid.commit}:${valid.relativePath}`;
}

/**
 * Parse `git:<commit>:<relativePath>` for a given Task. Rejects any malformed
 * form. PURE; no I/O. `commit` is a full object id and never contains a colon,
 * so the first colon after the prefix splits commit from path unambiguously.
 */
export function parseGitArtifactRef(value: string, taskId: string): GitArtifactRef {
  if (!isGitArtifactRefString(value)) {
    throw new Error("Not a commit-pinned artifact reference.");
  }
  const body = value.slice(GIT_ARTIFACT_REF_PREFIX.length);
  const separator = body.indexOf(":");
  if (separator <= 0 || separator === body.length - 1) {
    throw new Error("Commit-pinned reference must be git:<commit>:<relativePath>.");
  }
  return validateGitArtifactRef({
    taskId,
    commit: body.slice(0, separator),
    relativePath: body.slice(separator + 1)
  });
}

/**
 * Resolve a pinned reference to its frozen bytes (ASYNC). Reads the exact
 * commit/path from the Task's local repository and returns bytes + the actual
 * sha256. When the reference records a `digest`, a mismatch is a drift error —
 * though for a correctly pinned commit this can only happen if the recorded
 * digest was wrong, since the commit freezes the bytes.
 */
export async function resolveGitArtifact(home: string, ref: GitArtifactRef): Promise<ArtifactContent> {
  const valid = validateGitArtifactRef(ref);
  const repo = openTaskArtifactRepository(home, valid.taskId);
  if (!repo.exists()) {
    throw new Error(`Artifact repository is unavailable for ${valid.taskId}.`);
  }
  const content = await repo.read(valid.relativePath, valid.commit);
  if (valid.digest !== undefined && content.digest !== valid.digest) {
    throw new Error(
      `Frozen artifact drifted from its recorded digest: ${valid.taskId}@${valid.commit}:${valid.relativePath}.`
    );
  }
  return content;
}

/** Ordinary read: current bytes of `relativePath` at HEAD (ASYNC, not frozen). */
export async function readCurrentArtifact(
  home: string,
  taskId: string,
  relativePath: string
): Promise<ArtifactContent> {
  const repo = openTaskArtifactRepository(home, taskId);
  if (!repo.exists()) throw new Error(`Artifact repository is unavailable for ${taskId}.`);
  return repo.read(safeRelativeArtifactPath(relativePath));
}

/** Ordinary listing: tracked artifacts at HEAD (ASYNC, not frozen). Empty when no repo yet. */
export async function listCurrentArtifacts(
  home: string,
  taskId: string
): Promise<readonly ArtifactEntry[]> {
  const repo = openTaskArtifactRepository(home, taskId);
  if (!repo.exists()) return [];
  return repo.list();
}

/**
 * Pin the CURRENT HEAD state of one or more relativePaths into frozen
 * references (ASYNC). Used at Candidate submission / completion time to capture
 * exactly what exists now. Fails if any path is not tracked at HEAD.
 */
export async function pinCurrentArtifacts(
  home: string,
  taskId: string,
  relativePaths: readonly string[]
): Promise<readonly GitArtifactRef[]> {
  const repo = openTaskArtifactRepository(home, taskId);
  if (!repo.exists()) throw new Error(`Artifact repository is unavailable for ${taskId}.`);
  const head = await repo.head();
  if (head === null) throw new Error(`Artifact repository has no commits for ${taskId}.`);
  const refs: GitArtifactRef[] = [];
  for (const relativePath of relativePaths) {
    // Reading at the pinned commit both proves the path exists there and yields
    // the exact digest to record for display/fast verification.
    const content = await repo.read(safeRelativeArtifactPath(relativePath), head);
    refs.push(validateGitArtifactRef({
      taskId,
      commit: head,
      relativePath: content.relativePath,
      digest: content.digest
    }));
  }
  return refs;
}
