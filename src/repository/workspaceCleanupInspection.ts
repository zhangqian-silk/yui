import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lstat, readdir, readlink } from "node:fs/promises";
import type { TaskStore } from "../storage/taskStore.js";
import { projectTaskRemoteDeliveryFromStore } from "../task/remoteDeliveryService.js";
import type { Task } from "../task/task.js";
import type { WorkItemWorkspaceDisposition } from "../workItem/workItem.js";
import { cleanupCheckFromError, type CleanupCheck } from "../workspace/cleanupInspection.js";
import { WorkItemChangeSetManager } from "../workspace/workItemChangeSetManager.js";
import { managedWorkspaceKey, managedWorktreeName, type ManagedWorkspace } from "../worktree/managedWorkspace.js";
import { integrationWorktreeIdentity, worktreeIdentity, type GitWorkspacePort } from "./gitWorkspace.js";
import { taskWorkspaceRefSegment } from "./taskWorkspaceIdentity.js";
import { jobCleanupBlocker } from "../job/jobCleanupInspection.js";
import { defaultIntegrationRuntimeIsolation } from "../runtime/integrationRuntimeIsolation.js";
import { inspectTaskRuntimeCleanup, type TaskRuntimeIsolationPort } from "../runtime/taskRuntimeIsolation.js";

/** Current owner facts + the same Git inspection used immediately before removal.
 * No preparation, locks, Git refresh, runtime stop, DB writes or repair.
 */
