import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentDefinition } from "../agent/agent.js";
import { isAgentAdapterId, supportedAgentAdapterIds, type AgentAdapterId } from "../agent/adapterCatalog.js";
import {
  ownedArgumentsForAdapter,
  validateAgentAdvancedArguments,
  validateAgentBaseArguments
} from "../agent/argumentPolicy.js";
import { writeTextFileAtomically } from "../storage/durableFile.js";
import type {
  AgentConfigurationCatalog,
  AgentConfigurationDiscoveryInput
} from "./agentConfigurationCatalog.js";
import {
  discoverAcpConfiguration,
  discoverClaudeConfiguration,
  discoverCodexConfiguration
} from "./agentConfigurationProbe.js";
import type { PreInputReadinessCapability } from "../lifecycle/canonicalLifecycleEvent.js";
import { builtinAgentDriverRegistry } from "../runtime/builtinAgentDrivers.js";
import type { CodexThreadOptions } from "../runtime/codexAppServerRuntime.js";
import type { AcpSessionOptions } from "../runtime/acpProtocol.js";
import {
  CODEX_SANDBOXES as SANDBOXES, CODEX_APPROVALS as APPROVALS,
  configurationFieldsFromHelp, configurationFieldWarnings,
  staticAgentConfigurationFields, STATIC_CONFIGURATION_NOTICE
} from "./agentConfigurationFields.js";

export type AdvancedAgentConfig = Readonly<{ rawArgs?: readonly string[] }>;
export type PermissionStrategy = "default" | "bypass" | "configured";
export type CodexPermissionConfig =
  | Readonly<{ strategy: "default" }>
  | Readonly<{ strategy: "bypass" }>
  | Readonly<{
      strategy: "configured";
      sandbox?: "read-only" | "workspace-write" | "danger-full-access";
      approval?: "untrusted" | "on-request" | "never";
    }>;
export type ClaudePermissionConfig =
  | Readonly<{ strategy: "default" }>
  | Readonly<{ strategy: "bypass" }>
  | Readonly<{
      strategy: "configured";
      mode?: string;
      allowedTools?: readonly string[];
      disallowedTools?: readonly string[];
    }>;
export type CodexAgentConfig = Readonly<{
  adapterId: "codex";
  model?: string;
  effort?: string;
  permission: CodexPermissionConfig;
  search?: boolean;
  profile?: string;
  additionalDirectories?: readonly string[];
  advanced?: AdvancedAgentConfig;
}>;
export type ClaudeAgentConfig = Readonly<{
  adapterId: "claude";
  model?: string;
  effort?: string;
  permission: ClaudePermissionConfig;
  additionalDirectories?: readonly string[];
  settingsFile?: string;
  settingsSources?: readonly string[];
  advanced?: AdvancedAgentConfig;
}>;
/**
 * Configuration for an Agent reached over ACP.
 *
 * Model and reasoning effort are absent here because Yui's ACP client does not
 * implement `session/set_config_option` — not because the protocol lacks it.
 * ACP v1 defines that method and the `configOptions` an Agent advertises during
 * session setup, including `model` and `thought_level` categories. Stating the
 * limit as Yui's keeps the record honest and marks exactly what to build next.
 */
export type AcpAgentConfig = Readonly<{
  adapterId: "acp";
  /**
   * Selected through ACP's own session config options after the Session exists.
   * The protocol enumerates the values each Agent accepts, so a value stated
   * here is checked against that enumeration at launch rather than guessed at
   * configuration time.
   */
  model?: string;
  effort?: string;
  additionalDirectories?: readonly string[];
  /**
   * Unsupported by Yui's ACP client, not by the protocol: ACP defines no
   * client-side settings file or settings source, so there is nothing to send.
   */
  settingsFile?: undefined;
  settingsSources?: undefined;
  /**
   * How this Role's Session permission mode is decided.
   *
   * `default` states no opinion: Yui sends no mode, so the Agent's own default
   * stands. `bypass` is the user explicitly asking to act without approval
   * prompts, and is applied only through the mode value the selected execution
   * component declares. `configured` names one exact mode id the Agent offers.
   *
   * This is separate from how Yui answers `session/request_permission`. That
   * client-side question has one answer on this transport — Yui holds no
   * interactive consent and declines — and no strategy here changes it.
   */
  permission: AcpPermissionConfig;
  advanced?: AdvancedAgentConfig;
}>;

export type AcpPermissionConfig =
  | Readonly<{ strategy: "default" }>
  | Readonly<{ strategy: "bypass" }>
  | Readonly<{ strategy: "configured"; mode: string }>;
export type RoleAgentConfig = CodexAgentConfig | ClaudeAgentConfig | AcpAgentConfig;
export type CodexRoleAgentConfig = CodexAgentConfig;
export type ClaudeRoleAgentConfig = ClaudeAgentConfig;
export type AcpRoleAgentConfig = AcpAgentConfig;

export type CapabilityField = Readonly<{
  key: string;
  kind: "enum" | "boolean" | "string" | "string-list" | "path" | "path-list";
  status: "available" | "degraded" | "unavailable";
  choices?: readonly string[];
  allowCustom: boolean;
}>;
export type AgentInstallation = Readonly<{
  status: "installed" | "missing" | "unsupported-version" | "probe-failed";
  command: string;
  version?: string;
  reason?: string;
  probedAt: string;
}>;
export type CapabilitySnapshot = Readonly<{
  schemaVersion: 1;
  agentId: string;
  adapterId: AgentAdapterId;
  installation: AgentInstallation;
  lifecycle: Readonly<{
    start: true;
    resume: true;
    nativeSessionDiscovery: "runtime" | "preallocated";
    interrupt: true;
    /**
     * Whether this provider emits a native event proven to occur before the
     * first prompt that Yui may map to pre-input readiness. Explicit and fail
     * closed when unsupported — never a provider-name default.
     */
    preInputReadiness: PreInputReadinessCapability;
  }>;
  fields: readonly CapabilityField[];
  warnings: readonly string[];
  refreshedAt: string;
}>;
export type AgentProbeResult = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
}>;
export type AgentProbeRunner = (command: string, args: readonly string[]) => AgentProbeResult;
export type CapabilityInspectionOptions = Readonly<{ now?: Date; run?: AgentProbeRunner }>;

