import { isDeepStrictEqual } from "node:util";
import { requireKnownFields } from "../domain/validation.js";
import { validateGlobalRole, validateTaskRole, type GlobalRole, type TaskRole } from "./role.js";

/** Persist the binding, never a copy of the inherited configuration. Historical
 * Runs keep their own effective snapshot; current reads resolve the parent. */
export type InheritedTaskRole = Pick<TaskRole,
  "schemaVersion" | "taskId" | "name" | "template" | "workspace" | "launchRevision" |
  "createdAt" | "updatedAt" | "executionEnvironment" | "instanceCode">;
export type StoredTaskRole = TaskRole | InheritedTaskRole;
const localFields = ["schemaVersion", "taskId", "name", "template", "workspace", "launchRevision",
  "createdAt", "updatedAt", "executionEnvironment", "instanceCode"] as const;
const inheritedFields = ["activeAgentId", "agentBindings", "leaderStages", "defaultAccess", "description",
  "responsibilities", "constraints", "expectedOutput", "systemPrompt", "skills", "enabled"] as const;

export function validateStoredTaskRole(role: StoredTaskRole): void {
  if (role.template === undefined) { validateTaskRole(role as TaskRole); return; }
  requireKnownFields(role, localFields, "Inherited Task Role");
  if (role.template !== "experiment-leader" || role.name !== "leader" || role.schemaVersion !== 1
    || typeof role.taskId !== "string" || !/^task-[a-zA-Z0-9_-]+$/u.test(role.taskId)
    || typeof role.workspace !== "string" || !role.workspace.trim()
    || !Number.isSafeInteger(role.launchRevision) || role.launchRevision < 1
    || !Number.isFinite(Date.parse(role.createdAt)) || !Number.isFinite(Date.parse(role.updatedAt))) {
    throw new Error("Invalid inherited Task Leader binding.");
  }
}

export function resolveTaskRoleTemplate(role: StoredTaskRole, parent: GlobalRole | null): TaskRole {
  if (role.template === undefined) return validateTaskRole(role as TaskRole);
  validateStoredTaskRole(role);
  if (!parent || parent.name !== "leader") throw new Error("ExperimentLeader requires the global Leader template.");
  validateGlobalRole(parent);
  return validateTaskRole({
    ...structuredClone(parent),
    ...structuredClone(role),
    enabled: parent.enabled,
    launchRevision: parent.launchRevision + role.launchRevision,
    responsibilities: [...(parent.responsibilities ?? []),
      "Maintain experiment directions, fixed plans, measurements and evidence-based conclusions."],
    skills: [...(parent.skills ?? []).filter(id => id !== "yui-leader"), "yui-experiment-leader"]
  });
}

export function taskRoleStorageRecord(role: TaskRole, parent: GlobalRole | null): StoredTaskRole {
  if (role.template === undefined) return role;
  if (!parent) throw new Error("ExperimentLeader requires the global Leader template.");
  const local = Object.fromEntries(localFields.filter(key => role[key] !== undefined)
    .map(key => [key, role[key]])) as InheritedTaskRole;
  local.launchRevision = role.launchRevision - parent.launchRevision;
  validateStoredTaskRole(local);
  const effective = resolveTaskRoleTemplate(local, parent);
  if (inheritedFields.some(key => !isDeepStrictEqual(role[key], effective[key]))) {
    throw new Error("ExperimentLeader inherits its configuration directly; update the parent Leader template.");
  }
  return local;
}

export function createExperimentLeader(taskId: string, workspace: string, parent: GlobalRole | null, now: Date): TaskRole {
  return resolveTaskRoleTemplate({
    schemaVersion: 1, taskId, name: "leader", template: "experiment-leader",
    workspace, launchRevision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString()
  }, parent);
}
