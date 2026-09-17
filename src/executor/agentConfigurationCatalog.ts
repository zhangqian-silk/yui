import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ConfiguredAgent } from "../agent/agent.js";
import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import { writeTextFileAtomically } from "../storage/durableFile.js";
import { resolveAgentAdapter, type RoleAgentConfig } from "./agentAdapter.js";
import { redactAgentErrorText } from "../runtime/agentError.js";
import type { AgentCapabilityConfig } from "./agentCapabilityConfig.js";
import { staticAgentConfigurationFields, STATIC_CONFIGURATION_NOTICE } from "./agentConfigurationFields.js";

export type AgentConfigurationChoice = Readonly<{
  value: string;
  label: string;
  description?: string;
}>;

export type AgentModelChoice = Readonly<{
  value: string;
  label: string;
  description?: string;
  resolvedModel?: string;
  isDefault: boolean;
  defaultEffort?: string;
  efforts: readonly AgentConfigurationChoice[];
  serviceTiers?: readonly AgentConfigurationChoice[];
  defaultServiceTier?: string;
}>;

export type AgentConfigurationField = Readonly<{
  key: string;
  choices: readonly AgentConfigurationChoice[];
  allowCustom: boolean;
  available?: boolean;
  reason?: string;
}>;

/**
 * What a live handshake reported, as distinct from what Yui statically
 * supports.
 *
 * A connection plan's static table says which protocol Yui implements. It
 * cannot say what the Agent on the other end agreed to, and for a plan whose
 * products are interchangeable that difference is the whole point. Every field
 * is explicit about absence: a plan with no capability exchange reports
 * `unsupported`, and a plan that has one but learned nothing reports `unknown`,
 * so a missing value is never read as a negative answer.
 */
export type AgentHandshakeObservation =
  | Readonly<{
      status: "unsupported";
      /** Why no handshake facts exist: this plan negotiates nothing. */
      reason: string;
    }>
  | Readonly<{
      status: "observed";
      /** Protocol version the two sides settled on. */
      protocolVersion: number;
      /** Self-reported product identity, `unknown` when the Agent stayed silent. */
      agentName: string | "unknown";
      agentVersion: string | "unknown";
      /** Capability names the Agent advertised, sorted; `[]` means none. */
      capabilities: readonly string[];
      /** Authentication methods advertised, sorted; `[]` means none. */
      authMethods: readonly string[];
    }>;

export type AgentConfigurationCatalog = Readonly<{
  schemaVersion: 1;
  agentId: string;
  adapterId: AgentAdapterId;
  cliVersion?: string;
  /**
   * Absent when the catalog was not produced by a live connection, which is a
   * third state distinct from both branches above: nothing was attempted.
   */
  handshake?: AgentHandshakeObservation;
  models: readonly AgentModelChoice[];
  fields: readonly AgentConfigurationField[];
  warnings: readonly string[];
}>;

export type AgentConfigurationDiscoveryInput = Readonly<{
  agent: ConfiguredAgent;
  cwd: string;
  config?: AgentCapabilityConfig;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
}>;

export type AgentConfigurationDiscovery = (
  input: AgentConfigurationDiscoveryInput
) => Promise<AgentConfigurationCatalog>;

export type AgentConfigurationFailure = Readonly<{
  code: "timeout" | "missing-command" | "probe-failed";
  message: string;
}>;

export type ResolvedAgentConfigurationCatalog = Readonly<{
  /** Origin of the metadata query, not native confirmation of every field. */
  source: "live" | "cache" | "fallback";
  attemptedAt: string;
  fetchedAt?: string;
  catalog: AgentConfigurationCatalog;
  failure?: AgentConfigurationFailure;
}>;

export type ResolveAgentConfigurationInput = Readonly<{
  agent: ConfiguredAgent;
  cwd: string;
  config?: AgentCapabilityConfig;
  /** Explicitly re-probe metadata; never start model work or a refresh worker. */
  refresh?: boolean;
}>;

export type AgentConfigurationCatalogServiceOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => Date;
  discover?: AgentConfigurationDiscovery;
  /** Bound completed metadata results; active requests are coalesced separately. */
  memoryCacheLimit?: number;
}>;

type CachedCatalog = Readonly<{
  schemaVersion: 1;
  fingerprint: string;
  fetchedAt: string;
  catalog: AgentConfigurationCatalog;
}>;

const DEFAULT_TIMEOUT_MS = 8_000;