export type CompileInput<TConfig extends RoleAgentConfig = RoleAgentConfig> = Readonly<{
  agent: AgentDefinition;
  config: TConfig;
  workspace: string;
  sessionTitle?: string;
  developerInstructions?: string;
  skills?: readonly Readonly<{ id: string; path: string; content: string }>[];
  managedContextFile?: string;
  sessionManifestPath?: string;
  sessionManifestDigest?: string;
}>;
export type ResumeInput<TConfig extends RoleAgentConfig = RoleAgentConfig> =
  CompileInput<TConfig> & Readonly<{ nativeSessionId: string }>;
export type CompiledAgentLaunch = Readonly<{
  argv: readonly string[];
  sessionStrategy: "runtime-discovery" | "preallocated";
  /** Remote TUI flags do not configure the server's new Thread. */
  codexThread?: CodexThreadOptions;
}>;
export type CompiledManagedControlLaunch = CompiledAgentLaunch & Readonly<{
  transport: "codex-app-server-proxy" | "claude-stream-json" | "acp-stdio";
  codexThread?: CodexThreadOptions;
  acpSession?: AcpSessionOptions;
}>;

export interface AgentAdapter<TConfig extends RoleAgentConfig = RoleAgentConfig> {
  readonly id: AgentAdapterId;
  readonly label: string;
  readonly supportedVersion: string;
  readonly capabilities: Readonly<{
    recover: true;
    interrupt: true;
    nativeSessionDiscovery: "runtime" | "preallocated";
    preInputReadiness: PreInputReadinessCapability;
  }>;
  validateConfig(input: CompileInput<TConfig>): void;
  compileNew(input: CompileInput<TConfig>): CompiledAgentLaunch;
  compileResume(input: ResumeInput<TConfig>): CompiledAgentLaunch;
  compileManagedControl(
    input: CompileInput<TConfig>,
    mode: "new" | "resume",
    nativeSessionId?: string
  ): CompiledManagedControlLaunch;
  canonicalizeConfig(config: TConfig): TConfig;
  reservedArguments(): readonly string[];
  discoverConfiguration(input: AgentConfigurationDiscoveryInput): Promise<AgentConfigurationCatalog>;
}

const PROBE_TIMEOUT_MS = 2_000;
const PROBE_MAX_BYTES = 1024 * 1024;
// Offline producer/type evidence, not a claim of live account/model testing.
// Keep the existing minimum support floors separate: see provider-protocol-contracts.md.
const AUDITED_PRODUCER_VERSIONS = { codex: "0.153.4", claude: "2.1.270" } as const;

abstract class BaseAdapter<TConfig extends RoleAgentConfig> implements AgentAdapter<TConfig> {
  abstract readonly id: AgentAdapterId;
  abstract readonly label: string;
  abstract readonly supportedVersion: string;
  abstract readonly capabilities: AgentAdapter<TConfig>["capabilities"];
  abstract validateStructured(config: TConfig): void;
  abstract structuredArgs(config: TConfig): string[];
  abstract compileResume(input: ResumeInput<TConfig>): CompiledAgentLaunch;
  abstract compileManagedControl(
    input: CompileInput<TConfig>,
    mode: "new" | "resume",
    nativeSessionId?: string
  ): CompiledManagedControlLaunch;
  abstract discoverConfiguration(
    input: AgentConfigurationDiscoveryInput
  ): Promise<AgentConfigurationCatalog>;

  launchContextArgs(_input: CompileInput<TConfig>): string[] {
    return [];
  }

  validateConfig(input: CompileInput<TConfig>): void {
    if (input.agent.adapterId !== this.id || input.config.adapterId !== this.id) {
      throw new Error(`Agent adapter identity mismatch: expected ${this.id}.`);
    }
    validateAgentBaseArguments(this.id, input.agent.baseArgs);
    this.validateStructured(input.config);
  }

  compileNew(input: CompileInput<TConfig>): CompiledAgentLaunch {
    this.validateConfig(input);
    const config = this.canonicalizeConfig(input.config);
    return {
      argv: [
        ...input.agent.baseArgs,
        ...this.structuredArgs(config),
        ...this.launchContextArgs(input),
        ...(config.advanced?.rawArgs ?? [])
      ],
      sessionStrategy: this.capabilities.nativeSessionDiscovery === "runtime"
        ? "runtime-discovery"
        : "preallocated"
    };
  }

  canonicalizeConfig(config: TConfig): TConfig {
    this.validateStructured(config);
    const directories = config.additionalDirectories === undefined
      ? undefined
      : canonicalDirectories(config.additionalDirectories);
    return cloneConfig(config, directories) as TConfig;
  }

  reservedArguments(): readonly string[] {
    return ownedArgumentsForAdapter(this.id);
  }
}

class CodexAdapter extends BaseAdapter<CodexAgentConfig> {
  readonly id = "codex" as const;
  readonly label = "Codex";
  readonly supportedVersion = "0.150.1";
  readonly capabilities = {
    recover: true,
    interrupt: true,
    nativeSessionDiscovery: "runtime",
    preInputReadiness: driverPreInputReadiness("codex")
  } as const;

