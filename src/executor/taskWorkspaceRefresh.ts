import { isDeepStrictEqual } from "node:util";
import { createTaskEvent } from "../event/taskEvent.js";
import { validateRoleSessionSet } from "../executor/agentExecutor.js";
import { roleSessionMayContinue, validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import type { RuntimeRoleOwner } from "../runtime/lifecycleReservation.js";
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
  // Initial support is deliberately narrow: Codex thread/resume receives cwd
  // and thread-scoped sandbox options. ACP/other adapters need their own proof.
  const sameExistingPaths = effective.workspace.entries.every(previous => {
    const next = main.entries.find(entry => entry.projectId === previous.projectId);
    return next && next.path === previous.path && next.directory === previous.directory
      && next.branch === previous.branch && next.access === previous.access;
  });
  if (effective.adapterId !== "codex" || !sameExistingPaths) {
    return { effective: desired, unsupported:
      `Cannot preserve ${effective.adapterId} conversation for this Task-main scope change: `
      + (effective.adapterId !== "codex" ? "adapter scope-resume capability is not established."
        : "an existing path, branch or access grant changed.")
      + " Original Session, permissions and inputs are retained. Inspect exact resources; "
      + "explicit session new is a bounded fallback, never an automatic replay." };
  }
  return { effective: desired };
}

/** The caller owns the existing lifecycle lane and has persisted its drain
 * receipt and observed physical Host exit. Nothing here submits an input. */
export function adoptDrainedTaskWorkspace(
  store: TaskStore, owner: RuntimeRoleOwner, nativeSessionId: string,
  effective: EffectiveLaunchSnapshot, assertCurrent: () => void, now = new Date()
): void {
  if (owner.scope !== "task") throw new Error("Only Task-main scope can be adopted.");
  store.transaction(tx => {
    assertCurrent();
    const set = tx.getTaskRoleSessionSet(owner.taskId, owner.roleName);
    const session = set?.sessions[set.activeAgentId];
    if (!set || !session || session.nativeSessionId !== nativeSessionId
      || tx.getActiveRun(owner.taskId, owner.roleName) !== null) {
      throw new Error("Workspace refresh must wait for the exact Role's durable terminal.");
    }
    const target = taskWorkspaceReconfiguration(tx, owner, session.effective);
    if (target.unsupported || !isDeepStrictEqual(target.effective, effective)) {
      throw new Error("Task-main scope changed after Host drain.");
    }
    const binding = set.providerBinding;
    if (binding && (binding.authority.owner !== "controller"
      || binding.run && ["submitting", "accepted", "delivery-unknown"].includes(binding.run.status))) {
      throw new Error("Workspace refresh cannot adopt unknown or externally owned native execution.");
    }
    const timestamp = now.toISOString();
    tx.saveTaskRoleSessionSet(validateRoleSessionSet({
      ...set, updatedAt: timestamp, sessions: { ...set.sessions,
        [set.activeAgentId]: { ...session, effective, updatedAt: timestamp } }
    }));
    tx.saveEvent(owner.taskId, createTaskEvent(tx.nextEventId(owner.taskId), owner.taskId,
      "runtime.workspace-scope-adopted", { roleName: owner.roleName, nativeSessionId,
        previous: JSON.stringify(session.effective.workspace), current: JSON.stringify(effective.workspace),
        previousWriteProjectIds: JSON.stringify(session.effective.writeProjectIds),
        writeProjectIds: JSON.stringify(effective.writeProjectIds), conversationPreserved: "true" }, now));
  });
}
