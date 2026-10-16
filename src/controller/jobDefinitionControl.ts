import { createHash, randomUUID } from "node:crypto";
import { openSync, closeSync, fstatSync, readSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { JsonValue } from "../core/protocol.js";
import { requireKnownFields } from "../domain/validation.js";
import {
  createJobDefinition, reviseJobDefinition, jobScopeKey, validateJobDefinition,
  type JobConfiguration, type JobDefinition, type JobScope, type JobTrigger
} from "../job/jobDefinition.js";
import {
  acknowledgeUnknownDurableJob, requestDurableJobCancel, validateDurableJob,
  JOB_RUNNER_IMPLEMENTATION, executionNamespace, type GlobalJobRun, type JobRun
} from "../job/durableJob.js";
import { prepareBuiltinJob, projectRefreshDigest } from "../job/builtinJob.js";
import { projectRefreshTargetDigest, requireRefreshProject } from "../repository/projectRefresh.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  assertCallerAuthorized, assertNonSecretJobInput, createDurableJobControl,
  jobAuthorityBinding, validateStartParams, requireJobAssignment, parseDurableJobCaller,
  type DurableJobCaller, type DurableJobStartParams
} from "./jobControl.js";
import { createFileArtifactPort } from "./jobSupervisor.js";

export type RunAdmission = Readonly<{
  run: JobRun;
  created: boolean;
  reason?: "overlap";
}>;

function authorizeScope(store: TaskStore, scope: JobScope, caller: DurableJobCaller): void {
  parseDurableJobCaller(caller as unknown as JsonValue);
  jobScopeKey(scope);
  // Match Task Context's Operator-only boundary for global callers as well
  // as excluding Task callers from global Jobs. Session identity alone is not
  // permission for a custom GlobalRole to read or manage Task definitions.
  if ((scope.kind === "global" && caller.scope !== "global")
    || (caller.scope === "global" && caller.role !== "operator")) {
    throw Object.assign(new Error("Only the current Operator Session may access Jobs across global scope."),
      { name: "CoreApplicationError", code: "UNAUTHORIZED" });
  }
  assertCallerAuthorized(store, caller, scope.kind === "task" ? scope.taskId : "");
}

function taskParams(job: JobDefinition, caller: DurableJobCaller, requestId: string): DurableJobStartParams {
  if (job.scope.kind !== "task" || job.configuration.kind !== "shell") throw new Error("Not a Task Job.");
  return { ...job.configuration, taskId: job.scope.taskId, caller, requestId };
}

function authorizeDefinition(store: TaskStore, job: JobDefinition, caller: DurableJobCaller, write: boolean): void {
  authorizeScope(store, job.scope, caller);
  if (job.scope.kind === "task") {
    const params = taskParams(job, caller, "definition-validation");
    // A definition must not reveal another Assignment's commands/environment.
    requireJobAssignment(store, params, caller);
    if (write) validateStartParams(store, params);
    if (write) assertNonSecretJobInput(params);
  } else if (write) {
    if (job.configuration.kind !== "builtin") throw new Error("Global Jobs require builtin actions.");
    prepareBuiltinJob(job.configuration, "/");
    if (job.configuration.action === "project.refresh") {
      const project = requireRefreshProject(store, job.configuration.projectId!, true);
      if (projectRefreshDigest(job.configuration) !== projectRefreshTargetDigest(project)) {
        throw new Error("Project refresh target changed; inspect the Project and explicitly update the Job.");
      }
      const duplicate = store.listJobDefinitions({ kind: "global" }).find(other =>
        other.id !== job.id && other.configuration.kind === "builtin"
        && other.configuration.action === "project.refresh" && other.configuration.projectId === project.id);
      if (duplicate) throw new Error(`Project refresh Job already exists: ${duplicate.id}.`);
    }
  }
}

export function listJobRuns(store: TaskStore, job: JobDefinition): JobRun[] {
  return (job.scope.kind === "task" ? store.listDurableJobs(job.scope.taskId) : store.listGlobalJobRuns())
    .filter(run => run.definitionId === job.id);
}

