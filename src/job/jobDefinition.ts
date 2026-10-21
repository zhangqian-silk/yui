import { requireIdentity, requireKnownFields, requirePositiveInteger, requireText, requireTimestamp } from "../domain/validation.js";
import type { DurableJob, DurableJobOwner, DurableJobStep } from "./durableJob.js";
import { validateJobExecutionConfiguration, validateDurableJobOwner } from "./durableJob.js";
import type { JsonValue } from "../core/protocol.js";
import { validateAgentJobConfiguration, type AgentJobConfiguration } from "./agentJob.js";
import { validateTaskJobConfiguration, type TaskJobConfiguration as DelegatedTaskConfiguration } from "./taskDelegation.js";

export type JobScope = Readonly<{ kind: "task"; taskId: string }> | Readonly<{ kind: "global" }>;
export type TaskJobConfiguration = Readonly<{
  kind: "shell";
  owner: DurableJobOwner;
  projectId: string;
  head: string;
  workspace: string;
  env: Readonly<Record<string, string>>;
  steps: readonly DurableJobStep[];
}>;
export type BuiltinJobConfiguration = Readonly<{
  kind: "builtin";
  action: string;
  projectId?: string;
  input: JsonValue;
}>;
export type JobConfiguration = TaskJobConfiguration | BuiltinJobConfiguration | AgentJobConfiguration | DelegatedTaskConfiguration;
export type JobDefinition = Readonly<{
  schemaVersion: 1;
  id: string;
  scope: JobScope;
  title: string;
  revision: number;
  configuration: JobConfiguration;
  /** Compiled installer provenance, never caller-supplied execution authority. */
  builtin?: "project-sync";
  instantiation?: Readonly<{ sourceId: string; sourceRevision: number; key: string }>;
  createdAt: string;
  updatedAt: string;
}>;
export type JobTrigger = Readonly<{
  source: "manual" | "retry" | "schedule" | "integration" | "migration";
  key: string;
}>;

/** Discovery counts for one owning scope; reads still authorize each record. */
export type JobScopeSummary = Readonly<{ scope: JobScope; definitions: number; schedules: number; enabledSchedules: number }>;

export function jobScopeKey(scope: JobScope): string {
  if (scope.kind === "global") return "global";
  requireIdentity(scope.taskId, "Job Task id");
  if (!/^task-\d+$/u.test(scope.taskId)) throw new Error("Invalid Job Task id.");
  return scope.taskId;
}

export function validateJobDefinition(job: JobDefinition): JobDefinition {
  requireKnownFields(job, ["schemaVersion", "id", "scope", "title", "revision", "configuration", "builtin", "instantiation", "createdAt", "updatedAt"], "Job");
  if (job.schemaVersion !== 1) throw new Error("Job schemaVersion must be 1.");
  requireIdentity(job.id, "Job id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(job.id)) throw new Error("Invalid Job definition id.");
  requireText(job.title, "Job title");
  requirePositiveInteger(job.revision, "Job revision");
  requireTimestamp(job.createdAt, "Job createdAt");
  requireTimestamp(job.updatedAt, "Job updatedAt");
  if (job.instantiation !== undefined) {
    requireKnownFields(job.instantiation, ["sourceId", "sourceRevision", "key"], "Job instantiation");
    requireIdentity(job.instantiation.sourceId, "Job source id");
    requirePositiveInteger(job.instantiation.sourceRevision, "Job source revision");
    requireText(job.instantiation.key, "Job instantiation key");
  }
  if (job.scope.kind !== "task" && job.scope.kind !== "global") throw new Error("Invalid Job scope.");
  requireKnownFields(job.scope, job.scope.kind === "task" ? ["kind", "taskId"] : ["kind"], "Job scope");
  jobScopeKey(job.scope);
  const config = job.configuration;
  if (job.builtin !== undefined && (job.builtin !== "project-sync" || job.scope.kind !== "global"
    || config.kind !== "builtin" || config.action !== "project.refresh"
    || job.id !== `project-sync-${config.projectId}` || job.instantiation !== undefined)) {
    throw new Error("Invalid builtin Project sync definition.");
  }
  if (config.kind === "agent") {
    validateAgentJobConfiguration(config);
  } else if (config.kind === "task") {
    validateTaskJobConfiguration(config);
  } else if (job.scope.kind === "global") {
    if (config.kind !== "builtin") throw new Error("Global Jobs require a controlled builtin action.");
    requireKnownFields(config, ["kind", "action", "projectId", "input"], "Builtin Job");
    requireText(config.action, "Builtin action");
    if (config.projectId !== undefined) requireIdentity(config.projectId, "Job Project id");
    if (config.input === undefined) throw new Error("Builtin Job input is required.");
  } else {
    if (config.kind !== "shell") throw new Error("Task Jobs require a managed shell configuration.");
    requireKnownFields(config, ["kind", "owner", "projectId", "head", "workspace", "env", "steps"], "Task Job");
    requireIdentity(config.projectId, "Job Project id");
    validateDurableJobOwner(config.owner, job.scope.taskId);
    validateJobExecutionConfiguration(config);
  }
  return job;
}

export function createJobDefinition(
  input: Pick<JobDefinition, "id" | "scope" | "title" | "configuration">, now: Date
): JobDefinition {
  return validateJobDefinition({
    schemaVersion: 1, ...structuredClone(input), revision: 1,
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  });
}

export function reviseJobDefinition(
  job: JobDefinition, input: Pick<JobDefinition, "title" | "configuration">, now: Date
): JobDefinition {
  if (job.configuration.kind !== input.configuration.kind) {
    throw new Error("Changing Job executor kind requires a new Job id; preserve the original execution history.");
  }
  return validateJobDefinition({
    ...job, title: input.title, configuration: structuredClone(input.configuration),
    revision: job.revision + 1, updatedAt: now.toISOString()
  });
}

/** Old execution IDs are preserved one-to-one; command equality never merges history. */
export function definitionFromTaskRun(run: DurableJob): JobDefinition {
  if (run.delegation) throw new Error("Task delegation already requires a Job definition.");
  return createJobDefinition({
    id: run.definitionId, scope: { kind: "task", taskId: run.taskId }, title: run.steps[0]!.name,
    configuration: {
      kind: "shell", owner: run.owner, projectId: run.projectId, head: run.head,
      workspace: run.workspace, env: run.env, steps: run.steps
    }
  }, new Date(run.createdAt));
}
