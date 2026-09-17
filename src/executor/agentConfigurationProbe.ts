import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parse } from "smol-toml";

import { configuredAgentLaunchEnvironment } from "../agent/launchEnvironment.js";
import { codexClientInitialization } from "../runtime/codexAppServerRuntime.js";
import {
  acpInitializeRequest,
  readAcpInitializeResult,
  type AcpInitializeResult
} from "../runtime/acpProtocol.js";
import { handshakeObservationFrom } from "../runtime/agentRunConfiguration.js";
import { YUI_VERSION } from "../version.js";
import {
  configurationFieldsFromHelp, configurationFieldWarnings, STATIC_CONFIGURATION_NOTICE
} from "./agentConfigurationFields.js";
import type {
  AgentConfigurationCatalog,
  AgentConfigurationChoice,
  AgentConfigurationDiscoveryInput,
  AgentConfigurationField,
  AgentHandshakeObservation,
  AgentModelChoice
} from "./agentConfigurationCatalog.js";

/**
 * Codex and Claude Code are configured by flags and their own files; neither
 * plan exchanges capabilities on connect. Saying so explicitly keeps a caller
 * from reading a missing handshake as an Agent that answered with nothing.
 */
const NO_HANDSHAKE: AgentHandshakeObservation = Object.freeze({
  status: "unsupported",
  reason: "This connection plan has no capability handshake; support is static."
});

const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_TERMINATION_GRACE_MS = 100;
const ACP_PROBE_REQUEST_ID = 1;

export async function discoverCodexConfiguration(
  input: AgentConfigurationDiscoveryInput
): Promise<AgentConfigurationCatalog> {
  const environment = configuredAgentLaunchEnvironment(input.agent, input.environment);
  const profile = input.config?.adapterId === "codex" ? input.config.profile : undefined;
  const globalArgs = [
    ...input.agent.baseArgs,
    ...(profile === undefined ? [] : ["--profile", profile])
  ];
  const client = JsonRpcProcess.start(
    input.agent.command,
    [...globalArgs, "app-server", "--stdio"],
    input.cwd,
    environment,
    input.signal
  );
  try {
    const [version, help] = await Promise.all([
      runTextProcess(
        input.agent.command,
        [...input.agent.baseArgs, "--version"],
        input.cwd,
        environment,
        input.signal
      ),
      runTextProcess(
        input.agent.command,
        [...input.agent.baseArgs, "--help"],
        input.cwd,
        environment,
        input.signal
      ),
      client.request("initialize", codexClientInitialization())
        .then(() => { client.notify("initialized", {}); })
    ]);
    const [models, requirementsResult, providerCapabilities] = await Promise.all([
      listCodexModels(client),
      client.request("configRequirements/read", {}),
      client.request("modelProvider/capabilities/read", {})
    ]);
    const requirements = requiredObject(requirementsResult, "Codex configuration requirements response").requirements;
    const requirementRecord = requirements === null ? undefined
      : requiredObject(requirements, "Codex configuration requirements");
    const allowedSandboxes = optionalStrings(requirementRecord?.allowedSandboxModes);
    const allowedApprovals = optionalApprovalChoices(requirementRecord?.allowedApprovalPolicies);
    const allowedWebSearchModes = optionalStrings(requirementRecord?.allowedWebSearchModes);
    const capabilityRecord = requiredObject(providerCapabilities, "Codex Provider capabilities");
    if (typeof capabilityRecord.webSearch !== "boolean") {
      throw new Error("Codex Provider capabilities did not report webSearch.");
    }
    const webSearch = capabilityRecord.webSearch
      && (allowedWebSearchModes === undefined || allowedWebSearchModes.includes("live"));
    const fields = configurationFieldsFromHelp("codex", help).map(candidate => {
      const allowed = candidate.key === "permission.sandbox" ? allowedSandboxes
        : candidate.key === "permission.approval" ? allowedApprovals : undefined;
      if (allowed !== undefined) {
        const choices = candidate.choices.filter(choice => allowed.includes(choice.value));
        return {
          ...candidate, choices, available: choices.length > 0,
          reason: `${candidate.reason} Native configuration requirements applied.${
            choices.length === 0 ? " No usable values were confirmed." : ""
          }`
        };
      }
      if (candidate.key === "search") return field(
        "search", webSearch ? [choice("true")] : [], false, webSearch,
        webSearch ? "Native Provider capability and configuration requirements permit live web search."
          : "Live web search is unavailable or disallowed."
      );
      if (candidate.key === "profile") return codexProfileField(environment);
      return candidate;
    });
    return {
      schemaVersion: 1,
      agentId: input.agent.id,
      adapterId: "codex",
      ...(semanticVersion(version) === undefined ? {} : { cliVersion: semanticVersion(version) }),
      handshake: NO_HANDSHAKE,
      models,
      fields,
      warnings: [...client.warnings(), ...configurationFieldWarnings(fields)]
    };
  } finally {
    client.close();
  }
}

