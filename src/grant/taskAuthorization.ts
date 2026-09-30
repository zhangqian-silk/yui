import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { usageError } from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import { currentManagedRuntime } from "../runtime/managedCaller.js";
import type { CapabilityGrant } from "./capabilityGrant.js";

/** A source is evidence to interpret, never a claim made in a Role report.
 * Semantic authorization remains the current Leader's responsibility. These
 * checks deliberately do not classify natural language or match keywords. */
export type TaskAuthorizationSource = Readonly<{
  messageId: string;
  digest: string;
  purpose: string;
  nativeSessionId: string;
}>;

export function taskAuthorizationSource(
  store: TaskStore, taskId: string, environment: NodeJS.ProcessEnv,
  messageId: string | undefined, purpose: string | undefined
): TaskAuthorizationSource {
  const caller = currentManagedRuntime(store, environment, taskId, "leader");
  if (caller?.executionAuthority !== "delivery") {
    throw usageError("Authorization requires this Task's current delivery Leader Session.");
  }
  const task = store.getTask(taskId);
  if (!task || task.status === "archived" || task.status === "draft"
    || task.executionGate?.state === "stopped") {
    throw usageError("Task authorization is unavailable in this lifecycle or execution gate.");
  }
  const message = store.listMessages(taskId).find(entry => entry.id === messageId);
  if (!message || !((message.kind === "user" && message.author.type === "user")
    || (message.kind === "operator" && message.author.type === "operator"))) {
    throw usageError("Name an original user or Operator authorization Message in this Task with --source-message; a Role report is not user authority.");
  }
  if (!purpose?.trim() || !message.body.includes(purpose.trim())) {
    throw usageError("--purpose must quote the original explicit authorization verbatim; an Agent's paraphrase is not source evidence.");
  }
  return {
    messageId: message.id,
    // Delivery receipts can settle after admission; they do not change what
    // the user said. Bind the original author/content identity, not transport.
    digest: createHash("sha256").update(JSON.stringify({
      taskId: message.taskId, id: message.id, kind: message.kind,
      author: message.author, body: message.body, createdAt: message.createdAt
    })).digest("hex"),
    purpose: purpose.trim(),
    nativeSessionId: caller.nativeSessionId
  };
}

const RELEASE_ACTIONS = new Set([
  "pr-create-or-reuse", "ci-confirm", "merge", "version-tag",
  "npm-publish", "fresh-install-smoke", "post-verify"
]);
const TASK_ACTIONS = new Set([...RELEASE_ACTIONS, "plugin.execute", "resource.local.read", "resource.local.write"]);

/** Leader grants cannot silently become global grants. Domain consumers still
 * enforce the exact bounds, digest, uses, expiry and irreversible ceiling. */
export function assertLeaderGrantBounds(store: TaskStore, grant: CapabilityGrant, now: Date): void {
  const task = store.getTask(grant.taskId)!;
  if (task.status !== "active" || task.executionGate?.state !== "enabled") {
    throw usageError("New Leader grants require an active Task with execution enabled.");
  }
  if (!grant.expiresAt || Date.parse(grant.expiresAt) <= now.getTime() || !grant.maxUses) {
    throw usageError("Leader grants require a future --expires-at and finite --max-uses.");
  }
  if (grant.scope.taskId !== grant.taskId
    || grant.scope.projectIds?.some(id => !task.projectBindings.some(binding => binding.projectId === id))
    || grant.actions.some(action => !TASK_ACTIONS.has(action))) {
    throw usageError("Grant exceeds this Task's Project or action authority; global operations require Operator.");
  }
  const bounds = (names: string[]) => {
    for (const name of names) {
      if (!grant.parameterBounds[name]?.length) throw usageError(`Leader grant requires exact --param ${name}=... bounds.`);
    }
  };
  if (grant.actions.some(action => RELEASE_ACTIONS.has(action))) {
    bounds(["sourceCommit"]);
    if (grant.actions.includes("post-verify")) bounds(["command"]);
    if (grant.parameterBounds.sourceCommit!.some(commit => !/^[a-f0-9]{40}$/u.test(commit))) {
      throw usageError("Release sourceCommit bounds must be exact 40-hex commits.");
    }
    if (!grant.scope.projectIds?.length || !grant.scope.repositories?.length || grant.scope.homePath) {
      throw usageError("Release grants require explicit Project/repository scope and cannot target a Home.");
    }
    const repositories = grant.scope.projectIds.map(id => store.getProject(id)?.remoteUrl)
      .map(url => url?.replace(/\.git$/u, "").match(/[:/]([^/:]+\/[^/]+)$/u)?.[1]);
    if (grant.scope.repositories.some(repo => !repositories.includes(`${repo.owner}/${repo.name}`))) {
      throw usageError("Repository is outside the selected Task Projects.");
    }
    if (grant.actions.some(action => ["npm-publish", "fresh-install-smoke", "version-tag"].includes(action))) bounds(["version"]);
    if (grant.parameterBounds.version?.some(version => !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version))) {
      throw usageError("Release version bounds must name concrete versions, not tags or ranges.");
    }
    if (grant.actions.some(action => ["npm-publish", "fresh-install-smoke"].includes(action))
      && !grant.scope.packages?.length) throw usageError("Package effects require explicit --scope-package.");
  }
  if (grant.actions.includes("plugin.execute")) {
    bounds(["pluginId", "digest", "environmentRef", "trust", "phase"]);
    if (grant.parameterBounds.environmentRef!.some(ref => !ref.startsWith(`${grant.taskId}/`))
      || grant.parameterBounds.trust!.some(trust => trust !== "trusted-local")
      || grant.parameterBounds.phase!.some(phase => !["build", "validate", "activate", "call"].includes(phase))) {
      throw usageError("Plugin grant has an out-of-Task environment, trust or phase.");
    }
  }
  if (grant.actions.some(action => action.startsWith("resource.local."))) {
    bounds(["resourceId"]);
    if (!grant.scope.homePath) throw usageError("Local resource grants require an exact canonical --scope-home path.");
    const path = assertTaskLocalResourcePath(store, grant.scope.homePath);
    if (grant.parameterBounds.resourceId!.some(id => store.getLocalResource(id)?.path !== path)) {
      throw usageError("Resource identity does not match the authorized canonical path.");
    }
  } else if (grant.scope.homePath) {
    throw usageError("A Leader cannot grant Home access.");
  }
}

export function assertTaskLocalResourcePath(store: TaskStore, path: string): string {
  const canonical = realpathSync(path);
  if (canonical !== path) throw usageError("Use the exact canonical resource directory path.");
  const overlaps = (other: string) => {
    const contains = (parent: string, child: string) => {
      const rel = relative(parent, child);
      return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
    };
    return contains(canonical, other) || contains(other, canonical);
  };
  const protectedPaths = [
    realpathSync(store.rootDirectory()), ...store.listProjects().map(project => project.path),
    ...store.listTasks().flatMap(task => store.listManagedWorkspaces(task.id)
      .flatMap(workspace => [workspace.root, ...workspace.entries.map(entry => entry.path)]))
  ];
  if (protectedPaths.some(overlaps)) {
    throw usageError("Resource overlaps a Yui Home, stable Project or managed workspace; use its existing authority.");
  }
  return canonical;
}
