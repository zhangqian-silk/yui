import type { TaskStore } from "../storage/taskStore.js";
import { taskAuthorizationSource, type TaskAuthorizationSource } from "../grant/taskAuthorization.js";

/** In-process admission, never a CLI flag or an RPC-supplied authority object.
 * Cleanup deliberately ends the caller. The admitted operation, not a dead
 * Session, owns the final commit; it is valid only for this exact terminal Task. */
export type LeaderArchiveAdmission = Readonly<{
  taskId: string;
  source: TaskAuthorizationSource;
  terminalIdentity: string;
}>;
const admissions = new WeakSet<LeaderArchiveAdmission>();
const terminalIdentity = (store: TaskStore, taskId: string) => {
  const task = store.getTask(taskId);
  if (!task || !["completed", "cancelled"].includes(task.status)) throw new Error("Ordinary Leader archive requires a terminal Task.");
  return JSON.stringify({
    status: task.status, completedAt: task.completedAt, completionSummary: task.completionSummary,
    retiredAt: task.retiredAt, retirementSummary: task.retirementSummary,
    projectBindings: task.projectBindings
  });
};

export function admitLeaderArchive(store: TaskStore, taskId: string, environment: NodeJS.ProcessEnv,
  messageId: string, purpose: string): LeaderArchiveAdmission {
  const source = taskAuthorizationSource(store, taskId, environment, messageId, purpose);
  const admission = Object.freeze({ taskId, source, terminalIdentity: terminalIdentity(store, taskId) });
  admissions.add(admission);
  return admission;
}

export function assertLeaderArchiveAdmission(
  store: TaskStore, taskId: string, admission: LeaderArchiveAdmission
): void {
  if (!admissions.has(admission) || admission.taskId !== taskId
    || terminalIdentity(store, taskId) !== admission.terminalIdentity) {
    throw new Error("Archive admission is untrusted or its terminal Task changed.");
  }
}
