import { createHash } from "node:crypto";
import { CliError, usageError } from "../errors/cliError.js";
import { assertProjectActive, type Project } from "./project.js";
import { GitWorkspaceRefreshError, NodeGitWorkspace, type GitWorkspacePort } from "./gitWorkspace.js";
import { acquireProjectMaintenanceLock } from "./projectMaintenanceLock.js";

type RefreshStore = Readonly<{ rootDirectory(): string; listProjects(): Project[] }>;

/** Bind maintenance intent to catalog identity, not a caller-supplied path. */
export function projectRefreshTargetDigest(project: Project): string {
  return createHash("sha256").update(JSON.stringify([
    project.id, project.path, project.remoteUrl, project.stableBranch,
    project.developmentBranch, project.ownership, project.status
  ])).digest("hex");
}

export function requireRefreshProject(store: RefreshStore, id: string, automatic = false): Project {
  const project = store.listProjects().find(project => project.id === id);
  if (!project) throw usageError(`Project not found: ${id}.`);
  assertProjectActive(project, "refresh");
  if (automatic && project.ownership !== "managed") {
    throw usageError(`Automatic Project refresh requires a managed Project: ${id}.`);
  }
  if (project.remoteUrl === undefined) throw usageError(`Project refresh requires a remote URL: ${id}.`);
  if (project.stableBranch !== project.developmentBranch) {
    throw usageError(`Project refresh requires matching stable and development branches: ${id}.`);
  }
  return project;
}

/** Shared manual/background operation. Waiting never authorizes a changed target. */
export async function refreshRegisteredProject(store: RefreshStore, id: string, options: Readonly<{
  automatic?: boolean;
  expectedDigest?: string;
  git?: Pick<GitWorkspacePort, "refresh">;
  signal?: AbortSignal;
  beforeRefresh?: () => void;
}> = {}) {
  const project = requireRefreshProject(store, id, options.automatic);
  const expected = options.expectedDigest ?? projectRefreshTargetDigest(project);
  const check = () => {
    const current = requireRefreshProject(store, id, options.automatic);
    if (projectRefreshTargetDigest(current) !== expected) {
      throw new Error(`Project changed while waiting to refresh: ${id}; read current state before retrying.`);
    }
    return current;
  };
  check();
  const release = await acquireProjectMaintenanceLock(store.rootDirectory(), id, { signal: options.signal });
  try {
    const current = check();
    options.beforeRefresh?.();
    const refreshed = await (options.git ?? new NodeGitWorkspace()).refresh({
      repositoryPath: current.path, remoteUrl: current.remoteUrl!, stableRef: current.stableBranch
    });
    return { project: current, ...refreshed };
  } catch (error) {
    if (error instanceof GitWorkspaceRefreshError) {
      throw new CliError("RUNTIME_ERROR", error.message, undefined, { projectId: id, refresh: error.result });
    }
    throw error;
  } finally {
    release();
  }
}