/** Read-only presentation; attempts/results remain owned by exact JobRuns. */
function presentDefinition(store: TaskStore, job: JobDefinition) {
  if (job.configuration.kind !== "builtin" || job.configuration.action !== "project.refresh") return job;
  const projectId = job.configuration.projectId;
  const targetDigest = projectRefreshDigest(job.configuration);
  const runs = listJobRuns(store, job).filter(run => !("taskId" in run)
    && run.action === "project.refresh" && run.projectId === projectId
    && projectRefreshDigest({ kind: "builtin", action: run.action,
      projectId: run.projectId, input: run.actionInput }) === targetDigest)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const summarize = (run: JobRun | undefined) => run === undefined ? null : {
    runId: run.id, definitionRevision: run.definitionRevision, trigger: run.trigger,
    status: run.status, attemptedAt: run.createdAt, finishedAt: run.terminalAt ?? null
  };
  return { ...job, refresh: {
    projectId, lastAttempt: summarize(runs[0]),
    lastSuccessfulRefresh: summarize(runs.find(run => run.status === "succeeded"))
  } };
}

function authorizeRunRead(store: TaskStore, run: JobRun, caller: DurableJobCaller): void {
  // A revised definition's Assignment does not grant access to earlier Runs.
  if ("taskId" in run) createDurableJobControl(store).getJob(run.taskId, run.id, caller);
}

/**
 * The narrow Schedule seam: call inside the SAME TaskStore transaction as
 * schedule advancement. No external effects occur here; rollback removes the
 * admission as well. The caller must be freshly authenticated on every call.
 */
export function admitJobRun(
  store: TaskStore, home: string, scope: JobScope, definitionId: string,
  caller: DurableJobCaller, trigger: JobTrigger, now: Date, retryOf?: string
): RunAdmission {
  return store.transaction(tx => {
    const job = tx.getJobDefinition(scope, definitionId);
    if (job === null) throw new Error("Job definition not found.");
    authorizeDefinition(tx, job, caller, false);
    if (!trigger.key.trim() || !["manual", "retry", "schedule", "integration"].includes(trigger.source)) {
      throw new Error("Invalid JobRun trigger.");
    }
    const runs = listJobRuns(tx, job);
    const same = runs.find(run => run.trigger.key === trigger.key && run.trigger.source === trigger.source);
    if (same !== undefined) {
      authorizeRunRead(tx, same, caller);
      if (same.definitionRevision !== job.revision || same.retryOf !== retryOf) {
        throw new Error(`JobRun trigger conflicts with its original snapshot: ${same.id}.`);
      }
      return { run: same, created: false };
    }
    authorizeDefinition(tx, job, caller, true);
    const occupied = runs.find(run => run.status === "queued" || run.status === "running"
      || run.status === "unknown-needs-attention");
    if (occupied !== undefined) {
      authorizeRunRead(tx, occupied, caller);
      return { run: occupied, created: false, reason: "overlap" };
    }
    if (retryOf !== undefined && !runs.some(run => run.id === retryOf
      && ["failed", "cancelled", "timed-out"].includes(run.status))) {
      throw new Error("Retry requires an exact failed/cancelled/timed-out Run of this Job.");
    }
    const requestId = `job:${job.id}:${trigger.source}:${trigger.key}`;
    if (scope.kind === "task") {
      const result = createDurableJobControl(tx).startJob({
        ...taskParams(job, caller, requestId), definitionId, trigger, retryOf
      }, now);
      return { run: result.job, created: result.created };
    }
    if (job.configuration.kind !== "builtin") throw new Error("Global Jobs require builtin actions.");
    const id = `job-${randomUUID()}`;
    const locator = `artifacts/jobs/global/${id}`;
    const spec = prepareBuiltinJob(job.configuration, join(home, locator), { home, runId: id });
    const actorId = `global:${caller.role}`;
    const run: GlobalJobRun = validateDurableJob({
      schemaVersion: 1, scope: "global", id, definitionId: job.id, definitionRevision: job.revision,
      trigger: structuredClone(trigger), action: job.configuration.action,
      actionInput: structuredClone(job.configuration.input),
      ...(job.configuration.projectId === undefined ? {} : { projectId: job.configuration.projectId }),
      ...spec, status: "queued", artifactsLocator: locator,
      idempotencyKey: createHash("sha256").update(JSON.stringify([actorId, requestId])).digest("hex"),
      operation: {
        requestId, actorId, authorityRef: jobAuthorityBinding(tx, "global", caller.role!, ""),
        targetId: job.id, capability: "job.run", implementation: JOB_RUNNER_IMPLEMENTATION,
        inputDigest: createHash("sha256").update(JSON.stringify([job, trigger, retryOf])).digest("hex"),
        effect: "none", receiptRefs: [], partialResultRefs: []
      },
      ...(retryOf === undefined ? {} : { retryOf }),
      createdAt: now.toISOString(), updatedAt: now.toISOString()
    });
    tx.saveGlobalJobRun(run);
    return { run, created: true };
  });
}

