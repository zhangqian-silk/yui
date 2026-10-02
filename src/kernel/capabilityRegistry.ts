import type { TrustedCallContext } from "./callAuthority.js";
import { InstanceHost, type ImplementationRef } from "./instanceHost.js";
import { capabilitySchemaError, checkCapabilitySchema, type CapabilitySchema } from "./capabilitySchema.js";
import { checkSurfaceDescriptors, type SurfaceDescriptors } from "../surface/surfaceContributions.js";
import type { AccessAssessment } from "./accessAssessment.js";

export type CapabilityEffect = "query" | "local-mutation" | "external-operation";
export type CapabilityScope = Readonly<{ kind: "global" } | { kind: "project" | "task"; id: string }>;
export type CapabilityDescriptor = Readonly<{
  name: string;
  contractVersion: string;
  summary: string;
  inputSchema: CapabilitySchema;
  outputSchema: CapabilitySchema;
  effect: CapabilityEffect;
  requiredPermissions: readonly string[];
  provider: ImplementationRef;
  source: string;
  scope: CapabilityScope;
  required?: readonly Readonly<{ name: string; contractVersion: string }>[];
  unavailable?: string;
  surfaces?: SurfaceDescriptors;
}>;
export type CapabilityCall = Readonly<{
  name: string;
  input: unknown;
  contractVersion?: string;
  providerId?: string;
  requestId?: string;
}>;
/** Original owner's read model or receipt, never a new writable operation. */
export type CapabilityOperation = Readonly<{
  operationRef: Readonly<{ taskId: string; jobId: string }>;
  effect: "none" | "possible" | "confirmed";
  state: string;
  outcome?: string;
  receiptRefs: readonly string[];
  partialResultRefs: readonly string[];
}>;
export type CapabilityResult = Readonly<{
  kind: "value" | "operation" | "unavailable" | "ambiguous" | "denied" | "invalid" | "failed";
  effect: "none" | "possible" | "confirmed";
  operations: readonly CapabilityOperation[];
  value?: unknown;
  detail?: string;
  candidates?: readonly CapabilityDescriptor[];
  provider?: ImplementationRef;
  selection?: "explicit" | "unique";
}>;
export type CapabilityInvocation = Readonly<{
  /** No credentials, authority issuer, Store or registry is exposed to code. */
  context: TrustedCallContext;
  requestId?: string;
  call(request: CapabilityCall): Promise<CapabilityResult>;
  /** Save evidence in its semantic owner first; this preserves its locator
   * through wrapper/output failures. Not a persistence API. */
  observe(operation: CapabilityOperation): void;
}>;
export type CapabilityImplementation = Readonly<{
  invoke(name: string, input: unknown, invocation: CapabilityInvocation): unknown | Promise<unknown>;
}>;
export type CapabilityVisibility = Readonly<{ taskIds: readonly string[]; projectIds: readonly string[] }>;
export type CapabilityDiscovery = CapabilityDescriptor & Readonly<{ access?: AccessAssessment }>;
/** Trusted owners may accompany a failed operation with its current read model.
 * This is diagnostic data, not an operation receipt or an authority token. */
export class CapabilityExecutionError extends Error {
  readonly value: unknown;
  constructor(message: string, value: unknown) {
    super(message);
    this.value = structuredClone(value);
  }
}
type Authorize = (context: TrustedCallContext, descriptor?: CapabilityDescriptor, input?: unknown) => CapabilityVisibility;
const effectRank = { query: 0, "local-mutation": 1, "external-operation": 2 };
const reserved = new Set(["yui", "task", "context", "config", "job", "resource", "plugin", "runtime", "grant", "capability", "artifact", "environment", "project"]);

/** One rebuildable descriptor view over the composition root's existing Host.
 * Only the trusted root owns this object. Extensions receive a bound invocation
 * port, never the registry/Host or an actor-selecting call interface. */
export class CapabilityRegistry {
  #descriptors: readonly CapabilityDescriptor[] = [];
  readonly #coreProviders = new Set<string>();

