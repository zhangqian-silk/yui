import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { requireIdentity, requireKnownFields, requirePositiveInteger, requireText, requireTimestamp } from "../domain/validation.js";
import type { JobScope, JobTrigger } from "./jobDefinition.js";
import { jobScopeKey } from "./jobDefinition.js";
import { validateBusinessResult, type JobBusinessResult } from "./jobBusinessResult.js";
import type { DurableJobStatus } from "./durableJob.js";
import { validateRunArtifacts, artifactsAppendOnly, type JobArtifactReference } from "../artifacts/jobArtifact.js";

/** Logical roles, never a permanently selected native conversation. */
export type JobAgentTarget =
  | Readonly<{ kind: "operator" }>
  | Readonly<{ kind: "task"; taskId: string; roleName: string; ownerRunId?: string }>
  | Readonly<{ kind: "job"; agentId: string }>;
export type AgentJobConfiguration = Readonly<{
  kind: "agent";
  target: JobAgentTarget;
  input: string;
  concurrency?: "serial" | "isolated";
}>;
export type JobAgentRecipient =
  | Readonly<{ scope: "global"; roleName: string }>
  | Readonly<{ scope: "task"; taskId: string; roleName: string; ownerRunId?: string }>;
export type JobAgentAttempt = Readonly<{
  messageId: string;
  recipient: JobAgentRecipient;
  createdAt: string;
  /** Captured from the original message's exact native delivery, not the latest Session. */
  execution?: Readonly<{ nativeSessionId: string; attemptId: string; nativeTurnId: string }>;
  terminal?: Readonly<{ status: "completed" | "failed" | "cancelled"; observedAt: string }>;
}>;
export type AgentJobRun = Readonly<{
  schemaVersion: 1;
  executor: "agent";
  id: string;
  scope: JobScope;
  definitionId: string;
  definitionRevision: number;
  configuration: AgentJobConfiguration;
  trigger: JobTrigger;
  retryOf?: string;
  status: DurableJobStatus;
  attempts: readonly JobAgentAttempt[];
  businessResult?: JobBusinessResult;
  artifacts?: readonly JobArtifactReference[];
  cancelRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
}>;

export function validateAgentJobConfiguration(config: AgentJobConfiguration): void {
  requireKnownFields(config, ["kind", "target", "input", "concurrency"], "Agent Job configuration");
  if (config.kind !== "agent") throw new Error("Invalid Agent Job executor.");
  requireText(config.input, "Agent Job input");
  if (Buffer.byteLength(config.input) > 65536) throw new Error("Agent Job input exceeds 64 KiB.");
  if (config.concurrency !== undefined && !["serial", "isolated"].includes(config.concurrency)) {
    throw new Error("Invalid Agent Job concurrency.");
  }
  const target = config.target;
  if (target.kind === "operator") requireKnownFields(target, ["kind"], "Operator target");
  else if (target.kind === "task") {
    requireKnownFields(target, ["kind", "taskId", "roleName", "ownerRunId"], "Task Agent target");
    jobScopeKey({ kind: "task", taskId: target.taskId });
    requireIdentity(target.roleName, "Task Role");
    if (target.roleName !== "leader" && !target.ownerRunId) throw new Error("Task Agent target requires its exact Assignment ownerRunId.");
    if (target.ownerRunId !== undefined) requireIdentity(target.ownerRunId, "Assignment Run");
  } else if (target.kind === "job") {
    requireKnownFields(target, ["kind", "agentId"], "Job Agent target");
    requireIdentity(target.agentId, "Job Agent");
  } else throw new Error("Unknown Agent Job target.");
  if (config.concurrency === "isolated" && target.kind !== "job") {
    throw new Error("Isolated concurrency requires a Job-owned Agent; shared roles are serial.");
  }
}

export function jobAgentRoleName(scope: JobScope, jobId: string, runId?: string): string {
  return `job-${createHash("sha256").update(JSON.stringify([scope, jobId, runId ?? null])).digest("hex").slice(0, 32)}`;
}

