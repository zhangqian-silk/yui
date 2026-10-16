import type { JsonValue } from "../core/protocol.js";
import { requireKnownFields } from "../domain/validation.js";
import type { JobScope } from "../job/jobDefinition.js";
import { nextScheduleDue, scheduleId, validateSchedule, type Schedule, type ScheduleRule } from "../schedule/schedule.js";
import type { TaskStore } from "../storage/taskStore.js";
import { admitJobRun, authorizeDefinition, authorizeScope, createJobDefinitionControl } from "./jobDefinitionControl.js";
import { jobAuthorityBinding, type DurableJobCaller } from "./jobControl.js";
import type { JobRun } from "../job/durableJob.js";
import { createGlobalRoleMessage } from "../message/message.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { enqueueSupervisorEvent } from "../scheduler/operatorEvent.js";
import { redactLaunchText } from "../runtime/launchDiagnostics.js";

function binding(store: TaskStore, caller: DurableJobCaller, scope: JobScope): string {
  return jobAuthorityBinding(store, caller.scope, caller.role!, scope.kind === "task" ? scope.taskId : "");
}

function authorizeSchedule(store: TaskStore, schedule: Schedule, caller: DurableJobCaller, write: boolean) {
  const job = store.getJobDefinition(schedule.scope, schedule.jobId);
  if (job === null) throw new Error("Schedule Job definition is missing.");
  authorizeDefinition(store, job, caller, write);
  return job;
}

function fence(schedule: Schedule | null, now: Date): Date {
  return new Date(Math.max(now.getTime(), Date.parse(schedule?.processedThrough ?? "") || 0));
}

export function createScheduleControl(store: TaskStore, home: string) {
  return (value: JsonValue, now: Date): unknown => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Schedule request.");
    requireKnownFields(value, ["op", "scope", "caller", "id", "jobId", "rule", "expectedRevision"], "Schedule request");
    const input = value as unknown as {
      op: string; scope: JobScope; caller: DurableJobCaller; id: string;
      jobId?: string; rule?: ScheduleRule; expectedRevision?: number;
    };
    authorizeScope(store, input.scope, input.caller);
    return store.transaction(tx => {
      if (input.op === "list") {
        return tx.listSchedules(input.scope).filter(s => {
          try { authorizeSchedule(tx, s, input.caller, false); return true; } catch { return false; }
        });
      }
      scheduleId(input.id);
      const previous = tx.getSchedule(input.scope, input.id);
      if (input.op === "create") {
        scheduleId(input.jobId!);
        const job = tx.getJobDefinition(input.scope, input.jobId!);
        if (job === null) throw new Error("Schedule Job definition is missing.");
        if (previous !== null) {
          authorizeSchedule(tx, previous, input.caller, false);
          if (previous.jobId !== input.jobId || JSON.stringify(previous.rule) !== JSON.stringify(input.rule)) {
            throw new Error("Schedule id already exists; use update with its revision.");
          }
          return previous;
        }
        authorizeDefinition(tx, job, input.caller, true);
        const due = nextScheduleDue(input.rule!, now);
        if (due === null) throw new Error("A new once Schedule must be in the future.");
        const schedule = validateSchedule({
          schemaVersion: 1, id: input.id, scope: structuredClone(input.scope), jobId: input.jobId!,
          rule: structuredClone(input.rule!), state: "enabled", revision: 1, generation: 1, nextDue: due,
          authorization: { caller: structuredClone(input.caller), binding: binding(tx, input.caller, input.scope), jobRevision: job.revision },
          createdAt: now.toISOString(), updatedAt: now.toISOString()
        });
        tx.saveSchedule(schedule);
        return schedule;
      }
      if (previous === null) throw new Error("Schedule not found.");
      authorizeSchedule(tx, previous, input.caller, false);
      if (input.op === "show") {
        const runs = createJobDefinitionControl(tx, home)({
          op: "runs", scope: input.scope, id: previous.jobId, caller: input.caller
        } as unknown as JsonValue, now) as JobRun[];
        const ownRuns = runs.filter(r => r.trigger.source === "schedule" && r.trigger.key.startsWith(`${previous.id}:`));
        const lastSuccess = ownRuns.filter(r => r.status === "succeeded")
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
        return { schedule: previous, lastSuccess };
      }
      if (previous.revision !== input.expectedRevision) throw new Error("Schedule revision changed; read it before modifying.");
      let next: Schedule;
      if (input.op === "disable") {
        next = { ...previous, state: "disabled", reason: "Explicitly disabled; no future admission. Existing Runs are unchanged." };
      } else if (input.op === "enable" || input.op === "update") {
        if (input.op === "enable" && ["completed", "retired"].includes(previous.state)) {
          throw new Error("Completed/retired Schedule requires an explicit future rule update.");
        }
        const jobId = input.op === "update" ? input.jobId ?? previous.jobId : previous.jobId;
        scheduleId(jobId);
        const rule = input.op === "update" ? input.rule! : previous.rule;
        const job = authorizeSchedule(tx, { ...previous, jobId }, input.caller, true);
        const after = fence(previous, now);
        // Once overlap/disabled intent keeps its original due instant on enable.
        const nextDue = input.op === "enable" && rule.kind === "once"
          ? previous.nextDue : nextScheduleDue(rule, after);
        if (nextDue === null) throw new Error("Rule must have a future occurrence.");
        next = {
          ...previous, jobId, rule: structuredClone(rule), nextDue,
          state: input.op === "enable" || previous.state === "enabled" ? "enabled" : "disabled",
          generation: previous.generation + (input.op === "update" ? 1 : 0),
          processedThrough: after.toISOString(),
          authorization: { caller: structuredClone(input.caller), binding: binding(tx, input.caller, input.scope), jobRevision: job.revision }
        };
        const { reason: _reason, ...withoutReason } = next;
        next = withoutReason;
      } else throw new Error(`Unknown Schedule operation: ${input.op}.`);
      next = { ...next, revision: previous.revision + 1, updatedAt: now.toISOString() };
      tx.saveSchedule(next);
      return next;
    });
  };
}