  discoverConfiguration(input: AgentConfigurationDiscoveryInput): Promise<AgentConfigurationCatalog> {
    return discoverCodexConfiguration(input);
  }

  override compileNew(input: CompileInput<CodexAgentConfig>): CompiledAgentLaunch {
    const launch = super.compileNew(input);
    const developerInstructions = codexSessionInstructions(input);
    return {
      ...launch,
      codexThread: {
        ...codexThreadOptions(input, this.canonicalizeConfig(input.config)),
        ...(developerInstructions === undefined ? {} : { developerInstructions })
      }
    };
  }

  validateStructured(config: CodexAgentConfig): void {
    exact(config, ["adapterId", "model", "effort", "permission", "search", "profile",
      "additionalDirectories", "advanced"], "Codex Agent config");
    if (config.adapterId !== "codex") throw new Error("Codex Agent config adapter is invalid.");
    optionalText(config.model, "Codex model");
    optionalText(config.effort, "Codex effort");
    optionalText(config.profile, "Codex profile");
    if (config.search !== undefined && typeof config.search !== "boolean") {
      throw new Error("Codex search must be boolean.");
    }
    validatePaths(config.additionalDirectories, "Codex additional directory");
    if (config.permission === undefined) {
      throw new Error("Codex permission strategy is required.");
    }
    if (config.permission.strategy === "configured") {
      exact(config.permission, ["strategy", "sandbox", "approval"], "Codex permission config");
      if (config.permission.sandbox !== undefined
        && !SANDBOXES.includes(config.permission.sandbox)) {
        throw new Error("Codex sandbox is invalid.");
      }
      if (config.permission.approval !== undefined
        && !APPROVALS.includes(config.permission.approval)) {
        throw new Error("Codex approval is invalid.");
      }
      requireConfiguredPermissionOption(config.permission, "Codex");
    } else {
      exact(config.permission, ["strategy"], "Codex permission config");
      validateSimplePermissionStrategy(config.permission.strategy, "Codex permission strategy");
    }
    advanced(this.id, config.advanced);
  }

  structuredArgs(config: CodexAgentConfig): string[] {
    return [
      // Yui launches Codex in a detached tmux window. Disable the startup
      // updater so an unrelated native prompt cannot consume managed input.
      "--config", "check_for_update_on_startup=false",
      ...(config.model === undefined ? [] : ["--model", config.model]),
      ...(config.effort === undefined ? [] : ["--config", `model_reasoning_effort=\"${config.effort}\"`]),
      ...(config.permission.strategy === "bypass"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : config.permission.strategy === "configured"
          ? [
              ...(config.permission.sandbox === undefined
                ? [] : ["--sandbox", config.permission.sandbox]),
              ...(config.permission.approval === undefined
                ? [] : ["--ask-for-approval", config.permission.approval])
            ]
          : []),
      ...(config.search === true ? ["--search"] : []),
      ...(config.profile === undefined ? [] : ["--profile", config.profile]),
      ...(config.additionalDirectories ?? []).flatMap((path) => ["--add-dir", path])
    ];
  }

  override launchContextArgs(input: CompileInput<CodexAgentConfig>): string[] {
    // Yui has already scoped and authorized this exact workspace. Declare that
    // invocation-local trust explicitly so Codex does not place its interactive
    // directory trust prompt in front of the managed first input. This does not
    // mutate the user's Codex config or trust any parent/sibling directory.
    const workspaceTrust = [
      "--config",
      `projects={${JSON.stringify(resolve(input.workspace))}={trust_level="trusted"}}`
    ];
    const instructions = codexSessionInstructions(input);
    if (instructions === undefined) return workspaceTrust;
    return [
      ...workspaceTrust,
      "--config",
      `developer_instructions=${tomlString(instructions)}`
    ];
  }

  compileResume(input: ResumeInput<CodexAgentConfig>): CompiledAgentLaunch {
    const launch = this.compileNew(input);
    return { ...launch, argv: [...launch.argv, "resume", nativeId(input.nativeSessionId)] };
  }

  compileManagedControl(
    input: CompileInput<CodexAgentConfig>,
    _mode: "new" | "resume",
    _nativeSessionId?: string
  ): CompiledManagedControlLaunch {
    const config = this.canonicalizeConfig(input.config);
    if (config.profile !== undefined) {
      throw new Error(
        "Managed Codex does not accept a Codex config profile because it cannot be scoped to one "
        + "shared-daemon thread. Use a Yui Agent Profile for skills, model, and effort."
      );
    }
    const launch = this.compileNew(input);
    // A managed Codex thread is an ordinary user thread. Its Yui guidance is
    // part of the durable Task message, not a developer_instructions override
    // that would shadow the user's native project/developer configuration.
    const argv = withoutCodexConfigOverride(launch.argv, "developer_instructions");
    if (config.model !== undefined) {
      const modelFlag = argv.findIndex((value, index) => (
        value === "--model" && argv[index + 1] === config.model
      ));
      if (modelFlag < 0) throw new Error("Managed Codex launch lost its selected model.");
      argv.splice(modelFlag, 2);
      // App Server thread/start reads the model from resolved configuration;
      // the interactive --model shortcut is not inherited by new threads.
      argv.push("--config", `model=${tomlString(config.model)}`);
    }
    return {
      ...launch,
      argv: [...argv, "app-server", "proxy"],
      transport: "codex-app-server-proxy",
      codexThread: codexThreadOptions(input, config)
    };
  }
}

