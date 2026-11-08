import { isDeepStrictEqual } from "node:util";
import { requireKnownFields } from "../domain/validation.js";
import { createRoleAgentBinding, resolveLeaderStageBinding, validateGlobalRole, validateTaskRole,
  type GlobalRole, type TaskRole, type LeaderSelectionOverride, type LeaderLaunchOverrides,
  type LeaderConfigurationSources } from "./role.js";

/** Persist the binding, never a copy of the inherited configuration. Historical
 * Runs keep their own effective snapshot; current reads resolve the parent. */
export type InheritedTaskRole = Pick<TaskRole,
  "schemaVersion" | "taskId" | "name" | "template" | "workspace" | "launchRevision" |
  "createdAt" | "updatedAt" | "executionEnvironment" | "instanceCode" | "launchOverrides">;
export type StoredTaskRole = TaskRole | InheritedTaskRole;
const localFields = ["schemaVersion", "taskId", "name", "template", "workspace", "launchRevision",
  "createdAt", "updatedAt", "executionEnvironment", "instanceCode", "launchOverrides"] as const;
const inheritedFields = ["activeAgentId", "agentBindings", "leaderStages", "defaultAccess", "description",
  "responsibilities", "constraints", "expectedOutput", "systemPrompt", "skills", "enabled", "configurationSources"] as const;

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
  if (role.launchOverrides !== undefined) {
    validateSelection(role.launchOverrides, true);
    for (const selection of Object.values(role.launchOverrides.stages ?? {})) validateSelection(selection);
  }
}

function validateSelection(selection: LeaderSelectionOverride & { stages?: LeaderLaunchOverrides["stages"] }, stages = false): void {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new Error("Invalid Leader launch override.");
  requireKnownFields(selection, stages ? ["agentId", "bindings", "stages"] : ["agentId", "bindings"], "Leader launch override");
  if (selection.agentId !== undefined && (typeof selection.agentId !== "string"
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(selection.agentId))) throw new Error("Invalid override Agent id.");
  if (selection.stages !== undefined) {
    if (!selection.stages || typeof selection.stages !== "object" || Array.isArray(selection.stages)) throw new Error("Invalid Leader stages.");
    requireKnownFields(selection.stages, ["draft", "develop"], "Leader stages");
  }
  if (selection.bindings !== undefined) {
    if (!selection.bindings || typeof selection.bindings !== "object" || Array.isArray(selection.bindings)) throw new Error("Invalid override bindings.");
    for (const [id, binding] of Object.entries(selection.bindings)) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("Invalid override binding.");
      requireKnownFields(binding, ["adapterId", "component", "model", "effort"], "Leader override binding");
      const base = createRoleAgentBinding({ id, ...binding });
      resolveLeaderStageBinding({ name: "leader", activeAgentId: id, agentBindings: { [id]: base },
        leaderStages: { draft: { ...(binding.model === undefined ? {} : { model: binding.model }),
          ...(binding.effort === undefined ? {} : { effort: binding.effort }) } } }, "draft");
      for (const field of ["model", "effort"] as const) {
        if (binding[field] !== undefined && (typeof binding[field] !== "string" || !binding[field]!.trim())) {
          throw new Error(`Invalid override ${field}.`);
        }
      }
    }
  }
}

