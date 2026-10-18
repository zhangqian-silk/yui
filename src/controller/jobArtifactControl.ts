import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "../core/protocol.js";
import { requireKnownFields } from "../domain/validation.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { JobScope } from "../job/jobDefinition.js";
import type { JobRun as ProcessJobRun } from "../job/durableJob.js";
import type { AgentJobRun } from "../job/agentJob.js";
type JobRun = ProcessJobRun | AgentJobRun;
import { runReference } from "../job/jobBusinessResult.js";
import { createJobDefinitionControl } from "./jobDefinitionControl.js";
import { assertCallerAuthorized, type DurableJobCaller } from "./jobControl.js";
import { artifactInputBytes, presentArtifactContent, type ArtifactSaveCapabilityInput } from "../artifacts/artifactCapability.js";
import { previewArtifactContent } from "../web/webMaterials.js";
import { boundedJobArtifactPayload, MAX_JOB_ARTIFACT_RESPONSE_BYTES } from "../artifacts/jobArtifactTransport.js";
import {
  jobArtifactOwner, openJobArtifactRepository, readJobArtifactReference,
  validateJobArtifactReference, type JobArtifactReference
} from "../artifacts/jobArtifact.js";

type ArtifactRequest = Readonly<{
  op: string; scope: JobScope; caller: DurableJobCaller; id: string; runId: string;
  artifact?: ArtifactSaveCapabilityInput;
  reference?: JobArtifactReference;
  offset?: number;
}>;

/** Git commits precede database publication. A failed publication retains the exact
 * commit and returns its reference for explicit registration, never business replay.
 * Never hold a synchronous SQLite transaction across awaited Git operations. */
export async function controlJobArtifact(store: TaskStore, home: string, value: JsonValue, now: Date) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Job artifact request.");
  requireKnownFields(value, ["op", "scope", "caller", "id", "runId", "artifact", "reference", "offset"], "Job artifact request");
  const input = value as unknown as ArtifactRequest;
  const current = (): JobRun => createJobDefinitionControl(store, home)({
    op: "run-get", scope: input.scope, caller: input.caller, id: input.id, runId: input.runId
  } as JsonValue, now) as JobRun;
  const run = current(); // Both definition and historical Assignment authorization.
  const repo = openJobArtifactRepository(home, jobArtifactOwner(run), runReference(run));
  if (input.op === "artifact-list") {
    const head = await repo.head();
    const files = head === null ? [] : await repo.list(head);
    if (files.length > 256) throw new Error("Artifact repository exceeds the bounded 256-file listing.");
    const saved: JobArtifactReference[] = [];
    if (head !== null) for (const file of files) {
      // One bounded file at a time: a valid 256-file repository must not spawn
      // hundreds of Git children or materialize all 8 MiB blobs concurrently.
      const content = await repo.read(file.relativePath, head);
      saved.push({ kind: "artifact", owner: jobArtifactOwner(run), sourceRun: runReference(run),
        version: head, relativePath: file.relativePath, digest: content.digest });
    }
    current();
    return { sourceRun: runReference(run), artifacts: run.artifacts ?? [],
      repository: { head, saved, workingChanges: await repo.workingChanges() } };
  }
  if (input.op === "artifact-read" || input.op === "artifact-preview") {
    const ref = validateJobArtifactReference(input.reference!, run);
    // This grants only a deliberately selected, published object, never HEAD or
    // all material in its Task. An arbitrary caller-supplied Task ref is not a grant.
    if (!(run.artifacts ?? []).some(item => isDeepStrictEqual(item, ref))) {
      throw new Error("Artifact reference is not registered for this exact Run.");
    }
    const content = await readJobArtifactReference(home, ref);
    current(); // A replaced Session during I/O must not receive the material.
    return boundedJobArtifactPayload({ reference: ref, ...(input.op === "artifact-preview"
      ? previewArtifactContent(content, input.offset) : presentArtifactContent(content)) }, "Artifact response", MAX_JOB_ARTIFACT_RESPONSE_BYTES);
  }
  if (!["artifact-save", "artifact-register"].includes(input.op)) throw new Error("Unknown Job artifact operation.");
  let ref: JobArtifactReference;
  if (input.op === "artifact-save") {
    const artifact = input.artifact!;
    requireKnownFields(artifact, ["relativePath", "content", "encoding", "message", "expectedHead"], "Job artifact save");
    boundedJobArtifactPayload(artifact, "Artifact save");
    if (typeof artifact.relativePath !== "string" || artifact.relativePath.length > 512) throw new Error("Artifact path exceeds 512 characters.");
    if ((run.artifacts?.length ?? 0) >= 256) throw new Error("Run artifacts exceed the bounded reference limit.");
    const bytes = artifactInputBytes(artifact);
    const saved = await repo.save({ files: [{ relativePath: artifact.relativePath, bytes }],
      message: artifact.message ?? `Save ${artifact.relativePath}`, expectedHead: artifact.expectedHead });
    const content = await repo.read(artifact.relativePath, saved.commit);
    ref = { kind: "artifact", owner: jobArtifactOwner(run), sourceRun: runReference(run),
      version: saved.commit, relativePath: content.relativePath, digest: content.digest };
  } else {
    ref = validateJobArtifactReference(input.reference!, run);
    if (ref.owner.kind === "task") {
      // Only a Task Leader or Operator with current access may select Task material.
      // Assignment readers cannot manufacture a cross-entity grant.
      if (!(input.caller.scope === "global" && input.caller.role === "operator")
        && !(input.caller.scope === "task" && input.caller.role === "leader")) {
        throw new Error("Selecting Task artifacts requires its authorized Leader or Operator.");
      }
      assertCallerAuthorized(store, input.caller, ref.owner.taskId);
    }
    await readJobArtifactReference(home, ref);
  }
  try {
    return store.transaction(tx => {
      const fresh = current();
      if (ref.owner.kind === "task") assertCallerAuthorized(tx, input.caller, ref.owner.taskId);
      const previous = fresh.artifacts ?? [];
      if (previous.some(item => isDeepStrictEqual(item, ref))) return { status: "registered", reference: ref };
      const next = { ...fresh, artifacts: [...previous, ref],
        updatedAt: new Date(Math.max(now.getTime(), Date.parse(fresh.updatedAt))).toISOString() };
      if ("executor" in next) tx.saveAgentJobRun(next);
      else if ("taskId" in next) tx.saveDurableJob(next.taskId, next);
      else tx.saveGlobalJobRun(next);
      return { status: "registered", reference: ref };
    });
  } catch (cause) {
    // An explicit partial receipt survives the RPC's bounded exception text.
    // It is NOT a published result. Never replay the business action or silently
    // retry the database write to conceal this boundary.
    return { status: "saved-unregistered", reference: ref,
      error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 4096),
      recovery: "Inspect artifact-list and register this exact reference; do not rerun business work." };
  }
}
