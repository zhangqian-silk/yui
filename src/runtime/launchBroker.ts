import { randomBytes } from "node:crypto";
import { resolve, isAbsolute } from "node:path";
import {
  validateProviderAuthorityFence,
  type ProviderAuthorityFence
} from "./providerAuthorityFence.js";
import { AGENT_HOST_LAUNCH_TICKET_TTL_MS } from "./runtimeDeadlines.js";
import type { CodexThreadOptions } from "./codexAppServerRuntime.js";
import type { AcpSessionOptions } from "./acpProtocol.js";
import type { ImplementationRef } from "../kernel/instanceHost.js";
import { validateAgentEndpointImplementation } from "./agentEndpointIdentity.js";
import { validateExecutionEnvironmentSnapshot, type ExecutionEnvironmentSnapshot } from "../resources/projectResource.js";
import { isAgentAdapterId, type AgentAdapterId } from "../agent/adapterCatalog.js";
import {
  adapterIdForExecutionComponent,
  isAgentExecutionComponentId,
  type AgentExecutionComponentId
} from "../agent/executionComponents.js";
import { agentTransportForAdapter, type AgentTransport } from "../agent/connectionPlan.js";
import { resolveAgentAdapter } from "../executor/agentAdapter.js";

export type AgentHostLaunchPayload = Readonly<{
  schemaVersion: 2;
  command: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  cwd: string;
  /** Exact launch only; never exported into the long-lived Provider environment. */
  startupRunId?: string;
  executionEnvironment?: ExecutionEnvironmentSnapshot;
  childLifecycle: "persistent" | "per-turn";
  startMode: "provider" | "idle";
  providerControl?: AgentHostProviderControl;
  /** Invocation-local options for the native global TUI's own startup request. */
  interactiveCodexThread?: CodexThreadOptions;
}>;

export type ProviderOwnedTurn = Readonly<{
  attemptId: string;
  turnId: string;
}>;

type AgentHostProviderControlBase = Readonly<{
  schemaVersion: 1;
  adapterId: AgentAdapterId;
  /**
   * Which product executes, as recorded by the Agent binding. The plan above
   * says how Yui reaches it; this says what answers. Carried because one
   * protocol decision depends on the product — the mode value that grants
   * bypass — and it must come from the stored binding rather than from the
   * command line that was assembled.
   */
  component?: AgentExecutionComponentId;
  transport: AgentTransport;
  sessionTitle?: string;
  authority: ProviderAuthorityFence;
  codexThread?: CodexThreadOptions;
  /** ACP has no launch flags; its per-Session facts travel with the control. */
  acpSession?: AcpSessionOptions;
  endpointImplementation?: ImplementationRef;
  /** Session-only launch; the coordinator records its identity before any input. */
  sessionOnly?: boolean;
}>;

/**
 * Session lifecycle is independent from Turn submission. `start` creates one
 * new native Session; `restore` reattaches exactly the named Session and never
 * falls back to creating another one.
 */
export type AgentHostProviderControl = AgentHostProviderControlBase & (
  | Readonly<{
      kind: "start";
      mode: "new";
      nativeSessionId?: string;
    }>
  | Readonly<{
      kind: "restore";
      mode: "resume";
      nativeSessionId: string;
      ownedTurn?: ProviderOwnedTurn;
    }>
);

type Reservation = Readonly<{
  ticket: string;
  payload: AgentHostLaunchPayload;
  createdAt: number;
}>;

const brokers = new Map<string, LaunchBroker>();

/** One Controller-process broker per canonical Home. Payloads never hit disk or tmux. */
export function launchBrokerForHome(home: string): LaunchBroker {
  const key = resolve(home);
  const existing = brokers.get(key);
  if (existing !== undefined) return existing;
  const broker = new LaunchBroker();
  brokers.set(key, broker);
  return broker;
}

export class LaunchBroker {
  readonly #reservations = new Map<string, Reservation>();

  reserve(payload: AgentHostLaunchPayload): Readonly<{ ticket: string }> {
    validatePayload(payload);
    const ticket = randomBytes(32).toString("hex");
    this.#reservations.set(ticket, Object.freeze({
      ticket,
      payload,
      createdAt: Date.now()
    }));
    return Object.freeze({ ticket });
  }

  redeem(ticket: string): AgentHostLaunchPayload {
    const reservation = this.#reservations.get(ticket);
    if (reservation === undefined || reservation.ticket !== ticket) {
      throw new Error("Launch ticket is invalid or already consumed.");
    }
    this.#reservations.delete(ticket);
    if (Date.now() - reservation.createdAt > AGENT_HOST_LAUNCH_TICKET_TTL_MS) {
      throw new Error("Launch ticket expired before redemption.");
    }
    return reservation.payload;
  }

  revoke(ticket: string): void {
    this.#reservations.delete(ticket);
  }

  pendingCount(): number {
    return this.#reservations.size;
  }
}

