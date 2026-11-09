import { isDeepStrictEqual } from "node:util";
import { basename, join, resolve } from "node:path";
import { createTaskEvent } from "../event/taskEvent.js";
import { validateRoleSessionSet } from "../executor/agentExecutor.js";
import { roleSessionMayContinue, validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import { hasRuntimeCleanupObligation, runtimeLifecycleTarget, type RuntimeRoleOwner } from "../runtime/lifecycleReservation.js";
import type { TaskStore } from "../storage/taskStore.js";

/** Derive only Task-main physical scope. Never adopt Role/model/permission
 * defaults, planning authority, or another WorkItem/Review's workspace. */
export function taskWorkspaceReconfiguration(
  store: TaskStore, owner: RuntimeRoleOwner, effective: EffectiveLaunchSnapshot
): Readonly<{ effective: EffectiveLaunchSnapshot; unsupported?: string }> {
  if (owner.scope !== "task" || effective.executionAuthority !== "delivery") return { effective };
  const main = store.getTaskWorkspace(owner.taskId);
  const role = store.getRole(owner.taskId, owner.roleName);
  if (!main || !role || main.owner.type !== "task"
    || role.workspace !== main.root || effective.workspace.root !== main.root) return { effective };
  const run = store.getActiveRun(owner.taskId, owner.roleName);
  if (run && (run.workspace?.owner.type !== "task" || run.workItemId !== undefined)) return { effective };
  if (store.listWorkItems(owner.taskId).some(item => item.assignee === owner.roleName
    && !["accepted", "retired"].includes(item.status))) return { effective };
  const isolated = store.listManagedWorkspaces(owner.taskId).some(workspace =>
    workspace.owner.type !== "task" && workspace.root === effective.workspace.root);
  if (isolated) return { effective };
  const desired = validateEffectiveLaunchSnapshot({
    ...effective,
    workspace: { root: main.root, entries: main.entries },
    // Task management is not a write grant. Read-only Leaders remain read-only;
    // workers retain their captured Assignment scope.
    writeProjectIds: owner.roleName === "leader" && effective.profileAccess === "write"
      && effective.workspace.entries.filter(entry => entry.access === "write")
        .every(entry => effective.writeProjectIds.includes(entry.projectId))
      ? main.entries.filter(entry => entry.access === "write").map(entry => entry.projectId).sort()
      : effective.writeProjectIds
  });
  if (roleSessionMayContinue(effective, desired)) return { effective };
  // This changes Yui's project configuration, not the Provider's cwd, sandbox,
  // native options or connection. Existing paths/grants must remain identical;
  // additions must be direct children of the already captured native root.
  const sameExistingPaths = effective.workspace.entries.every(previous => {
    const next = main.entries.find(entry => entry.projectId === previous.projectId);
    return next && next.path === previous.path && next.directory === previous.directory
      && next.branch === previous.branch && next.access === previous.access;
  });
  const root = resolve(effective.workspace.root);
  const contained = main.entries.every(entry => entry.directory !== "." && entry.directory !== ".."
    && basename(entry.directory) === entry.directory
    && entry.path === join(root, entry.directory));
  if (!sameExistingPaths || !contained
    || effective.executionEnvironment !== undefined && effective.executionEnvironment.directory.path !== root) {
    return { effective: desired, unsupported:
      "Cannot hot-adopt this Task-main configuration: an existing path, branch or access grant changed, "
      + "or the new Project is outside the captured native root. "
      + "Original Host, Session and inputs are retained; no automatic restart or interruption." };
  }
  return { effective: desired };
}

/** Called in the workspace adoption transaction, before any observer can see a
 * scope mismatch. No Provider call, Turn mutation or lifecycle signal is needed.
 * Runs retain their frozen evidence; live Session authority is read from Store. */
export function adoptTaskWorkspaceConfiguration(
  store: TaskStore, taskId: string, now = new Date()
): void {
  store.transaction(tx => {
    for (const role of tx.listRoles(taskId)) {
      const owner = { scope: "task" as const, taskId, roleName: role.name };
      const set = tx.getTaskRoleSessionSet(taskId, role.name);
      const session = set?.sessions[set.activeAgentId];
      if (!set || !session || session.status !== "active") continue;
      const target = taskWorkspaceReconfiguration(tx, owner, session.effective);
      if (target.unsupported) throw new Error(target.unsupported);
      const effective = target.effective;
      if (isDeepStrictEqual(effective, session.effective)) continue;
      if (hasRuntimeCleanupObligation(tx.getWorkMailbox(runtimeLifecycleTarget(owner)))) {
        throw new Error("An existing runtime lifecycle operation owns this Session; configuration was not adopted.");
      }
      const timestamp = now.toISOString();
      tx.saveTaskRoleSessionSet(validateRoleSessionSet({
        ...set, updatedAt: timestamp, sessions: { ...set.sessions,
          [set.activeAgentId]: { ...session, effective, updatedAt: timestamp } }
      }));
      tx.saveEvent(taskId, createTaskEvent(tx.nextEventId(taskId), taskId,
        "runtime.workspace-scope-adopted", { roleName: role.name, nativeSessionId: session.nativeSessionId,
          previous: JSON.stringify(session.effective.workspace), current: JSON.stringify(effective.workspace),
          previousWriteProjectIds: JSON.stringify(session.effective.writeProjectIds),
          writeProjectIds: JSON.stringify(effective.writeProjectIds), conversationPreserved: "true",
          hostPreserved: "true", adoption: "configuration-only" }, now));
    }
  });
}