export function resolveTaskRoleTemplate(role: StoredTaskRole, parent: GlobalRole | null): TaskRole {
  if (role.template === undefined) return validateTaskRole(role as TaskRole);
  validateStoredTaskRole(role);
  if (!parent || parent.name !== "leader") throw new Error("ExperimentLeader requires the global Leader template.");
  validateGlobalRole(parent);
  const overrides = role.launchOverrides;
  const bindings = structuredClone(parent.agentBindings);
  // Newly selected Agents use their own standard binding. Existing bindings
  // continue inheriting permissions and other non-overridable configuration.
  for (const selection of [overrides, ...Object.values(overrides?.stages ?? {})]) {
    for (const [id, descriptor] of Object.entries(selection?.bindings ?? {})) {
      const current = bindings[id];
      if (current && (current.adapterId !== descriptor.adapterId || current.component !== descriptor.component)) {
        throw new Error(`Experiment Leader Agent identity changed: ${id}. Clear its overrides before selecting it again.`);
      }
      bindings[id] ??= createRoleAgentBinding({ id, ...descriptor });
    }
  }
  const select = (stage?: "draft" | "develop") => {
    const inherited = stage === undefined ? undefined : parent.leaderStages?.[stage];
    const local = stage === undefined ? undefined : overrides?.stages?.[stage];
    const agentId = local?.agentId ?? overrides?.agentId ?? inherited?.agentId ?? parent.activeAgentId;
    const binding = bindings[agentId];
    if (!binding) throw new Error(`Experiment Leader Agent is not bound: ${agentId}.`);
    const sources: LeaderConfigurationSources = {
      agentId: local?.agentId !== undefined ? "task-stage" : overrides?.agentId !== undefined ? "task-default"
        : inherited?.agentId !== undefined ? "global-stage" : "global-default",
      model: "native-default", effort: "native-default"
    };
    const selection: { agentId: string; model?: string; effort?: string } = { agentId };
    for (const field of ["model", "effort"] as const) {
      const candidates = [
        [local?.bindings?.[agentId]?.[field], "task-stage"],
        [overrides?.bindings?.[agentId]?.[field], "task-default"],
        [(inherited?.agentId ?? parent.activeAgentId) === agentId ? inherited?.[field] : undefined, "global-stage"],
        [binding.config[field], parent.agentBindings[agentId] ? "global-binding" : "native-default"]
      ] as const;
      const winner = candidates.find(([value]) => value !== undefined);
      if (winner) { selection[field] = winner[0]; sources[field] = winner[1]; }
    }
    const resolved = resolveLeaderStageBinding({ name: "leader", activeAgentId: agentId, agentBindings: bindings,
      leaderStages: { draft: selection } }, "draft");
    return { selection, sources, binding: resolved };
  };
  const base = select(), draft = select("draft"), develop = select("develop");
  return validateTaskRole({
    ...structuredClone(parent),
    ...structuredClone(role),
    enabled: parent.enabled,
    launchRevision: parent.launchRevision + role.launchRevision,
    activeAgentId: base.binding.agentId,
    agentBindings: { ...bindings, [base.binding.agentId]: base.binding },
    leaderStages: { draft: draft.selection, develop: develop.selection },
    configurationSources: { default: base.sources, draft: draft.sources, develop: develop.sources },
    responsibilities: [...(parent.responsibilities ?? []),
      "Maintain experiment directions, fixed plans, measurements and evidence-based conclusions."],
    skills: [...(parent.skills ?? []).filter(id => id !== "yui-leader"), "yui-experiment-leader"]
  });
}

/** Explicit patch boundary; a resolved Role round trip must never freeze its parent. */
export function updateExperimentLeaderOverrides(role: TaskRole, parent: GlobalRole, overrides: LeaderLaunchOverrides, now: Date): TaskRole {
  const local = taskRoleStorageRecord(role, parent) as InheritedTaskRole;
  if (!isDeepStrictEqual(local.launchOverrides ?? {}, overrides)) local.launchRevision++;
  local.updatedAt = now.toISOString();
  if (Object.keys(overrides).length) local.launchOverrides = structuredClone(overrides);
  else delete local.launchOverrides;
  return resolveTaskRoleTemplate(local, parent);
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
    throw new Error("ExperimentLeader inherits non-overridden configuration; use task role update for launch overrides or update the parent Leader template.");
  }
  return local;
}

export function createExperimentLeader(taskId: string, workspace: string, parent: GlobalRole | null, now: Date): TaskRole {
  return resolveTaskRoleTemplate({
    schemaVersion: 1, taskId, name: "leader", template: "experiment-leader",
    workspace, launchRevision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString()
  }, parent);
}
