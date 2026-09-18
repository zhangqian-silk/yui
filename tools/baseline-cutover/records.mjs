// One-time 0.99.0 contract reader. This directory is never a runtime dependency.
// Only named Yui-owned envelopes are converted. User JSON, frozen Context
// resources, native payloads, counters, hashes and revision fields are opaque.
const versions = {
  config: 6, configured_agents: 3, agent_profiles: 3, projects: 6,
  task_records: 7, task_roles: 4, global_roles: 3,
  role_session_sets: 12, global_role_session_sets: 5,
  messages: 3, global_role_messages: 1, turns: 5, review_rounds: 8,
  change_sets: 4, integration_attempts: 6, durable_jobs: 2,
  managed_workspaces: 2, input_requests: 3, decisions: 1, milestones: 2,
  events: 2, task_wakes: 2, capability_grants: 2, release_workflows: 1,
  publication_references: 1, local_resources: 1, environment_preparations: 1,
  plugin_intents: 1, plugin_validations: 1, session_owners: 2,
  work_items: 15, active_turns: 3,
  context_snapshots: 1, gate_artifacts: 1, resource_registry: 1
};
export const RECORD_TABLES = Object.freeze(Object.keys(versions));

function reset(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== expected) {
    throw new Error(`Unsupported 0.99.0 ${label} envelope; preserve the original record.`);
  }
  value.schemaVersion = 1;
  return value;
}
function effective(value) { if (value !== undefined) reset(value, 4, "effective launch"); }
function workspace(value) { if (value !== undefined) reset(value, 2, "managed workspace"); }
function session(value) { reset(value, 6, "Role Session"); effective(value.effective); }
function candidate(value) {
  reset(value, 3, "WorkItem Candidate");
  workspace(value.workspace);
}
function group(value) {
  reset(value, 2, "ExecutionGroup");
  for (const lane of value.lanes) {
    reset(lane, 2, "ExecutionLane");
    effective(lane.effective);
  }
}

export function convertBrief(value) { return reset(value, 2, "TaskBrief"); }

export function convertRecord(table, original) {
  const value = structuredClone(original);
  reset(value, versions[table], table);
  switch (table) {
    case "projects":
      for (const entry of value.knowledge) {
        if (entry.status !== "active") continue;
        let plan;
        try { plan = JSON.parse(entry.body); } catch { continue; }
        if (plan?.kind !== "verification-plan") continue;
        reset(plan, 2, "active VerificationPlan");
        entry.body = JSON.stringify(plan);
      }
      break;
    case "role_session_sets":
    case "global_role_session_sets":
      for (const item of Object.values(value.sessions)) session(item);
      for (const item of Object.values(value.history ?? {})) session(item);
      if (value.providerBinding !== null) reset(value.providerBinding, 5, "Provider Runtime Binding");
      break;
    case "turns":
      effective(value.effective);
      workspace(value.workspace);
      if (value.result !== undefined) reset(value.result, 2, "AgentRun Result");
      break;
    case "review_rounds":
      workspace(value.workspace);
      if (value.executionGroup !== undefined) group(value.executionGroup);
      break;
    case "work_items":
      for (const item of value.executionGroups) group(item);
      for (const item of value.candidates) candidate(item);
      break;
    case "events":
      if (value.type === "runtime.observation" || value.type === "runtime.process-exit-observed") {
        const observation = JSON.parse(value.payload.observation);
        reset(observation, value.type === "runtime.observation" ? 4 : 2, value.type);
        value.payload.observation = JSON.stringify(observation);
      }
      break;
  }
  return value;
}