export async function inspectWorkspaceCleanup(
  store: TaskStore, git: GitWorkspacePort, workspace: ManagedWorkspace,
  disposition: WorkItemWorkspaceDisposition, forceArchive = false, home?: string,
  integrationRuntime?: TaskRuntimeIsolationPort
): Promise<CleanupCheck[]> {
  const owner = workspace.owner;
  const task = store.getTask(owner.taskId);
  if (task === null) throw new Error(`Task not found: ${owner.taskId}.`);
  const resource = managedWorkspaceKey(owner);
  const sources = [resource];
  const actions = workspaceCleanupActions(workspace);
  const checks: CleanupCheck[] = [];
  const add = (reason: string, detail: string, expected: unknown, observed: unknown) =>
    checks.push({ resource, reason, status: "blocked", detail, expected, observed, sources, actions });
  if (!isDeepStrictEqual(store.getManagedWorkspace(owner), workspace)) {
    add("workspace-identity-mismatch", "Current workspace ownership differs from the inspected record.",
      "same managed workspace", "changed or missing");
    return checks;
  }
  // Job admission supports these three exact managed owners. Apply the same
  // physical check before every supported owner's cleanup, not only Integration.
  for (const job of store.listDurableJobs(task.id).filter(job =>
    (owner.type === "task" && job.owner.kind === "task")
    || (owner.type === "work-item" && job.owner.kind === "work-item"
      && job.owner.workItemId === owner.workItemId)
    || (owner.type === "integration-attempt" && job.owner.kind === "integration-attempt"
      && job.owner.integrationAttemptId === owner.integrationAttemptId))) {
    const blocker = jobCleanupBlocker(job, home);
    if (blocker !== undefined) add("unresolved-execution", blocker,
      "settled execution", { jobId: job.id, status: job.status });
  }
  checks.push(...await inspectWorkspaceContainer(workspace));
  if (task.workspaceIdentity === undefined && workspace.entries.some(e => e.access === "write")) {
    add("workspace-metadata-missing", "Task has no durable workspace identity; do not infer one from paths.",
      "recorded Task workspace identity", null);
    return checks;
  }
  let roleName = managedWorktreeName(owner);
  switch (owner.type) {
    case "work-item": {
      const item = store.getWorkItem(task.id, owner.workItemId);
      if (item === null || !["accepted", "retired"].includes(item.status)) {
        add("owner-unsettled", "WorkItem must be terminal before cleanup.", ["accepted", "retired"], item?.status ?? null);
      }
      if (item?.workspaceDisposition !== undefined && item.workspaceDisposition !== disposition) {
        add("workspace-disposition-mismatch", "WorkItem cleanup disposition differs from the recorded decision.",
          item.workspaceDisposition, disposition);
      }
      if (item?.status === "accepted" && disposition === "integrated") {
        const inspection = await new WorkItemChangeSetManager(store).inspectIntegrated(task.id, item.id);
        checks.push(...inspection.checks);
      }
      break;
    }
    case "review-round": {
      const round = store.getReviewRound(task.id, owner.reviewRoundId);
      if (round === null || !["completed", "failed"].includes(round.status)) {
        add("owner-unsettled", "ReviewRound must be terminal before cleanup.", ["completed", "failed"], round?.status ?? null);
      }
      if (round?.workspace === undefined || !isDeepStrictEqual(round.workspace, workspace)) {
        add("workspace-metadata-mismatch", "ReviewRound and managed workspace records diverge.",
          "same workspace in ReviewRound and registry", "different or missing mirror");
      }
      if (round?.scope === "task") roleName = `reviewer-${round.reviewerRoleName}`;
      break;
    }
    case "execution-lane": {
      const group = owner.purpose === "execution"
        ? store.getWorkItem(task.id, owner.workItemId!)?.executionGroups.find(g => g.id === owner.executionGroupId)
        : store.getReviewRound(task.id, owner.reviewRoundId!)?.executionGroup;
      const lane = group?.id === owner.executionGroupId
        ? group.lanes.find(l => l.id === owner.executionLaneId) : undefined;
      if (lane === undefined || lane.disposition === "open") {
        add("owner-unsettled", "Execution Lane is not terminally resolved.", "settled lane", lane?.disposition ?? null);
      }
      break;
    }
    case "integration-attempt": {
      const attempt = store.getIntegrationAttempt(task.id, owner.integrationAttemptId);
      const entry = workspace.entries[0];
      if (workspace.entries.length !== 1 || entry?.access !== "write"
        || entry.projectId !== attempt?.projectId || entry.path !== workspace.root) {
        add("workspace-identity-mismatch", "Integration resource does not match its single recorded Project worktree.",
          "one writable Project at the Integration root", "different or missing entry");
        return checks;
      }
      if (attempt === null || ["running", "blocked", "conflicted", "validating"].includes(attempt.status)) {
        add("owner-unsettled", "IntegrationAttempt must be terminal before cleanup.", "terminal attempt", attempt?.status ?? null);
      }
      try {
        if (home === undefined) throw new Error("Runtime Home unavailable.");
        const runtime = integrationRuntime ?? defaultIntegrationRuntimeIsolation(home, store.getHomeIdentity().homeId);
        inspectTaskRuntimeCleanup(runtime.preflight({ workspace, allowExactActive: true }),
          attempt?.status === "committed" ? "completion" : "failure");
      } catch {
        add("runtime-resource-unverified", "Integration runtime ownership or physical quiescence cannot be verified.",
          "exactly owned inactive runtime and cleanup claims", "unverified");
      }
      break;
    }
    case "task":
      if (!["completed", "cancelled", "archived"].includes(task.status)) {
        add("task-not-terminal", "Task must be completed or retired before archive cleanup.",
          ["completed", "cancelled", "archived"], task.status);
      }
      break;
  }
  const delivery = owner.type === "task"
    ? await readArchiveDelivery(store, git, task, forceArchive) : undefined;
  if (disposition === "integrated" && delivery !== undefined && (!delivery.allMerged || !delivery.allVerified)) {
    add("delivery-coverage", "Task main has commits without verified remote coverage; cleanup does not establish delivery.",
      { allMerged: true, allVerified: true }, { allMerged: delivery.allMerged, allVerified: delivery.allVerified });
  }
  for (const entry of workspace.entries.filter(e => e.access === "write")) {
    const entryResource = `${resource}/${entry.projectId}`;
    const entryChecks: CleanupCheck[] = [];
    const check = (reason: string, detail: string, expected: unknown, observed: unknown) =>
      entryChecks.push({ resource: entryResource, reason, status: "blocked", detail, expected, observed, sources, actions });
    // Integration's durable root is its single Project worktree (not the
    // multi-Project owner container used by the other workspace owners).
    const container = owner.type === "integration-attempt" ? dirname(workspace.root) : workspace.root;
    const expectedPath = join(container, entry.directory);
    if (entry.path !== expectedPath) {
      check("workspace-path-mismatch", "Recorded path is not the current owner-root/Project path; relocation is not proven.",
        { ownerRelativePath: entry.directory }, { ownerRelativePath: safeRelativePath(container, entry.path) });
      checks.push(...entryChecks);
      continue; // Never inspect a foreign/mismatched path.
    }
    const taskSegment = taskWorkspaceRefSegment(task);
    const expectedBranch = owner.type === "integration-attempt"
      ? integrationWorktreeIdentity(taskSegment, owner.integrationAttemptId).branch
      : worktreeIdentity(taskSegment, roleName).branch;
    if (entry.branch !== expectedBranch) {
      check("workspace-identity-mismatch", "Recorded branch does not match the exact owner.",
        expectedBranch, entry.branch);
      checks.push(...entryChecks);
      continue;
    }
    try {
      const main = store.getTaskWorkspace(task.id)?.entries.find(e => e.projectId === entry.projectId);
      if (main === undefined && owner.type !== "task") {
        check("workspace-metadata-missing", "Task main Git repository reference is unavailable.", "Task main Project entry", null);
      } else {
        const state = owner.type === "task"
          ? await git.inspectTaskClone({ path: entry.path, container: workspace.root, directory: entry.directory,
            taskSegment, branch: entry.branch })
          : await git.inspectWorktree({ repositoryPath: main!.path, container, directory: entry.directory,
            taskSegment, roleName,
            ...(owner.type === "integration-attempt" ? { expectedBranch } : {}) });
        if (state === "dirty") check("dirty-worktree", "Uncommitted or untracked changes must be preserved.", "clean", "dirty");
        if (owner.type === "task" && state !== "missing" && delivery !== undefined) {
          const covered = delivery.projects.find(p => p.projectId === entry.projectId);
          const expected = covered?.expectedLocalCommit;
          const observed = (await git.inspect(entry.path, "HEAD")).baseCommit;
          const baseline = task.projectBindings.find(binding => binding.projectId === entry.projectId)?.baseCommit;
          const unchangedAbandonment = disposition === "abandoned" && baseline !== undefined && observed === baseline;
          if (!unchangedAbandonment && disposition === "abandoned" && (!covered?.merged || !covered.verified)) {
            check("delivery-coverage", "Abandonment does not discard unverified local commits; only the exact unchanged baseline is disposable.",
              { baseline: baseline ?? null, verifiedDelivery: true }, observed);
          } else if (!unchangedAbandonment && expected != null && expected !== observed && covered?.deliveryLocalCommit !== observed) {
            check("head-mismatch", "Task main HEAD differs from the accepted head and its covered publication candidate.",
              { acceptedCommit: expected, deliveryLocalCommit: covered?.deliveryLocalCommit ?? null }, observed);
          }
        }
      }
    } catch (error) {
      entryChecks.push(...cleanupCheckFromError(error, entryResource, sources, actions));
    }
    checks.push(...entryChecks);
  }
  return checks;
}