/** One bounded pass in the existing Controller. Transactions never spawn. */
export function reconcileSchedules(
  store: TaskStore, home: string, now: Date, onError: (error: Error) => void = () => {}, limit = 100
): void {
  for (const candidate of store.listDueSchedules(now.toISOString(), limit)) {
    try {
      store.transaction(tx => {
        const schedule = tx.getSchedule(candidate.scope, candidate.id);
        if (schedule?.state !== "enabled" || schedule.nextDue === null || Date.parse(schedule.nextDue) > now.getTime()) return;
        const dueAt = schedule.nextDue;
        const after = fence(schedule, now);
        if (schedule.scope.kind === "task") {
          const task = tx.getTask(schedule.scope.taskId);
          if (task === null || task.status !== "active" || task.executionGate.state !== "enabled") {
            tx.saveSchedule({ ...schedule, state: "needs-attention", revision: schedule.revision + 1,
              reason: "Task execution unavailable; pending intent retained.", updatedAt: now.toISOString() });
            return;
          }
        }
        const job = authorizeSchedule(tx, schedule, schedule.authorization.caller, true);
        if (job.revision !== schedule.authorization.jobRevision
          || binding(tx, schedule.authorization.caller, schedule.scope) !== schedule.authorization.binding) {
          throw new Error("Schedule authority or Job revision changed; inspect and explicitly enable.");
        }
        const result = admitJobRun(tx, home, schedule.scope, schedule.jobId, schedule.authorization.caller,
          { source: "schedule", key: `${schedule.id}:${schedule.generation}:${dueAt}` }, now);
        const overlap = result.reason === "overlap";
        const nextDue = overlap && schedule.rule.kind === "once" ? dueAt : nextScheduleDue(schedule.rule, after);
        tx.saveSchedule({
          ...schedule, nextDue, state: nextDue === null ? "completed" : "enabled",
          processedThrough: after.toISOString(), revision: schedule.revision + 1,
          lastAttempt: { at: now.toISOString(), dueAt, outcome: overlap ? "overlap" : "admitted", runId: result.run.id },
          updatedAt: now.toISOString()
        });
      });
    } catch (error) {
      const reason = redactLaunchText(error instanceof Error ? error.message : String(error));
      // Admission/advancement rolled back together. Do not retry an unknown error.
      store.transaction(tx => {
        const current = tx.getSchedule(candidate.scope, candidate.id);
        if (current?.state !== "enabled" || current.revision !== candidate.revision) return;
        tx.saveSchedule({ ...current, state: "needs-attention", reason, revision: current.revision + 1,
          lastAttempt: { at: now.toISOString(), dueAt: current.nextDue!, outcome: "blocked", reason },
          updatedAt: now.toISOString() });
        if (current.scope.kind === "task") {
          const event = createTaskEvent(tx.nextEventId(current.scope.taskId), current.scope.taskId,
            "schedule.needs-attention", { scheduleId: current.id, reason }, now);
          tx.saveEvent(current.scope.taskId, event);
          enqueueSupervisorEvent(tx, event, "leader", "schedule-needs-attention", now);
        } else {
          tx.saveGlobalRoleMessage(createGlobalRoleMessage(tx.nextGlobalRoleMessageId(), "operator",
            `Yui-Summary: Schedule ${current.id} needs attention; no Run was admitted.\n`
            + `Reason: ${reason}\nRead: yui schedule show --global --schedule ${current.id}\n`
            + "Inspect the original intent before explicitly enabling; no new authority is implied.",
            "system", { type: "system" }, now,
            { inputControl: { action: "queue", requestId: `schedule-attention:${current.id}:${current.revision}` } }));
        }
      });
      onError(new Error(`Schedule ${candidate.id} needs attention: ${reason}`, { cause: error }));
    }
  }
}
