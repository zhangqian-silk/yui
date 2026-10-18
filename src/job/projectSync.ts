import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import type { TaskStore } from "../storage/taskStore.js";
import { managedProjectPath } from "../repository/project.js";
import { requireRefreshProject, projectRefreshTargetDigest } from "../repository/projectRefresh.js";
import { createJobDefinition, reviseJobDefinition, validateJobDefinition, type JobDefinition } from "./jobDefinition.js";
import { nextScheduleDue, validateScheduleRule, type Schedule, type ScheduleRule } from "../schedule/schedule.js";
import { scheduleServiceBinding } from "./scheduleService.js";

const scope = { kind: "global" } as const;
const unavailable = "Project sync unavailable: ";
export const PROJECT_SYNC_INTERVAL_MS = 6 * 60 * 60_000;

/** Called under the maintenance lock immediately before Git, not a timer probe. */
export function requireProjectSyncCheckout(store: TaskStore, job: JobDefinition): void {
  requireProjectSyncTarget(store, job);
  const path = managedProjectPath(store.rootDirectory(), job.configuration.kind === "builtin" ? job.configuration.projectId! : "");
  if (realpathSync(path) !== path || !lstatSync(join(path, ".git")).isDirectory()
    || lstatSync(join(path, ".git")).isSymbolicLink()) {
    throw new Error("Builtin sync requires its own canonical checkout, not a linked or shared worktree.");
  }
}

/** Current registry and maintenance source, not the builtin label, bound authority. */
export function requireProjectSyncTarget(store: TaskStore, job: JobDefinition): void {
  if (job.builtin !== "project-sync" || job.configuration.kind !== "builtin") throw new Error("Not a builtin Project sync.");
  validateJobDefinition(job);
  const project = requireRefreshProject(store, job.configuration.projectId!, true);
  if (resolve(project.path) !== managedProjectPath(store.rootDirectory(), project.id)) {
    throw new Error("Project sync requires its canonical managed checkout.");
  }
  if (!isDeepStrictEqual(job.configuration.input, { targetDigest: projectRefreshTargetDigest(project) })) {
    throw new Error("Project sync target changed; await registry reconciliation.");
  }
  const custom = store.listJobDefinitions(scope).find(other => !other.builtin && !other.instantiation
    && other.configuration.kind === "builtin" && other.configuration.action === "project.refresh"
    && other.configuration.projectId === project.id);
  if (custom) throw new Error(`Existing custom maintenance Job ${custom.id}; builtin sync does not take it over. Explicitly retarget that Job before enabling builtin sync.`);
}

function grant(store: TaskStore, plan: Schedule, job: JobDefinition, now: Date): Schedule["authorization"] {
  requireProjectSyncTarget(store, job);
  const grantId = randomUUID();
  return { kind: "service", service: "schedule", grantId, revoked: false, jobRevision: job.revision,
    grantedBy: { scope: "service", service: "project-sync" }, grantedAt: now.toISOString(),
    binding: scheduleServiceBinding(store, plan, job, grantId) };
}

