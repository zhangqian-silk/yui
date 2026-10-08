import { lstat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  isArchivePersistenceFailure,
  recordArchiveCleanup,
  type ArchiveDiagnostic
} from "../task/archiveDiagnostics.js";
import { archiveExecutionChecks, archiveSettlementChecks } from "../task/archivePreflight.js";
import { projectTaskRemoteDeliveryFromStore } from "../task/remoteDeliveryService.js";
import { CleanupInspectionError } from "../workspace/cleanupInspection.js";
import { WorkItemChangeSetManager } from "../workspace/workItemChangeSetManager.js";
import { withResourceRegistry } from "../resources/resourceRegistryStore.js";
import { jobCleanupBlocker } from "../job/jobCleanupInspection.js";

import type { ReviewRound } from "../review/reviewRound.js";
import {
  hasRuntimeLifecycleWork,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import type {
  WorkItem,
  WorkItemWorkspaceDisposition
} from "../workItem/workItem.js";
import {
  managedWorkspaceKey,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import type { GitWorkspaceRemoval } from "./gitWorkspace.js";
import { acquireProjectMaintenanceLocks } from "./projectMaintenanceLock.js";
import {
  FileTaskWorkspacePreparer,
  WorkspaceCleanupBlockedError
} from "./taskWorkspacePreparer.js";

export { WorkspaceCleanupBlockedError } from "./taskWorkspacePreparer.js";

export type TaskRoleRuntimeStopper = Readonly<{
  stopTaskRoleSessions(taskId: string, roleNames: readonly string[]): Promise<void>;
  /** Prove quiescence, then remove this Task's terminals, including exited panes. */
  releaseTaskTerminals(taskId: string): Promise<void>;
  inspectTaskRolePanes?(taskId: string): readonly Readonly<{
    roleName: string;
    dead: boolean;
  }>[];
  /**
   * Issue 03 archive postcondition. Proves the Task owns no live physical
   * Session resources (Provider roots, tmux panes) before its workspaces are
   * deleted. Implementations must no-op in the default `report` reconcile
   * mode; in `exact-owner-cleanup` mode they throw
   * {@link WorkspaceCleanupBlockedError} while owned resources remain live.
   */
  assertTaskPhysicalResourcesReleased?(taskId: string): Promise<void>;
}>;

type TaskArchiveSnapshot = Readonly<{
  task: Task;
  managedWorkspaces: readonly ManagedWorkspace[];
  workItems: readonly WorkItem[];
  reviewRounds: readonly ReviewRound[];
}>;

/**
 * Coordinates persisted Role cwd changes with the runtime that may still be
 * executing in the previous directory.
 */
export class TaskWorkspaceCoordinator {
  constructor(
    readonly store: TaskStore,
    readonly preparer: FileTaskWorkspacePreparer,
    readonly runtime: TaskRoleRuntimeStopper
  ) {}

  async isolateWorkItem(taskId: string, workItemId: string) {
    const item = this.store.getWorkItem(taskId, workItemId);
    if (item === null) throw new Error(`Work item not found: ${taskId}/${workItemId}.`);
    const assignee = this.#workItemIsolationAssignee(item);
    const activeDevelopRun = this.store.listRuns(item.taskId)
      .find((run) => run.status === "active" && run.workItemId === item.id);
    if (activeDevelopRun !== undefined) {
      throw new Error(`Work Item already has an active Develop AgentRun: ${activeDevelopRun.id}.`);
    }
    const task = this.store.getTask(item.taskId)!;
    const taskProjectIds = task.projectBindings.map(({ projectId }) => projectId);
    const existing = this.store.getWorkItemWorkspace(item.taskId, item.id);
    if (existing !== null
      && existing.owner.type === "work-item"
      && existing.owner.workItemId === item.id
      && sameProjectScope(existing, taskProjectIds, item.writeProjectIds)
      && item.baseRefs === undefined) return existing;
    if (existing !== null) {
      if (existing.owner.type !== "work-item" || existing.owner.workItemId !== item.id) {
        throw new Error(`WorkItem already has another managed workspace: ${item.taskId}/${item.id}.`);
      }
    }
    await this.preparer.prepareTaskWorkspace(item.taskId);
    const prepared = this.store.getWorkItemWorkspace(item.taskId, item.id);
    if (prepared !== null
      && prepared.owner.type === "work-item"
      && prepared.owner.workItemId === item.id
      && sameProjectScope(prepared, taskProjectIds, item.writeProjectIds)
      && item.baseRefs === undefined) return prepared;
    if (prepared !== null) {
      if (prepared.owner.type !== "work-item" || prepared.owner.workItemId !== item.id) {
        throw new Error(`WorkItem already has another managed workspace: ${item.taskId}/${item.id}.`);
      }
    }
    if (assignee !== undefined) await this.#stopLiveRoles(item.taskId, [assignee]);
    return this.preparer.prepareWorkItemWorkspace(item.taskId, item.id);
  }

  async cleanupWorkItem(
    taskId: string,
    workItemId: string,
    disposition: WorkItemWorkspaceDisposition
  ): Promise<GitWorkspaceRemoval> {
    const item = this.store.getWorkItem(taskId, workItemId);
    if (item === null) throw new Error(`Work item not found: ${taskId}/${workItemId}.`);
    if (!isTerminalWorkItem(item)) {
      throw new Error(`Work item must be terminal before cleanup: ${item.id}.`);
    }
    if (item.workspaceDisposition !== undefined
      && item.workspaceDisposition !== disposition) {
      throw new Error(
        `Work item workspace is already recorded as ${item.workspaceDisposition}.`
      );
    }
    if (item.workspaceDisposition === disposition) return "missing";
    // Hold the per-Project maintenance fence so concurrent Project maintenance
    // or Task archive cannot interleave with worktree removal.
    const workspace = this.store.getWorkItemWorkspace(item.taskId, item.id);
    const projectIds = workspace === null
      ? []
      : workspace.entries
        .filter(({ access }) => access === "write")
        .map(({ projectId }) => projectId);
    const releaseMaintenance = projectIds.length === 0
      ? () => {}
      : await acquireProjectMaintenanceLocks(this.preparer.home, projectIds);
    try {
      if (!isDeepStrictEqual(this.store.getWorkItem(taskId, workItemId), item)
        || !isDeepStrictEqual(this.store.getWorkItemWorkspace(taskId, workItemId), workspace)) {
        throw new Error(`Work item changed while waiting for cleanup: ${taskId}/${workItemId}.`);
      }
      const state = await this.preparer.inspectWorkItemWorkspace(item.taskId, item.id);
      if (state === "dirty") return "dirty";
      this.#assertWorkItemRuntimeQuiescent(item);
      this.#assertNoActiveWorkItemDurableJobs(item);
      await this.#stopLiveRoles(item.taskId, this.#workItemRoleNames(item));
      const laneCleanup = await this.preparer.cleanupExecutionLaneWorkspacesForWorkItem(
        item.taskId,
        item.id
      );
      if (laneCleanup === "dirty") return "dirty";
      return await this.preparer.cleanupWorkItemWorkspace(item.taskId, item.id, disposition);
    } finally {
      releaseMaintenance();
    }
  }

  async cleanupWorkItemRuntime(
    taskId: string,
    workItemId: string
  ): Promise<"released"> {
    const item = this.store.getWorkItem(taskId, workItemId);
    if (item === null) throw new Error(`Work item not found: ${taskId}/${workItemId}.`);
    this.#assertWorkItemRuntimeQuiescent(item);
    await this.#stopLiveRoles(item.taskId, this.#workItemRoleNames(item));
    return "released";
  }

  /**
   * Stops one Task Role's physical runtime without changing its workspace.
   * The caller owns the subsequent atomic record retirement and wake.
   */
  async cleanupTaskRoleRuntime(
    taskId: string,
    roleName: string
  ): Promise<"released"> {
    await this.#stopLiveRoles(taskId, [roleName]);
    return "released";
  }

  async cleanupReviewRound(
    taskId: string,
    reviewRoundId: string
  ): Promise<GitWorkspaceRemoval> {
    const round = this.store.getReviewRound(taskId, reviewRoundId);
    if (round === null) throw new Error(`ReviewRound not found: ${taskId}/${reviewRoundId}.`);
    if (round.status !== "completed" && round.status !== "failed") {
      throw new Error(`ReviewRound must be terminal before cleanup: ${round.id}.`);
    }
    if (round.workspaceDisposition?.kind === "reassigned") return "missing";
    // Hold the per-Project maintenance fence so concurrent Project maintenance
    // or Task archive cannot interleave with worktree removal.
    const workspace = this.store.getReviewRoundWorkspace(taskId, reviewRoundId);
    const projectIds = workspace === null
      ? []
      : workspace.entries
        .filter(({ access }) => access === "write")
        .map(({ projectId }) => projectId);
    const releaseMaintenance = projectIds.length === 0
      ? () => {}
      : await acquireProjectMaintenanceLocks(this.preparer.home, projectIds);
    try {
      if (!isDeepStrictEqual(this.store.getReviewRound(taskId, reviewRoundId), round)
        || !isDeepStrictEqual(this.store.getReviewRoundWorkspace(taskId, reviewRoundId), workspace)) {
        throw new Error(`ReviewRound changed while waiting for cleanup: ${taskId}/${reviewRoundId}.`);
      }
      const state = await this.preparer.inspectReviewRoundWorkspace(taskId, reviewRoundId);
      if (state === "dirty") return "dirty";
      await this.#stopLiveRoles(taskId, this.#reviewRoundRoleNames(round));
      const laneCleanup = await this.preparer.cleanupExecutionLaneWorkspacesForReviewRound(
        taskId,
        reviewRoundId
      );
      if (laneCleanup === "dirty") return "dirty";
      return await this.preparer.cleanupReviewRoundWorkspace(taskId, reviewRoundId);
    } finally {
      releaseMaintenance();
    }
  }

  /** Business/runtime admission only. Physical workspaces may safely remain;
   * their removal uses the same foreground cleanup after ordinary or force archive.
   */
  async prepareTaskForArchive(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (task === null) throw new Error(`Task not found: ${taskId}.`);
    if (task.status !== "completed" && task.status !== "cancelled") {
      throw new Error(`Task must be completed or retired before archive: ${task.id}.`);
    }
    const settlement = [...archiveSettlementChecks(this.store, task), ...archiveExecutionChecks(this.store, taskId, this.preparer.home)];
    if (settlement.length > 0) throw new CleanupInspectionError(settlement);
    const managedWorkspaces = [...this.store.listManagedWorkspaces(task.id)]
      .sort((left, right) => managedWorkspaceKey(left.owner)
        .localeCompare(managedWorkspaceKey(right.owner)));
    // Fence Project preparation while stopping exact Task runtimes; do not
    // mutate Project paths until after the independent archive commit.
    const projectIds = new Set(task.projectBindings.map(({ projectId }) => projectId));
    for (const workspace of managedWorkspaces) {
      for (const entry of workspace.entries) projectIds.add(entry.projectId);
    }
    const releaseMaintenance = await acquireProjectMaintenanceLocks(this.preparer.home, projectIds);
    try {
      this.#assertTaskArchiveLifecycle(task);
      const currentWorkspaces = [...this.store.listManagedWorkspaces(task.id)]
        .sort((left, right) => managedWorkspaceKey(left.owner)
          .localeCompare(managedWorkspaceKey(right.owner)));
      if (!isDeepStrictEqual(currentWorkspaces, managedWorkspaces)) {
        throw new Error(`Task workspaces changed while waiting for archive cleanup: ${taskId}.`);
      }
      const allWorkItems = [...this.store.listWorkItems(task.id)]
        .sort((left, right) => left.id.localeCompare(right.id));
      const allReviewRounds = [...this.store.listReviewRounds(task.id)]
        .sort((left, right) => left.id.localeCompare(right.id));
      const snapshot: TaskArchiveSnapshot = {
        task,
        managedWorkspaces,
        workItems: allWorkItems,
        reviewRounds: allReviewRounds
      };
      const roleNames = this.store.listRoles(taskId).map(({ name }) => name);
      await this.#stopLiveRoles(taskId, roleNames);
      await this.runtime.releaseTaskTerminals(task.id);
      if (this.runtime.assertTaskPhysicalResourcesReleased === undefined) {
        throw new Error("Archive requires exact physical runtime inspection.");
      }
      await this.runtime.assertTaskPhysicalResourcesReleased(task.id);
      this.#assertTaskArchiveSnapshot(snapshot);
      const rechecked = [...archiveSettlementChecks(this.store, task), ...archiveExecutionChecks(this.store, taskId, this.preparer.home)];
      if (rechecked.length > 0) throw new CleanupInspectionError(rechecked);
    } finally { releaseMaintenance(); }
  }

  /** Best-effort cleanup only after authorized archive admission has committed.
   * This is one foreground attempt, not a retry worker. Each independent result
   * is durable before continuing, and a failed audit write really fails.
   */
  async cleanupArchivedTask(taskId: string, disposition: WorkItemWorkspaceDisposition): Promise<void> {
    const task = this.store.getTask(taskId);
    if (task?.status !== "archived") {
      throw new Error(`Archive must commit before cleanup: ${taskId}.`);
    }
    recordArchiveCleanup(this.store, taskId, { resource: `cleanup-pass:${taskId}`,
      detail: "Begin one foreground exact-owner cleanup pass." }, "started");
    const attempt = async (
      diagnostic: ArchiveDiagnostic,
      action: () => Promise<"removed" | "missing" | "released" | "dirty">
    ): Promise<boolean> => {
      recordArchiveCleanup(this.store, taskId, diagnostic, "started");
      let status: "removed" | "missing" | "released" | "retained";
      let detail = diagnostic.detail;
      try {
        const result = await action();
        status = result === "dirty" ? "retained" : result;
        if (result === "dirty") detail = "Dirty workspace retained; archive does not discard local changes.";
      } catch (error) {
        if (isArchivePersistenceFailure(error)) throw error;
        status = "retained";
        detail = error instanceof Error ? error.message : String(error);
      }
      recordArchiveCleanup(this.store, taskId, { ...diagnostic, detail }, status);
      return status !== "retained";
    };
    let runtimeReleased = true;
    for (const role of this.store.listRoles(taskId)) {
      const released = await attempt({ resource: `role:${taskId}/${role.name}`,
        detail: "Exact Role runtime stop." }, async () => {
        const checks = archiveExecutionChecks(this.store, taskId, this.preparer.home).filter(c => c.resource === `role:${taskId}/${role.name}`);
        if (checks.length > 0) throw new CleanupInspectionError(checks);
        await this.#stopLiveRoles(taskId, [role.name]);
        return "released";
      });
      runtimeReleased &&= released;
    }
    const physicalReleased = await attempt({ resource: `runtime:${taskId}`,
      detail: "Verify exact physical resource release before workspace deletion." }, async () => {
      const checks = archiveExecutionChecks(this.store, taskId, this.preparer.home);
      if (checks.length > 0) throw new CleanupInspectionError(checks);
      if (!runtimeReleased) throw new Error("One or more Role runtimes could not be safely released.");
      await this.runtime.releaseTaskTerminals(taskId);
      if (this.runtime.assertTaskPhysicalResourcesReleased === undefined) {
        throw new Error("Exact physical resource release inspection is unavailable.");
      }
      await this.runtime.assertTaskPhysicalResourcesReleased(taskId);
      return "released";
    });
    if (physicalReleased) {
      // Task main owns the Git objects of its dependent worktrees, so it is
      // always last and remains when any dependent cleanup is unresolved.
      const workspaces = this.store.listManagedWorkspaces(taskId).sort((a, b) =>
        Number(a.owner.type === "task") - Number(b.owner.type === "task"));
      for (const workspace of workspaces) {
        await attempt({ resource: managedWorkspaceKey(workspace.owner),
          detail: "Remove only clean, exactly owned workspace resources.",
          paths: [workspace.root, ...workspace.entries.filter(e => e.access === "write").map(e => e.path)]
        }, async () => {
          const release = await acquireProjectMaintenanceLocks(this.preparer.home,
            workspace.entries.map(e => e.projectId));
          try {
            if (!isDeepStrictEqual(this.store.getManagedWorkspace(workspace.owner), workspace)) {
              throw new Error("Workspace ownership changed; retained.");
            }
            const owner = workspace.owner;
            switch (owner.type) {
              case "work-item": {
                const item = this.store.getWorkItem(taskId, owner.workItemId);
                if (item?.status === "accepted" && disposition === "integrated") {
                  await new WorkItemChangeSetManager(this.store).assertIntegrated(taskId, item.id);
                }
                return await this.preparer.cleanupWorkItemWorkspace(taskId, owner.workItemId,
                  item?.status === "retired" ? "abandoned" : disposition);
              }
              case "review-round":
                return await this.preparer.cleanupReviewRoundWorkspace(taskId, owner.reviewRoundId);
              case "execution-lane":
                return await this.preparer.cleanupExecutionLaneWorkspace(taskId, owner.executionGroupId, owner.executionLaneId);
              case "integration-attempt":
                return await this.preparer.cleanupIntegrationWorkspace(taskId, owner.integrationAttemptId);
              case "task": {
                const current = this.store.getTask(taskId)!;
                const delivery = projectTaskRemoteDeliveryFromStore(this.store, current);
                if (!delivery.allMerged || !delivery.allVerified) {
                  throw new Error("Task main retained: local commits are not covered by verified remote delivery. Force does not discard them.");
                }
                for (const entry of workspace.entries.filter(e => e.access === "write")) {
                  const covered = delivery.projects.find(p => p.projectId === entry.projectId);
                  const expected = covered?.expectedLocalCommit;
                  const path = await lstat(entry.path).catch(error => {
                    if (error.code === "ENOENT") return null;
                    throw error;
                  });
                  if (expected !== null && expected !== undefined
                    && path !== null) {
                    const actual = await this.preparer.git.inspect(entry.path, "HEAD");
                    if (actual.baseCommit !== expected && actual.baseCommit !== covered?.deliveryLocalCommit) {
                      throw new Error(`Task main HEAD changed: ${entry.path}; retained.`);
                    }
                  }
                }
                const result = await this.preparer.cleanupTaskForArchive(taskId, disposition);
                if (result.status !== "removed") throw new Error(result.error ?? "Task main or dependent workspace retained.");
                return "removed";
              }
            }
          } finally { release(); }
        });
      }
    }
    // The registry remains the authority for scratch/resources not represented
    // by a current workspace. Do not invent ownership or sweep those paths.
    // Expose exact unresolved registrations instead of claiming full release.
    const registered = withResourceRegistry(this.preparer.home, undefined, registry =>
      Object.values(registry.load().records).filter(record =>
        record.owner.taskId === taskId && record.disposition !== "deleted"));
    for (const record of registered) {
      recordArchiveCleanup(this.store, taskId, {
        resource: `resource:${record.id}`, paths: [record.path],
        detail: `Registered ${record.kind} retained (${record.disposition}); owner=${JSON.stringify(record.owner)}. `
          + "No deletion attempted by archive for this remaining registration. Inspect with yui resources gc --dry-run."
      }, "retained");
    }
    recordArchiveCleanup(this.store, taskId, { resource: `task:${taskId}`,
      detail: "Foreground cleanup attempt finished; inspect retained resource references and warnings." }, "finished");
  }

  #assertTaskArchiveSnapshot(snapshot: TaskArchiveSnapshot): void {
    this.#assertTaskArchiveLifecycle(snapshot.task);
    const managedWorkspaces = [...this.store.listManagedWorkspaces(snapshot.task.id)]
      .sort((left, right) => managedWorkspaceKey(left.owner)
        .localeCompare(managedWorkspaceKey(right.owner)));
    const workItems = [...this.store.listWorkItems(snapshot.task.id)]
      .sort((left, right) => left.id.localeCompare(right.id));
    const reviewRounds = [...this.store.listReviewRounds(snapshot.task.id)]
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!isDeepStrictEqual(managedWorkspaces, snapshot.managedWorkspaces)
      || !isDeepStrictEqual(workItems, snapshot.workItems)
      || !isDeepStrictEqual(reviewRounds, snapshot.reviewRounds)) {
      throw new WorkspaceCleanupBlockedError(
        "task-changed",
        `task:${snapshot.task.id}`,
        true,
        `Task resources changed while archive cleanup stopped runtimes: ${snapshot.task.id}.`
      );
    }
  }

  #assertTaskArchiveLifecycle(expected: Task): void {
    const current = this.store.getTask(expected.id);
    if (current === null || !isDeepStrictEqual(current, expected)) {
      throw new WorkspaceCleanupBlockedError(
        "task-changed",
        `task:${expected.id}`,
        true,
        `Task changed during archive cleanup: ${expected.id}.`
      );
    }
  }

  #assertWorkItemRuntimeQuiescent(item: WorkItem): void {
    const activeRun = this.store.listRuns(item.taskId)
      .find((run) => run.status === "active" && run.workItemId === item.id);
    if (activeRun !== undefined) {
      throw new WorkspaceCleanupBlockedError(
        "active-turn",
        `work-item:${item.taskId}/${item.id}`,
        true,
        `Work item still has an active AgentRun: ${item.taskId}/${item.id}.`
      );
    }
  }

  /** Check before stopping Roles or cleaning child lanes. The preparer's
   * shared inspection repeats this physical check immediately before removal.
   */
  #assertNoActiveWorkItemDurableJobs(item: WorkItem): void {
    const jobs = this.store.listDurableJobs(item.taskId);
    const blocking = jobs.filter((job) => (
      job.owner.kind === "work-item"
      && job.owner.workItemId === item.id
      && jobCleanupBlocker(job, this.preparer.home) !== undefined
    ));
    if (blocking.length > 0) {
      throw new WorkspaceCleanupBlockedError(
        "active-durable-job",
        `work-item:${item.taskId}/${item.id}`,
        true,
        `Work item ${item.id} still has ${blocking.length} active DurableJob(s): `
        + `${blocking.map((job) => `${job.id}/${job.status}`).join(", ")}. `
        + "Settle their outcomes and establish physical exit before cleanup; acknowledgement alone is not stop evidence."
      );
    }
  }

  #workItemRoleNames(item: WorkItem): readonly string[] {
    return [
      ...(item.assignee === undefined ? [] : [item.assignee]),
      ...item.executionGroups.flatMap((group) => group.lanes.map(({ roleName }) => roleName))
    ];
  }

  #reviewRoundRoleNames(round: ReviewRound): readonly string[] {
    return [
      round.reviewerRoleName,
      ...(round.executionGroup?.lanes.map(({ roleName }) => roleName) ?? [])
    ];
  }

  async #stopLiveRoles(taskId: string, roleNames: readonly string[]): Promise<void> {
    const targets = [...new Set(roleNames)];
    for (const roleName of targets) {
      if (this.store.getActiveRun(taskId, roleName) !== null) {
        throw new Error(`Role has an active AgentRun: ${taskId}/${roleName}.`);
      }
      if (hasRuntimeLifecycleWork(
        this.store.getWorkMailbox(
          runtimeLifecycleTarget({ scope: "task", taskId, roleName })
        )
      )) {
        throw new Error(`Role has unsettled runtime lifecycle state: ${taskId}/${roleName}.`);
      }
    }
    const inspect = this.runtime.inspectTaskRolePanes?.bind(this.runtime);
    const observedPanes = inspect?.(taskId);
    const live = targets.filter((roleName) => {
      const sessions = this.store.getTaskRoleSessionSet(taskId, roleName);
      return observedPanes?.some((pane) => pane.roleName === roleName && !pane.dead) === true
        // A terminal current Session can still carry a resumable native id or
        // Provider binding. Exact cleanup retires both before a workspace or
        // release-control transition is allowed to wake this Role again.
        || (sessions !== null && (
          Object.keys(sessions.sessions).length > 0
          || sessions.providerBinding !== null
        ));
    });
    if (live.length > 0) await this.runtime.stopTaskRoleSessions(taskId, live);

    // Recheck exact runtime quiescence under the Task transaction when this
    // runtime exposes physical panes. Store reads are always authoritative.
    if (inspect === undefined) return;
    this.store.transaction((tx) => {
      const panes = inspect(taskId);
      for (const roleName of targets) {
        if (panes.some((pane) => pane.roleName === roleName && !pane.dead)) {
          throw new Error(`Task Role native pane must stop before workspace migration: ${roleName}.`);
        }
        if (tx.getActiveRun(taskId, roleName) !== null) {
          throw new Error(`Role has an active AgentRun: ${taskId}/${roleName}.`);
        }
        if (hasRuntimeLifecycleWork(
          tx.getWorkMailbox(
            runtimeLifecycleTarget({ scope: "task", taskId, roleName })
          )
        )) {
          throw new Error(`Role has unsettled runtime lifecycle state: ${taskId}/${roleName}.`);
        }
      }
    });
  }

  #workItemIsolationAssignee(item: WorkItem): string | undefined {
    const task = this.store.getTask(item.taskId);
    if (task === null) throw new Error(`Task not found: ${item.taskId}.`);
    if (task.status !== "active") throw new Error(`Task is not active: ${task.id}.`);
    if (task.projectBindings.length === 0) {
      throw new Error(`WorkItem isolation requires a Project-backed Task: ${task.id}.`);
    }
    if (item.assignee === "leader") {
      throw new Error("The Leader must remain in the Task main worktree.");
    }
    if (isTerminalWorkItem(item)) {
      throw new Error(`Work item is already terminal: ${item.id}.`);
    }
    if (item.assignee !== undefined && this.store.getActiveRun(task.id, item.assignee) !== null) {
      throw new Error(`Role has an active AgentRun: ${task.id}/${item.assignee}.`);
    }
    if (item.assignee !== undefined && this.store.getRole(task.id, item.assignee) === null) {
      throw new Error(`Role not found: ${task.id}/${item.assignee}.`);
    }
    return item.assignee;
  }
}

function sameProjectScope(
  workspace: Readonly<{ entries: readonly Readonly<{ projectId: string; access: string }>[] }>,
  taskProjectIds: readonly string[],
  writeProjectIds: readonly string[]
): boolean {
  const actualProjects = workspace.entries.map(({ projectId }) => projectId).sort();
  const expectedProjects = [...taskProjectIds].sort();
  const actual = workspace.entries
    .filter(({ access }) => access === "write")
    .map(({ projectId }) => projectId)
    .sort();
  const expected = [...writeProjectIds].sort();
  return actualProjects.length === expectedProjects.length
    && actualProjects.every((projectId, index) => projectId === expectedProjects[index])
    && actual.length === expected.length
    && actual.every((projectId, index) => projectId === expected[index]);
}

function isTerminalWorkItem(item: WorkItem): boolean {
  return ["accepted", "retired"].includes(item.status);
}