export function validateAgentHostLaunchPayload(value: unknown): AgentHostLaunchPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent Host launch payload must be an object.");
  }
  return validatePayload(value as AgentHostLaunchPayload);
}

function validatePayload(payload: AgentHostLaunchPayload): AgentHostLaunchPayload {
  if (payload.schemaVersion !== 2) throw new Error("Agent Host launch payload version is invalid.");
  text(payload.command, "command");
  text(payload.cwd, "cwd");
  if (payload.startupRunId !== undefined) {
    text(payload.startupRunId, "startup Run id");
    if (payload.environment?.YUI_SESSION_SCOPE !== "task") {
      throw new Error("Only a Task launch may carry a startup Run identity.");
    }
  }
  if (!Array.isArray(payload.args)) throw new Error("Agent Host launch args must be an array.");
  payload.args.forEach((value) => text(value, "argument"));
  if (payload.environment === null || typeof payload.environment !== "object") {
    throw new Error("Agent Host launch environment must be an object.");
  }
  for (const [key, value] of Object.entries(payload.environment)) {
    text(key, "environment key");
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error("Agent Host launch environment value is invalid.");
    }
  }
  if (payload.executionEnvironment !== undefined) {
    const adopted = validateExecutionEnvironmentSnapshot(payload.executionEnvironment);
    if (payload.environment.YUI_SESSION_SCOPE !== "task"
      || payload.environment.YUI_TASK_ID !== adopted.taskId
      || payload.cwd !== adopted.directory.path) {
      throw new Error("Agent Host execution environment does not match its Task and cwd.");
    }
  }
  if (payload.childLifecycle !== "persistent" && payload.childLifecycle !== "per-turn") {
    throw new Error("Agent Host child lifecycle is invalid.");
  }
  if (payload.startMode !== "provider" && payload.startMode !== "idle") {
    throw new Error("Agent Host start mode is invalid.");
  }
  if (payload.providerControl !== undefined) validateProviderControl(payload.providerControl);
  return payload;
}

function validateProviderControl(control: AgentHostProviderControl): void {
  if (control.schemaVersion !== 1) throw new Error("Agent Host Provider control version is invalid.");
  if (control.endpointImplementation !== undefined) validateAgentEndpointImplementation(control.endpointImplementation);
  if (!isAgentAdapterId(control.adapterId)) {
    throw new Error("Agent Host Provider control adapter is invalid.");
  }
  // The connection plan owns the protocol/transport pair. Re-deriving it here
  // is what keeps a control from naming a carrier its adapter does not speak.
  if (control.transport !== agentTransportForAdapter(control.adapterId)) {
    throw new Error("Agent Host Provider control transport does not match its adapter.");
  }
  // The component determines its plan, so a control naming both must have them
  // agree. Letting them drift would let a launch apply one product's
  // configuration decisions to another product's Session.
  if (control.component !== undefined) {
    if (!isAgentExecutionComponentId(control.component)) {
      throw new Error("Agent Host Provider control execution component is invalid.");
    }
    if (adapterIdForExecutionComponent(control.component) !== control.adapterId) {
      throw new Error(
        "Agent Host Provider control execution component does not match its adapter."
      );
    }
  }
  if ((control.adapterId === "codex") !== (control.codexThread !== undefined)) {
    throw new Error("Agent Host Provider thread settings do not match its adapter.");
  }
  if (control.codexThread !== undefined) validateCodexThreadOptions(control.codexThread);
  if (control.adapterId !== "acp" && control.acpSession !== undefined) {
    throw new Error("Agent Host ACP session settings do not match its adapter.");
  }
  if (control.acpSession !== undefined) validateAcpSessionOptions(control.acpSession);
  if (control.mode !== "new" && control.mode !== "resume") {
    throw new Error("Agent Host Provider control mode is invalid.");
  }
  if (control.kind !== "start" && control.kind !== "restore") {
    throw new Error("Agent Host Provider control kind is invalid.");
  }
  if ((control.kind === "start") !== (control.mode === "new")) {
    throw new Error("Agent Host Provider control kind does not match its transport mode.");
  }
  if (control.kind !== "restore" && "ownedTurn" in control) {
    throw new Error("Only Session restore can reconcile an owned Turn.");
  }
  if (control.kind === "restore" && control.ownedTurn !== undefined) {
    if (control.adapterId !== "codex") {
      throw new Error("Only Managed Codex can recover an owned Turn across client attachment.");
    }
    text(control.ownedTurn.attemptId, "owned Provider input attemptId");
    text(control.ownedTurn.turnId, "owned Provider Turn id");
  }
  // Resume always needs the id being resumed. A new launch needs one only from
  // an Agent that accepts a caller-chosen Session id; the others report theirs
  // once they answer, so demanding it up front rejects a valid launch.
  const requiresNativeSessionId = control.mode === "resume"
    || resolveAgentAdapter(control.adapterId).capabilities.nativeSessionDiscovery === "preallocated";
  if (requiresNativeSessionId !== (control.nativeSessionId !== undefined)) {
    throw new Error("Agent Host Provider resume identity is inconsistent.");
  }
  if (control.nativeSessionId !== undefined) text(control.nativeSessionId, "nativeSessionId");
  if (control.sessionTitle !== undefined) {
    const title = control.sessionTitle.trim();
    if (
      title.length === 0
      || title.length > 1_024
      || /[\r\n\0]/u.test(title)
    ) {
      throw new Error("Agent Host Provider session title is invalid.");
    }
  }
  validateProviderAuthorityFence(control.authority);
}