class ClaudeAdapter extends BaseAdapter<ClaudeAgentConfig> {
  readonly id = "claude" as const;
  readonly label = "Claude";
  readonly supportedVersion = "2.1.207";
  readonly capabilities = {
    recover: true,
    interrupt: true,
    nativeSessionDiscovery: "preallocated",
    preInputReadiness: driverPreInputReadiness("claude")
  } as const;

  discoverConfiguration(input: AgentConfigurationDiscoveryInput): Promise<AgentConfigurationCatalog> {
    return discoverClaudeConfiguration(input);
  }

  validateStructured(config: ClaudeAgentConfig): void {
    exact(config, ["adapterId", "model", "effort", "permission", "additionalDirectories",
      "settingsFile", "settingsSources", "advanced"], "Claude Agent config");
    if (config.adapterId !== "claude") throw new Error("Claude Agent config adapter is invalid.");
    optionalText(config.model, "Claude model");
    optionalText(config.effort, "Claude effort");
    validatePaths(config.additionalDirectories, "Claude additional directory");
    if (config.settingsFile !== undefined) absolutePath(config.settingsFile, "Claude settings file");
    optionalTexts(config.settingsSources, "Claude settings source");
    if (config.settingsSources !== undefined && new Set(config.settingsSources).size !== config.settingsSources.length) {
      throw new Error("Claude settings sources contain duplicates.");
    }
    if (config.permission === undefined) {
      throw new Error("Claude permission strategy is required.");
    }
    if (config.permission.strategy === "configured") {
      exact(config.permission, ["strategy", "mode", "allowedTools", "disallowedTools"], "Claude permission config");
      optionalText(config.permission.mode, "Claude permission mode");
      optionalTexts(config.permission.allowedTools, "Claude allowed tool");
      optionalTexts(config.permission.disallowedTools, "Claude disallowed tool");
      if (config.permission.allowedTools?.length === 0
        || config.permission.disallowedTools?.length === 0) {
        throw new Error("Claude configured tool lists must not be empty.");
      }
      requireConfiguredPermissionOption(config.permission, "Claude");
    } else {
      exact(config.permission, ["strategy"], "Claude permission config");
      validateSimplePermissionStrategy(config.permission.strategy, "Claude permission strategy");
    }
    advanced(this.id, config.advanced);
  }

  structuredArgs(config: ClaudeAgentConfig): string[] {
    return [
      ...(config.model === undefined ? [] : ["--model", config.model]),
      ...(config.effort === undefined ? [] : ["--effort", config.effort]),
      ...(config.permission.strategy === "bypass"
        ? ["--dangerously-skip-permissions"]
        : config.permission.strategy === "configured"
          && config.permission.mode !== undefined
          ? ["--permission-mode", config.permission.mode]
          : []),
      ...(config.permission.strategy !== "configured"
        || config.permission.allowedTools === undefined
        ? [] : ["--allowed-tools", ...config.permission.allowedTools]),
      ...(config.permission.strategy !== "configured"
        || config.permission.disallowedTools === undefined
        ? [] : ["--disallowed-tools", ...config.permission.disallowedTools]),
      ...(config.additionalDirectories ?? []).flatMap((path) => ["--add-dir", path]),
      ...(config.settingsFile === undefined ? [] : ["--settings", config.settingsFile]),
      ...(config.settingsSources === undefined ? [] : ["--setting-sources", config.settingsSources.join(",")])
    ];
  }

  override compileNew(input: CompileInput<ClaudeAgentConfig>): CompiledAgentLaunch {
    const launch = super.compileNew(input);
    return input.sessionTitle === undefined
      ? launch
      : {
          ...launch,
          argv: [...launch.argv, "--name", sessionTitle(input.sessionTitle)]
        };
  }

  override launchContextArgs(input: CompileInput<ClaudeAgentConfig>): string[] {
    if (input.sessionManifestPath !== undefined) {
      return ["--append-system-prompt-file", input.sessionManifestPath];
    }
    const sections = [
      input.developerInstructions,
      ...(input.skills ?? []).map((skill) => [
        `# Yui Skill: ${skill.id}`,
        `Source: ${skill.path}/SKILL.md (resolve relative links from this directory).`,
        skill.content
      ].join("\n\n"))
    ].filter((value): value is string => value !== undefined && value.trim().length > 0);
    if (sections.length === 0) return [];
    const context = sections.join("\n\n");
    if (input.managedContextFile === undefined) {
      throw new Error(
        "Claude session context requires a managed context file under YUI_HOME."
      );
    }
    writeTextFileAtomically(input.managedContextFile, context);
    return ["--append-system-prompt-file", input.managedContextFile];
  }

  compileResume(input: ResumeInput<ClaudeAgentConfig>): CompiledAgentLaunch {
    const launch = this.compileNew(input);
    return { ...launch, argv: [...launch.argv, "--resume", nativeId(input.nativeSessionId)] };
  }
  compileManagedControl(
    input: CompileInput<ClaudeAgentConfig>,
    mode: "new" | "resume",
    nativeSessionId?: string
  ): CompiledManagedControlLaunch {
    if (nativeSessionId === undefined) {
      throw new Error("Managed Claude control requires a preallocated native Session id.");
    }
    const sessionId = nativeId(nativeSessionId);
    const launch = mode === "new"
      ? this.compileNew(input)
      : this.compileResume({ ...input, nativeSessionId: sessionId });
    return {
      ...launch,
      argv: [
        ...launch.argv,
        ...(mode === "new" ? ["--session-id", sessionId] : []),
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose",
        "--replay-user-messages"
      ],
      transport: "claude-stream-json"
    };
  }
}

