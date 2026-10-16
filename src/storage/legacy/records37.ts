import { normalizeVerificationPlan } from "../../verification/verificationPlan.js";

/**
 * Explicit integer-storage-37 -> storage-1.0 envelope conversion.
 *
 * Derived from tools/baseline-cutover/records.mjs at
 * b560cce2ee7cf7d3d893871cff547ab9f9ed9ebb. Only named Yui envelopes
 * change. Business revisions, native identities, receipt states, frozen Context
 * and arbitrary user/provider JSON retain their original meaning and bytes.
 * This is a migration transform, never an ordinary Store reader.
 */
const versions: Readonly<Record<string, number>> = Object.freeze({
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
});

export const LEGACY37_RECORD_TABLES = Object.freeze(Object.keys(versions));
type RecordValue = Record<string, unknown>;

function object(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Unsupported legacy:37 ${label}; preserve the original record.`);
  }
  return value as RecordValue;
}

function reset(value: unknown, expected: number, label: string): RecordValue {
  const record = object(value, label);
  if (record.schemaVersion !== expected) {
    throw new Error(`Unsupported legacy:37 ${label} envelope; preserve the original record.`);
  }
  record.schemaVersion = 1;
  return record;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Unsupported legacy:37 ${label}.`);
  return value;
}

function effective(value: unknown): void {
  if (value !== undefined) reset(value, 4, "effective launch");
}
function workspace(value: unknown): void {
  if (value !== undefined) reset(value, 2, "managed workspace");
}
function session(value: unknown): void {
  effective(reset(value, 6, "Role Session").effective);
}
function group(value: unknown): void {
  for (const lane of array(reset(value, 2, "ExecutionGroup").lanes, "ExecutionGroup lanes")) {
    effective(reset(lane, 2, "ExecutionLane").effective);
  }
}

export function convertLegacy37Brief(original: unknown): RecordValue {
  return reset(structuredClone(original), 2, "TaskBrief");
}

/** Run after the minor chain has used original Knowledge/proposal bodies to
 * establish their exact association. Never rewrite the historical proposal. */
export function finalizeLegacy37Project(original: unknown): RecordValue {
  const value = structuredClone(object(original, "Project"));
  for (const entry of array(value.knowledge, "Project knowledge")) {
    const knowledge = object(entry, "Project knowledge entry");
    if (knowledge.status !== "active") continue;
    let plan: unknown;
    try { plan = JSON.parse(String(knowledge.body)); } catch { continue; }
    if (plan === null || typeof plan !== "object" || Array.isArray(plan)
      || (plan as RecordValue).kind !== "verification-plan") continue;
    reset(plan, 2, "active VerificationPlan");
    normalizeVerificationPlan(plan);
    knowledge.body = JSON.stringify(plan);
  }
  return value;
}

export function convertLegacy37Record(table: string, original: unknown): RecordValue {
  const version = Object.hasOwn(versions, table) ? versions[table] : undefined;
  if (version === undefined) throw new Error(`Unknown legacy:37 record family ${table}.`);
  const value = reset(structuredClone(original), version, table);
  switch (table) {
    case "role_session_sets":
    case "global_role_session_sets":
      for (const item of Object.values(object(value.sessions, "sessions"))) session(item);
      for (const item of table === "role_session_sets"
        ? array(value.history ?? [], "Task Session history")
        : Object.values(object(value.history ?? {}, "Global Session history"))) session(item);
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
      for (const item of array(value.executionGroups, "WorkItem executionGroups")) group(item);
      for (const item of array(value.candidates, "WorkItem candidates")) {
        workspace(reset(item, 3, "WorkItem Candidate").workspace);
      }
      break;
    case "events":
      if (value.type === "runtime.observation" || value.type === "runtime.process-exit-observed") {
        const payload = object(value.payload, "Event payload");
        if (typeof payload.observation !== "string") throw new Error("Invalid legacy:37 observation.");
        const observation: unknown = JSON.parse(payload.observation);
        reset(observation, value.type === "runtime.observation" ? 4 : 2, value.type);
        payload.observation = JSON.stringify(observation);
      }
      break;
  }
  return value;
}
