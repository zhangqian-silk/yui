import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * The single authority for every Yui self-managed path derived from a Home.
 *
 * Historically the managed Git worktrees and provider runtimes escaped Home
 * through two different mechanisms: worktree/task roots were derived from the
 * user-facing `defaultWorkspace` (an out-of-Home directory), and provider
 * runtimes/backups were written to string-built siblings of Home
 * (`${home}.task-runtimes`, `${home}-backups`). Both are unified here so that a
 * single canonical YUI_HOME contains all self-managed data, with only the
 * approved short-path IPC sockets (Controller, tmux, Agent Host, integration
 * runtime) remaining outside it for the `sockaddr_un` length budget.
 *
 * `defaultWorkspace` is intentionally NOT an input to this module: it remains a
 * user-facing cwd for ad-hoc/global Roles and the origin for external Project
 * input, never a second authority for internal managed layout.
 */

/** Canonicalize a Home string the same way callers already resolve it. */
function homeRoot(home: string): string {
  const resolved = resolve(home);
  if (!isAbsolute(resolved)) {
    throw new Error("YUI_HOME must be an absolute path.");
  }
  return resolved;
}

/**
 * Root that contains every managed Git workspace (both the physical worktrees
 * and the per-Task symlink views). A single parent keeps the two families
 * adjacent and lets the storage migration relocate them as one subtree.
 */
export function managedWorkspacesRoot(home: string): string {
  return join(homeRoot(home), "workspaces");
}

/** Physical managed clones and linked worktrees: `<home>/workspaces/worktree`. */
export function managedWorktreeRoot(home: string): string {
  return join(managedWorkspacesRoot(home), "worktree");
}

/** Per-Task symlink views over the worktrees: `<home>/workspaces/tasks`. */
export function managedTaskRoot(home: string): string {
  return join(managedWorkspacesRoot(home), "tasks");
}

/**
 * Dedicated partition for provider runtime roots (data/cache/tmp) and the
 * planning cwd. This is the ONE Home subtree the Task runtime isolation
 * boundary permits its roots to overlap; every other part of Home (the
 * database, `workspaces/`, `projects/`) stays protected.
 */
export function managedRuntimeRoot(home: string): string {
  return join(homeRoot(home), "runtime", "task-runtimes");
}

/**
 * Dedicated Home partition for the integration check runtime's provider
 * data/cache/tmp. Distinct from `managedRuntimeRoot` so an integration attempt's
 * disposable roots never collide with a Task runtime's, yet still sit inside the
 * one managed runtime subtree the isolation boundary permits to overlap Home.
 * The integration tmux socket endpoint is NOT here — it stays a short `/tmp`
 * path for the `sockaddr_un` budget (see `gitIntegrationService`).
 */
export function managedIntegrationRuntimeRoot(home: string): string {
  return join(homeRoot(home), "runtime", "integration-runtimes");
}

/**
 * Disposable staging prefix for `yui update`'s side-by-side package install
 * (an upgrade artifact): `<home>/runtime/update-staging`. Kept under Home so a
 * staged upgrade never lands in a shared system temp root.
 */
export function updateStagingRoot(home: string): string {
  return join(homeRoot(home), "runtime", "update-staging");
}

/**
 * Disposable scratch parent for the release workflow's Yui-authored artifacts —
 * the fresh-install smoke directory and the verified publish-snapshot tarball
 * (release artifacts): `<home>/runtime/release-workflow`. Kept under Home so a
 * release artifact never lands in a shared system temp root.
 */
export function releaseWorkflowScratchRoot(home: string): string {
  return join(homeRoot(home), "runtime", "release-workflow");
}

/** Disposable planning cwd parent: `<home>/runtime/task-runtimes/planning`. */
export function planningRuntimeRoot(home: string): string {
  return join(managedRuntimeRoot(home), "planning");
}

/** Planning cwd for a single Task, materialized on demand at launch. */
export function planningRuntimeCwd(home: string, taskId: string): string {
  return join(planningRuntimeRoot(home), taskId);
}

/** Storage-upgrade database backups: `<home>/backups` (was a Home sibling). */
export function storageBackupRoot(home: string): string {
  return join(homeRoot(home), "backups");
}

/** True when `child` is strictly inside `parent` (shared with isolation checks). */
export function isWithinManagedRoot(parent: string, child: string): boolean {
  const nested = relative(resolve(parent), resolve(child));
  return nested.length > 0 && !nested.startsWith("..") && !isAbsolute(nested);
}
