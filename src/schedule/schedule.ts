import { CronExpressionParser } from "cron-parser";
import { requireKnownFields, requirePositiveInteger, requireTimestamp, requireText } from "../domain/validation.js";
import { jobScopeKey, type JobScope } from "../job/jobDefinition.js";
import { parseDurableJobCaller, type DurableJobCaller } from "../controller/jobControl.js";
import type { JsonValue } from "../core/protocol.js";

export type ScheduleRule =
  | Readonly<{ kind: "once"; at: string }>
  | Readonly<{ kind: "interval"; anchor: string; everyMs: number }>
  | Readonly<{ kind: "cron"; expression: string; timezone: string }>;

export type ScheduleTarget = Readonly<{ kind: "existing-job" }>
  | Readonly<{ kind: "new-job"; definitionRevision: number }>;
export type ScheduleAuthorization =
  | Readonly<{ kind: "session"; caller: DurableJobCaller; binding: string; jobRevision: number }>
  | Readonly<{ kind: "service"; service: "schedule"; grantId: string; revoked: boolean;
      binding: string; jobRevision: number;
      grantedBy: DurableJobCaller | Readonly<{ scope: "service"; service: "project-sync" }>; grantedAt: string }>;

export type Schedule = Readonly<{
  schemaVersion: 1;
  id: string;
  scope: JobScope;
  jobId: string;
  target: ScheduleTarget;
  rule: ScheduleRule;
  revision: number;
  generation: number;
  state: "enabled" | "disabled" | "completed" | "needs-attention" | "retired";
  nextDue: string | null;
  /** Monotonic UTC fence, also retained across edits and wall-clock rollback. */
  processedThrough?: string;
  authorization: ScheduleAuthorization;
  /** User intent is separate from eligibility/dispatch state; rule owns time. */
  builtin?: Readonly<{ projectId: string; enabled: boolean }>;
  lastAttempt?: Readonly<{
    at: string;
    dueAt: string;
    outcome: "admitted" | "overlap" | "blocked";
    runId?: string;
    jobId?: string;
    generation?: number;
    reason?: string;
  }>;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}>;

export function scheduleId(id: string): void {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(id)) {
    throw new Error("An explicit safe Schedule/Job id is required.");
  }
}

function instant(value: string): void {
  requireTimestamp(value, "Schedule instant");
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) throw new Error("Schedule instants require an explicit UTC offset.");
}

export function validateScheduleRule(rule: ScheduleRule): ScheduleRule {
  if (rule?.kind === "once") {
    requireKnownFields(rule, ["kind", "at"], "Once rule");
    instant(rule.at);
  } else if (rule?.kind === "interval") {
    requireKnownFields(rule, ["kind", "anchor", "everyMs"], "Interval rule");
    instant(rule.anchor);
    if (!Number.isSafeInteger(rule.everyMs) || rule.everyMs < 1000) throw new Error("Interval everyMs must be an integer of at least 1000.");
  } else if (rule?.kind === "cron") {
    requireKnownFields(rule, ["kind", "expression", "timezone"], "Cron rule");
    if (typeof rule.timezone !== "string" || !rule.timezone.trim()) throw new Error("An explicit IANA timezone is required.");
    new Intl.DateTimeFormat("en", { timeZone: rule.timezone });
    if (typeof rule.expression !== "string" || rule.expression.trim().split(/\s+/u).length !== 5
      || /\bH\b/iu.test(rule.expression)) throw new Error("Cron requires five fields and does not support random H.");
    CronExpressionParser.parse(rule.expression, { tz: rule.timezone, currentDate: "2026-01-01T00:00:00Z" });
  } else throw new Error("Unknown Schedule rule.");
  return rule;
}

/** Strictly after the fence; once returns null after its single occurrence. */
export function nextScheduleDue(rule: ScheduleRule, after: Date): string | null {
  validateScheduleRule(rule);
  const at = after.getTime();
  if (rule.kind === "once") return Date.parse(rule.at) > at ? new Date(rule.at).toISOString() : null;
  if (rule.kind === "interval") {
    const anchor = Date.parse(rule.anchor);
    return new Date(anchor + Math.max(0, Math.floor((at - anchor) / rule.everyMs) + 1) * rule.everyMs).toISOString();
  }
  return CronExpressionParser.parse(rule.expression, { currentDate: after, tz: rule.timezone }).next().toISOString();
}