/** Called by the existing Controller Schedule pass, with no timer or Git effects. */
export function reconcileProjectSync(store: TaskStore, now: Date, onError: (error: Error) => void = () => {}): void {
  const ids = new Set([...store.listProjects().map(p => p.id),
    ...store.listSchedules(scope).flatMap(s => s.builtin ? [s.builtin.projectId] : [])]);
  for (const projectId of ids) {
    try {
      store.transaction(tx => {
        const id = `project-sync-${projectId}`;
        const project = tx.listProjects().find(p => p.id === projectId);
        let job = tx.getJobDefinition(scope, id);
        let plan = tx.getSchedule(scope, id);
        if ((job && job.builtin !== "project-sync") || (plan && !plan.builtin)) {
          throw new Error(`Reserved builtin identity ${id} is occupied; existing records were not adopted.`);
        }
        if (!job && !project) return;
        let changed = false;
        if (project) {
          const configuration = { kind: "builtin" as const, action: "project.refresh", projectId,
            input: { targetDigest: projectRefreshTargetDigest(project) } };
          if (!job) {
            job = validateJobDefinition({ ...createJobDefinition({ id, scope, title: `Project sync · ${project.name}`, configuration }, now),
              builtin: "project-sync" });
            tx.saveJobDefinition(job);
            changed = true;
          } else if (!isDeepStrictEqual(job.configuration, configuration)) {
            job = reviseJobDefinition(job, { title: job.title, configuration }, now);
            tx.saveJobDefinition(job);
            changed = true;
          }
        }
        if (!job) throw new Error(`Builtin Project sync definition missing: ${id}.`);
        let reason: string | undefined;
        try { requireProjectSyncTarget(tx, job); }
        catch (error) { reason = unavailable + (error instanceof Error ? error.message : String(error)); }
        if (!plan) {
          const rule = { kind: "interval" as const, anchor: new Date(now.getTime() + PROJECT_SYNC_INTERVAL_MS).toISOString(),
            everyMs: PROJECT_SYNC_INTERVAL_MS };
          const grantId = randomUUID();
          plan = { schemaVersion: 1, id, scope, jobId: id, target: { kind: "existing-job" }, rule,
            builtin: { projectId, enabled: true }, revision: 1, generation: 1,
            state: reason ? "needs-attention" : "enabled", nextDue: nextScheduleDue(rule, now),
            authorization: { kind: "service", service: "schedule", grantId, revoked: true, jobRevision: job.revision,
              grantedBy: { scope: "service", service: "project-sync" }, grantedAt: now.toISOString(),
              binding: scheduleServiceBinding(tx, { id, scope, jobId: id, target: { kind: "existing-job" } }, job, grantId) },
            ...(reason ? { reason } : {}), createdAt: now.toISOString(), updatedAt: now.toISOString() };
          if (!reason) plan = { ...plan, authorization: grant(tx, plan, job, now) };
          tx.saveSchedule(plan);
          return;
        }
        const original = plan;
        if (plan.authorization.kind !== "service") throw new Error("Builtin Schedule requires service authority.");
        if (reason || !plan.builtin!.enabled) {
          plan = { ...plan, state: plan.builtin!.enabled ? "needs-attention" : "disabled",
            reason: reason ?? "Project sync disabled by user.",
            authorization: { ...plan.authorization, revoked: true } };
        } else if (changed || plan.reason?.startsWith(unavailable)) {
          const { reason: _reason, ...rest } = plan;
          const after = new Date(Math.max(now.getTime(), Date.parse(plan.processedThrough ?? "") || 0));
          plan = { ...rest, state: "enabled", nextDue: nextScheduleDue(plan.rule, after),
            processedThrough: after.toISOString(), generation: plan.generation + 1,
            authorization: grant(tx, plan, job, now) };
        }
        // Unchanged dispatch failures are visible, not automatically retried/re-authorized.
        if (!isDeepStrictEqual(original, plan)) tx.saveSchedule({
          ...plan, revision: original.revision + 1, updatedAt: now.toISOString()
        });
      });
    } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
  }
}

/** Narrow user override. No alternative writable target or authorization surface. */
export function updateProjectSync(store: TaskStore, previous: Schedule, op: string, rule: ScheduleRule | undefined, now: Date): Schedule {
  if (!previous.builtin || previous.authorization.kind !== "service") throw new Error("Not a builtin Schedule.");
  if (!["enable", "disable", "revoke", "update"].includes(op)) throw new Error("Unsupported builtin Schedule operation.");
  const nextRule = rule ?? previous.rule;
  validateScheduleRule(nextRule);
  if (nextRule.kind === "once" || (nextRule.kind === "interval" && nextRule.everyMs < 60_000)) {
    throw new Error("Builtin sync requires a recurring rule (interval at least 60000ms, or five-field cron).");
  }
  const enabled = op === "enable" ? true : ["disable", "revoke"].includes(op) ? false : previous.builtin.enabled;
  const after = new Date(Math.max(now.getTime(), Date.parse(previous.processedThrough ?? "") || 0));
  const { reason: _reason, ...rest } = previous;
  let next: Schedule = { ...rest, builtin: { ...previous.builtin, enabled }, rule: structuredClone(nextRule),
    state: enabled ? "enabled" : "disabled", revision: previous.revision + 1,
    generation: previous.generation + (op === "update" ? 1 : 0), updatedAt: now.toISOString(),
    nextDue: nextScheduleDue(nextRule, after), processedThrough: after.toISOString() };
  if (!enabled) next = { ...next, reason: "Project sync disabled by user.",
    authorization: { ...previous.authorization, revoked: true } };
  else {
    const job = store.getJobDefinition(scope, previous.jobId);
    if (!job) throw new Error("Builtin definition missing.");
    requireProjectSyncTarget(store, job);
    next = { ...next, authorization: previous.authorization.revoked || op === "enable"
      ? grant(store, next, job, now) : previous.authorization };
  }
  store.saveSchedule(next);
  return next;
}