export function authorizeGlobalJobStart(store: TaskStore, run: GlobalJobRun): void {
  if (run.operation.actorId !== "global:operator"
    || jobAuthorityBinding(store, "global", "operator", "") !== run.operation.authorityRef) {
    throw Object.assign(new Error("Global JobRun caller binding was revoked; no execution was started."), { name: "CoreJobError" });
  }
  // Storage failures are not domain refusals or proof of no execution.
  const projects = run.action === "project.refresh" ? store.listProjects() : [];
  const home = store.rootDirectory();
  try {
    const compiled = prepareBuiltinJob({
      kind: "builtin", action: run.action, input: run.actionInput,
      ...(run.projectId === undefined ? {} : { projectId: run.projectId })
    }, run.workspace, { home, runId: run.id });
    if (run.action === "project.refresh") {
      const project = requireRefreshProject({ listProjects: () => projects, rootDirectory: () => home }, run.projectId!, true);
      if (projectRefreshTargetDigest(project) !== projectRefreshDigest({
        kind: "builtin", action: run.action, projectId: run.projectId, input: run.actionInput
      })) throw new Error("Project refresh target changed before execution.");
      if (run.workspace !== join(home, "artifacts/jobs/global", run.id)) {
        throw new Error("Project refresh Run workspace does not match its artifact directory.");
      }
    }
    if (JSON.stringify(compiled.steps) !== JSON.stringify(run.steps)
      || JSON.stringify(compiled.env) !== JSON.stringify(run.env) || compiled.head !== run.head) {
      throw new Error("Global JobRun does not match its controlled action.");
    }
  } catch (error) {
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }),
      { name: "CoreJobError" });
  }
}