function validateCodexThreadOptions(options: CodexThreadOptions): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Agent Host Codex thread settings are invalid.");
  }
  for (const [value, label] of [
    [options.model, "model"],
    [options.approvalPolicy, "approval policy"],
    [options.sandbox, "sandbox"],
    [options.developerInstructions, "developer instructions"]
  ] as const) {
    if (value !== undefined) text(value, `Codex thread ${label}`);
  }
  if (options.runtimeWorkspaceRoots !== undefined) {
    if (!Array.isArray(options.runtimeWorkspaceRoots)) {
      throw new Error("Agent Host Codex runtime workspace roots are invalid.");
    }
    options.runtimeWorkspaceRoots.forEach((root) => text(root, "Codex runtime workspace root"));
  }
  if (options.config !== undefined
    && (options.config === null || typeof options.config !== "object"
      || Array.isArray(options.config))) {
    throw new Error("Agent Host Codex thread config is invalid.");
  }
}

function validateAcpSessionOptions(options: AcpSessionOptions): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Agent Host ACP session settings are invalid.");
  }
  if (options.additionalDirectories !== undefined) {
    if (!Array.isArray(options.additionalDirectories)) {
      throw new Error("Agent Host ACP additional workspace roots are invalid.");
    }
    // ACP requires each additional root to be absolute. Rejecting a relative
    // path here keeps an invalid request from reaching the Agent at all.
    for (const root of options.additionalDirectories) {
      if (!isAbsolute(text(root, "ACP additional workspace root"))) {
        throw new Error("Agent Host ACP additional workspace root must be absolute.");
      }
    }
  }
  if (options.sessionBootstrap !== undefined) {
    text(options.sessionBootstrap, "ACP session bootstrap");
  }
  const desired = options.desiredConfiguration;
  if (desired !== undefined) {
    if (desired === null || typeof desired !== "object" || Array.isArray(desired)) {
      throw new Error("Agent Host ACP session configuration is invalid.");
    }
    if (desired.model !== undefined) text(desired.model, "ACP session model");
    if (desired.effort !== undefined) text(desired.effort, "ACP session effort");
    if (desired.permissionMode !== undefined) {
      text(desired.permissionMode, "ACP session permission mode");
    }
    if (desired.permissionBypass !== undefined && typeof desired.permissionBypass !== "boolean") {
      throw new Error("Agent Host ACP session permission bypass is invalid.");
    }
    // Naming an exact mode and asking for bypass are two different requests, and
    // a payload carrying both leaves it ambiguous which one the user made.
    if (desired.permissionMode !== undefined && desired.permissionBypass === true) {
      throw new Error(
        "Agent Host ACP session configuration cannot request both a named permission "
        + "mode and the bypass strategy."
      );
    }
  }
}

function text(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`Agent Host ${label} is invalid.`);
  }
  return value;
}
