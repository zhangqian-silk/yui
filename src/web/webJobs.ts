import type { JsonValue } from "../core/protocol.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { JobScope } from "../job/jobDefinition.js";
import { activeLiveRoleAgentSession } from "../executor/agentExecutor.js";
import { createJobDefinitionControl } from "../controller/jobDefinitionControl.js";
import { createScheduleControl } from "../controller/scheduleControl.js";
import { requireKnownFields } from "../domain/validation.js";
import { WebRequestRejected, webLocalMutation } from "./webMutation.js";

/** Local-user ingress only, behind the Web token/origin boundary. Never use
 * this adapter for managed RPC callers. The route fixes scope; the server
 * resolves the current Operator binding on every request. No invented Session
 * or durable second authority: the public services revalidate the binding.
 */
export function createWebJobs(store: TaskStore, home: string) {
  function invoke(scope: JobScope, family: "jobs" | "schedules", value: unknown, write: boolean, now: Date) {
    const apply = (tx: TaskStore) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an operation.");
      requireKnownFields(value, family === "jobs"
        ? ["op", "id", "title", "configuration", "expectedRevision", "runId", "requestId"]
        : ["op", "id", "jobId", "rule", "expectedRevision"], "Web Job/Schedule request");
      const input = value as Record<string, JsonValue>;
      const reads = family === "jobs" ? ["list", "show", "runs", "run-get", "run-result", "run-evidence", "run-delegation", "logs"] : ["list", "show"];
      const writes = family === "jobs" ? ["define", "update", "run", "run-cancel"] : ["create", "update", "enable", "disable"];
      if (!(write ? writes : reads).includes(String(input.op))) throw new Error("Operation is not available on this endpoint.");
      if (scope.kind === "task" && !tx.getTask(scope.taskId)) throw new Error("Task not found.");
      const session = activeLiveRoleAgentSession(tx.getGlobalRoleSessionSet("operator"));
      if (!session) throw new Error("A current Operator Session is required for Job management.");
      const caller = { scope: "global", role: "operator", nativeSessionId: session.nativeSessionId,
        agentId: session.agentId, adapterId: session.adapterId };
      const { requestId, ...fields } = input;
      if (input.op === "run" && (typeof requestId !== "string" || !requestId.trim() || requestId.length > 200)) {
        throw new Error("Immediate execution requires a stable requestId.");
      }
      const params = { ...fields, scope, caller,
        ...(input.op === "run" ? { trigger: { source: "manual", key: requestId } } : {}) } as JsonValue;
      return (family === "jobs" ? createJobDefinitionControl(tx, home) : createScheduleControl(tx, home))(params, now);
    };
    if (write) return webLocalMutation(store, apply);
    try { return store.transaction(apply); }
    catch (error) { throw new WebRequestRejected(error instanceof Error ? error.message : String(error)); }
  }
  return {
    read: (scope: JobScope, family: "jobs" | "schedules", value: unknown, now: Date) => invoke(scope, family, value, false, now),
    mutate: (scope: JobScope, family: "jobs" | "schedules", value: unknown, now: Date) => invoke(scope, family, value, true, now)
  };
}