export async function discoverClaudeConfiguration(
  input: AgentConfigurationDiscoveryInput
): Promise<AgentConfigurationCatalog> {
  const environment = {
    ...configuredAgentLaunchEnvironment(input.agent, input.environment),
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts"
  };
  const config = input.config?.adapterId === "claude" ? input.config : undefined;
  const initializationArgs = [
    ...input.agent.baseArgs,
    "--output-format", "stream-json",
    "--verbose",
    "--input-format", "stream-json",
    "--no-session-persistence",
    ...(config?.settingsSources === undefined
      ? [] : [`--setting-sources=${config.settingsSources.join(",")}`]),
    ...(config?.settingsFile === undefined ? [] : ["--settings", config.settingsFile])
  ];
  const [version, help, initialization] = await Promise.all([
    runTextProcess(
      input.agent.command,
      [...input.agent.baseArgs, "--version"],
      input.cwd,
      environment,
      input.signal
    ),
    runTextProcess(
      input.agent.command,
      [...input.agent.baseArgs, "--help"],
      input.cwd,
      environment,
      input.signal
    ),
    requestClaudeInitialization(
      input.agent.command,
      initializationArgs,
      input.cwd,
      environment,
      input.signal
    )
  ]);
  const initialized = object(initialization);
  const models = array(initialized?.models, "Claude model catalog").map(claudeModel);
  const fields = configurationFieldsFromHelp("claude", help);
  return {
    schemaVersion: 1,
    agentId: input.agent.id,
    adapterId: "claude",
    ...(semanticVersion(version) === undefined ? {} : { cliVersion: semanticVersion(version) }),
    handshake: NO_HANDSHAKE,
    models,
    fields,
    warnings: configurationFieldWarnings(fields)
  };
}

async function listCodexModels(client: JsonRpcProcess): Promise<AgentModelChoice[]> {
  const models: AgentModelChoice[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = object(await client.request("model/list", {
      limit: 100,
      includeHidden: false,
      ...(cursor === undefined ? {} : { cursor })
    }));
    for (const raw of array(result?.data, "Codex model catalog")) {
      models.push(codexModel(raw));
    }
    const next = result?.nextCursor;
    if (next === null || next === undefined) return models;
    if (typeof next !== "string" || next.length === 0) {
      throw new Error("Codex model catalog returned an invalid cursor.");
    }
    cursor = next;
  }
  throw new Error("Codex model catalog exceeded the pagination limit.");
}

function codexModel(value: unknown): AgentModelChoice {
  const model = requiredObject(value, "Codex model");
  const rawEfforts = array(model.supportedReasoningEfforts, "Codex model efforts");
  const efforts = rawEfforts.map((raw): AgentConfigurationChoice => {
    const effort = requiredObject(raw, "Codex effort");
    const value = requiredString(effort.reasoningEffort, "Codex effort value");
    return {
      value,
      label: value,
      ...(typeof effort.description === "string" && effort.description.trim().length > 0
        ? { description: effort.description.trim() } : {})
    };
  });
  const serviceTiers = Array.isArray(model.serviceTiers)
    ? model.serviceTiers.map((raw): AgentConfigurationChoice => {
        const tier = requiredObject(raw, "Codex service tier");
        return {
          value: requiredString(tier.id, "Codex service tier id"),
          label: requiredString(tier.name, "Codex service tier name"),
          ...(typeof tier.description === "string" && tier.description.trim().length > 0
            ? { description: tier.description.trim() } : {})
        };
      })
    : undefined;
  return {
    value: requiredString(model.model ?? model.id, "Codex model value"),
    label: requiredString(model.displayName ?? model.model ?? model.id, "Codex model label"),
    ...(typeof model.description === "string" && model.description.trim().length > 0
      ? { description: model.description.trim() } : {}),
    isDefault: model.isDefault === true,
    ...(typeof model.defaultReasoningEffort === "string"
      ? { defaultEffort: model.defaultReasoningEffort } : {}),
    efforts,
    ...(serviceTiers === undefined ? {} : { serviceTiers }),
    ...(typeof model.defaultServiceTier === "string"
      ? { defaultServiceTier: model.defaultServiceTier } : {})
  };
}

