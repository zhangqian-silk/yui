import type { AgentAdapterId } from "./adapterCatalog.js";
import {
  resolveAgentEnvironment,
  type ConfiguredAgent
} from "./agent.js";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";
import { usableInteractiveTerminal } from "../output/terminal.js";

export { YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES } from "./managedRuntimeEnvironment.js";

/**
 * Non-secret process context needed by native Agent CLIs after tmux starts
 * them with an empty environment. Keep this list explicit: arbitrary parent
 * variables can contain credentials belonging to a different Agent.
 */
export const AGENT_OPERATIONAL_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TMUX_TMPDIR",
  "TERM",
  "COLORTERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_ADDRESS",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NAME",
  "LC_NUMERIC",
  "LC_PAPER",
  "LC_TELEPHONE",
  "LC_TIME",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "SSH_AUTH_SOCK"
] as const;

/** Native account context. Credential values remain volatile and belong only
 * to this adapter; they are never copied into Roles, Tasks or launch arguments.
 * Do not inherit numeric credential FDs across unrelated processes. */
const CLAUDE_NATIVE_ENVIRONMENT_NAMES = [
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_AUTOUPDATER"
] as const;

export const NATIVE_AGENT_ENVIRONMENT_NAMES = [
  "CODEX_HOME", ...CLAUDE_NATIVE_ENVIRONMENT_NAMES
] as const;

export function nativeAgentEnvironmentNames(
  adapterId: AgentAdapterId
): readonly string[] {
  switch (adapterId) {
    case "codex": return ["CODEX_HOME"];
    case "claude": return CLAUDE_NATIVE_ENVIRONMENT_NAMES;
    // ACP standardizes the protocol, not where a product keeps its
    // configuration. Naming a variable here would be a product branch, so an
    // ACP Agent that needs one declares it as an ordinary environment binding.
    case "acp": return [];
  }
}

export function selectEnvironment(
  source: NodeJS.ProcessEnv,
  names: Iterable<string>
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}

function selectNonEmptyEnvironment(
  source: NodeJS.ProcessEnv,
  names: Iterable<string>
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value.length > 0) selected[name] = value;
  }
  return selected;
}

export function operationalAgentEnvironment(
  adapterId: AgentAdapterId,
  source: NodeJS.ProcessEnv
): Record<string, string> {
  return {
    ...selectNonEmptyEnvironment(source, [
      ...AGENT_OPERATIONAL_ENVIRONMENT_NAMES,
      ...nativeAgentEnvironmentNames(adapterId)
    ]),
    PATH: source.PATH
      || `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: source.HOME || homedir(),
    TERM: usableInteractiveTerminal(source.TERM),
    // Base fallback only. Every managed Task launch has its isolation
    // environment (TMPDIR = the Home-side runtime `roots.temporary`) assigned
    // OVER this by the launch planner, so this branch is reached only by
    // non-isolated global/ad-hoc launches with no managed runtime. Those run in
    // the operator's own context, where their inherited TMPDIR (or the system
    // temp) is the correct scratch — forcing it under control Home would
    // misroute user scratch into Yui-managed storage.
    TMPDIR: source.TMPDIR || tmpdir()
  };
}

export function configuredAgentLaunchEnvironment(
  agent: ConfiguredAgent,
  source: NodeJS.ProcessEnv
): Record<string, string> {
  const {
    SSH_AUTH_SOCK: _sshAgent,
    ...operational
  } = operationalAgentEnvironment(agent.adapterId, source);
  return {
    ...operational,
    ...resolveAgentEnvironment(agent, source)
  };
}