/** Inspect the complete logical container before removing any Project. Files
 * and unrecognized links are evidence, not disposable workspace scaffolding.
 */
export async function inspectWorkspaceContainer(workspace: ManagedWorkspace): Promise<CleanupCheck[]> {
  if (workspace.owner.type === "integration-attempt") return []; // root is the Git worktree itself
  const resource = managedWorkspaceKey(workspace.owner);
  const sources = [resource];
  const actions = workspaceCleanupActions(workspace);
  try {
    const root = await lstat(workspace.root).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (root === null) return [];
    if (!root.isDirectory() || root.isSymbolicLink()) return [{
      resource, reason: "workspace-identity-mismatch", status: "blocked",
      detail: "Logical workspace container is not an owned directory.",
      expected: "directory", observed: "different filesystem type", sources, actions
    }];
    const unexpected: string[] = [];
    for (const entry of await readdir(workspace.root, { withFileTypes: true })) {
      const owned = workspace.entries.find(e => e.directory === entry.name);
      const allowed = owned !== undefined && (owned.access === "write"
        ? entry.isDirectory() && !entry.isSymbolicLink()
        : entry.isSymbolicLink() && resolve(workspace.root,
          await readlink(join(workspace.root, entry.name))) === resolve(owned.path));
      if (!allowed) unexpected.push(entry.name);
    }
    return unexpected.length === 0 ? [] : [{
      resource, reason: "workspace-material-retained", status: "blocked",
      detail: "Logical container contains material outside its registered Project entries; no Project removal was started.",
      expected: "only registered Project directories/links", observed: unexpected,
      sources, actions
    }];
  } catch (error) { return cleanupCheckFromError(error, resource, sources, actions); }
}

