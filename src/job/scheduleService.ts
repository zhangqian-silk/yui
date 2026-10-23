import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Schedule } from "../schedule/schedule.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { JobDefinition } from "./jobDefinition.js";
import type { GlobalJobRun } from "./durableJob.js";
import { requireProjectSyncTarget } from "./projectSync.js";

/** Internal compiled registration, not a caller identity accepted by RPC. */
const actions = new Set(["system.noop", "project.refresh"]);
export type ScheduleServiceRef = Readonly<{ scheduleId: string; grantId: string }>;

export function requireServiceTarget(job: JobDefinition): void {
  if (job.scope.kind === "global" && job.configuration.kind === "shell") return;
  if (job.scope.kind !== "global" || job.configuration.kind !== "builtin"
    || !actions.has(job.configuration.action)) throw new Error("Schedule service is not registered for this scope/action.");
}

export function scheduleServiceBinding(store: TaskStore, schedule: Pick<Schedule, "id" | "scope" | "jobId" | "target">,
  job: JobDefinition, grantId: string): string {
  requireServiceTarget(job);
  return createHash("sha256").update(JSON.stringify([
    "schedule-service/v1", store.getHomeIdentity().homeId, grantId,
    schedule.id, schedule.scope, schedule.jobId, schedule.target, job
  ])).digest("hex");
}

export function requireScheduleService(store: TaskStore, ref: ScheduleServiceRef): Schedule {
  const schedule = store.getSchedule({ kind: "global" }, ref.scheduleId);
  const auth = schedule?.authorization;
  if (!schedule || auth?.kind !== "service" || auth.revoked || auth.grantId !== ref.grantId) {
    throw new Error("Schedule service authority was revoked; no execution was started.");
  }
  const source = store.getJobDefinition(schedule.scope, schedule.jobId);
  if (!source || source.revision !== auth.jobRevision
    || scheduleServiceBinding(store, schedule, source, auth.grantId) !== auth.binding) {
    throw new Error("Schedule service target or authority changed; explicitly reauthorize.");
  }
  if (schedule.builtin) {
    if (!schedule.builtin.enabled) throw new Error("Builtin Project sync was disabled.");
    requireProjectSyncTarget(store, source);
  }
  return schedule;
}

/** Bind each immutable Run to its exact stored grant, definition and input. */
export function serviceRunBinding(store: TaskStore, run: GlobalJobRun, schedule: Schedule): string {
  return createHash("sha256").update(JSON.stringify([
    "schedule-service-run/v1", store.getHomeIdentity().homeId, schedule.authorization.binding,
    run.serviceAuthorization, run.id, run.definitionId, run.definitionRevision,
    run.action, run.projectId, run.actionInput, run.trigger, run.operation.requestId
  ])).digest("hex");
}

export function authorizeServiceJob(store: TaskStore, job: JobDefinition, ref: ScheduleServiceRef, key: string): Schedule {
  const schedule = requireScheduleService(store, ref);
  const source = store.getJobDefinition(schedule.scope, schedule.jobId)!;
  const matches = schedule.target.kind === "existing-job" ? job.id === source.id
    : job.instantiation?.sourceId === source.id && job.instantiation.sourceRevision === source.revision
      && job.instantiation.key === key;
  if (!matches || !key.startsWith(`${schedule.id}:`)
    || !isDeepStrictEqual(job.configuration, source.configuration)) {
    throw new Error("Job is outside the Schedule service authority target.");
  }
  return schedule;
}
