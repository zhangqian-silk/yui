/** Conservative encoded payload bound inside the 1 MiB Controller envelope.
 * JSON escaping/base64 and reference metadata count, not just raw file bytes.
 * Repository limits stay independent; large retained text uses paged preview. */
export const MAX_JOB_ARTIFACT_JSON_BYTES = 256 * 1024;
// Leave room for the fixed reference and presentation metadata added on reads.
export const MAX_JOB_ARTIFACT_RESPONSE_BYTES = 512 * 1024;

export function boundedJobArtifactPayload<T>(value: T, label: string, limit = MAX_JOB_ARTIFACT_JSON_BYTES): T {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > limit) {
    throw new Error(`${label} exceeds the Job artifact ${limit / 1024} KiB encoded JSON transport limit. `
      + "Use smaller material or paged artifact-preview for retained text; source Task material remains available through its owning surface.");
  }
  return value;
}