/** Reuse Publication's projection, supplying live heads only where its existing
 * contract asks for them (active/cancelled). Completed/archived heads stay frozen.
 * Never prepare a workspace or substitute an old binding's commit for a failed read.
 */
export async function readArchiveDelivery(store: TaskStore, git: GitWorkspacePort, task: Task, forceArchive = false) {
  const projects: Array<{ projectId: string; commit: string }> = [];
  // Force admission preserves its existing store-only evidence; it never
  // freezes new delivery heads merely because an inspection observed them.
  if (!forceArchive && (task.status === "active" || task.status === "cancelled") && task.workspaceIdentity !== undefined) {
    const main = store.getTaskWorkspace(task.id);
    if (main?.owner.type === "task" && main.owner.taskId === task.id) {
      const branch = worktreeIdentity(taskWorkspaceRefSegment(task), "main").branch;
      for (const entry of main.entries.filter(e => e.access === "write")) {
        if (entry.path !== join(main.root, entry.directory) || entry.branch !== branch) continue;
        try {
          const head = await git.inspect(entry.path, "HEAD");
          if (head.root === entry.path && await git.headRef(entry.path) === branch) {
            projects.push({ projectId: entry.projectId, commit: head.baseCommit });
          }
        } catch { /* Failed reads remain unavailable in the existing projection. */ }
      }
    }
  }
  return projectTaskRemoteDeliveryFromStore(store, task, { projects });
}

export function workspaceCleanupActions(workspace: ManagedWorkspace): string[] {
  const owner = workspace.owner;
  switch (owner.type) {
    case "task": return [`yui task remote-delivery ${owner.taskId}`, `yui task show ${owner.taskId}`,
      `yui task archive-cleanup ${owner.taskId}`];
    case "work-item": return [`yui task work show ${owner.taskId}/${owner.workItemId}`,
      `yui task work cleanup ${owner.taskId}/${owner.workItemId} --integrated|--abandon`];
    case "review-round": return [`yui task work review show ${owner.taskId}/${owner.reviewRoundId}`,
      `yui task work review cleanup ${owner.taskId}/${owner.reviewRoundId}`];
    case "integration-attempt": return [`yui task integration show ${owner.taskId}/${owner.integrationAttemptId}`,
      `yui task integration cleanup ${owner.taskId}/${owner.integrationAttemptId}`];
    case "execution-lane": return owner.purpose === "execution"
      ? [`yui task work show ${owner.taskId}/${owner.workItemId}`,
        `yui task work cleanup ${owner.taskId}/${owner.workItemId} --integrated|--abandon`]
      : [`yui task work review show ${owner.taskId}/${owner.reviewRoundId}`,
        `yui task work review cleanup ${owner.taskId}/${owner.reviewRoundId}`];
  }
}

/** Only expose paths inside this already-authorized owner, never foreign paths. */
export function safeRelativePath(root: string, path: string): string {
  const value = relative(root, path);
  return value === ".." || value.startsWith("../") || isAbsolute(value) ? "[outside owner root]" : value || ".";
}