export class AgentConfigurationCatalogService {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #discover: AgentConfigurationDiscovery;
  readonly #memoryCacheLimit: number;
  readonly #requests = new Map<string, Promise<ResolvedAgentConfigurationCatalog>>();
  readonly #completed = new Map<string, ResolvedAgentConfigurationCatalog>();

  constructor(
    private readonly yuiHome: string,
    options: AgentConfigurationCatalogServiceOptions = {}
  ) {
    this.#environment = options.environment ?? process.env;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = options.now ?? (() => new Date());
    this.#discover = options.discover ?? ((input) =>
      resolveAgentAdapter(input.agent.adapterId).discoverConfiguration(input));
    this.#memoryCacheLimit = options.memoryCacheLimit ?? 64;
    if (!Number.isSafeInteger(this.#memoryCacheLimit) || this.#memoryCacheLimit < 1) {
      throw new Error("Agent metadata memory cache limit must be positive.");
    }
  }

  resolve(input: ResolveAgentConfigurationInput): Promise<ResolvedAgentConfigurationCatalog> {
    const fingerprint = catalogFingerprint(input, this.#environment);
    const active = this.#requests.get(fingerprint);
    if (active !== undefined) return active;
    const cached = this.#completed.get(fingerprint);
    if (cached !== undefined && input.refresh !== true) {
      this.#completed.delete(fingerprint);
      this.#completed.set(fingerprint, cached);
      return Promise.resolve(cached.source === "live" ? { ...cached, source: "cache" } : cached);
    }
    const request = this.#resolve(input, fingerprint).then(result => {
      this.#completed.delete(fingerprint);
      this.#completed.set(fingerprint, result);
      while (this.#completed.size > this.#memoryCacheLimit) {
        this.#completed.delete(this.#completed.keys().next().value!);
      }
      return result;
    }).finally(() => { this.#requests.delete(fingerprint); });
    this.#requests.set(fingerprint, request);
    return request;
  }

  async #resolve(
    input: ResolveAgentConfigurationInput,
    fingerprint: string
  ): Promise<ResolvedAgentConfigurationCatalog> {
    const attemptedAt = this.#now().toISOString();
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    try {
      const discovered = await Promise.race([
        this.#discover({
          ...input,
          environment: this.#environment,
          signal: controller.signal
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(Object.assign(
              new Error(`Agent capability discovery timed out after ${this.#timeoutMs}ms.`),
              { code: "ETIMEDOUT" }
            ));
          }, this.#timeoutMs);
        })
      ]);
      const catalog = validateCatalog(discovered, input.agent);
      const fetchedAt = this.#now().toISOString();
      try {
        writeTextFileAtomically(
          cachePath(this.yuiHome, input.agent.id, fingerprint),
          `${JSON.stringify({
            schemaVersion: 1,
            fingerprint,
            fetchedAt,
            catalog
          } satisfies CachedCatalog, null, 2)}\n`
        );
        return { source: "live", attemptedAt, fetchedAt, catalog };
      } catch {
        return {
          source: "live",
          attemptedAt,
          fetchedAt,
          catalog: {
            ...catalog,
            warnings: [
              ...catalog.warnings,
              "The runtime catalog cache could not be updated."
            ]
          }
        };
      }
    } catch (error) {
      const failure = catalogFailure(error);
      const cached = readCachedCatalog(
        cachePath(this.yuiHome, input.agent.id, fingerprint),
        fingerprint,
        input.agent
      );
      if (cached !== null) {
        return {
          source: "cache",
          attemptedAt,
          fetchedAt: cached.fetchedAt,
          catalog: cached.catalog,
          failure
        };
      }
      return {
        source: "fallback",
        attemptedAt,
        catalog: fallbackAgentConfigurationCatalog(input.agent),
        failure
      };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      controller.abort();
    }
  }
}

export function fallbackAgentConfigurationCatalog(
  agent: Pick<ConfiguredAgent, "id" | "adapterId">
): AgentConfigurationCatalog {
  return {
    schemaVersion: 1,
    agentId: agent.id,
    adapterId: agent.adapterId,
    models: [],
    fields: staticAgentConfigurationFields(agent.adapterId),
    warnings: ["Runtime configuration catalog is unavailable.", STATIC_CONFIGURATION_NOTICE]
  };
}

export function configurationField(
  catalog: AgentConfigurationCatalog,
  key: string
): AgentConfigurationField | undefined {
  return catalog.fields.find((candidate) => candidate.key === key);
}