export function validateAgentJobRun(run: AgentJobRun): AgentJobRun {
  requireKnownFields(run, ["schemaVersion", "executor", "id", "scope", "definitionId", "definitionRevision",
    "configuration", "trigger", "retryOf", "status", "attempts", "businessResult", "cancelRequestedAt",
    "createdAt", "updatedAt", "terminalAt", "artifacts"], "Agent JobRun");
  if (run.schemaVersion !== 1 || run.executor !== "agent") throw new Error("Invalid Agent JobRun.");
  requireIdentity(run.id, "Agent JobRun id");
  requireIdentity(run.definitionId, "Agent Job id");
  requirePositiveInteger(run.definitionRevision, "Agent Job revision");
  requireKnownFields(run.scope, run.scope.kind === "task" ? ["kind", "taskId"] : ["kind"], "Agent Job scope");
  if (!["task", "global"].includes(run.scope.kind)) throw new Error("Invalid Agent Job scope.");
  jobScopeKey(run.scope);
  validateAgentJobConfiguration(run.configuration);
  requireKnownFields(run.trigger, ["source", "key"], "Agent Job trigger");
  if (!["manual", "retry", "schedule"].includes(run.trigger.source)) throw new Error("Invalid Agent Job trigger.");
  requireText(run.trigger.key, "Agent Job trigger key");
  if (!["queued", "running", "succeeded", "failed", "cancelled", "timed-out", "unknown-needs-attention"].includes(run.status)) {
    throw new Error("Invalid Agent JobRun status.");
  }
  requireTimestamp(run.createdAt, "Agent JobRun createdAt");
  requireTimestamp(run.updatedAt, "Agent JobRun updatedAt");
  for (const value of [run.cancelRequestedAt, run.terminalAt]) if (value !== undefined) requireTimestamp(value, "Agent JobRun timestamp");
  if (!Array.isArray(run.attempts) || !run.attempts.length || run.attempts.length > 128) throw new Error("Invalid Agent Job attempts.");
  for (const attempt of run.attempts) {
    requireKnownFields(attempt, ["messageId", "recipient", "createdAt", "execution", "terminal"], "Agent Job attempt");
    requireIdentity(attempt.messageId, "Agent Job message");
    requireTimestamp(attempt.createdAt, "Agent Job attempt timestamp");
    const recipient = attempt.recipient;
    requireKnownFields(recipient, recipient.scope === "task"
      ? ["scope", "taskId", "roleName", "ownerRunId"] : ["scope", "roleName"], "Agent Job recipient");
    if (!["task", "global"].includes(recipient.scope)) throw new Error("Invalid Agent Job recipient.");
    requireIdentity(recipient.roleName, "Agent Job recipient Role");
    if (recipient.scope === "task") jobScopeKey({ kind: "task", taskId: recipient.taskId });
    if (attempt.execution) {
      requireKnownFields(attempt.execution, ["nativeSessionId", "attemptId", "nativeTurnId"], "Agent Job execution");
      for (const value of Object.values(attempt.execution)) {
        if (typeof value !== "string") throw new Error("Invalid Agent execution identity.");
        requireText(value, "Agent Job execution identity");
      }
    }
    if (attempt.terminal) {
      requireKnownFields(attempt.terminal, ["status", "observedAt"], "Agent Turn terminal");
      if (!attempt.execution || !["completed", "failed", "cancelled"].includes(attempt.terminal.status)) throw new Error("Invalid Agent terminal evidence.");
      requireTimestamp(attempt.terminal.observedAt, "Agent terminal observation");
    }
  }
  if (run.businessResult) {
    validateBusinessResult(run.businessResult, { scope: run.scope, runId: run.id });
    if (run.status !== run.businessResult.outcome || !run.terminalAt) throw new Error("Agent result and terminal disagree.");
  } else if (["succeeded", "failed", "cancelled", "timed-out"].includes(run.status)) {
    throw new Error("Agent Job terminal requires an explicit business result.");
  }
  validateRunArtifacts(run);
  return run;
}

export function assertAgentJobRunTransition(previous: AgentJobRun, next: AgentJobRun): void {
  const mutable = ["status", "attempts", "businessResult", "cancelRequestedAt", "updatedAt", "terminalAt", "artifacts"];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof AgentJobRun>) {
    if (!mutable.includes(key) && !isDeepStrictEqual(previous[key], next[key])) throw new Error("Agent Job snapshot is immutable.");
  }
  if (previous.businessResult && (!isDeepStrictEqual(previous.businessResult, next.businessResult)
    || previous.status !== next.status || previous.terminalAt !== next.terminalAt
    || previous.attempts.length !== next.attempts.length)) throw new Error("Agent Job result is immutable.");
  if (!artifactsAppendOnly(previous, next)) throw new Error("Agent Job artifacts are append-only.");
  if (previous.cancelRequestedAt !== undefined && previous.cancelRequestedAt !== next.cancelRequestedAt) throw new Error("Cancellation is immutable.");
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt) || next.attempts.length < previous.attempts.length) throw new Error("Agent Job history cannot move backwards.");
  previous.attempts.forEach((attempt, index) => {
    const updated = next.attempts[index]!;
    if (!isDeepStrictEqual({ ...attempt, execution: undefined, terminal: undefined }, { ...updated, execution: undefined, terminal: undefined })
      || attempt.execution && !isDeepStrictEqual(attempt.execution, updated.execution)
      || attempt.terminal && !isDeepStrictEqual(attempt.terminal, updated.terminal)) throw new Error("Agent attempt evidence is immutable.");
  });
}
