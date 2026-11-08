import { copyGlobalRoleToTaskRole, validateTaskRole, type GlobalRole, type TaskRole } from "./role.js";

/** Experiment mode adds capabilities to the ordinary copied Task Leader.
 * Skill bodies still resolve from the current shared installation/Home. */
export function createExperimentLeaderFromRole(role: TaskRole): TaskRole {
  if (role.name !== "leader") throw new Error("ExperimentLeader requires a Leader.");
  return validateTaskRole({
    ...role,
    template: "experiment-leader",
    responsibilities: [...(role.responsibilities ?? []),
      "Maintain experiment directions, fixed plans, measurements and evidence-based conclusions."],
    skills: [...new Set([...(role.skills ?? []).filter(id => id !== "yui-leader"), "yui-experiment-leader"])]
  });
}

export function createExperimentLeader(taskId: string, workspace: string, parent: GlobalRole | null, now: Date): TaskRole {
  if (!parent || parent.name !== "leader") throw new Error("ExperimentLeader requires the global Leader template.");
  return createExperimentLeaderFromRole({ ...copyGlobalRoleToTaskRole(parent, taskId, now), workspace });
}
