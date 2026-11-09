import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { usageError } from "../errors/cliError.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { enqueueWork } from "../coordination/workMailboxQueue.js";
import { NodeGitWorkspace, type GitWorkspacePort } from "../repository/gitWorkspace.js";
import { assertProjectActive, resolveProject } from "../repository/project.js";
import type { TaskStore } from "../storage/taskStore.js";
import { taskLocalActor } from "../task/taskAuthority.js";
import { updateTaskMetadata, type Task } from "../task/task.js";
import type { TaskCommandOptions, TaskCommandExecution } from "./taskCommandTypes.js";

/** A binding-set CAS, independent of unrelated Brief/Message activity. */
export function taskProjectBindingsGuard(task: Task): string {
  return createHash("sha256").update(JSON.stringify(task.projectBindings)).digest("hex");
}

/**
 * Changes the upstream selection, not the physical base. Existing Integration
 * owns rebasing/checks/CAS; this command must never pretend a ref edit moved HEAD.
 * Remote observation is read-only and the transaction rechecks all local inputs.
 */
export async function runTaskProjectUpdateCommand(
  args: readonly string[], store: TaskStore,
  options: TaskCommandOptions & { git?: Pick<GitWorkspacePort, "resolveRemoteHead"> } = {}
): Promise<TaskCommandExecution> {
  const usage = "yui task project update <task> <project> --base <ref> --if-current <writeGuard>";
  const [taskId, projectRef, ...tail] = args;
  const flags = new Map<string, string>();
  for (let index = 0; index < tail.length; index += 2) {
    const key = tail[index]!, value = tail[index + 1];
    if (!["--base", "--if-current"].includes(key) || flags.has(key) || !value?.trim()
      || value.startsWith("--")) throw usageError(usage);
    flags.set(key, value);
  }
  if (!taskId || !projectRef || flags.size !== 2) throw usageError(usage);
  const baseRef = flags.get("--base")!;
  if (baseRef.startsWith("-") || /[\s\0]/.test(baseRef)) throw usageError("Invalid Project base reference.");
  const task = store.getTask(taskId);
  if (!task) throw usageError(`Task not found: ${taskId}.`);
  const actor = taskLocalActor(store, options.environment, taskId);
  if (!["draft", "active"].includes(task.status)) throw usageError("Binding updates require a Draft or active Task.");
  if (flags.get("--if-current") !== taskProjectBindingsGuard(task)) {
    throw usageError("Task Project bindings changed; reread task project list and use its writeGuard.");
  }
  const project = resolveProject(store.listProjects(), projectRef);
  if (!project) throw usageError(`Project not found: ${projectRef}.`);
  assertProjectActive(project, "update a Task binding");
  const binding = task.projectBindings.find(entry => entry.projectId === project.id);
  if (!binding) throw usageError(`Project is not bound to Task: ${project.id}. Use task project add.`);
  if (binding.baseRef === baseRef) return {
    kind: "output", output: `Task Project binding is unchanged: ${taskId}/${project.id}.\n`,
    data: { task, change: "unchanged", writeGuard: taskProjectBindingsGuard(task), workspaceMigrated: false }
  };
  const workspace = store.getTaskWorkspace(taskId);
  const entry = workspace?.entries.find(entry => entry.projectId === project.id);
  if (project.remoteUrl === undefined) throw usageError(`Project has no remote URL: ${project.id}.`);
  const git = options.git ?? new NodeGitWorkspace(() => store.getConfig());
  const remote = await git.resolveRemoteHead({ remoteUrl: project.remoteUrl, branch: baseRef });
  const change = binding.baseCommit === undefined ? "unmaterialized"
    : remote.commit === binding.baseCommit ? "reference-only" : "upstream-target";
  const now = options.now?.() ?? new Date();
  const updated = store.transaction(tx => {
    const current = tx.getTask(taskId);
    if (!current || current.status !== task.status || current.executionGate.state !== task.executionGate.state
      || taskProjectBindingsGuard(current) !== flags.get("--if-current")
      || !isDeepStrictEqual(tx.getTaskWorkspace(taskId), workspace)
      || !isDeepStrictEqual(tx.getProject(project.id), project)) {
      throw usageError("Task Project/workspace changed during reference resolution; reread before retrying.");
    }
    taskLocalActor(tx, options.environment, taskId);
    const next = updateTaskMetadata(current, { projectBindings: current.projectBindings.map(value =>
      value.projectId === project.id ? { ...value, baseRef } : value) }, now);
    tx.saveTask(next);
    if (workspace && entry) tx.saveManagedWorkspace({
      ...workspace, updatedAt: now.toISOString(), entries: workspace.entries.map(value =>
        value.projectId === project.id ? { ...value, baseRef } : value)
    });
    const event = createTaskEvent(tx.nextEventId(taskId), taskId, "task.project-updated", {
      projectId: project.id, actor, previous: JSON.stringify(binding), current: JSON.stringify(next.projectBindings.find(value =>
        value.projectId === project.id)!), change, resolvedCommit: remote.commit,
      workspaceMigrated: "false"
    }, now);
    tx.saveEvent(taskId, event);
    enqueueWork(tx, { kind: "task", taskId }, "task-project-updated", now,
      [{ type: "event", taskId, id: event.id }]);
    return next;
  });
  await options.runtime?.notifyMailboxChanged({ kind: "task", taskId });
  const nextAction = change === "upstream-target"
    ? `yui task upstream integrate ${taskId} --project ${project.id}`
    : undefined;
  return { kind: "output", output: `Updated ${taskId}/${project.id}: ${change}; existing commits and worktree preserved.`
    + (nextAction ? `\nPhysical baseline has NOT moved. Integrate explicitly: ${nextAction}` : "") + "\n",
    data: { task: updated, change, resolvedCommit: remote.commit, workspaceMigrated: false,
      writeGuard: taskProjectBindingsGuard(updated), ...(nextAction ? { nextAction } : {}) } };
}