/** One bounded RPC surface; legacy job.start/get/cancel remain exact-run APIs. */
export function createJobDefinitionControl(store: TaskStore, home: string) {
  return (value: JsonValue, now: Date): unknown => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Job request.");
    requireKnownFields(value, ["op", "scope", "caller", "id", "title", "configuration", "expectedRevision", "trigger", "retryOf", "runId"], "Job request");
    const input = value as unknown as {
      op: string; scope: JobScope; caller: DurableJobCaller; id?: string; title?: string;
      configuration?: JobConfiguration; expectedRevision?: number; trigger?: JobTrigger; retryOf?: string; runId?: string;
    };
    authorizeScope(store, input.scope, input.caller);
    return store.transaction(tx => {
      if (input.op === "list") {
        return tx.listJobDefinitions(input.scope).filter(job => {
          try { authorizeDefinition(tx, job, input.caller, false); return true; } catch { return false; }
        }).map(job => presentDefinition(tx, job));
      }
      if (typeof input.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(input.id)) throw new Error("An explicit safe Job id is required.");
      const existing = tx.getJobDefinition(input.scope, input.id);
      if (input.op === "define" || input.op === "update") {
        let configuration = input.configuration!;
        // Empty input is an explicit request to bind the current catalog target.
        // A saved digest is never silently refreshed on run/retry.
        if (input.scope.kind === "global" && configuration?.kind === "builtin"
          && configuration.action === "project.refresh" && JSON.stringify(configuration.input) === "{}") {
          const project = requireRefreshProject(tx, configuration.projectId!, true);
          configuration = { ...configuration, input: { targetDigest: projectRefreshTargetDigest(project) } };
        }
        const fields = { title: input.title!, configuration };
        if (input.op === "define") {
          const next = createJobDefinition({ id: input.id, scope: input.scope, ...fields }, now);
          authorizeDefinition(tx, next, input.caller, true);
          if (existing !== null) {
            if (JSON.stringify(existing.configuration) !== JSON.stringify(next.configuration) || existing.title !== next.title) {
              throw new Error("Job id already exists with different configuration; use update with its revision.");
            }
            return existing;
          }
          tx.saveJobDefinition(next);
          return next;
        }
        if (existing === null || existing.revision !== input.expectedRevision) throw new Error("Job revision changed or Job missing.");
        // The old snapshot may no longer be runnable (for example HEAD moved).
        // Check its ownership before validating the replacement for execution.
        authorizeDefinition(tx, existing, input.caller, false);
        const next = reviseJobDefinition(existing, fields, now);
        authorizeDefinition(tx, next, input.caller, true);
        tx.saveJobDefinition(next);
        return next;
      }
      if (existing === null) throw new Error("Job definition not found.");
      validateJobDefinition(existing);
      authorizeDefinition(tx, existing, input.caller, false);
      if (input.op === "show") return presentDefinition(tx, existing);
      if (input.op === "runs") return listJobRuns(tx, existing).filter(run => {
        try { authorizeRunRead(tx, run, input.caller); return true; }
        catch { return false; }
      });
      if (input.op === "run") {
        if (input.trigger === undefined) throw new Error("A trigger identity is required.");
        // Schedule is an internal transactional caller, not a manual RPC claim.
        if (!["manual", "retry"].includes(input.trigger.source)) throw new Error("RPC triggers must be manual or retry.");
        return admitJobRun(tx, home, input.scope, input.id, input.caller, input.trigger, now, input.retryOf);
      }
      const run = listJobRuns(tx, existing).find(candidate => candidate.id === input.runId);
      if (run === undefined) throw new Error("Exact JobRun not found.");
      authorizeRunRead(tx, run, input.caller);
      if (input.op === "run-get") return run;
      if (input.op === "logs") {
        const steps = run.result?.steps ?? createFileArtifactPort(home)
          .readCheckpoint(executionNamespace(run), run.id)?.completedSteps ?? run.checkpoint?.completedSteps ?? [];
        if (steps.length === 0) return [];
        const root = realpathSync(resolve(home, run.artifactsLocator, "logs"));
        return steps.map(step => {
          const path = realpathSync(resolve(root, step.logPath));
          if (!path.startsWith(root + sep)) throw new Error("JobRun log escaped its artifact directory.");
          const fd = openSync(path, "r");
          try {
            const size = fstatSync(fd).size;
            const bytes = Buffer.alloc(Math.min(size, 65536));
            const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
            return { step: step.name, path, text: bytes.subarray(0, count).toString("utf8"), truncated: size > bytes.length };
          } finally { closeSync(fd); }
        });
      }
      if (input.op === "run-cancel" || input.op === "run-acknowledge") {
        if ("taskId" in run) {
          const control = createDurableJobControl(tx);
          return input.op === "run-cancel"
            ? control.cancelJob(run.taskId, run.id, now, input.caller)
            : control.acknowledgeJob(run.taskId, run.id, now, input.caller);
        }
        const next = input.op === "run-cancel" ? requestDurableJobCancel(run, now) : acknowledgeUnknownDurableJob(run, now);
        tx.saveGlobalJobRun(next);
        return next;
      }
      throw new Error(`Unknown Job operation: ${input.op}.`);
    });
  };
}