/**
 * The Agent Client Protocol adapter.
 *
 * One adapter serves every ACP Agent. It deliberately compiles no arguments of
 * its own: entering ACP mode is a per-product invocation detail that belongs in
 * the Agent descriptor's `baseArgs`, and everything after startup is negotiated
 * over the protocol. Adding a second ACP product therefore requires a new
 * descriptor and no new code here.
 */
class AcpAdapter extends BaseAdapter<AcpAgentConfig> {
  readonly id = "acp" as const;
  readonly label = "Agent Client Protocol";
  // The protocol version Yui implements. ACP Agents are versioned
  // independently of their products, and `initialize` negotiates the real
  // version at connect time, so no product's release number belongs here.
  readonly supportedVersion = "0.0.0";
  readonly capabilities = {
    recover: true,
    interrupt: true,
    // ACP assigns the Session id in its `session/new` response.
    nativeSessionDiscovery: "runtime",
    preInputReadiness: driverPreInputReadiness("acp")
  } as const;

  discoverConfiguration(input: AgentConfigurationDiscoveryInput): Promise<AgentConfigurationCatalog> {
    return discoverAcpConfiguration(input);
  }

  validateStructured(config: AcpAgentConfig): void {
    exact(config, ["adapterId", "model", "effort", "permission", "additionalDirectories",
      "settingsFile", "settingsSources", "advanced"], "ACP Agent config");
    if (config.adapterId !== "acp") throw new Error("ACP Agent config adapter is invalid.");
    // Model and effort are session config options in ACP, so a value is legal
    // here whatever this build knows about the product. Whether the Agent
    // actually offers it is decided by the live option list at launch: the
    // protocol enumerates the accepted values, and only that enumeration can
    // answer it. Rejecting an unrecognised name here would require Yui to hold
    // a model list per product, which is the fabricated authority this design
    // avoids.
    optionalText(config.model, "ACP model");
    optionalText(config.effort, "ACP effort");
    if (config.settingsFile !== undefined || config.settingsSources !== undefined) {
      throw new Error("Yui's ACP client exposes no client-side settings configuration.");
    }
    // `additionalDirectories` is a real ACP session-lifecycle field, so a
    // Project-backed workspace is configurable here. Whether it is actually
    // sent is decided per connection: ACP requires Clients to send it only to
    // an Agent that advertised `sessionCapabilities.additionalDirectories`, and
    // only the live handshake knows that. Rejecting it here instead would make
    // every multi-root Project launch fail before the Agent is even asked.
    validatePaths(config.additionalDirectories, "ACP additional directory");
    if (config.permission === undefined) {
      throw new Error("ACP permission strategy is required.");
    }
    // `configured` carries the one mode id the user named; the other two
    // strategies carry nothing, so an extra field would mean a caller expected a
    // value this adapter never reads.
    if (config.permission.strategy === "configured") {
      exact(config.permission, ["strategy", "mode"], "ACP permission config");
      // The mode is matched by exact id against what the Agent offers at launch.
      // Yui keeps no per-product mode list, so any non-empty id is accepted here
      // and verified there.
      requireOneText(config.permission.mode, "ACP permission mode");
    } else {
      exact(config.permission, ["strategy"], "ACP permission config");
      if (config.permission.strategy !== "default" && config.permission.strategy !== "bypass") {
        throw new Error("ACP permission strategy is invalid.");
      }
    }
    advanced(this.id, config.advanced);
  }

  structuredArgs(_config: AcpAgentConfig): string[] {
    return [];
  }

  compileResume(input: ResumeInput<AcpAgentConfig>): CompiledAgentLaunch {
    // Reattaching is a `session/load` call inside the protocol, not a flag.
    nativeId(input.nativeSessionId);
    return this.compileNew(input);
  }

  compileManagedControl(
    input: CompileInput<AcpAgentConfig>,
    _mode: "new" | "resume",
    _nativeSessionId?: string
  ): CompiledManagedControlLaunch {
    const config = this.canonicalizeConfig(input.config);
    const bootstrap = acpSessionBootstrap(input);
    const directories = config.additionalDirectories ?? [];
    // What the Role asked for, in the form the Session applies. Only stated
    // fields travel: an absent model is a request for the Agent's own default,
    // and `default` permission deliberately sends no mode at all.
    const desired = {
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.effort === undefined ? {} : { effort: config.effort }),
      ...(config.permission.strategy === "configured"
        ? { permissionMode: config.permission.mode }
        : config.permission.strategy === "bypass"
          ? { permissionBypass: true }
          : {})
    };
    const hasDesired = Object.keys(desired).length > 0;
    return {
      ...this.compileNew(input),
      transport: "acp-stdio",
      // ACP accepts no Yui flags, so everything a managed Session needs travels
      // as protocol input. Omit the key entirely when there is nothing to say.
      ...(directories.length === 0 && bootstrap === undefined && !hasDesired ? {} : {
        acpSession: {
          ...(directories.length === 0 ? {} : { additionalDirectories: [...directories] }),
          ...(bootstrap === undefined ? {} : { sessionBootstrap: bootstrap }),
          ...(hasDesired ? { desiredConfiguration: desired } : {})
        }
      })
    };
  }
}

/**
 * The instructions a managed ACP Session must read before it acts.
 *
 * ACP defines no system prompt and no equivalent of `--append-system-prompt`,
 * so unlike Codex and Claude this text cannot be delivered at launch. It is
 * carried to the Session and prepended to the first prompt instead. The
 * manifest form stays a pointer rather than an inlined Task: content is read
 * through the manifest's own Context API, exactly as the other adapters do.
 */