  constructor(
    private readonly host: InstanceHost,
    private readonly authorize: Authorize,
    builtins: readonly CapabilityDescriptor[] = [],
    private readonly assess?: (context: TrustedCallContext, descriptor: CapabilityDescriptor, input: unknown) => AccessAssessment | undefined
  ) {
    this.#publish(builtins, true);
    builtins.forEach((entry) => this.#coreProviders.add(entry.provider.id));
  }

  /** Publish a complete provider generation atomically after owner initialization.
   * Failure leaves all existing descriptors intact. Host lifecycle remains owned
   * by the root: publish replacement, then detach old generation when appropriate. */
  register(descriptors: readonly CapabilityDescriptor[]): void {
    this.#publish(descriptors, false);
  }

  /** Data-only candidate check before author initialization; no acquisition or
   * publication. Repeat immediately before publishing after any async work. */
  checkRegistration(context: TrustedCallContext, descriptors: readonly CapabilityDescriptor[]): void {
    const prepared = this.#prepare(descriptors, false);
    if (!prepared.length) throw new Error("Plugin must contribute capabilities.");
    const available = [
      ...this.#authorized(context).filter((entry) => entry.provider.id !== prepared[0].provider.id),
      ...prepared
    ];
    const check = (entry: CapabilityDescriptor, path: ReadonlySet<CapabilityDescriptor>): void => {
      this.authorize(context, entry);
      if (path.has(entry)) throw new Error("Required capability dependency cycle.");
      for (const dependency of entry.required ?? []) {
        const matches = available.filter((candidate) => candidate.name === dependency.name
          && candidate.contractVersion === dependency.contractVersion && candidate.unavailable === undefined
          && (prepared.includes(candidate) || this.host.isAvailable(candidate.provider)));
        if (matches.length !== 1) throw new Error(`Required capability is missing or ambiguous: ${dependency.name}.`);
        check(matches[0], new Set([...path, entry]));
      }
    };
    prepared.forEach((entry) => check(entry, new Set()));
  }

  disable(providerId: string): void {
    this.#descriptors = this.#descriptors.filter((entry) => entry.provider.id !== providerId);
  }

  #authorized(context: TrustedCallContext): readonly CapabilityDescriptor[] {
    const visibility = this.authorize(context);
    return this.#descriptors.filter((entry) => visible(entry.scope, visibility))
      .filter((entry) => {
        try { this.authorize(context, entry); return true; } catch { return false; }
      });
  }

  search(context: TrustedCallContext, query = ""): readonly CapabilityDiscovery[] {
    // Descriptor discovery must not acquire or inspect runtime Providers. These
    // are templates: without input, no exact-target authorization is asserted.
    return this.#authorized(context).filter((entry) => `${entry.name} ${entry.summary}`.toLowerCase().includes(query.toLowerCase()))
      .map(entry => {
        const access = this.assess?.(context, entry, undefined);
        return access ? { ...entry, access } : entry;
      }).filter(entry => !("access" in entry) || entry.access?.state !== "hidden");
  }

  #select(context: TrustedCallContext, request: Omit<CapabilityCall, "input">, execution: boolean): CapabilityResult {
    try {
      const authorized = this.#authorized(context);
      const candidates = authorized.filter((entry) => entry.name === request.name
        && (request.contractVersion === undefined || request.contractVersion === entry.contractVersion)
        && (request.providerId === undefined || request.providerId === entry.provider.id));
      if (!candidates.length) return result("unavailable", "No authorized compatible Provider is available.");
      const available = execution ? candidates.filter(entry => this.#unavailable(entry, authorized, new Set()) === undefined) : candidates;
      if (!available.length) {
        return { ...result("unavailable", candidates.map(entry =>
          `${entry.provider.id}: ${this.#unavailable(entry, authorized, new Set())}`).join("; ")), candidates };
      }
      if (available.length > 1) return { ...result("ambiguous", "Select an explicit Provider and contract version."), candidates };
      const selected = available[0];
      return {
        ...result("value"), value: selected, candidates, provider: selected.provider,
        selection: request.providerId === undefined ? "unique" : "explicit"
      };
    } catch {
      return result("denied", "Current call authority is unavailable.");
    }
  }

  describe(context: TrustedCallContext, request: Omit<CapabilityCall, "input"> & { input?: unknown }): CapabilityResult {
    const selected = this.#select(context, request, false);
    if (selected.kind !== "value") return selected;
    const descriptor = selected.value as CapabilityDescriptor;
    if (Object.hasOwn(request, "input")) {
      const error = capabilitySchemaError(descriptor.inputSchema, request.input);
      if (error) return result("invalid", error);
      try { this.authorize(context, descriptor, request.input); }
      catch { return result("denied", "Current call authority is unavailable."); }
    }
    try {
      const access = this.assess?.(context, descriptor, request.input);
      if (access?.state === "hidden") return result("unavailable", "No authorized compatible Provider is available.");
      return access ? { ...selected, value: { ...descriptor, access } } : selected;
    } catch (error) {
      return result("failed", error instanceof Error ? error.message : "Authorization assessment failed.");
    }
  }

  call(context: TrustedCallContext, request: CapabilityCall): Promise<CapabilityResult> {
    return this.#call(context, request, "external-operation");
  }

