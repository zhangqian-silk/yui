import type { PromptEnvelope } from "./promptEnvelope.js";
import type { ProviderDeliveryFailure } from "./agentError.js";
import type { RuntimeBinding } from "./runtimeBinding.js";
import type { ProviderAuthorityFence } from "./providerAuthorityFence.js";
import type { RuntimeOwner } from "./runtimeOwner.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import type { TaskRuntimeLaunchPolicy } from "./taskRuntimeIsolation.js";
import type {
  NewSessionLaunchRequest,
  ResumeSessionLaunchRequest
} from "./sessionLaunchRequest.js";

export type SessionRuntimeState = "starting" | "running" | "stopped" | "unavailable";

export type RuntimeLaunchRetryReason =
  | "previous-process"
  | "writable-client"
  | "provider-child-active";

/** A Session launch may be temporarily unavailable or fail with a diagnosis. */
export class RuntimeLaunchError extends Error {
  readonly name: string = "RuntimeLaunchError";

  constructor(
    readonly retryable: boolean,
    message: string,
    readonly reason?: RuntimeLaunchRetryReason,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

/** A host-side contention check that occurs before planning or process start. */
export class RuntimeHostContentionError extends RuntimeLaunchError {
  readonly name = "RuntimeHostContentionError";

  constructor(
    readonly reason: Extract<
      RuntimeLaunchRetryReason,
      "writable-client" | "provider-child-active" | "previous-process"
    >,
    message: string
  ) {
    super(true, message, reason);
  }
}

/** A reused Host reported an unusable state; this operation did not create it. */
export class RuntimeHostUnavailableError extends RuntimeLaunchError {
  constructor(
    readonly hostState: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(false, message, undefined, options);
  }
}

export type SessionInspection = Readonly<{
  state: SessionRuntimeState;
  nativeSessionId?: string;
}>;

export type RuntimeLaunchPreparationRequest = Readonly<{
  owner: RuntimeOwner;
  agentId: string;
  adapterId: string;
  effective: EffectiveLaunchSnapshot;
  workspace: string;
  /** Authoritative runtime owner; a Role is only transport/session addressing. */
  managedWorkspace?: ManagedWorkspace;
  /**
   * Set when the Task legitimately owns no workspace: an empty environment plan
   * over no bound Project (S27). Absent `managedWorkspace` otherwise still means
   * "the authoritative workspace is missing" and fails the launch closed, so
   * the two cases stay distinguishable rather than collapsing into `undefined`.
   */
  workspaceFree?: true;
  runtimePolicy?: TaskRuntimeLaunchPolicy;
  environment?: Readonly<Record<string, string>>;
  mode: "new" | "resume";
  nativeSessionId?: string;
  runId?: string;
}>;

/**
 * Exact launch facts available after planning but before the
 * session host is allowed to create the external Provider process.
 */
export type RuntimeLaunchPreflight = Readonly<{
  owner: RuntimeOwner;
  runId?: string;
  agentId: string;
  adapterId: string;
  effective: EffectiveLaunchSnapshot;
  sessionTitle?: string;
  nativeSessionId?: string;
}>;

export type RuntimeLaunchPreStart = (preflight: RuntimeLaunchPreflight) => void;

/** Prepare a Session and record its native identity before AgentRun delivery. */
export interface RuntimeLaunchPreparationPort {
  /**
   * When supplied, the host must invoke `beforeHostStart` before creating any
   * external Provider process; callers use it to persist the exact AgentRun fence.
   */
  prepare(
    request: RuntimeLaunchPreparationRequest,
    assertCurrent?: () => void,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding>;
}

export type AgentEnvironmentRefresh = Readonly<{
  sources: Readonly<Record<string, string>>;
  sourceNames: readonly string[];
  nativeSources: Readonly<Record<string, string>>;
  nativeNames: readonly string[];
}>;

/** Volatile, non-persisted source values used to resolve configured Agent bindings. */
export interface AgentEnvironmentRefreshPort {
  refreshAgentEnvironment(refresh: AgentEnvironmentRefresh): void;
}

export interface SessionHostPort {
  /** The callback must run after planning but before any Provider process starts. */
  start(
    request: NewSessionLaunchRequest,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding>;
  /** Reattach exactly the requested native Session; never creates a replacement Session. */
  restore(
    request: ResumeSessionLaunchRequest,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding>;
  stop(binding: RuntimeBinding): Promise<void>;
  inspect(binding: RuntimeBinding): Promise<SessionInspection>;
  /** Owner-level probe used to resolve an interrupted pre-binding launch. */
  inspectOwner(owner: RuntimeOwner): Promise<SessionInspection>;
  /** Optional one-snapshot owner inventory for low-frequency reconciliation. */
  inspectOwners?(
    owners: readonly RuntimeOwner[]
  ): Promise<readonly Readonly<{
    owner: RuntimeOwner;
    inspection: SessionInspection;
  }>[]>;
  /**
   * Stop the current host process selected by its domain owner.
   *
   * Returns true only when the owner is confirmed absent after the operation;
   * false means the host could not be inspected or stopped and the durable
   * cleanup obligation must remain queued.
   */
  stopOwner(owner: RuntimeOwner): Promise<boolean>;
}

export type PromptPushResult =
  | "delivered"
  | "pending"
  | "busy"
  | "rejected"
  | "delivery-unknown"
  | "unavailable";

/**
 * A push outcome plus the Host's structured cause when it did not deliver.
 *
 * The bare `PromptPushResult` says only what happened, not why. Callers that
 * persist a failure fact need the original cause, so the port returns both
 * and never forces a consumer to reconstruct a reason from the status alone.
 */
export type PromptPushOutcome = Readonly<{
  result: PromptPushResult;
  failure?: ProviderDeliveryFailure;
}>;

export function promptPushOutcome(
  result: PromptPushResult,
  failure?: ProviderDeliveryFailure
): PromptPushOutcome {
  return Object.freeze({
    result,
    ...(failure === undefined ? {} : { failure })
  });
}

export type ActivePromptPushRequest = Readonly<{
  binding: RuntimeBinding;
  envelope: PromptEnvelope;
}>;

export type ActivePromptSteerRequest = Readonly<{
  /**
   * The exact Session owner. A steer is valid for a Global owner as well as a
   * Task owner, so the port carries the full RuntimeOwner rather than assuming a
   * Task and reconstructing a taskId. A Global steer never invents a taskId or
   * runId to satisfy a Task-shaped call (decision-3 §9).
   */
  owner: RuntimeOwner;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  nativeTurnId: string;
  providerAuthority: ProviderAuthorityFence;
  envelope: PromptEnvelope;
}>;

export interface ActivePromptPushPort {
  tryPush(request: ActivePromptPushRequest): Promise<PromptPushOutcome>;
  trySteer(request: ActivePromptSteerRequest): Promise<PromptPushOutcome>;
}