function acpSessionBootstrap(input: CompileInput<AcpAgentConfig>): string | undefined {
  const sections = input.sessionManifestPath === undefined
    ? [
        input.developerInstructions,
        ...(input.skills === undefined || input.skills.length === 0 ? [] : [
          [
            "Yui Role Skills are available at the paths below. Before performing work "
            + "governed by one, read and follow its SKILL.md on demand; do not treat "
            + "this list as a user message.",
            ...input.skills.map((skill) => `- ${skill.id}: ${skill.path}/SKILL.md`)
          ].join("\n")
        ])
      ]
    : [
        `Yui managed Session. Read and follow the Session Manifest at `
        + `${input.sessionManifestPath} (digest ${input.sessionManifestDigest ?? "unknown"}). `
        + "Load each Skill and Role Profile by its manifest path before acting; Task "
        + "content is available only through the manifest's exact Context API."
      ];
  const bootstrap = sections
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join("\n\n");
  return bootstrap.length === 0 ? undefined : bootstrap;
}

function driverPreInputReadiness(adapterId: AgentAdapterId): PreInputReadinessCapability {
  const capability = builtinAgentDriverRegistry().requireByAdapterId(adapterId)
    .capabilities.observation.preInputReadiness;
  return capability === "exact"
    ? Object.freeze({
        status: "supported",
        nativeEvent: "Agent Driver session.ready",
        note: "The registered Agent Driver supplies an exact pre-input readiness observation."
      })
    : Object.freeze({
        status: "unsupported",
        reason: "not-available",
        note: "The registered Agent Driver does not expose exact pre-input readiness."
      });
}

const ADAPTERS: Readonly<Record<AgentAdapterId, AgentAdapter<any>>> = {
  codex: new CodexAdapter(), claude: new ClaudeAdapter(), acp: new AcpAdapter()
};

function tomlString(value: string): string {
  if (value.includes("\0")) throw new Error("Agent launch context cannot contain NUL bytes.");
  return JSON.stringify(value);
}

function codexThreadOptions(
  input: CompileInput<CodexAgentConfig>,
  config: CodexAgentConfig
): CodexThreadOptions {
  const roots = [...new Set([
    resolve(input.workspace),
    ...(config.additionalDirectories ?? []).map((path) => resolve(path))
  ])];
  const threadConfig = {
    // Yui has already scoped and authorized this exact managed workspace.
    // Keep the trust override on this thread instead of mutating global config.
    projects: { [resolve(input.workspace)]: { trust_level: "trusted" } },
    ...(config.effort === undefined ? {} : { model_reasoning_effort: config.effort }),
    ...(config.search === true ? { web_search: "live" } : {})
  };
  const permission = config.permission.strategy === "bypass"
    ? { approvalPolicy: "never", sandbox: "danger-full-access" }
    : config.permission.strategy === "configured"
      ? {
          ...(config.permission.approval === undefined
            ? {}
            : { approvalPolicy: config.permission.approval }),
          ...(config.permission.sandbox === undefined
            ? {}
            : { sandbox: config.permission.sandbox })
        }
      : {};
  return {
    ...(config.model === undefined ? {} : { model: config.model }),
    ...permission,
    runtimeWorkspaceRoots: roots,
    ...(Object.keys(threadConfig).length === 0 ? {} : { config: threadConfig })
  };
}

function codexSessionInstructions(input: CompileInput<CodexAgentConfig>): string | undefined {
  if (input.sessionManifestPath !== undefined) {
    return `Yui managed Session. Read and follow the Session Manifest at ${input.sessionManifestPath} (digest ${input.sessionManifestDigest ?? "unknown"}). Load each Skill and Role Profile by its manifest path before acting; Task content is available only through the manifest's exact Context API.`;
  }
  const instructions = [
    input.developerInstructions,
    ...(input.skills === undefined || input.skills.length === 0 ? [] : [
      "Yui Role Skills are available at the paths below. Before performing work governed by one, read and follow its SKILL.md on demand; do not treat this list as a user message.",
      ...input.skills.map((skill) => `- ${skill.id}: ${skill.path}/SKILL.md`)
    ])
  ].filter((value): value is string => value !== undefined && value.trim().length > 0);
  return instructions.length === 0 ? undefined : instructions.join("\n");
}

function withoutCodexConfigOverride(argv: readonly string[], key: string): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (
      (argument === "--config" || argument === "-c")
      && argv[index + 1]?.startsWith(`${key}=`) === true
    ) {
      index += 1;
      continue;
    }
    filtered.push(argument);
  }
  return filtered;
}

function sessionTitle(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Agent session title is invalid.");
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new Error("Agent session title is invalid.");
  }
  return normalized;
}
export { supportedAgentAdapterIds };
export function findAgentAdapter(id: string): AgentAdapter | null {
  // `ADAPTERS` is keyed by the catalog, so it already answers this question.
  // A second name list here would strand a catalogued adapter that has a real
  // implementation sitting one line above.
  return isAgentAdapterId(id) ? ADAPTERS[id] : null;
}
export function resolveAgentAdapter(id: string): AgentAdapter {
  const adapter = findAgentAdapter(id);
  if (adapter === null) throw new Error(`Agent adapter is unsupported: ${id}.`);
  return adapter;
}