export function validateSchedule(value: Schedule): Schedule {
  requireKnownFields(value, ["schemaVersion", "id", "scope", "jobId", "target", "rule", "revision", "generation",
    "state", "nextDue", "processedThrough", "authorization", "builtin", "lastAttempt", "reason", "createdAt", "updatedAt"], "Schedule");
  if (value.schemaVersion !== 1) throw new Error("Invalid Schedule schema.");
  scheduleId(value.id);
  scheduleId(value.jobId);
  validateScheduleTarget(value.target);
  if (!["task", "global"].includes(value.scope.kind)) throw new Error("Invalid Schedule scope.");
  requireKnownFields(value.scope, value.scope.kind === "task" ? ["kind", "taskId"] : ["kind"], "Schedule scope");
  jobScopeKey(value.scope);
  if (value.builtin !== undefined) {
    requireKnownFields(value.builtin, ["projectId", "enabled"], "Builtin Schedule");
    if (!/^project-\d+$/u.test(value.builtin.projectId) || typeof value.builtin.enabled !== "boolean"
      || value.scope.kind !== "global" || value.id !== `project-sync-${value.builtin.projectId}`
      || value.jobId !== value.id || value.target.kind !== "existing-job"
      || value.authorization.kind !== "service") throw new Error("Invalid builtin Schedule.");
  }
  validateScheduleRule(value.rule);
  requirePositiveInteger(value.revision, "Schedule revision");
  requirePositiveInteger(value.generation, "Schedule generation");
  if (!["enabled", "disabled", "completed", "needs-attention", "retired"].includes(value.state)) throw new Error("Invalid Schedule state.");
  if (value.state === "enabled" && value.nextDue === null) throw new Error("Enabled Schedule requires nextDue.");
  if (value.state === "completed" && (value.rule.kind !== "once" || value.nextDue !== null)) throw new Error("Only an admitted once Schedule is completed.");
  if (value.nextDue !== null) instant(value.nextDue);
  if (value.processedThrough !== undefined) instant(value.processedThrough);
  instant(value.createdAt);
  instant(value.updatedAt);
  requirePositiveInteger(value.authorization.jobRevision, "Schedule Job revision");
  if (typeof value.authorization.binding !== "string" || !/^[a-f0-9]{64}$/u.test(value.authorization.binding)) throw new Error("Invalid Schedule authority binding.");
  if (value.authorization.kind === "service") {
    requireKnownFields(value.authorization, ["kind", "service", "grantId", "revoked", "binding", "jobRevision", "grantedBy", "grantedAt"], "Schedule service authorization");
    if (value.scope.kind !== "global" || value.authorization.service !== "schedule"
      || typeof value.authorization.revoked !== "boolean") throw new Error("Invalid Schedule service scope or registration.");
    scheduleId(value.authorization.grantId);
    instant(value.authorization.grantedAt);
    if (value.authorization.grantedBy.scope === "service") {
      requireKnownFields(value.authorization.grantedBy, ["scope", "service"], "Builtin service issuer");
      if (value.authorization.grantedBy.service !== "project-sync" || value.builtin === undefined) {
        throw new Error("Invalid builtin service issuer.");
      }
    } else {
      const manager = parseDurableJobCaller(value.authorization.grantedBy as unknown as JsonValue);
      if ((manager.scope === "user" && Object.keys(manager).length !== 1)
        || (manager.scope !== "user" && (manager.scope !== "global" || manager.role !== "operator" || !manager.nativeSessionId))) {
        throw new Error("Invalid service grant issuer.");
      }
    }
  } else {
    requireKnownFields(value.authorization, ["kind", "caller", "binding", "jobRevision"], "Schedule authorization");
    if (value.authorization.kind !== "session") throw new Error("Explicit Schedule authorization kind is required.");
    const caller = value.authorization.caller;
    requireKnownFields(caller, ["scope", "taskId", "role", "agentId", "adapterId", "nativeSessionId", "runId"], "Schedule caller");
    if (typeof caller.role !== "string" || typeof caller.nativeSessionId !== "string") throw new Error("Schedule authority requires a Role and Session.");
    requireText(caller.role, "Schedule caller role");
    requireText(caller.nativeSessionId, "Schedule caller Session");
    if (caller.scope === "global") {
      if (caller.role !== "operator") throw new Error("Global Schedule authority requires Operator.");
    } else if (caller.scope !== "task" || value.scope.kind !== "task" || caller.taskId !== value.scope.taskId) {
      throw new Error("Schedule caller must belong to its scope.");
    }
  }
  if (value.reason !== undefined) requireText(value.reason, "Schedule reason");
  if (value.lastAttempt !== undefined) {
    requireKnownFields(value.lastAttempt, ["at", "dueAt", "outcome", "runId", "jobId", "generation", "reason"], "Schedule attempt");
    instant(value.lastAttempt.at);
    instant(value.lastAttempt.dueAt);
    if (!["admitted", "overlap", "blocked"].includes(value.lastAttempt.outcome)) throw new Error("Invalid Schedule attempt.");
    if (value.lastAttempt.runId !== undefined) requireText(value.lastAttempt.runId, "Schedule Run id");
    if (value.lastAttempt.jobId !== undefined) scheduleId(value.lastAttempt.jobId);
    if (value.lastAttempt.generation !== undefined) requirePositiveInteger(value.lastAttempt.generation, "Schedule attempt generation");
    if (value.lastAttempt.reason !== undefined) requireText(value.lastAttempt.reason, "Schedule attempt reason");
  }
  return value;
}

export function validateScheduleTarget(target: ScheduleTarget): ScheduleTarget {
  if (target?.kind === "existing-job") requireKnownFields(target, ["kind"], "Schedule target");
  else if (target?.kind === "new-job") {
    requireKnownFields(target, ["kind", "definitionRevision"], "Schedule target");
    requirePositiveInteger(target.definitionRevision, "Schedule source definition revision");
  } else throw new Error("Invalid Schedule target.");
  return target;
}
