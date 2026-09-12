import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { TaskStore } from "../storage/taskStore.js";
import { checkGrant, recordGrantUse } from "../grant/capabilityGrant.js";
import { requireText } from "../domain/validation.js";
import { validateProject } from "../repository/project.js";
import { updateRole, type TaskRole } from "../role/role.js";
import { saveTaskRoleUpdate } from "../role/taskRoleUpdate.js";
import type { TaskEventPayload } from "../event/taskEvent.js";
import { assertRoleRuntimeMutationAllowed } from "../commands/roleRuntimeGuard.js";
import { assertProviderConversationReplaceable, currentProviderConversation } from "../runtime/providerRuntimeIdentity.js";
import { projectProviderContinuations } from "../runtime/runtimeContinuationProjection.js";
import {
  contentDigest, validateExecutionEnvironmentSnapshot,
  type EnvironmentPreparation, type ExecutionEnvironmentSnapshot, type LocalResource
} from "./projectResource.js";

export type EnvironmentPlan =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "scratch" }>
  | Readonly<{ kind: "local"; resourceId: string; access: "read" | "write" }>;

/** Trusted typed owner; the public caller is authenticated by the existing
 * capability boundary. No new Store, worker, scheduling or Git authority. */
export function createProjectResources(store: TaskStore, now: () => Date = () => new Date()) {
  const task = (taskId: string) => {
    const value = store.getTask(taskId);
    if (!value) throw new Error(`Task not found: ${taskId}.`);
    return value;
  };
  const intent = (taskId: string) => {
    const value = task(taskId);
    return contentDigest(JSON.stringify({
      // Git's moving delivery pointers do not change Resource intent.
      projectBindings: value.projectBindings.map(({ projectId, directory, baseRef }) => ({ projectId, directory, baseRef })),
      projects: value.projectBindings.map(({ projectId }) => {
        const project = store.getProject(projectId);
        return { projectId, resources: project?.resourceRefs, providers: project?.defaultCapabilityProviders };
      })
    }));
  };
  const openTask = (taskId: string) => {
    const value = task(taskId);
    if (value.status !== "draft" && value.status !== "active") throw new Error("Task is not open for environment adoption.");
    return value;
  };
  const resource = (resourceId: string) => {
    const value = store.getLocalResource(resourceId);
    if (!value) throw new Error(`Local resource not found: ${resourceId}.`);
    return value;
  };
  const grantFor = (taskId: string, resourceId: string, access: "read" | "write", reservation?: string, reservedOnly = false) => {
    const target = resource(resourceId);
    const grant = store.listCapabilityGrants(taskId).find((candidate) => {
      // A Project scope is visibility, not an exhaustive Resource grant. A
      // concrete resource bound is mandatory even for a broadly named action.
      if (!candidate.parameterBounds.resourceId?.includes(resourceId)) return false;
      if (reservedOnly && (reservation === undefined || !candidate.useReservations.includes(reservation))) return false;
      if (candidate.scope.homePath !== undefined && resolve(candidate.scope.homePath) !== target.path) return false;
      if (candidate.scope.projectIds?.some((id) => !task(taskId).projectBindings.some((binding) => binding.projectId === id))) return false;
      return checkGrant(candidate, { action: `resource.local.${access}`, params: { resourceId } }, now(),
        { skipUsesCheck: reservation !== undefined && candidate.useReservations.includes(reservation) }).allowed;
    });
    if (!grant) throw new Error(`Resource grant unavailable: ${resourceId}/${access}.`);
    return grant;
  };
  const preparation = (taskId: string, id: string) => {
    const value = store.getEnvironmentPreparation(taskId, id);
    if (!value) throw new Error(`Environment preparation not found: ${taskId}/${id}.`);
    return value;
  };
  const assertLocalWriteOwner = (path: string, access: "read" | "write") => {
    if (access !== "write") return;
    const protectedPaths = [
      realpathSync(store.rootDirectory()),
      ...store.listProjects().map((project) => project.path),
      ...store.listTasks().flatMap((value) => store.listManagedWorkspaces(value.id)
        .flatMap((workspace) => [workspace.root, ...workspace.entries.map((entry) => entry.path)]))
    ];
    if (protectedPaths.some((protectedPath) => overlaps(path, currentOrAbsentPath(protectedPath)))) {
      throw new Error("Local resource overlaps a Yui Home or managed Git workspace; use its existing owner and Git operations.");
    }
  };
  const resolveExecutionEnvironment = (taskId: string, id: string): ExecutionEnvironmentSnapshot => {
    openTask(taskId);
    const value = preparation(taskId, id);
    if (value.disposition !== "adopted") throw new Error("Execution environment must be adopted and not released.");
    if (value.intentDigest !== intent(taskId)) throw new Error("Task resource/configuration intent changed; prepare again.");
    if (!value.directory || !value.environmentRef || value.isolation !== "trusted-local") {
      throw new Error("Empty preparation has no native execution directory; select a directory environment or managed workspace.");
    }
    assertDirectory(value.directory);
    if (value.directory.ownership === "user") assertLocalWriteOwner(value.directory.path, value.access);
    for (const resourceId of value.resourceRefs) {
      // Adoption already charged the bounded grant. Launch/resume may recheck
      // that reservation, but must neither invent nor consume another use.
      grantFor(taskId, resourceId, value.access, id, true);
      const target = resource(resourceId);
      assertDirectory(target);
      if (target.path !== value.directory.path || target.device !== value.directory.device || target.inode !== value.directory.inode) {
        throw new Error("Execution environment no longer matches its registered Resource.");
      }
    }
    return validateExecutionEnvironmentSnapshot({
      taskId, preparationId: id, environmentRef: value.environmentRef,
      access: value.access, isolation: value.isolation, directory: { ...value.directory }
    });
  };
  return {
    resolveExecutionEnvironment,
    bindEnvironment(
      taskId: string, roleName: string, preparationId: string | null,
      source: TaskEventPayload = { source: "environment.bind" }
    ): TaskRole {
      return store.transaction((tx) => {
        openTask(taskId);
        const role = tx.getRole(taskId, roleName);
        if (!role) throw new Error(`Role not found: ${taskId}/${roleName}.`);
        assertRoleRuntimeMutationAllowed(tx, { scope: "task", taskId, roleName }, "environment binding");
        const executionEnvironment = preparationId === null ? null : resolveExecutionEnvironment(taskId, preparationId);
        const timestamp = now();
        const updated = updateRole(role, { executionEnvironment }, timestamp);
        // Desired configuration only: active native Sessions retain their
        // immutable actual snapshot until explicitly ended.
        saveTaskRoleUpdate(tx, role, updated, timestamp, source);
        return updated;
      });
    },
    gitResult(taskId: string, changeSetId: string) {
      const changeSet = store.getChangeSet(taskId, changeSetId);
      if (!changeSet) throw new Error("ChangeSet not found in this Task.");
      return {
        kind: "external-version" as const, resourceId: changeSet.projectId,
        version: changeSet.headCommit,
        verification: { taskId, changeSetId: changeSet.id, baseCommit: changeSet.baseCommit },
        // This is a projection of the existing fixed Git result, not another
        // mutable repository/worktree/Integration record.
        changeSet
      };
    },
    registerLocalDirectory(displayName: string, path: string): LocalResource {
      const identity = directoryIdentity(path);
      return store.transaction((tx) => {
        const existing = tx.listLocalResources().find((value) => value.device === identity.device && value.inode === identity.inode);
        if (existing) return existing;
        const value: LocalResource = { schemaVersion: 1, id: `resource-${randomUUID()}`,
          kind: "local-directory", displayName: requireText(displayName, "Resource name"),
          ...identity, ownership: "user", createdAt: now().toISOString() };
        tx.saveLocalResource(value);
        return value;
      });
    },
    readLocalResource(taskId: string, resourceId: string) {
      grantFor(taskId, resourceId, "read");
      return resource(resourceId);
    },
    projectContext(taskId: string, projectId: string) {
      if (!task(taskId).projectBindings.some((binding) => binding.projectId === projectId)) throw new Error("Project is outside the Task context.");
      const project = store.getProject(projectId);
      if (!project) throw new Error("Project not found.");
      return { id: project.id, name: project.name, knowledge: project.knowledge,
        resourceRefs: project.resourceRefs, defaultCapabilityProviders: project.defaultCapabilityProviders };
    },
    configureProject(projectId: string, resourceRefs: readonly string[], defaultCapabilityProviders: Readonly<Record<string, string>>) {
      return store.transaction((tx) => {
        const project = tx.getProject(projectId);
        if (!project || project.status !== "active") throw new Error("Active Project not found.");
        resourceRefs.forEach(resource);
        const next = validateProject({ ...project, resourceRefs, defaultCapabilityProviders, updatedAt: now().toISOString() });
        tx.saveProject(next);
        return next;
      });
    },
    prepare(taskId: string, plan: EnvironmentPlan): EnvironmentPreparation {
      openTask(taskId);
      let directory: EnvironmentPreparation["directory"];
      const id = `preparation-${randomUUID()}`;
      const access = plan.kind === "local" ? plan.access : "write";
      const resourceRefs = plan.kind === "local" ? [plan.resourceId] : [];
      if (plan.kind === "local") {
        grantFor(taskId, plan.resourceId, access);
        const target = resource(plan.resourceId);
        assertDirectory(target);
        assertLocalWriteOwner(target.path, access);
        directory = { path: target.path, device: target.device, inode: target.inode, ownership: "user" };
      } else if (plan.kind === "scratch") {
        const parent = join(store.rootDirectory(), "environments");
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        if (realpathSync(parent) !== resolve(parent)) throw new Error("Environment root must not be a symlink.");
        directory = { ...directoryIdentity(mkdtempSync(join(parent, `${id}-`))), ownership: "preparation" };
      }
      try {
        return store.transaction((tx) => {
          openTask(taskId);
          const timestamp = now().toISOString();
          const value: EnvironmentPreparation = { schemaVersion: 1, id, taskId,
            disposition: "prepared", intentDigest: intent(taskId), resourceRefs, access,
            isolation: directory ? "trusted-local" : "none",
            ...(directory ? { directory, environmentRef: `${taskId}/${id}` } : {}),
            createdAt: timestamp, updatedAt: timestamp };
          tx.saveEnvironmentPreparation(value);
          return value;
        });
      } catch (error) {
        if (directory?.ownership === "preparation") {
          // Only the exact newly-created empty directory is eligible. Never
          // recursively remove a partial/unknown external preparation.
          try { assertDirectory(directory); rmdirSync(directory.path); }
          catch (cleanup) { throw new AggregateError([error, cleanup], `Unadopted environment retained: ${directory.path}`); }
        }
        throw error;
      }
    },
    adopt(taskId: string, id: string): EnvironmentPreparation {
      return store.transaction((tx) => {
        openTask(taskId);
        const value = preparation(taskId, id);
        if (value.disposition === "released") throw new Error("Environment was released.");
        if (value.intentDigest !== intent(taskId)) throw new Error("Task resource/configuration intent changed; prepare again.");
        if (value.directory) assertDirectory(value.directory);
        if (value.directory?.ownership === "user") assertLocalWriteOwner(value.directory.path, value.access);
        const grants = value.resourceRefs.map((resourceId) => grantFor(taskId, resourceId, value.access, id));
        if (value.disposition === "adopted") return value;
        if (value.directory) {
          for (const otherTask of tx.listTasks()) {
            const conflict = tx.listEnvironmentPreparations(otherTask.id).some((other) =>
              other.disposition === "adopted" && other.directory
              && (value.access === "write" || other.access === "write")
              && overlaps(other.directory.path, value.directory!.path));
            if (conflict) throw new Error("Resource conflicts with an adopted environment; inspect its use or choose isolated scratch.");
          }
        }
        grants.forEach((grant) => tx.saveCapabilityGrant(taskId, recordGrantUse(grant, now(), id)));
        const adopted = { ...value, disposition: "adopted" as const, updatedAt: now().toISOString() };
        tx.saveEnvironmentPreparation(adopted);
        return adopted;
      });
    },
    release(taskId: string, id: string, evidence?: { quiescence: string }): EnvironmentPreparation {
      return store.transaction((tx) => {
        const value = preparation(taskId, id);
        if (value.disposition === "released") return value;
        if (value.disposition === "adopted" && value.directory) {
          requireText(evidence?.quiescence ?? "", "Actual quiescence evidence");
          const references = (environment: ExecutionEnvironmentSnapshot | undefined) =>
            environment?.taskId === taskId && environment.preparationId === id;
          const sessionSets = tx.listRoleSessionSets(taskId);
          const continuations = projectProviderContinuations(tx.listEvents(taskId));
          for (const set of sessionSets) {
            const users = [...Object.values(set.sessions), ...(set.history ?? [])]
              .filter((session) => references(session.effective.executionEnvironment));
            if (set.providerBinding != null && users.some((session) =>
              session.nativeSessionId === currentProviderConversation(set.providerBinding!).conversationId)) {
              // A dead Host cannot prove that the native daemon accepted
              // nothing or that a detached input has finished.
              assertProviderConversationReplaceable(set.providerBinding);
            }
            if (continuations.some((continuation) =>
              continuation.roleName === set.owner.roleName
              && (continuation.execution !== "quiescent"
                || continuation.observation !== "exact" || continuation.identityConflict)
              && (users.some((session) => session.agentId === continuation.identity.accountScope
                && session.nativeSessionId === continuation.identity.conversationId)
                || references(tx.getRun(taskId, continuation.runId)?.effective.executionEnvironment)))) {
              throw new Error("Environment still has a live or unknown native continuation.");
            }
          }
          if (value.directory && (
            tx.listRuns(taskId).some((run) => run.status === "active"
              && (references(run.effective.executionEnvironment)
                || (run.workspace && overlaps(run.workspace.root, value.directory!.path))))
            || sessionSets.some((set) =>
              [...Object.values(set.sessions), ...(set.history ?? [])].some((session) =>
                session.status === "active" && references(session.effective.executionEnvironment)))
            || tx.listDurableJobs(taskId).some((job) => ["queued", "running", "unknown-needs-attention"].includes(job.status)
              && overlaps(job.workspace, value.directory!.path))
          )) throw new Error("Environment still has a live or unknown execution reference.");
        }
        if (value.directory?.ownership === "preparation") {
          assertDirectory(value.directory);
          const parent = realpathSync(join(store.rootDirectory(), "environments"));
          if (!within(parent, value.directory.path) || !value.directory.path.startsWith(join(parent, `${id}-`))) {
            throw new Error("Preparation directory is outside its owned root.");
          }
          // Content must first be saved or explicitly handled by its owner.
          // Nonempty directories are retained with ENOTEMPTY, never force-deleted.
          rmdirSync(value.directory.path);
        }
        const released = { ...value, disposition: "released" as const, updatedAt: now().toISOString(),
          ...(evidence === undefined ? {} : { releaseEvidence: requireText(evidence.quiescence, "Actual quiescence evidence") }) };
        tx.saveEnvironmentPreparation(released);
        return released;
      });
    }
  };
}

function directoryIdentity(path: string) {
  const canonical = realpathSync(resolve(path));
  const stat = statSync(canonical, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Resource must be a local directory.");
  return { path: canonical, device: String(stat.dev), inode: String(stat.ino) };
}

function assertDirectory(expected: { path: string; device: string; inode: string }) {
  if (lstatSync(expected.path).isSymbolicLink()) throw new Error("Directory identity changed to a symlink.");
  const current = directoryIdentity(expected.path);
  if (current.path !== expected.path || current.device !== expected.device || current.inode !== expected.inode) {
    throw new Error("Directory identity changed; retained for owner inspection.");
  }
}

function within(parent: string, path: string): boolean {
  const value = relative(parent, path);
  return value !== "" && value !== ".." && !value.startsWith("../") && !isAbsolute(value);
}

function overlaps(left: string, right: string): boolean {
  return left === right || within(left, right) || within(right, left);
}

function currentOrAbsentPath(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    // Historical workspace references may outlive a removed directory. Retain
    // that exact address; never manufacture a replacement or ignore other errors.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
    throw error;
  }
}
