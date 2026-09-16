import { usageError, taskNotFound, roleNotFound, agentNotFound } from "../errors/cliError.js";
import type { ResolveAgentConfigurationInput, ResolvedAgentConfigurationCatalog } from "./agentConfigurationCatalog.js";
import { projectAgentCapabilityConfig, type AgentCapabilityConfig } from "./agentCapabilityConfig.js";
import { activeRoleAgentBinding } from "../role/role.js";
import { configuredAgentFingerprint, readAgentFailureContext } from "../runtime/agentFailureContext.js";
import { resolveManagedTaskReader } from "../runtime/managedCaller.js";
import { assertContextRecordReadable } from "../context/taskContext.js";
import type { TaskStore } from "../storage/taskStore.js";

export type TaskAgentCapabilityQuery = Readonly<{
  taskId: string; roleName: string; errorId?: string; refresh?: boolean;
}>;

export type TaskAgentCapabilityContext = Readonly<{
  taskId: string; roleName: string; selection: "desired-role" | "failed-launch";
  errorId?: string; agentId: string; requestedModel?: string; cwd: string;
}>;
export type TaskAgentCapabilityResult = ResolvedAgentConfigurationCatalog & Readonly<{
  context: TaskAgentCapabilityContext & Readonly<{ environmentSource: "controller" }>;
}>;

/** Resolve authority and scope before any native metadata process is started. */
export function resolveTaskAgentCapabilities(
  query: TaskAgentCapabilityQuery, store: TaskStore, environment: NodeJS.ProcessEnv = {}
): Readonly<{
  input: ResolveAgentConfigurationInput;
  context: TaskAgentCapabilityContext;
}> {
  const { taskId, roleName, errorId } = query;
  const reader = resolveManagedTaskReader(store, environment);
  if (reader !== undefined && (reader.taskId !== taskId
    || reader.roleName !== "leader" && reader.roleName !== roleName)) {
    throw usageError("Agent capability query is outside the caller's Task/Role.");
  }
  const task = store.getTask(taskId);
  if (task === null) throw taskNotFound(taskId);
  let agentId: string, cwd: string, config: AgentCapabilityConfig;
  let expectedFingerprint: string | undefined;
  let expectedComponent: string | undefined;
  if (errorId !== undefined) {
    assertContextRecordReadable(store, taskId, "task-event", errorId, environment);
    const event = store.listEventsByType(taskId, ["runtime.agent-error"]).find(event => event.id === errorId);
    if (event === undefined || event.payload.roleName !== roleName) {
      throw usageError("Agent failure is not owned by this Task/Role.");
    }
    const captured = readAgentFailureContext(event.payload.capabilityContext);
    if (captured.status === "unavailable") {
      throw usageError(`${captured.reason} No historical configuration was inferred. `
        + `Inspect current desired configuration explicitly with yui task role capabilities ${taskId} ${roleName} --refresh.`);
    }
    ({ agentId, cwd, config } = captured);
    expectedFingerprint = captured.agentFingerprint;
  } else {
    const role = store.getRole(taskId, roleName);
    if (role === null) throw roleNotFound(roleName);
    const binding = activeRoleAgentBinding(role);
    agentId = binding.agentId;
    expectedComponent = binding.component;
    cwd = role.workspace;
    config = projectAgentCapabilityConfig(binding.config);
  }
  const agent = store.getConfiguredAgent(agentId);
  if (agent === null) throw agentNotFound(agentId);
  if (agent.adapterId !== config.adapterId
    || expectedComponent !== undefined && agent.component !== expectedComponent) {
    throw usageError("The Role capability binding no longer matches the configured Agent implementation.");
  }
  if (expectedFingerprint !== undefined && configuredAgentFingerprint(agent) !== expectedFingerprint) {
    throw usageError("The configured Agent command or environment bindings changed since this failure. "
      + "The historical capability query was not run; inspect current desired configuration explicitly.");
  }
  return {
    input: { agent, cwd, config,
      refresh: query.refresh === true },
    context: { taskId, roleName, selection: errorId === undefined ? "desired-role" : "failed-launch",
      ...(errorId === undefined ? {} : { errorId }), agentId: agent.id,
      ...(config.model === undefined ? {} : { requestedModel: config.model }),
      cwd }
  };
}