function claudeModel(value: unknown): AgentModelChoice {
  const model = requiredObject(value, "Claude model");
  const modelValue = requiredString(model.value, "Claude model value");
  const effortValues = Array.isArray(model.supportedEffortLevels)
    ? model.supportedEffortLevels.map((effort) => requiredString(effort, "Claude effort"))
    : [];
  return {
    value: modelValue,
    label: requiredString(model.displayName ?? modelValue, "Claude model label"),
    ...(typeof model.description === "string" && model.description.trim().length > 0
      ? { description: model.description.trim() } : {}),
    ...(typeof model.resolvedModel === "string" && model.resolvedModel.trim().length > 0
      ? { resolvedModel: model.resolvedModel.trim() } : {}),
    isDefault: modelValue === "default",
    efforts: effortValues.map(choice)
  };
}

async function requestClaudeInitialization(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<unknown> {
  const requestId = `yui-catalog-${process.pid}`;
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"]
  });
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const output = createInterface({ input: child.stdout });
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      output.close();
      terminateProcess(child);
      signal.removeEventListener("abort", abort);
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const abort = (): void => finish(abortError());
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, exitSignal) => {
      if (!settled) finish(new Error(
        `Claude configuration probe exited before initialization (${code ?? exitSignal ?? "unknown"}).`
      ));
    });
    output.on("line", (line) => {
      bytes += Buffer.byteLength(line);
      if (bytes > MAX_OUTPUT_BYTES) {
        finish(new Error("Claude configuration probe exceeded the output limit."));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        return;
      }
      const envelope = object(message);
      const response = object(envelope?.response);
      if (envelope?.type !== "control_response" || response?.request_id !== requestId) return;
      if (response.subtype !== "success") {
        finish(new Error(typeof response.error === "string"
          ? response.error : "Claude configuration initialization failed."));
        return;
      }
      finish(undefined, response.response);
    });
    child.stdin.on("error", (error) => finish(error));
    child.stdin.end(`${JSON.stringify({
      request_id: requestId,
      type: "control_request",
      request: { subtype: "initialize" }
    })}\n`);
  });
}

/**
 * Discover an ACP Agent's capabilities from the protocol itself.
 *
 * `initialize` is the only method used: it is the one exchange ACP guarantees
 * before any Session exists, and it requires no authentication, so discovery
 * never touches a model or spends quota. Everything reported here is what the
 * Agent actually advertised — no field is inferred from which product it is.
 */
