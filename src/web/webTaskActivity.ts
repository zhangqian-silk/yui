import type { TaskStore } from "../storage/taskStore.js";
import { taskNotFound } from "../errors/cliError.js";
import { recordPage, type ReadPageOptions } from "../output/boundedRead.js";
import { resolveRuntimeHealth } from "../config/yuiConfig.js";
import { projectTaskSessions } from "../runtime/taskSessions.js";

/** Native observations are not durable execution records. Flatten only the
 * unfinished, recorded facts so one bounded page cannot hide a large child
 * collection inside a single Session. Detail remains in the native Session. */
export function nativeActivityRows(projection: ReturnType<typeof projectTaskSessions>) {
  return projection.sessions.flatMap(session => {
    const identity = {
      roleName: session.roleName, agentId: session.agentId,
      driverId: session.driverId,
      nativeSessionId: session.nativeSessionId, runId: session.runId,
      sourceUpdatedAt: session.sourceUpdatedAt
    };
    const key = JSON.stringify([session.roleName, session.agentId, session.driverId, session.nativeSessionId]);
    return [
      ...(["idle", "stopped"].includes(session.group) ? [] : [{
        ...identity, id: key, kind: "session", status: session.group,
        summary: session.reason.slice(0, 1200), waitingReason: session.waitingReason,
        lastActivityAt: session.lastActivityAt
      }]),
      ...session.operations.filter(operation => !operation.startsWith("subagent:")).map(operation => ({
        ...identity, id: `${key}/operation/${operation}`, kind: "operation",
        status: "unsettled", summary: operation.slice(0, 1200)
      })),
      ...session.background.map(child => ({
        ...identity, runId: child.runId, id: `${key}/background/${child.id}`, kind: "background",
        status: child.execution, summary: child.id.slice(0, 1200)
      }))
    ];
  });
}

export function readWebTaskActivity(
  store: Pick<TaskStore, "readTransaction" | "getTask" | "listRoleSessionSets" | "listEvents" | "getConfig">,
  taskId: string, options: ReadPageOptions, now = new Date()
) {
  return store.readTransaction(reader => {
    if (reader.getTask(taskId) === null) throw taskNotFound(taskId);
    const projection = projectTaskSessions({
      taskId, sessionSets: reader.listRoleSessionSets(taskId), events: reader.listEvents(taskId), now,
      policy: resolveRuntimeHealth(reader.getConfig().runtimeHealth)
    });
    const rows = nativeActivityRows(projection);
    return {
      ...recordPage(rows, `task:${taskId}/native-activity`, options),
      readAt: now.toISOString(), coverage: "partial",
      scope: projection.coverage,
      counts: {
        sessions: rows.filter(row => row.kind === "session").length,
        operations: rows.filter(row => row.kind === "operation").length,
        background: rows.filter(row => row.kind === "background").length
      }
    };
  });
}
