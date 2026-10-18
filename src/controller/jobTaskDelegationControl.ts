import { createHash, randomUUID } from "node:crypto";
import { createTaskAggregate } from "../commands/taskCommands.js";
import { isDurableJobTerminal, validateDurableJob, type JobRun } from "../job/durableJob.js";
import { resultDigest, runReference, type JobBusinessResult } from "../job/jobBusinessResult.js";
import { validateTaskJobConfiguration, workItemDefinitionDigest, type TaskJobConfiguration } from "../job/taskDelegation.js";
import type { JobDefinition, JobTrigger } from "../job/jobDefinition.js";
import type { TaskStore } from "../storage/taskStore.js";
import { assertCallerAuthorized, type DurableJobCaller } from "./jobControl.js";
import { enqueueWork } from "../coordination/workMailboxQueue.js";
import { isDeepStrictEqual } from "node:util";

/** Scope authorization is performed by the Job ingress; provenance adds none. */
export function authorizeTaskJob(store: TaskStore, job: JobDefinition, caller: DurableJobCaller, write: boolean): void {
  if (job.configuration.kind !== "task") throw new Error("Not a Task delegation.");
  validateTaskJobConfiguration(job.configuration);
  if (caller.scope === "task") {
    if (!write && caller.role === "leader") return;
    // Creating another Task is a cross-Task effect, not inherited authority.
    if (caller.role !== "leader" || job.configuration.target.kind === "new"
      || job.configuration.target.taskId !== caller.taskId) {
      throw new Error("Task delegation requires exact target authority; source Job scope grants no cross-Task permission.");
    }
    assertCallerAuthorized(store, caller, caller.taskId!);
    if (write) {
      const session = store.getTaskRoleSessionSet(caller.taskId!, "leader");
      const effective = session?.sessions[session.activeAgentId]?.effective;
      if (effective?.executionAuthority !== "delivery" || effective.profileAccess !== "write") {
        throw new Error("Task delegation requires a current writable delivery Session.");
      }
    }
  }
  if (!write) return;
  if (job.scope.kind === "task") {
    const source = store.getTask(job.scope.taskId);
    if (!source || source.status !== "active" || source.executionGate.state !== "enabled") throw new Error("Source Task is not executable.");
  }
  const target = job.configuration.target;
  if (target.kind === "new") {
    for (const binding of target.projectBindings) {
      const project = store.listProjects().find(project => project.id === binding.projectId);
      if (!project || project.status !== "active") throw new Error("Target Project is not active.");
    }
  } else {
    const task = store.getTask(target.taskId);
    const work = store.getWorkItem(target.taskId, target.workItemId);
    if (!task || task.status !== "active" || task.executionGate.state !== "enabled"
      || !work || work.status !== "open" || work.revision !== target.revision) {
      throw new Error("An exact open WorkItem revision in an executable Task is required.");
    }
  }
}

/** Inside Run admission's transaction: Task/Leader + Run + association commit together. */
export function admitTaskJob(
  store: TaskStore, job: JobDefinition & { configuration: TaskJobConfiguration },
  caller: DurableJobCaller, trigger: JobTrigger, requestId: string, now: Date, retryOf?: string
): JobRun {
  const config = job.configuration;
  const id = job.scope.kind === "global" ? `job-${randomUUID()}` : store.nextDurableJobId(job.scope.taskId);
  const sourceRun = { scope: job.scope, runId: id };
  const target = config.target;
  const taskId = target.kind === "new" ? createTaskAggregate(store, target.title, {
    description: target.description, projectBindings: target.projectBindings,
    ...(target.type === undefined ? {} : { type: target.type })
  }, now, [], { kind: "job-run", jobId: job.id, run: sourceRun }).task.id : target.taskId;
  const delegation = { taskId, goal: config.goal,
    ...(target.kind === "work-item" ? { workItemId: target.workItemId, workItemRevision: target.revision,
      workItemDefinitionDigest: workItemDefinitionDigest(store.getWorkItem(taskId, target.workItemId)!) } : {}) };
  const actorId = caller.scope === "user" ? "user" : `${caller.scope}:${caller.role}`;
  const inputDigest = resultDigest(JSON.stringify([job, trigger, retryOf]));
  const locator = `artifacts/jobs/${job.scope.kind === "global" ? "global" : job.scope.taskId}/${id}`;
  const run = validateDurableJob({
      schemaVersion: 1 as const,
      ...(job.scope.kind === "global" ? { scope: "global" as const }
        : { taskId: job.scope.taskId, owner: { kind: "task" as const } }),
      id, definitionId: job.id, definitionRevision: job.revision, trigger,
      delegation, artifactsLocator: locator,
      idempotencyKey: createHash("sha256").update(JSON.stringify([actorId, requestId])).digest("hex"),
      operation: { requestId, actorId, inputDigest, authorityRef: inputDigest,
        targetId: taskId, capability: "job.run", implementation: { id: "yui:task-delegation", generation: "1" },
        effect: "confirmed" as const, receiptRefs: [`tasks/${taskId}`], partialResultRefs: [] },
      status: "running" as const, startedAt: now.toISOString(),
      ...(retryOf === undefined ? {} : { retryOf }),
      createdAt: now.toISOString(), updatedAt: now.toISOString()
  });
  saveRun(store, run);
  if (config.goal === "task-created") return reconcileTaskDelegation(store, run, now);
  return run;
}