export async function discoverAcpConfiguration(
  input: AgentConfigurationDiscoveryInput
): Promise<AgentConfigurationCatalog> {
  const environment = configuredAgentLaunchEnvironment(input.agent, input.environment);
  const negotiated = await requestAcpInitialization(
    input.agent.command,
    [...input.agent.baseArgs],
    input.cwd,
    environment,
    input.signal
  );
  const warnings: string[] = [STATIC_CONFIGURATION_NOTICE];
  if (!negotiated.capabilities.loadSession) {
    warnings.push(
      "This ACP Agent does not support `session/load`, so a managed Yui Turn "
      + "cannot survive a Provider restart."
    );
  }
  if (negotiated.authMethods.length > 0) {
    // Authenticating is the operator's decision, made outside Yui with the
    // product's own tooling. Reporting the requirement is the honest action.
    warnings.push(
      "This ACP Agent advertises authentication methods "
      + `(${negotiated.authMethods.map((method) => method.id).join(", ")}); `
      + "this handshake does not establish whether authentication is required "
      + "or already satisfied."
    );
  }
  return {
    schemaVersion: 1,
    agentId: input.agent.id,
    adapterId: "acp",
    ...(negotiated.agentVersion === undefined
      ? {}
      : semanticVersion(negotiated.agentVersion) === undefined
        ? {}
        : { cliVersion: semanticVersion(negotiated.agentVersion)! }),
    // What this Agent actually agreed to, kept separate from what Yui's client
    // statically supports. Projected by the same function a live Session uses,
    // so this query and a Session inspect cannot describe one Agent's handshake
    // differently. An Agent that reports no name stays `unknown` here and is
    // never resolved into a product by its command line.
    handshake: handshakeObservationFrom(negotiated),
    // Deliberately empty, and not because ACP cannot select a model. ACP
    // enumerates a Session's models in the `configOptions` returned by
    // `session/new` — which means listing them requires creating a real Session
    // on the Agent, and for a hosted product that is a billable remote effect
    // triggered by what the user asked to be a capability query. So this probe
    // stops at `initialize`: it reports that the axis is configurable and that
    // its values are negotiated per Session, rather than opening a Session to
    // populate a menu. The values are checked where they are actually known, at
    // launch, against the option list that Session returns.
    models: [],
    fields: [
      field("model", [], true, true,
        "ACP selects a model with session/set_config_option. The values one Agent "
        + "accepts are enumerated per Session at session/new, so Yui does not list "
        + "them here: creating a Session to populate the list would be a real, "
        + "possibly billed remote effect for what is only a capability query. A "
        + "configured model is checked against the Agent's own list at launch and "
        + "the launch fails if it is not offered."),
      field("effort", [], true, true,
        "ACP selects reasoning effort with session/set_config_option, under the "
        + "`thought_level` category. As with the model, the accepted values are "
        + "negotiated per Session and verified at launch rather than listed here."),
      field("permission.strategy", [choice("default"), choice("bypass"), choice("configured")],
        false, true,
        "Static Yui strategies: `default` sends no mode, so the Agent's own default stands. `configured` "
        + "selects one exact mode the Agent offers. `bypass` applies the mode that "
        + "grants unattended action, and only for an execution component Yui can "
        + "identify — it is never guessed from a mode's name. None of these change "
        + "how Yui answers session/request_permission: this client holds no "
        + "interactive consent and always declines."),
      field("permission.mode", [], true, true,
        "The mode ids belong to the Agent and are enumerated per Session, so Yui "
        + "verifies a configured mode against that list at launch instead of "
        + "listing candidates here."),
      field("additionalDirectories", [], true,
        negotiated.capabilities.additionalDirectories,
        negotiated.capabilities.additionalDirectories
          ? undefined
          : "This ACP Agent does not advertise "
            + "`sessionCapabilities.additionalDirectories`, so extra workspace roots "
            + "cannot be sent to it and only the launch `cwd` is in scope.")
    ],
    warnings
  };
}

/**
 * Run one `initialize` exchange and stop. The Agent is spawned, asked what it
 * supports, and terminated without creating a Session.
 */