export function defaultModel(
  catalog: AgentConfigurationCatalog
): AgentModelChoice | undefined {
  return catalog.models.find((model) => model.isDefault);
}

export function modelChoice(
  catalog: AgentConfigurationCatalog,
  value: string | undefined
): AgentModelChoice | undefined {
  return value === undefined
    ? defaultModel(catalog)
    : catalog.models.find((model) => model.value === value)
      ?? catalog.models.find((model) => model.resolvedModel === value && !model.isDefault)
      ?? catalog.models.find((model) => model.resolvedModel === value);
}

/** Observed choices, not an invented complete list of a Provider's model IDs. */
export function agentModelOptionsSummary(catalog: AgentConfigurationCatalog): string {
  const choices = catalog.models.map(model =>
    `${JSON.stringify(model.value)}${model.resolvedModel === undefined
      || model.resolvedModel === model.value ? "" : ` -> ${JSON.stringify(model.resolvedModel)}`}`);
  return [
    choices.length === 0
      ? "No native model options were reported."
      : `Native model options: ${choices.join(", ")}.`,
    ...(configurationField(catalog, "model")?.allowCustom === true
      ? ["Custom model IDs are validated by the Provider; this list is not exhaustive."] : [])
  ].join(" ");
}

/**
 * Validate known model/effort constraints. An explicitly open model field
 * delegates unlisted IDs to the Provider; aliases are not a complete whitelist.
 * A fallback has no model list and makes no claim about native acceptance.
 */
export function validateAgentLaunchConfiguration(
  catalog: AgentConfigurationCatalog,
  config: Pick<RoleAgentConfig, "model" | "effort">
): void {
  if (catalog.models.length === 0) return;
  const model = modelChoice(catalog, config.model);
  if (model === undefined) {
    if (config.model !== undefined && configurationField(catalog, "model")?.allowCustom === true) return;
    throw new Error(
      `Unsupported ${catalog.adapterId} launch configuration: field=model actual=${
        JSON.stringify(config.model ?? "")
      }. ${agentModelOptionsSummary(catalog)} `
      + `Inspect current options: yui config agent capabilities ${catalog.agentId}.`
    );
  }
  if (
    config.effort !== undefined
    && model.efforts.length > 0
    && !model.efforts.some((effort) => effort.value === config.effort)
  ) {
    throw new Error(
      `Unsupported ${catalog.adapterId} launch configuration: field=effort actual=${
        JSON.stringify(config.effort)
      } model=${JSON.stringify(model.value)} supported=${
        JSON.stringify(model.efforts.map(({ value }) => value))
      }. ${agentModelOptionsSummary(catalog)} `
      + `Inspect current options: yui config agent capabilities ${catalog.agentId}.`
    );
  }
}

function catalogFingerprint(
  input: ResolveAgentConfigurationInput,
  environment: NodeJS.ProcessEnv
): string {
  const bindings = input.agent.environment.map((binding) => ({
    target: binding.target,
    sourceName: binding.sourceName,
    value: environment[binding.sourceName] ?? null
  }));
  // Which directory an ACP Agent keeps its own state in is that product's
  // business, not the protocol's. Fingerprinting it against Claude's config
  // root made unrelated Claude edits invalidate this cache; the executable
  // path below is the honest identity for an Agent Yui only speaks to.
  const nativeRoot = input.agent.adapterId === "acp"
    ? null
    : input.agent.adapterId === "codex"
      ? environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), ".codex")
      : environment.CLAUDE_CONFIG_DIR ?? join(environment.HOME ?? homedir(), ".claude");
  const context = input.config?.adapterId === "codex"
    ? { profile: input.config.profile ?? null }
    : input.config?.adapterId === "claude"
      ? {
          settingsFile: input.config.settingsFile ?? null,
          settingsSources: input.config.settingsSources ?? null
        }
      : null;
  return createHash("sha256").update(JSON.stringify({
    // Old derived caches may contain guessed help values. They cannot establish
    // the current discovery contract. No durable record or cache shape changes.
    discoveryContract: "explicit-native-enumeration",
    agentId: input.agent.id,
    // The component, not just the plan: two ACP products answer the same
    // handshake differently, so a cache keyed on the plan alone would serve one
    // product's capabilities for the other.
    component: input.agent.component,
    adapterId: input.agent.adapterId,
    command: input.agent.command,
    baseArgs: input.agent.baseArgs,
    bindings,
    nativeRoot,
    cwd: input.cwd,
    context
  })).digest("hex");
}

