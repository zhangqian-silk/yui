import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { requireKnownFields } from "../domain/validation.js";
import { jobScopeKey, type JobScope } from "../job/jobDefinition.js";
import { runReference, type JobRunReference } from "../job/jobBusinessResult.js";
import type { JobRun } from "../job/durableJob.js";
import { requireCommitId } from "./managedGit.js";
import { safeRelativeArtifactPath } from "./artifactPaths.js";
import { openTaskArtifactRepository, openVersionedArtifactRepository } from "./taskArtifactRepository.js";

/** Explicit owned evidence. A Task artifact remains in its original Task repo.
 * sourceRun records the exact Job execution publishing/selecting this material. */
export type JobArtifactReference = Readonly<{
  kind: "artifact";
  owner: Readonly<{ kind: "job"; scope: JobScope; jobId: string }> | Readonly<{ kind: "task"; taskId: string }>;
  sourceRun: JobRunReference;
  version: string;
  relativePath: string;
  digest: string;
}>;

function identity(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)) {
    throw new Error("Invalid artifact owner/Run identity.");
  }
  return value;
}

function validateScope(scope: JobScope): void {
  requireKnownFields(scope, scope?.kind === "task" ? ["kind", "taskId"] : ["kind"], "Artifact scope");
  if (scope.kind !== "global" && scope.kind !== "task") throw new Error("Invalid artifact scope.");
  jobScopeKey(scope);
}

export function validateJobArtifactReference(ref: JobArtifactReference, run?: JobRun): JobArtifactReference {
  requireKnownFields(ref, ["kind", "owner", "sourceRun", "version", "relativePath", "digest"], "Artifact reference");
  if (ref.kind !== "artifact") throw new Error("Expected an explicit artifact reference.");
  requireKnownFields(ref.sourceRun, ["scope", "runId"], "Artifact source Run");
  validateScope(ref.sourceRun.scope);
  identity(ref.sourceRun.runId);
  if (ref.owner.kind === "job") {
    requireKnownFields(ref.owner, ["kind", "scope", "jobId"], "Artifact Job owner");
    validateScope(ref.owner.scope);
    identity(ref.owner.jobId);
    if (!isDeepStrictEqual(ref.owner.scope, ref.sourceRun.scope)) throw new Error("Artifact owner/source scope mismatch.");
    if (run && ref.owner.jobId !== run.definitionId) throw new Error("Artifact Job owner mismatch.");
  } else if (ref.owner.kind === "task") {
    requireKnownFields(ref.owner, ["kind", "taskId"], "Artifact Task owner");
    jobScopeKey({ kind: "task", taskId: ref.owner.taskId });
  } else throw new Error("Invalid artifact owner.");
  if (run && !isDeepStrictEqual(ref.sourceRun, runReference(run))) throw new Error("Artifact source Run mismatch.");
  if (requireCommitId(ref.version) !== ref.version) throw new Error("Artifact version must be an exact commit.");
  safeRelativeArtifactPath(ref.relativePath);
  if (ref.relativePath.length > 512) throw new Error("Artifact reference path exceeds 512 characters.");
  if (typeof ref.digest !== "string" || !/^[a-f0-9]{64}$/u.test(ref.digest)) throw new Error("Invalid artifact digest.");
  return ref;
}

export function jobArtifactOwner(run: JobRun): Extract<JobArtifactReference["owner"], { kind: "job" }> {
  return { kind: "job", scope: runReference(run).scope, jobId: run.definitionId };
}

/** Each Run has a distinct working tree and commit fence even for identical paths.
 * The retained storage is unrelated to execution workspaces/logs/checkpoints. */
export function openJobArtifactRepository(home: string, owner: ReturnType<typeof jobArtifactOwner>, sourceRun: JobRunReference) {
  validateScope(owner.scope);
  validateScope(sourceRun.scope);
  if (!isDeepStrictEqual(owner.scope, sourceRun.scope)) throw new Error("Artifact scope mismatch.");
  const scopePath = owner.scope.kind === "global" ? ["global"] : ["task", owner.scope.taskId];
  const path = join(home, "job-artifacts", ...scopePath, identity(owner.jobId), identity(sourceRun.runId));
  const lockKey = `job-${createHash("sha256").update(JSON.stringify([jobScopeKey(owner.scope), owner.jobId, sourceRun.runId])).digest("hex")}`;
  return openVersionedArtifactRepository(home, lockKey, path);
}

export async function readJobArtifactReference(home: string, ref: JobArtifactReference) {
  validateJobArtifactReference(ref);
  const repo = ref.owner.kind === "task"
    ? openTaskArtifactRepository(home, ref.owner.taskId)
    : openJobArtifactRepository(home, ref.owner, ref.sourceRun);
  const content = await repo.read(ref.relativePath, ref.version);
  if (content.digest !== ref.digest) throw new Error("Artifact digest mismatch; preserved evidence was not replaced.");
  return content;
}

export function validateRunArtifacts(run: JobRun): void {
  if (run.artifacts === undefined) return;
  if (!Array.isArray(run.artifacts) || run.artifacts.length > 256
    || Buffer.byteLength(JSON.stringify(run.artifacts)) > 128 * 1024) throw new Error("Run artifacts exceed the bounded reference limit.");
  for (const ref of run.artifacts) validateJobArtifactReference(ref, run);
}

export function artifactsAppendOnly(before: JobRun, after: JobRun): boolean {
  const old = before.artifacts ?? [];
  const next = after.artifacts ?? [];
  return next.length >= old.length && old.every((ref, i) => isDeepStrictEqual(ref, next[i]));
}