async function requestAcpInitialization(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<AcpInitializeResult> {
  const child = spawn(command, args, { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  return new Promise<AcpInitializeResult>((resolvePromise, reject) => {
    let settled = false;
    let bytes = 0;
    const output = createInterface({ input: child.stdout });
    const finish = (error?: Error, value?: AcpInitializeResult): void => {
      if (settled) return;
      settled = true;
      output.close();
      terminateProcess(child);
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolvePromise(value!);
    };
    const abort = (): void => finish(abortError());
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, exitSignal) => {
      if (!settled) finish(new Error(
        `ACP configuration probe exited before initialize (${code ?? exitSignal ?? "unknown"}).`
      ));
    });
    output.on("line", (line) => {
      bytes += Buffer.byteLength(line);
      if (bytes > MAX_OUTPUT_BYTES) {
        finish(new Error("ACP configuration probe exceeded the output limit."));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        return;
      }
      const envelope = object(message);
      if (envelope === undefined || envelope.id !== ACP_PROBE_REQUEST_ID) return;
      const failure = object(envelope.error);
      if (failure !== undefined) {
        finish(new Error(typeof failure.message === "string"
          ? `ACP initialize failed: ${failure.message}`
          : "ACP initialize failed."));
        return;
      }
      try {
        finish(undefined, readAcpInitializeResult(envelope.result));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0",
      id: ACP_PROBE_REQUEST_ID,
      method: "initialize",
      params: acpInitializeRequest(YUI_VERSION)
    })}\n`);
  });
}

async function runTextProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<string> {
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(`${stdout}\n${stderr}`);
    };
    const abort = (): void => {
      terminateProcess(child);
      finish(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", finish);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        terminateProcess(child);
        finish(new Error("Agent configuration probe exceeded the output limit."));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        terminateProcess(child);
        finish(new Error("Agent configuration probe exceeded the output limit."));
      }
    });
    child.on("exit", (code, exitSignal) => {
      if (code === 0) finish();
      else finish(new Error(
        `Agent configuration probe exited (${code ?? exitSignal ?? "unknown"}).`
      ));
    });
  });
}

class JsonRpcProcess {
  readonly #pending = new Map<number, Readonly<{
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>>();
  readonly #stderr: string[] = [];
  #nextId = 1;
  #closed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    signal: AbortSignal
  ) {
    const output = createInterface({ input: child.stdout });
    output.on("line", (line) => { this.#receive(line); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr.push(chunk);
      while (this.#stderr.join("").length > 16_384) this.#stderr.shift();
    });
    child.stdin.on("error", (error) => { this.#failAll(error); });
    const abort = (): void => {
      this.#failAll(abortError());
      this.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => { this.#failAll(error); });
    child.on("exit", (code, exitSignal) => {
      signal.removeEventListener("abort", abort);
      if (this.#closed) return;
      this.#failAll(new Error(
        `Codex App Server exited (${code ?? exitSignal ?? "unknown"}).`
      ));
    });
  }

  static start(
    command: string,
    args: readonly string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal
  ): JsonRpcProcess {
    return new JsonRpcProcess(spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"]
    }), signal);
  }

  request(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Codex App Server is closed."));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params: Readonly<Record<string, unknown>>): void {
    this.#write({ method, params });
  }

  warnings(): string[] {
    return this.#stderr.join("").split(/\r?\n/)
      .some((line) => /\b(?:warn|error|failed)\b/i.test(line))
      ? ["Codex App Server reported warnings during catalog discovery."]
      : [];
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    terminateProcess(this.child);
    this.#failAll(new Error("Codex App Server was closed."));
  }

  #receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    const response = object(message);
    if (typeof response?.id !== "number") return;
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);
    const error = object(response.error);
    if (error !== undefined) {
      pending.reject(new Error(typeof error.message === "string"
        ? error.message : "Codex App Server request failed."));
      return;
    }
    pending.resolve(response.result);
  }

  #write(value: Readonly<Record<string, unknown>>): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function terminateProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, PROCESS_TERMINATION_GRACE_MS);
  force.unref();
  child.once("exit", () => { clearTimeout(force); });
  child.kill("SIGTERM");
}

function codexProfileField(environment: NodeJS.ProcessEnv): AgentConfigurationField {
  const root = environment.CODEX_HOME
    ?? join(environment.HOME ?? homedir(), ".codex");
  try {
    const profiles = object(parse(readFileSync(join(root, "config.toml"), "utf8")).profiles);
    const names = Object.keys(profiles ?? {}).filter((name) =>
      name.trim().length > 0 && !name.includes("\0")
    ).sort();
    return field("profile", names.map(choice), true, undefined,
      "Local config.toml profile names, not a Provider enumeration; custom names remain explicit input.");
  } catch (error) {
    const absent = error instanceof Error && "code" in error && error.code === "ENOENT";
    return field("profile", [], true, absent ? undefined : false, absent
      ? "No local config.toml; no profile names observed. Custom names remain explicit input."
      : "Local config.toml could not be read or parsed; profile enumeration unavailable.");
  }
}

function optionalApprovalChoices(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  // Current Codex also reports structured granular policies. They constrain
  // configuration but cannot be selected by Yui's scalar approval input; do not
  // reject the whole legitimate response or expand them into guessed aliases.
  return array(value, "configuration approval requirements").flatMap(entry => {
    if (typeof entry === "string") return [requiredString(entry, "approval requirement")];
    if (object(object(entry)?.granular) !== undefined) return [];
    throw new Error("Codex configuration approval requirement is invalid.");
  });
}

function optionalStrings(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  return array(value, "configuration requirements").map((entry) =>
    requiredString(entry, "configuration requirement"));
}

function field(
  key: string,
  choices: readonly AgentConfigurationChoice[],
  allowCustom: boolean,
  available?: boolean,
  reason?: string
): AgentConfigurationField {
  return {
    key,
    choices,
    allowCustom,
    ...(available === undefined ? {} : { available }),
    ...(reason === undefined ? {} : { reason })
  };
}

function choice(value: string): AgentConfigurationChoice {
  return { value, label: value };
}

function semanticVersion(value: string): string | undefined {
  return /(?:^|\D)(\d+\.\d+\.\d+)(?:\D|$)/m.exec(value)?.[1];
}

function abortError(): Error {
  return Object.assign(new Error("Agent configuration discovery was aborted."), {
    name: "AbortError"
  });
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  const result = object(value);
  if (result === undefined) throw new Error(`${label} is invalid.`);
  return result;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}