function cachePath(yuiHome: string, agentId: string, fingerprint: string): string {
  return join(
    yuiHome,
    "cache",
    "agent-capabilities",
    "v1",
    agentId,
    `${fingerprint}.json`
  );
}

function readCachedCatalog(
  path: string,
  fingerprint: string,
  agent: ConfiguredAgent
): CachedCatalog | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!record(parsed)
    || parsed.schemaVersion !== 1
    || parsed.fingerprint !== fingerprint
    || typeof parsed.fetchedAt !== "string") {
    return null;
  }
  try {
    return {
      schemaVersion: 1,
      fingerprint,
      fetchedAt: parsed.fetchedAt,
      catalog: validateCatalog(parsed.catalog, agent)
    };
  } catch {
    return null;
  }
}

function validateCatalog(
  value: unknown,
  agent: Pick<ConfiguredAgent, "id" | "adapterId">
): AgentConfigurationCatalog {
  if (!record(value)
    || value.schemaVersion !== 1
    || value.agentId !== agent.id
    || value.adapterId !== agent.adapterId
    || !Array.isArray(value.models)
    || !Array.isArray(value.fields)
    || !Array.isArray(value.warnings)) {
    throw new Error("Agent configuration model catalog is incomplete.");
  }
  const models = value.models.map(validateModel);
  unique(models.map(({ value: model }) => model), "model");
  const fields = value.fields.map(validateField);
  unique(fields.map(({ key }) => key), "configuration field");
  if (models.length === 0 && !modelAxisIsAccountedFor(fields)) {
    throw new Error("Agent configuration model catalog is incomplete.");
  }
  const warnings = value.warnings.map((warning) => text(warning, "catalog warning"));
  return {
    schemaVersion: 1,
    agentId: agent.id,
    adapterId: agent.adapterId,
    ...(typeof value.cliVersion === "string"
      ? { cliVersion: text(value.cliVersion, "CLI version") } : {}),
    // Carried through rather than dropped. This is the only record of what the
    // Agent on the other end actually agreed to, and for a plan whose products
    // are interchangeable it is the one fact that tells them apart. Rebuilding
    // the catalog without it silently erased the probe's answer on both the
    // live path and the cache read-back, leaving every consumer unable to
    // distinguish "negotiated nothing" from "never asked".
    ...(value.handshake === undefined
      ? {}
      : { handshake: validateHandshake(value.handshake) }),
    models,
    fields,
    warnings
  };
}

/**
 * Whether an empty model list is an answer or a failure.
 *
 * Emptiness alone does not distinguish the two, so the `model` field's own
 * contract decides. `available` is the field that carries a probe's explicit
 * statement about an axis, and only a probe that states it has said anything
 * about what an empty list means:
 *
 * - `available: false` — the axis does not exist for this Agent, and `reason`
 *   says why. Nothing to enumerate.
 * - `available: true` — the axis exists and its values are deliberately
 *   enumerated later, with `allowCustom` letting a value be named before Yui has
 *   the list. This is ACP: models live in the `configOptions` a Session returns,
 *   so listing them at probe time would mean opening a real, possibly billed
 *   Session to populate a menu. The probe reports the axis, defers the values,
 *   and the configured model is verified against the Agent's own list at launch.
 * - absent — the probe made no claim, which is the Codex and Claude shape. Those
 *   probes enumerate models into the top-level `models` array on success, so an
 *   empty array there means `model list` failed or returned nothing usable, and
 *   the catalog really is incomplete.
 *
 * So an unstated `available` with no models stays a rejection, which is what
 * keeps a genuinely broken Codex or Claude discovery from passing as an answer.
 *
 * The earlier form of this check accepted only the first case. It therefore
 * rejected a valid ACP catalog and replaced it with the fallback, discarding the
 * live handshake and the probe's own reasons — the failure mode the
 * `available`/`reason` pair exists to prevent.
 */
function modelAxisIsAccountedFor(fields: readonly AgentConfigurationField[]): boolean {
  const model = fields.find(({ key }) => key === "model");
  if (model === undefined) return false;
  if (model.available === undefined) return model.choices.length > 0;
  // Stated either way, the field itself explains the empty list.
  return true;
}

/**
 * A handshake observation, kept in whichever of its three states it arrived in.
 *
 * Absence is meaningful and is preserved by the caller: it means no live
 * connection produced this catalog. The two present states are distinguished
 * here rather than merged, because `unsupported` ("this plan negotiates
 * nothing") and an `observed` result with empty capabilities ("the Agent
 * answered, and advertised none") are different answers that would otherwise
 * be indistinguishable. An unrecognised status is rejected instead of being
 * coerced into either one.
 */
