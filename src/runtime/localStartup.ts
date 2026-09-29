import {
  configuredAgentToDefinition,
  resolveAgentEnvironment,
  type ConfiguredAgent
} from "../agent/agent.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  codexSharedSocketPath,
  ensureCodexSharedDaemon,
  findMacCodexAppExecutable,
  prepareMacCodexAppConnection,
  type CodexProxyLaunch,
  type MacCodexAppPreparation
} from "./codexSharedDaemon.js";

export type LocalCodexStartup = Readonly<{
  daemons: readonly Readonly<{ agentIds: readonly string[]; socketPath: string; started: boolean }>[];
  app: "not-applicable" | "not-detected" | "multiple-homes" | MacCodexAppPreparation["state"];
}>;

/** Current Role demand, not every CLI installed on the machine or stale Agent record. */
export function codexAgentsInUse(store: TaskStore, targetAgentId?: string): ConfiguredAgent[] {
  const ids = new Set<string>();
  if (targetAgentId !== undefined) {
    ids.add(targetAgentId);
  } else {
    for (const role of store.listGlobalRoles()) ids.add(role.activeAgentId);
    for (const taskId of store.listActiveTaskIds()) {
      for (const role of store.listRoles(taskId)) ids.add(role.activeAgentId);
    }
  }
  return [...ids].flatMap((id) => {
    const agent = store.getConfiguredAgent(id);
    return agent?.adapterId === "codex" ? [agent] : [];
  });
}

export async function prepareLocalCodexStartup(
  store: TaskStore,
  home: string,
  environment: NodeJS.ProcessEnv,
  targetAgentId?: string,
  platform: string = process.platform
): Promise<LocalCodexStartup> {
  const agents = codexAgentsInUse(store, targetAgentId);
  if (agents.length === 0) return { daemons: [], app: "not-applicable" };
  const groups = new Map<string, { launch: CodexProxyLaunch; agentIds: string[] }>();
  for (const configured of agents) {
    const agent = configuredAgentToDefinition(configured);
    const launch: CodexProxyLaunch = {
      command: agent.command,
      args: [...agent.baseArgs, "app-server", "proxy"],
      cwd: home,
      environment: {
        ...environment,
        ...resolveAgentEnvironment(agent, environment),
        YUI_AGENT_BASE_ARGS: JSON.stringify(agent.baseArgs)
      }
    };
    const socketPath = codexSharedSocketPath(launch.environment, home);
    const existing = groups.get(socketPath);
    if (existing === undefined) groups.set(socketPath, { launch, agentIds: [agent.id] });
    else existing.agentIds.push(agent.id);
  }
  const daemons = [];
  for (const [socketPath, group] of groups) {
    const started = await ensureCodexSharedDaemon(group.launch);
    daemons.push({ agentIds: group.agentIds, socketPath, started });
  }
  if (platform !== "darwin") return { daemons, app: "not-applicable" };
  const appExecutable = findMacCodexAppExecutable(environment);
  if (appExecutable === undefined) return { daemons, app: "not-detected" };
  const operatorAgentId = store.getGlobalRole("operator")?.activeAgentId;
  const selected = [...groups.values()].find((group) => group.agentIds.includes(operatorAgentId ?? ""))
    ?? (groups.size === 1 ? [...groups.values()][0] : undefined);
  if (selected === undefined) return { daemons, app: "multiple-homes" };
  const selectedSocketPath = codexSharedSocketPath(selected.launch.environment, home);
  const daemonStartedEarlier = daemons.find((daemon) => daemon.socketPath === selectedSocketPath)?.started ?? false;
  const prepared = await prepareMacCodexAppConnection(selected.launch, appExecutable, daemonStartedEarlier);
  return { daemons, app: prepared.state };
}