export function inspectAgentCapabilities(
  agent: AgentDefinition,
  optionsOrNow: CapabilityInspectionOptions | Date = {}
): CapabilitySnapshot {
  const options = optionsOrNow instanceof Date ? { now: optionsOrNow } : optionsOrNow;
  const now = options.now ?? new Date();
  const run = options.run ?? runProbe;
  const at = now.toISOString();
  const adapter = resolveAgentAdapter(agent.adapterId);
  validateAgentBaseArguments(agent.adapterId, agent.baseArgs);
  const versionRun = run(agent.command, [...agent.baseArgs, "--version"]);
  const failure = failed(versionRun);
  if (failure !== undefined) {
    const missing = versionRun.error?.code === "ENOENT";
    return snapshot(agent, adapter, {
      status: missing ? "missing" : "probe-failed", command: agent.command,
      reason: missing ? "Agent command was not found." : failure, probedAt: at
    }, baseline(agent.adapterId), at);
  }
  const version = /(?:^|\D)(\d+\.\d+\.\d+)(?:\D|$)/m
    .exec(output(versionRun.stdout, versionRun.stderr))?.[1];
  if (version === undefined) {
    return snapshot(agent, adapter, {
      status: "probe-failed", command: agent.command,
      reason: "Agent version probe did not return a semantic version.", probedAt: at
    }, baseline(agent.adapterId), at);
  }
  const supported = supports(version, adapter);
  let fields = baseline(agent.adapterId);
  const warnings: string[] = [];
  if (!supported) {
    return snapshot(agent, adapter, {
      status: "unsupported-version", command: agent.command, version,
      reason: `Minimum supported version is ${adapter.supportedVersion}.`,
      probedAt: at
    }, fields, at, [`Installed version ${version} is not supported by adapter ${adapter.id}.`]);
  }

  const help = run(agent.command, [...agent.baseArgs, "--help"]);
  const helpFailure = failed(help);
  if (helpFailure !== undefined) {
    return snapshot(agent, adapter, {
      status: "probe-failed", command: agent.command, version,
      reason: `Required ${adapter.label} capability probe failed: ${helpFailure}`,
      probedAt: at
    }, fields, at);
  }
  const helpOutput = output(help.stdout, help.stderr);
  const helpFields = configurationFieldsFromHelp(agent.adapterId, helpOutput);
  fields = capabilityFields(helpFields);
  warnings.push(...configurationFieldWarnings(helpFields));
  const missing = missingRequiredCapabilities(adapter.id, helpOutput);
  if (missing.length > 0) {
    return snapshot(agent, adapter, {
      status: "unsupported-version", command: agent.command, version,
      reason: `${adapter.label} CLI is missing required capabilities: ${missing.join(", ")}.`,
      probedAt: at
    }, fields, at, warnings);
  }
  const audited = adapter.id === "acp" ? undefined : AUDITED_PRODUCER_VERSIONS[adapter.id];
  if (audited !== undefined && compareVersions(version, audited) > 0) {
    warnings.push(
      `Installed ${adapter.label} version ${version} is newer than the latest audited producer `
      + `${audited}; required CLI flags were detected, not live protocol compatibility.`
    );
  }
  return snapshot(agent, adapter, {
    status: "installed", command: agent.command, version, probedAt: at
  }, fields, at, warnings);
}

function baseline(id: AgentAdapterId): CapabilityField[] {
  return capabilityFields(staticAgentConfigurationFields(id));
}

function capabilityFields(fields: AgentConfigurationCatalog["fields"]): CapabilityField[] {
  const kinds: Readonly<Record<string, CapabilityField["kind"]>> = {
    profile: "string", search: "boolean", additionalDirectories: "path-list", settingsFile: "path",
    settingsSources: "string-list", "permission.allowedTools": "string-list", "permission.disallowedTools": "string-list"
  };
  return fields.map(field => ({
    key: field.key, kind: kinds[field.key] ?? "enum", allowCustom: field.allowCustom,
    status: field.available === true ? "available" : field.available === false ? "unavailable" : "degraded",
    choices: field.choices.map(choice => choice.value)
  }));
}

function snapshot(agent: AgentDefinition, adapter: AgentAdapter, installation: AgentInstallation,
  fields: CapabilityField[], at: string, warnings: string[] = []): CapabilitySnapshot {
  return { schemaVersion: 1, agentId: agent.id, adapterId: agent.adapterId, installation,
    lifecycle: { start: true, resume: true, nativeSessionDiscovery: adapter.capabilities.nativeSessionDiscovery,
      interrupt: true, preInputReadiness: adapter.capabilities.preInputReadiness }, fields,
    warnings: [...new Set([STATIC_CONFIGURATION_NOTICE, ...warnings])], refreshedAt: at };
}
function runProbe(command: string, args: readonly string[]): AgentProbeResult {
  const result = spawnSync(command, [...args], { encoding: "utf8", shell: false, timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BYTES, stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""),
    ...(result.error === undefined ? {} : { error: result.error }) };
}
function failed(result: AgentProbeResult): string | undefined {
  if (result.error !== undefined) return result.error.code === "ETIMEDOUT"
    ? `Agent probe timed out after ${PROBE_TIMEOUT_MS} ms.` : "Agent probe failed to start.";
  return result.status === 0 ? undefined : `Agent probe exited with status ${result.status ?? "unknown"}.`;
}
function output(stdout: string, stderr: string): string {
  const value = `${stdout}\n${stderr}`;
  if (Buffer.byteLength(value, "utf8") > PROBE_MAX_BYTES) throw new Error("Agent probe output exceeded 1 MiB.");
  return value;
}
function supports(version: string, adapter: AgentAdapter): boolean {
  return compareVersions(version, adapter.supportedVersion) >= 0;
}

