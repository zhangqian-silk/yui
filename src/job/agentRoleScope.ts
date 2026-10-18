import type { TaskStore } from "../storage/taskStore.js";
import type { GlobalRole } from "../role/role.js";

/** A Job execution role is not a second Operator. Normal global Roles retain
 * their contract; this narrows only explicitly Job-owned managed CLI callers.
 * Job RPCs still authorize exact scope/Run and current native identity. */
export function assertJobAgentCommand(role: GlobalRole, args: readonly string[]): void {
  if (!role.jobOwner) return;
  const [command, action, operation, target] = args;
  const allowed = command === "job" && ["show", "runs", "run-get", "run-result", "run-context",
    "run-claim", "run-report", "run-evidence", "run-confirm", "artifact-save", "artifact-list",
    "artifact-read", "artifact-preview", "artifact-register"].includes(action ?? "")
    || command === "session" && (action === "skills" || action === "context" && operation === role.name)
    || command === "role" && action === "message" && ["list", "show"].includes(operation ?? "") && target === role.name
    || command === "inbox" && ["list", "show", "claim", "ack"].includes(action ?? "")
    || ["help", "version"].includes(command ?? "");
  if (!allowed) throw new Error("Job Agent authority is limited to its own context, inbox and exact Job execution; management requires its owner.");
}

/** Global runtime transport does not give a Job's execution Role global authority. */
export function assertJobRoleRunnable(store: TaskStore, role: GlobalRole): void {
  const owner = role.jobOwner;
  if (!owner) return;
  const job = store.getJobDefinition(owner.scope, owner.jobId);
  if (!job || job.configuration.kind !== "agent" || job.configuration.target.kind !== "job"
    || job.configuration.target.agentId !== role.activeAgentId) throw new Error("Job-owned Role configuration changed; inspect the original Job and pending input.");
  if (owner.scope.kind === "task") {
    const task = store.getTask(owner.scope.taskId);
    if (task?.status !== "active" || task.executionGate.state !== "enabled") {
      throw new Error("Job-owned Role cannot execute while its owning Task is stopped or terminal.");
    }
  }
}
