import { openTaskArtifactRepository, type ArtifactEntry } from "./taskArtifactRepository.js";
import { saveArtifactFile, type GitArtifactRef } from "./gitArtifactRef.js";
import { requireCommitId } from "./managedGit.js";
import { safeRelativeArtifactPath } from "./artifactPaths.js";

/**
 * Capability-shaped adapter over the per-Task local Git artifact repository.
 *
 * This is the file/directory artifact surface behind the `artifact.save`,
 * `artifact.read` and `artifact.list` capabilities and the `yui task artifact`
 * CLI. It deliberately does NOT reintroduce the immutable-record `artifact.save`
 * shape: an artifact is now a file at a `relativePath`, saved by editing and
 * committing it in the Task's local repository. The save returns a
 * self-certifying commit-pinned reference (`taskId + commit + relativePath`),
 * which is the identity used for frozen Candidate/Review/completion evidence.
 *
 * Content is handled as UTF-8 text with the same 8 MiB cap as the former
 * immutable text artifact. Binary artifacts, high-frequency runtime data and
 * very large files are out of scope for this first version by contract (§3.5)
 * and are rejected or referenced through their existing resource boundary, not
 * carried here.
 */

/** Text cap for a single artifact file, mirroring the former immutable-artifact limit. */
const MAX_ARTIFACT_TEXT_BYTES = 8 * 1024 * 1024;

export type ArtifactSaveCapabilityInput = Readonly<{
  relativePath: string;
  /** UTF-8 text body. Binary artifacts are deferred by contract. */
  content: string;
  /** One meaningful update = one commit; a caller-authored save message. */
  message?: string;
  /** Optional expected HEAD so a caller can fail closed on a concurrent advance. */
  expectedHead?: string;
}>;

export type ArtifactReadCapabilityResult = Readonly<{
  taskId: string;
  relativePath: string;
  commit: string;
  content: string;
  digest: string;
}>;

function requireTextContent(content: string): Buffer {
  if (typeof content !== "string") throw new Error("Artifact content must be UTF-8 text.");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > MAX_ARTIFACT_TEXT_BYTES) {
    throw new Error(`Artifact content must be UTF-8 text of at most ${MAX_ARTIFACT_TEXT_BYTES} bytes.`);
  }
  return bytes;
}

/**
 * `artifact.save`: write `content` to `relativePath` in the Task's local repo,
 * commit exactly that path, and return the resulting commit-pinned reference.
 */
export async function saveArtifactCapability(
  home: string,
  taskId: string,
  input: ArtifactSaveCapabilityInput
): Promise<GitArtifactRef> {
  const bytes = requireTextContent(input.content);
  return saveArtifactFile(home, taskId, {
    relativePath: input.relativePath,
    bytes,
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.expectedHead === undefined ? {} : { expectedHead: input.expectedHead })
  });
}

/**
 * `artifact.read`: read `relativePath` at HEAD, or at a pinned `commit` for
 * frozen evidence. Returns the bytes as UTF-8 text plus the resolved commit and
 * digest, so a caller can record or verify the exact reference.
 */
export async function readArtifactCapability(
  home: string,
  taskId: string,
  input: Readonly<{ relativePath: string; commit?: string }>
): Promise<ArtifactReadCapabilityResult> {
  const repo = openTaskArtifactRepository(home, taskId);
  if (!repo.exists()) throw new Error(`Artifact repository is unavailable for ${taskId}.`);
  const safeRelative = safeRelativeArtifactPath(input.relativePath);
  const content = await repo.read(
    safeRelative,
    input.commit === undefined ? undefined : requireCommitId(input.commit)
  );
  return {
    taskId,
    relativePath: content.relativePath,
    commit: content.commit,
    content: content.bytes.toString("utf8"),
    digest: content.digest
  };
}

/**
 * `artifact.list`: tracked artifacts at HEAD (empty when the Task has no repo
 * yet). This is an ordinary current read; it does not freeze anything.
 */
export async function listArtifactsCapability(
  home: string,
  taskId: string
): Promise<readonly ArtifactEntry[]> {
  const repo = openTaskArtifactRepository(home, taskId);
  if (!repo.exists()) return [];
  return repo.list();
}
