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
import { jobRunSnapshot } from "../job/jobBusinessResult.js";
import { authorizeServiceJob, requireScheduleService, serviceRunBinding, type ScheduleServiceRef } from "../job/scheduleService.js";

export type RunAdmission = Readonly<{
  run: JobRun;
  created: boolean;
  reason?: "overlap";
}>;

export function authorizeScope(store: TaskStore, scope: JobScope, caller: DurableJobCaller, allowPublic = false): void {
  parseDurableJobCaller(caller as unknown as JsonValue);
  jobScopeKey(scope);
  // Public local ingress is not a fabricated Operator. It grants only immediate
  // controlled global management/actions. Schedule grants are explicit and
  // Task-shell authority is unchanged.
  if (allowPublic && scope.kind === "global" && caller.scope === "user") {
    if (Object.keys(caller).some(key => key !== "scope")) throw new Error("Public user Job caller must not claim a managed identity.");
    return;
  }
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

export function authorizeDefinition(store: TaskStore, job: JobDefinition, caller: DurableJobCaller, write: boolean): void {
  authorizeScope(store, job.scope, caller, true);
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
      const duplicate = !job.instantiation && store.listJobDefinitions({ kind: "global" }).find(other =>
        !other.instantiation && other.id !== job.id && other.configuration.kind === "builtin"
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

export function authorizeRunRead(store: TaskStore, run: JobRun, caller: DurableJobCaller): void {
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
  caller: DurableJobCaller, trigger: JobTrigger, now: Date, retryOf?: string,
  service?: ScheduleServiceRef
): RunAdmission {
  return store.transaction(tx => {
    const job = tx.getJobDefinition(scope, definitionId);
    if (job === null) throw new Error("Job definition not found.");
    authorizeDefinition(tx, job, caller, false);
    const serviceSchedule = service === undefined ? undefined : authorizeServiceJob(tx, job, service, trigger.key);
    if (service && (scope.kind !== "global" || trigger.source !== "schedule" || retryOf !== undefined)) {
      throw new Error("Invalid Schedule service admission.");
    }
    if (!service && caller.scope === "user" && !["manual", "retry"].includes(trigger.source)) {
      throw new Error("Public Job admission only authorizes an immediate manual execution or explicit retry.");
    }
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
    const actorId = service ? "service:schedule" : caller.scope === "user" ? "user" : `global:${caller.role}`;
    let run: GlobalJobRun = {
      schemaVersion: 1, scope: "global", id, definitionId: job.id, definitionRevision: job.revision,
      trigger: structuredClone(trigger), action: job.configuration.action,
      ...(service === undefined ? {} : { serviceAuthorization: structuredClone(service) }),
      actionInput: structuredClone(job.configuration.input),
      ...(job.configuration.projectId === undefined ? {} : { projectId: job.configuration.projectId }),
      ...spec, status: "queued", artifactsLocator: locator,
      idempotencyKey: createHash("sha256").update(JSON.stringify([actorId, requestId])).digest("hex"),
      operation: {
        requestId, actorId, authorityRef: service || caller.scope === "user" ? "pending" : jobAuthorityBinding(tx, "global", caller.role!, ""),
        targetId: job.id, capability: "job.run", implementation: JOB_RUNNER_IMPLEMENTATION,
        inputDigest: createHash("sha256").update(JSON.stringify([job, trigger, retryOf])).digest("hex"),
        effect: "none", receiptRefs: [], partialResultRefs: []
      },
      ...(retryOf === undefined ? {} : { retryOf }),
      createdAt: now.toISOString(), updatedAt: now.toISOString()
    };
    if (serviceSchedule) run = { ...run, operation: { ...run.operation, authorityRef: serviceRunBinding(tx, run, serviceSchedule) } };
    else if (caller.scope === "user") run = { ...run, operation: { ...run.operation, authorityRef: publicJobBinding(tx, run) } };
    validateDurableJob(run);
    tx.saveGlobalJobRun(run);
    return { run, created: true };
  });
}

/** Job owns instantiation; Schedule supplies only the exact version and occurrence. */
export function instantiateJobRun(
  store: TaskStore, home: string, scope: JobScope, definitionId: string, revision: number,
  caller: DurableJobCaller, trigger: JobTrigger, now: Date, service?: ScheduleServiceRef
): RunAdmission {
  return store.transaction(tx => {
    const source = tx.getJobDefinition(scope, definitionId);
    if (!source || source.revision !== revision) throw new Error("Source Job revision changed; explicitly select an available version.");
    authorizeDefinition(tx, source, caller, true);
    const id = `instance-${createHash("sha256").update(JSON.stringify([source.scope, source.id, trigger])).digest("hex")}`;
    const instantiation = { sourceId: source.id, sourceRevision: revision, key: trigger.key };
    let job = tx.getJobDefinition(source.scope, id);
    if (job) {
      if (JSON.stringify(job.instantiation) !== JSON.stringify(instantiation)
        || JSON.stringify(job.configuration) !== JSON.stringify(source.configuration)) {
        throw new Error("Job instance identity conflicts with its original source.");
      }
    } else {
      job = validateJobDefinition({ ...createJobDefinition({ id, scope: source.scope,
        title: source.title, configuration: source.configuration }, now), instantiation });
      tx.saveJobDefinition(job);
    }
    return admitJobRun(tx, home, source.scope, job.id, caller, trigger, now, undefined, service);
  });
}

function publicJobBinding(store: TaskStore, run: GlobalJobRun): string {
  return createHash("sha256").update(JSON.stringify([
    "public-immediate-job/v1", store.getHomeIdentity().homeId, run.id, run.definitionId, run.definitionRevision,
    run.action, run.projectId, run.actionInput, run.trigger, run.operation.requestId
  ])).digest("hex");
}

export function authorizeGlobalJobStart(store: TaskStore, run: GlobalJobRun): void {
  let serviceAdmission = false;
  if (run.operation.actorId === "service:schedule" && run.serviceAuthorization && run.trigger.source === "schedule") {
    try {
      const schedule = requireScheduleService(store, run.serviceAuthorization);
      const job = store.getJobDefinition({ kind: "global" }, run.definitionId);
      if (!job || job.revision !== run.definitionRevision) throw new Error("Schedule Run Job revision changed.");
      authorizeServiceJob(store, job, run.serviceAuthorization, run.trigger.key);
      serviceAdmission = serviceRunBinding(store, run, schedule) === run.operation.authorityRef;
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), { name: "CoreJobError" });
    }
  }
  const publicAdmission = run.operation.actorId === "user"
    && ["manual", "retry"].includes(run.trigger.source)
    && publicJobBinding(store, run) === run.operation.authorityRef;
  if (!serviceAdmission && !publicAdmission && (run.operation.actorId !== "global:operator"
    || jobAuthorityBinding(store, "global", "operator", "") !== run.operation.authorityRef)) {
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
    authorizeScope(store, input.scope, input.caller, true);
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
      if (input.op === "run-get" || input.op === "run-confirm") return run;
      if (input.op === "run-result") return {
        snapshot: jobRunSnapshot(run),
        acceptedAt: run.createdAt, startedAt: run.startedAt ?? null,
        confirmedAt: run.businessResult === undefined ? null : run.terminalAt ?? null,
        status: run.status, result: run.businessResult ?? null
      };
      if (input.op === "run-evidence") return {
        sourceRun: jobRunSnapshot(run), operation: run.operation,
        process: run.process ?? null, checkpoint: run.checkpoint ?? null,
        processResult: run.result ?? null, artifactsLocator: run.artifactsLocator
      };
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