function saveRun(store: TaskStore, run: JobRun): void {
  if ("taskId" in run) store.saveDurableJob(run.taskId, run);
  else store.saveGlobalJobRun(run);
}

/** Collection is transactional, repeatable, and never executes/activates/stops a Task. */
export function reconcileTaskDelegation(store: TaskStore, observed: JobRun, now: Date): JobRun {
  return store.transaction(tx => {
    const run = "taskId" in observed ? tx.getDurableJob(observed.taskId, observed.id) : tx.getGlobalJobRun(observed.id);
    if (!run || !run.delegation || isDurableJobTerminal(run.status)) return run ?? observed;
    const link = run.delegation;
    const task = tx.getTask(link.taskId);
    if (!task) throw new Error("Delegated Task is missing; preserve the exact Run for inspection.");
    if (link.goal !== "work-item" && (task.source?.jobId !== run.definitionId
      || !isDeepStrictEqual(task.source.run, runReference(run)))) {
      throw new Error("Delegated Task creation source does not match the exact Run.");
    }
    let outcome: JobBusinessResult["outcome"] | undefined;
    let summary = "";
    let evidence: JobBusinessResult["evidence"] = [];
    if (link.goal === "task-created") {
      outcome = "succeeded"; summary = `Explicit creation goal met: ${task.id}; no delivery completion is claimed.`;
      const event = tx.listEventsByType(task.id, ["task.created"])[0];
      if (!event) throw new Error("Delegated Task creation evidence is missing.");
      evidence = [{ kind: "task-result", owner: { kind: "task", taskId: task.id },
        sourceRun: runReference(run), version: resultDigest(JSON.stringify(event)), locator: `events/${event.id}` }];
    } else if (link.goal === "work-item") {
      const work = tx.getWorkItem(task.id, link.workItemId!);
      if (!work || workItemDefinitionDigest(work) !== link.workItemDefinitionDigest) {
        outcome = "unknown-needs-attention"; summary = "Delegated WorkItem requirements changed or are missing; inspect the exact scope.";
      } else if (work.status === "retired") {
        outcome = "failed"; summary = `Delegated WorkItem retired: ${work.id}.`;
      } else if (work.status === "accepted") {
        const candidate = work.candidates.find(candidate => candidate.id === work.acceptedCandidateId
          && candidate.workItemRevision >= link.workItemRevision!);
        if (!candidate) throw new Error("Accepted delegation has no exact Candidate; preserve evidence.");
        outcome = "succeeded"; summary = work.outcome ?? candidate.summary;
        evidence = [{ kind: "work-item-result", owner: { kind: "task", taskId: task.id },
          sourceRun: runReference(run), version: resultDigest(JSON.stringify(candidate)),
          locator: `work-items/${work.id}/candidates/${candidate.id}` }];
      }
    } else {
      // The never-rewritten completion event identifies the exact lifecycle,
      // even if the Task is reopened before this collector runs.
      const event = tx.listEventsByType(task.id, ["task.completed"]).find(event => event.createdAt >= run.createdAt);
      if (event) {
        outcome = "succeeded"; summary = String(event.payload.summary);
        evidence = [{ kind: "task-result", owner: { kind: "task", taskId: task.id },
          sourceRun: runReference(run), version: resultDigest(JSON.stringify(event)), locator: `events/${event.id}` }];
      } else if (task.status === "cancelled" || (task.status === "archived" && task.completedAt === undefined)) {
        outcome = "failed"; summary = `Delegated Task ended without the requested delivery: ${task.id}.`;
      } else if (task.completedAt !== undefined) {
        outcome = "unknown-needs-attention"; summary = "Task reports completion without immutable completion-event evidence; inspect the target.";
      }
    }
    // Like process collection, already-proven delivery wins over a late cancel.
    // Cancelling an unsettled wait never fabricates target resource quiescence.
    if (!outcome && run.cancelRequestedAt) {
      outcome = "cancelled";
      summary = "This Run's delegation was cancelled; the target Task/Leader/WorkItem was not stopped. Inspect its own resources separately.";
    }
    if (!outcome) return run;
    const businessResult = { schemaVersion: 1 as const, sourceRun: runReference(run), outcome,
      summary, evidence };
    const next = validateDurableJob({ ...run, status: outcome, businessResult, wakeupNotified: true,
      terminalAt: now.toISOString(), updatedAt: now.toISOString() });
    saveRun(tx, next);
    if ("taskId" in run) enqueueWork(tx, { kind: "role", taskId: run.taskId, roleName: "leader" },
      "job-finished", now, [{ type: "task", id: run.taskId }]);
    else if (run.operation.actorId !== "user") enqueueWork(tx, { kind: "operator" }, "global-job-finished",
      now, [{ type: "global-job-run", id: run.id }], { source: "global-job", dedupeKey: `operator-global-job-run:${run.id}` });
    return next;
  });
}

/** Bounded projection only; source permissions never open the target's Context. */
export function taskDelegationView(store: TaskStore, run: JobRun) {
  if (!run.delegation) return null;
  const task = store.getTask(run.delegation.taskId);
  return { ...run.delegation, taskStatus: task?.status ?? null,
    executionGate: task?.executionGate.state ?? null,
    openInputs: store.listInputRequests(run.delegation.taskId).filter(input => input.status === "open").length,
    result: run.businessResult ?? null,
    cancellation: run.cancelRequestedAt ? "requested; target resources not stopped" : null };
}