  async #call(context: TrustedCallContext, request: CapabilityCall, ceiling: CapabilityEffect,
    permissions?: readonly string[]): Promise<CapabilityResult> {
    // Freeze one input snapshot across validation/acquisition and async nesting.
    try { request = deepFreeze(structuredClone(request)); } catch {
      return result("invalid", "Capability request must be cloneable data.");
    }
    // Execution selects independently of discovery assessment and rechecks the
    // exact input below. A requestable descriptor never grants admission.
    const resolved = this.#select(context, {
      name: request.name, contractVersion: request.contractVersion, providerId: request.providerId
    }, true);
    if (resolved.kind !== "value") return resolved;
    const descriptor = resolved.value as CapabilityDescriptor;
    const origin = { provider: descriptor.provider, selection: resolved.selection };
    if (effectRank[descriptor.effect] > effectRank[ceiling]) {
      return { ...result("denied", "Nested call exceeds the parent's effect boundary."), ...origin };
    }
    if (permissions !== undefined && descriptor.requiredPermissions.some((permission) => !permissions.includes(permission))) {
      return { ...result("denied", "Nested call exceeds the parent's declared permissions."), ...origin };
    }
    const inputError = capabilitySchemaError(descriptor.inputSchema, request.input);
    if (inputError) return { ...result("invalid", inputError), ...origin };
    if (descriptor.effect !== "query" && (typeof request.requestId !== "string" || !request.requestId.trim())) {
      return { ...result("invalid", "Effectful calls require requestId."), ...origin };
    }
    try { this.authorize(context, descriptor, request.input); } catch {
      return { ...result("denied", "Current call authority was revoked."), ...origin };
    }
    try {
      const access = this.assess?.(context, descriptor, request.input);
      if (access && access.state !== "authorized") {
        return { ...result("denied", "Exact target authorization is required."), ...origin };
      }
    } catch (error) {
      return { ...result("failed", error instanceof Error ? error.message : "Authorization assessment failed."), ...origin };
    }
    const operations: CapabilityOperation[] = [];
    let effect: CapabilityResult["effect"] = "none";
    const observe = (operation: CapabilityOperation) => {
      operations.push(structuredClone(operation));
      effect = accumulatedEffect(effect, operation.effect);
    };
    let entered = false;
    try {
      const value = await this.host.use<CapabilityImplementation, unknown>(descriptor.provider, async (implementation) => {
        entered = true;
        let open = true;
        const children: Promise<CapabilityResult>[] = [];
        try {
          return await implementation.invoke(descriptor.name, request.input, Object.freeze({
            context, requestId: request.requestId,
            observe: (operation: CapabilityOperation) => {
              if (!open) throw new Error("Capability invocation has ended.");
              observe(operation);
            },
            call: (nested: CapabilityCall) => {
              if (!open) return Promise.resolve(result("denied", "Capability invocation has ended."));
              const child = this.#call(context, nested, descriptor.effect, descriptor.requiredPermissions).then((outcome) => {
                outcome.operations.forEach(observe);
                effect = accumulatedEffect(effect, outcome.effect);
                return outcome;
              });
              children.push(child);
              return child;
            }
          }));
        } finally {
          open = false;
          // A wrapper throwing early must not detach its already-issued child
          // operations from the returned evidence or release the parent handle.
          await Promise.all(children);
        }
      });
      if (descriptor.effect === "local-mutation") effect = accumulatedEffect(effect, "confirmed");
      // An external implementation without an owner's operation reference is not
      // proof of success. Preserve uncertainty rather than return a value success.
      if (descriptor.effect === "external-operation" && !operations.length) {
        return { kind: "failed", detail: "External implementation returned no operation evidence.", effect: "possible", operations, ...origin };
      }
      let output: unknown;
      try {
        output = JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
          if ((typeof item === "number" && !Number.isFinite(item))
            || typeof item === "bigint" || typeof item === "function" || typeof item === "symbol") {
            throw new Error("Output contains a non-JSON value.");
          }
          return item;
        }));
      } catch {
        if (descriptor.effect !== "query") effect = accumulatedEffect(effect, "possible");
        return { kind: "invalid", detail: "Output is not JSON serializable.", effect, operations, ...origin };
      }
      const outputError = capabilitySchemaError(descriptor.outputSchema, output);
      if (outputError) {
        if (descriptor.effect !== "query") effect = accumulatedEffect(effect, "possible");
        return { kind: "invalid", detail: `Output ${outputError}`, effect, operations, ...origin };
      }
      return { kind: operations.length ? "operation" : "value", value: output, effect, operations, ...origin };
    } catch (error) {
      // An unrelated observation (including a historical queued Job with none)
      // cannot prove that a failing effectful wrapper performed no other action.
      // Preserve the owner's precise facts while reporting wrapper uncertainty.
      if (entered && descriptor.effect !== "query") effect = accumulatedEffect(effect, "possible");
      return {
        kind: entered ? "failed" : "unavailable",
        detail: error instanceof Error ? error.message : "Capability invocation failed.",
        ...(error instanceof CapabilityExecutionError ? { value: error.value } : {}),
        effect, operations, ...origin
      };
    }
  }

  #unavailable(
    entry: CapabilityDescriptor,
    authorized: readonly CapabilityDescriptor[],
    visiting: ReadonlySet<CapabilityDescriptor>
  ): string | undefined {
    if (entry.unavailable !== undefined) return entry.unavailable;
    if (!this.host.isAvailable(entry.provider)) return "Provider implementation is not available.";
    if (visiting.has(entry)) return "Required capability dependency cycle.";
    const path = new Set([...visiting, entry]);
    // Only declared exact name/version edges are checked. No installation,
    // priority policy, version solver or persisted dependency state is involved.
    const missing = entry.required?.filter((dependency) => !authorized.some((candidate) => (
      candidate.name === dependency.name && candidate.contractVersion === dependency.contractVersion
      && this.#unavailable(candidate, authorized, path) === undefined
    )));
    if (missing?.length) return `Missing available required capabilities: ${missing.map((dependency) => `${dependency.name}@${dependency.contractVersion}`).join(", ")}.`;
    return undefined;
  }

  #publish(descriptors: readonly CapabilityDescriptor[], core: boolean): void {
    if (!descriptors.length) return;
    const prepared = this.#prepare(descriptors, core);
    const provider = prepared[0].provider;
    // Validate acquisition before publishing; no implementation is invoked.
    if (prepared.some((entry) => !entry.unavailable)) {
      const handle = this.host.acquire<CapabilityImplementation>(provider);
      try {
        if (typeof handle.value?.invoke !== "function") throw new Error("Provider has no capability implementation.");
      } finally { void handle.release(); }
    }
    this.#descriptors = [
      ...this.#descriptors.filter((entry) => entry.provider.id !== provider.id),
      ...prepared.map((entry) => deepFreeze(entry))
    ];
  }

  #prepare(descriptors: readonly CapabilityDescriptor[], core: boolean): CapabilityDescriptor[] {
    if (!descriptors.length) return [];
    const prepared = structuredClone(descriptors);
    const provider = prepared[0].provider;
    if (!core && this.#coreProviders.has(provider.id)) throw new Error("Core Provider identity is reserved.");
    const names = new Set<string>();
    for (const entry of prepared) {
      if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(entry.name)
        || !entry.contractVersion?.trim() || !entry.source?.trim()
        || !Object.hasOwn(effectRank, entry.effect)
        || !Array.isArray(entry.requiredPermissions)
        || entry.requiredPermissions.some((permission) => typeof permission !== "string" || !permission.trim())) {
        throw new Error("Invalid capability descriptor.");
      }
      if (!core && reserved.has(entry.name.split(".")[0])) throw new Error("Core capability namespace is reserved.");
      if (!["global", "project", "task"].includes(entry.scope.kind)
        || (entry.scope.kind !== "global" && !entry.scope.id?.trim())) throw new Error("Invalid capability scope.");
      if (entry.provider.id !== provider.id || entry.provider.generation !== provider.generation) {
        throw new Error("Publish one complete Provider generation at a time.");
      }
      const key = `${entry.name}@${entry.contractVersion}`;
      if (names.has(key)) throw new Error(`Duplicate capability: ${key}.`);
      names.add(key);
      checkCapabilitySchema(entry.inputSchema);
      checkCapabilitySchema(entry.outputSchema);
      checkSurfaceDescriptors(entry);
      for (const dependency of entry.required ?? []) {
        if (!dependency.name?.trim() || !dependency.contractVersion?.trim()) throw new Error("Invalid required capability.");
      }
    }
    return [...prepared];
  }
}

function visible(scope: CapabilityScope, visibility: CapabilityVisibility): boolean {
  return scope.kind === "global" || (scope.kind === "task"
    ? visibility.taskIds.includes(scope.id) : visibility.projectIds.includes(scope.id));
}
function result(kind: CapabilityResult["kind"], detail?: string): CapabilityResult {
  return { kind, effect: "none", operations: [], ...(detail === undefined ? {} : { detail }) };
}
function accumulatedEffect(a: CapabilityResult["effect"], b: CapabilityResult["effect"]): CapabilityResult["effect"] {
  return a === "confirmed" || b === "confirmed" ? "confirmed" : a === "possible" || b === "possible" ? "possible" : "none";
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
