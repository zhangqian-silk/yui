import { createHash } from "node:crypto";
import type { JsonValue } from "../core/protocol.js";
import { requireKnownFields, requireText } from "../domain/validation.js";
import type { JobScope } from "./jobDefinition.js";
import type { JobRun, DurableJobOutcome, DurableJobResult } from "./durableJob.js";
import type { AgentJobRun } from "./agentJob.js";

export type JobRunReference = Readonly<{ scope: JobScope; runId: string }>;
/** References identify immutable evidence, not an unversioned filesystem asset. */
export type JobResultReference = Readonly<{
  kind: "run-record" | "execution-evidence";
  owner: JobRunReference;
  sourceRun: JobRunReference;
  version: string; // SHA-256 of the referenced record/file bytes.
  locator: string;
}>;
export type JobBusinessResult = Readonly<{
  schemaVersion: 1;
  sourceRun: JobRunReference;
  outcome: DurableJobOutcome;
  summary: string;
  data?: JsonValue;
  evidence: readonly JobResultReference[];
}>;

export function runReference(run: JobRun | AgentJobRun): JobRunReference {
  if ("executor" in run) return { scope: run.scope, runId: run.id };
  return { scope: "taskId" in run ? { kind: "task", taskId: run.taskId } : { kind: "global" }, runId: run.id };
}

export function resultDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateBusinessResult(result: JobBusinessResult, run: JobRunReference): JobBusinessResult {
  requireKnownFields(result, ["schemaVersion", "sourceRun", "outcome", "summary", "data", "evidence"], "Job business result");
  const matches = (ref: JobRunReference) => {
    requireKnownFields(ref, ["scope", "runId"], "Job result Run reference");
    requireKnownFields(ref.scope, ref.scope?.kind === "task" ? ["kind", "taskId"] : ["kind"], "Job result scope");
    return ref.runId === run.runId && ref.scope.kind === run.scope.kind
      && (run.scope.kind !== "task" || (ref.scope.kind === "task" && ref.scope.taskId === run.scope.taskId));
  };
  if (result.schemaVersion !== 1 || !matches(result.sourceRun)) throw new Error("Job result source Run mismatch.");
  if (!["succeeded", "failed", "cancelled", "timed-out", "unknown-needs-attention"].includes(result.outcome)) {
    throw new Error("Invalid Job business outcome.");
  }
  requireText(result.summary, "Job result summary");
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error("Job business result exceeds 256 KiB.");
  if (!Array.isArray(result.evidence)) throw new Error("Job result evidence must be an array.");
  for (const ref of result.evidence) {
    requireKnownFields(ref, ["kind", "owner", "sourceRun", "version", "locator"], "Job result reference");
    if (!["run-record", "execution-evidence"].includes(ref.kind) || !matches(ref.owner) || !matches(ref.sourceRun)
      || !/^[a-f0-9]{64}$/u.test(ref.version)) throw new Error("Invalid Job result evidence identity/version.");
    requireText(ref.locator, "Job result evidence locator");
    if (ref.locator.startsWith("/") || ref.locator.split("/").includes("..")) throw new Error("Invalid Job evidence locator.");
  }
  return result;
}

/** Shell and historical results describe only what the saved process evidence proves. */
export function processBusinessResult(run: JobRun, result: DurableJobResult): JobBusinessResult {
  const sourceRun = runReference(run);
  const summary = result.unknownReason ?? `Execution ${result.outcome}${result.failedStep ? ` at ${result.failedStep}` : ""}.`;
  return {
    schemaVersion: 1, sourceRun, outcome: result.outcome,
    summary: summary.length <= 4096 ? summary : `${summary.slice(0, 4096)}… (see original execution evidence)`,
    evidence: [{
      kind: "run-record", owner: sourceRun, sourceRun,
      version: resultDigest(JSON.stringify(result)),
      locator: `job-runs/${"taskId" in run ? run.taskId : "global"}/${run.id}/result`
    }]
  };
}

/** Derived only from the admitted Run; never read a mutable definition here. */
export function jobRunSnapshot(run: JobRun) {
  return {
    ...runReference(run), definitionId: run.definitionId, definitionRevision: run.definitionRevision,
    owner: "owner" in run ? run.owner : null,
    trigger: run.trigger, retryOf: run.retryOf ?? null,
    executor: "taskId" in run ? { kind: "shell" as const } : {
      kind: "builtin" as const, action: run.action, input: run.actionInput
    },
    target: { projectId: run.projectId ?? null, workspace: run.workspace, head: run.head },
    execution: { env: run.env, steps: run.steps, implementation: run.operation.implementation }
  };
}
