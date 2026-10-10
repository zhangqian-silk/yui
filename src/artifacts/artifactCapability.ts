import { openTaskArtifactRepository, type ArtifactEntry } from "./taskArtifactRepository.js";
import { saveArtifactFile, type GitArtifactRef } from "./gitArtifactRef.js";
import { requireCommitId } from "./managedGit.js";
import { safeRelativeArtifactPath } from "./artifactPaths.js";
import { isRasterArtifact, MAX_IMAGE_BYTES, rasterMetadata } from "./imageMetadata.js";

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
 * Text is UTF-8 (8 MiB). Static raster images use explicit base64 (4 MiB
 * decoded), with the same immutable repository and image limits as Web.
 */

/** Text cap for a single artifact file, mirroring the former immutable-artifact limit. */
const MAX_ARTIFACT_TEXT_BYTES = 8 * 1024 * 1024;

export type ArtifactSaveCapabilityInput = Readonly<{
  relativePath: string;
  /** UTF-8 text by default; canonical base64 for supported raster images. */
  content: string;
  encoding?: "utf8" | "base64";
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
  encoding?: "base64";
  mime?: string;
  width?: number;
  height?: number;
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
  if (input.encoding !== undefined && input.encoding !== "utf8" && input.encoding !== "base64") {
    throw new Error("Artifact encoding must be utf8 or base64.");
  }
  let bytes: Buffer;
  if (input.encoding === "base64") {
    if (!isRasterArtifact(input.relativePath) || typeof input.content !== "string"
      || input.content.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
      throw new Error("Base64 artifacts require a static PNG, JPEG or WebP path and at most 4 MiB.");
    }
    bytes = Buffer.from(input.content, "base64");
    if (bytes.toString("base64") !== input.content) throw new Error("Artifact image must use canonical base64.");
    rasterMetadata(bytes);
  } else {
    bytes = requireTextContent(input.content);
  }
  return saveArtifactFile(home, taskId, {
    relativePath: input.relativePath,
    bytes,
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.expectedHead === undefined ? {} : { expectedHead: input.expectedHead })
  });
}

/**
 * `artifact.read`: read `relativePath` at HEAD, or at a pinned `commit` for
 * frozen evidence. Images return explicit base64 and bounded raster metadata;
 * text returns UTF-8. Both carry the resolved commit and exact digest.
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
  const image = isRasterArtifact(safeRelative) ? rasterMetadata(content.bytes) : null;
  let text: string;
  if (image) text = content.bytes.toString("base64");
  else {
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content.bytes); }
    catch { throw new Error("Artifact is not readable UTF-8 text or a supported raster image."); }
    if (text.includes("\0")) throw new Error("Binary artifact is not supported as text.");
  }
  return {
    taskId,
    relativePath: content.relativePath,
    commit: content.commit,
    content: text,
    digest: content.digest,
    ...(image ? { encoding: "base64" as const, ...image } : {})
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