function compareVersions(leftVersion: string, rightVersion: string): number {
  const left = leftVersion.split(".").map(Number);
  const right = rightVersion.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function missingRequiredCapabilities(id: AgentAdapterId, help: string): string[] {
  // An ACP Agent declares its capabilities in the `initialize` handshake, not
  // in `--help`. Demanding Claude's flags of it reported a working Agent as a
  // broken one, so ACP is required to expose no flags at all here; the real
  // check is `discoverAcpConfiguration`, which speaks the protocol.
  if (id === "acp") return [];
  const required: readonly (readonly [RegExp, string])[] = id === "codex"
    ? [
        [/(?:^|\s)--config(?:\s|[=<,]|$)/m, "--config"],
        [/^\s*resume(?:\s|$)/m, "resume"]
      ]
    : [
        [/(?:^|\s)--append-system-prompt(?:-file|\[-file\])(?:\s|[=<,]|$)/m,
          "--append-system-prompt-file"],
        [/(?:^|\s)--resume(?:\s|[=<,]|$)/m, "--resume"],
        [/(?:^|\s)--session-id(?:\s|[=<,]|$)/m, "--session-id"],
        [/(?:^|\s)-p(?:\s|[=<,]|$)/m, "-p"],
        [/(?:^|\s)--output-format(?:\s|[=<,]|$)/m, "--output-format"],
        [/(?:^|\s)--input-format(?:\s|[=<,]|$)/m, "--input-format"],
        [/(?:^|\s)--verbose(?:\s|[=<,]|$)/m, "--verbose"],
        [/(?:^|\s)--replay-user-messages(?:\s|[=<,]|$)/m,
          "--replay-user-messages"],
        [/(?:^|\s)--plugin-dir(?:\s|[=<,]|$)/m, "--plugin-dir"],
        [/(?:^|\s)--name(?:\s|[=<,]|$)/m, "--name"]
      ];
  return required.flatMap(([pattern, label]) => pattern.test(help) ? [] : [label]);
}

function cloneConfig(config: RoleAgentConfig, paths: readonly string[] | undefined): RoleAgentConfig {
  const advancedConfig = config.advanced?.rawArgs === undefined ? config.advanced : { rawArgs: [...config.advanced.rawArgs] };
  if (config.adapterId === "acp") {
    return { ...config,
      permission: { ...config.permission },
      ...(paths === undefined ? {} : { additionalDirectories: [...paths] }),
      ...(advancedConfig === undefined ? {} : { advanced: advancedConfig }) };
  }
  if (config.adapterId === "codex") return { ...config,
    permission: { ...config.permission },
    ...(paths === undefined ? {} : { additionalDirectories: [...paths] }),
    ...(advancedConfig === undefined ? {} : { advanced: advancedConfig }) };
  return { ...config,
    permission: config.permission.strategy === "configured"
      ? { ...config.permission,
          ...(config.permission.allowedTools === undefined ? {} : { allowedTools: [...config.permission.allowedTools] }),
          ...(config.permission.disallowedTools === undefined ? {} : { disallowedTools: [...config.permission.disallowedTools] }) }
      : { ...config.permission },
    ...(paths === undefined ? {} : { additionalDirectories: [...paths] }),
    ...(config.settingsSources === undefined ? {} : { settingsSources: [...config.settingsSources] }),
    ...(advancedConfig === undefined ? {} : { advanced: advancedConfig }) };
}

export function defaultRoleAgentConfig(adapterId: AgentAdapterId): RoleAgentConfig {
  // Keyed by adapter, not a codex/else ternary: defaulting an unrecognized
  // adapter to Claude's shape produced a config whose `adapterId` disagreed
  // with the binding it was created for.
  //
  // ACP defaults to `default` rather than `bypass` because Yui answers ACP
  // permission requests itself, and the answer it must never invent is "yes".
  return adapterId === "acp"
    ? { adapterId: "acp", permission: { strategy: "default" } }
    : { adapterId, permission: { strategy: "bypass" } };
}

function validateSimplePermissionStrategy(value: unknown, label: string): void {
  if (value !== "default" && value !== "bypass") {
    throw new Error(`${label} is invalid.`);
  }
}

function requireConfiguredPermissionOption(
  permission: Readonly<Record<string, unknown>>,
  provider: string
): void {
  if (Object.keys(permission).every((key) => key === "strategy")) {
    throw new Error(
      `${provider} configured permission requires at least one provider-native option.`
    );
  }
}
function advanced(id: AgentAdapterId, value: AdvancedAgentConfig | undefined): void {
  if (value === undefined) return;
  exact(value, ["rawArgs"], "Advanced Agent config");
  validateAgentAdvancedArguments(id, value.rawArgs ?? []);
}
function validatePaths(values: readonly string[] | undefined, label: string): void {
  optionalTexts(values, label);
  for (const value of values ?? []) absolutePath(value, label);
}
function canonicalDirectories(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => {
    absolutePath(value, "Additional directory");
    let path: string;
    try { path = realpathSync(value); } catch { throw new Error("Additional directory does not exist or cannot be resolved."); }
    if (!statSync(path).isDirectory()) throw new Error("Additional directory is not a directory.");
    return path;
  }))].sort();
}
function absolutePath(value: string, label: string): void {
  text(value, label);
  if (!isAbsolute(value) || resolve(value) !== value || /[\r\n\0{}]/.test(value)) {
    throw new Error(`${label} must be an absolute canonical path.`);
  }
}
function optionalText(value: unknown, label: string): void {
  if (value !== undefined) text(value, label);
}
/** A required non-empty single-line value. */
function requireOneText(value: unknown, label: string): void {
  text(value, label);
}
function optionalTexts(values: readonly string[] | undefined, label: string): void {
  if (values === undefined) return;
  if (!Array.isArray(values)) throw new Error(`${label} list must be an array.`);
  values.forEach((value) => text(value, label));
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}
function exact(value: object, keys: readonly string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} contains an unsupported field.`);
}
function nativeId(value: string): string {
  text(value, "Native session id");
  if (value.trim() !== value) throw new Error("Native session id must not contain surrounding whitespace.");
  return value;
}