function validateHandshake(value: unknown): AgentHandshakeObservation {
  if (!record(value)) throw new Error("Agent handshake observation is invalid.");
  if (value.status === "unsupported") {
    return {
      status: "unsupported",
      reason: text(value.reason, "handshake reason")
    };
  }
  if (value.status !== "observed") {
    throw new Error(`Agent handshake status is unsupported: ${String(value.status)}.`);
  }
  if (!Number.isSafeInteger(value.protocolVersion)) {
    throw new Error("Agent handshake protocol version is invalid.");
  }
  const capabilities = array(value.capabilities, "handshake capabilities")
    .map((capability) => text(capability, "handshake capability"));
  unique(capabilities, "handshake capability");
  const authMethods = array(value.authMethods, "handshake authentication methods")
    .map((method) => text(method, "handshake authentication method"));
  unique(authMethods, "handshake authentication method");
  return {
    status: "observed",
    protocolVersion: value.protocolVersion as number,
    // `unknown` is a real answer here — the Agent connected but did not name
    // itself — so it is stored as given and never replaced by a guess.
    agentName: text(value.agentName, "handshake Agent name"),
    agentVersion: text(value.agentVersion, "handshake Agent version"),
    capabilities: [...capabilities].sort(),
    authMethods: [...authMethods].sort()
  };
}

function validateModel(value: unknown): AgentModelChoice {
  if (!record(value) || typeof value.isDefault !== "boolean" || !Array.isArray(value.efforts)) {
    throw new Error("Agent configuration model entry is invalid.");
  }
  const efforts = value.efforts.map(validateChoice);
  unique(efforts.map(({ value: effort }) => effort), "effort");
  const serviceTiers = value.serviceTiers === undefined
    ? undefined
    : array(value.serviceTiers, "service tiers").map(validateChoice);
  if (serviceTiers !== undefined) {
    unique(serviceTiers.map(({ value: tier }) => tier), "service tier");
  }
  return {
    value: text(value.value, "model value"),
    label: text(value.label, "model label"),
    ...(typeof value.description === "string"
      ? { description: text(value.description, "model description") } : {}),
    ...(typeof value.resolvedModel === "string"
      ? { resolvedModel: text(value.resolvedModel, "resolved model") } : {}),
    isDefault: value.isDefault,
    ...(typeof value.defaultEffort === "string"
      ? { defaultEffort: text(value.defaultEffort, "default effort") } : {}),
    efforts,
    ...(serviceTiers === undefined ? {} : { serviceTiers }),
    ...(typeof value.defaultServiceTier === "string"
      ? { defaultServiceTier: text(value.defaultServiceTier, "default service tier") } : {})
  };
}

function validateField(value: unknown): AgentConfigurationField {
  if (!record(value) || !Array.isArray(value.choices) || typeof value.allowCustom !== "boolean") {
    throw new Error("Agent configuration field entry is invalid.");
  }
  const choices = value.choices.map(validateChoice);
  unique(choices.map(({ value: choice }) => choice), "field choice");
  return {
    key: text(value.key, "field key"),
    choices,
    allowCustom: value.allowCustom,
    ...(typeof value.available === "boolean" ? { available: value.available } : {}),
    ...(typeof value.reason === "string"
      ? { reason: text(value.reason, "field reason") } : {})
  };
}

function validateChoice(value: unknown): AgentConfigurationChoice {
  if (!record(value)) throw new Error("Agent configuration choice is invalid.");
  return {
    value: text(value.value, "choice value"),
    label: text(value.label, "choice label"),
    ...(typeof value.description === "string"
      ? { description: text(value.description, "choice description") } : {})
  };
}

function catalogFailure(error: unknown): AgentConfigurationFailure {
  const candidate = error instanceof Error ? error : new Error(String(error));
  const code = "code" in candidate ? String(candidate.code) : "";
  return {
    code: code === "ETIMEDOUT" || candidate.name === "AbortError"
      ? "timeout"
      : code === "ENOENT" ? "missing-command" : "probe-failed",
    message: redactAgentErrorText(candidate.message || "Agent capability discovery failed.")
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Agent configuration ${label} are invalid.`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`Agent configuration ${label} is invalid.`);
  }
  return value.trim();
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Agent configuration ${label} entries contain duplicates.`);
  }
}
