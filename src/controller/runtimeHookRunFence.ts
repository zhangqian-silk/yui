import { openCurrentTaskStore } from "../storage/currentTaskStore.js";
import {
  hasRuntimeCleanupObligation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import {
  runtimeObservationFromTaskEvent,
  type RuntimeObservation
} from "../runtime/runtimeObservation.js";
import { formatRunReceiptId } from "../task/taskRecordReference.js";
import { currentProviderConversation, managedProviderTurnId } from "../runtime/providerRuntimeIdentity.js";
import type { TaskEvent } from "../event/taskEvent.js";
import { taskRoleRuntimeIdentity } from "../runtime/managedCaller.js";
import { runPurposeAdmitsTaskState } from "../agentRun/agentRun.js";
import type { TaskStore } from "../storage/taskStore.js";

export class RuntimeHookRunFenceError extends Error {}

export type RuntimeHookRunFence = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  runId?: string;
  receiptId?: string;
  nativeSessionId: string;
  workspace: string;
}>;

export type RuntimeHookRunFenceOptions = Readonly<{
  startupSession?: "preallocated" | "discovered";
  /** Terminal Hooks may arrive after the exact AgentRun has already completed. */
  terminal?: boolean;
  /** Stable Provider Turn identity used to recover its durable accepted AgentRun. */
  nativeTurnId?: string;
  /** Stable input identity used before the Provider has recorded a AgentRun id. */
  attemptId?: string;
  /** Session lifecycle observations remain valid while no AgentRun is active. */
  sessionOnly?: boolean;
  continuationId?: string;
  /** Host facts must never fall back from an unknown old input to the active Run. */
  exactInput?: boolean;
  startupRunId?: string;
}>;

/**
 * Resolve observations by Session and exact input identity. A startup Hook
 * may introduce a Session for an explicit new-Session AgentRun.
 */
export function resolveRuntimeHookRunFence(
  environment: NodeJS.ProcessEnv,
  adapterId: string,
  payloadNativeSessionId: string,
  options: RuntimeHookRunFenceOptions = {},
  currentStore?: TaskStore
): RuntimeHookRunFence {
  if (environment.YUI_SESSION_SCOPE !== "task") {
    throw new RuntimeHookRunFenceError("Runtime observation Hook requires a Task session scope.");
  }
  if (environment.YUI_ADAPTER_ID !== adapterId) {
    throw new RuntimeHookRunFenceError(`Runtime observation Hook requires the ${adapterId} adapter.`);
  }
  if (currentStore === undefined) {
    const store = openCurrentTaskStore(requireIdentity(environment.YUI_HOME, "YUI_HOME"));
    try { return resolveRuntimeHookRunFence(environment, adapterId, payloadNativeSessionId, options, store); }
    finally { store.close(); }
  }
  const taskId = requireIdentity(environment.YUI_TASK_ID, "Task id");
  const roleName = requireIdentity(environment.YUI_ROLE, "Role name");
  const agentId = requireIdentity(environment.YUI_AGENT_ID, "Agent id");
  const workspace = requireIdentity(environment.YUI_WORKSPACE, "YUI workspace");
  const nativeSessionId = requireIdentity(payloadNativeSessionId, "Provider session id");

  const store = currentStore;
  const task = store.getTask(taskId);
  if (task === null) {
    throw new RuntimeHookRunFenceError("Runtime observation Hook Task does not accept this lifecycle boundary.");
  }
  const role = store.getRole(taskId, roleName);
  const sessions = store.getTaskRoleSessionSet(taskId, roleName);
  const session = sessions?.sessions[agentId];
  const executionSession = session?.nativeSessionId === nativeSessionId
    ? session
    : sessions?.history?.find((entry) => (
        entry.agentId === agentId && entry.nativeSessionId === nativeSessionId
      ));
  const activeRun = store.getActiveRun(taskId, roleName);
  const providerTurn = sessions?.providerBinding?.run;
  const matchesProviderTurn = providerTurn !== null
    && providerTurn !== undefined
    && providerTurn.status !== "rejected" && providerTurn.status !== "deferred"
    && executionSession?.adapterId === adapterId
    && executionSession.effective.workspace.root === workspace
    && sessions?.providerBinding != null
    && currentProviderConversation(sessions.providerBinding).conversationId === nativeSessionId
    && (
      (options.attemptId !== undefined && providerTurn.attemptId === options.attemptId)
      || (options.nativeTurnId !== undefined && providerTurn.nativeTurnId === options.nativeTurnId)
    )
    && (options.attemptId === undefined || providerTurn.attemptId === options.attemptId)
    && (options.nativeTurnId === undefined || providerTurn.nativeTurnId === undefined
      || providerTurn.nativeTurnId === options.nativeTurnId);
  const acceptedRun = acceptedRunBinding(store.listEvents(taskId), {
    taskId, roleName, agentId, nativeSessionId,
    ...(options.nativeTurnId === undefined ? {} : { nativeTurnId: options.nativeTurnId }),
    ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId })
  });
  const acceptedBinding = acceptedRun ?? (
    options.continuationId === undefined ? null : knownContinuationBinding(
      store.listEvents(taskId),
      {
        taskId, roleName, agentId, nativeSessionId,
        continuationId: options.continuationId,
      }
    )
  );
  if (options.exactInput && acceptedBinding === null && !matchesProviderTurn) {
    throw new RuntimeHookRunFenceError("Runtime observation Hook input has no exact accepted execution binding.");
  }
  if (options.startupRunId !== undefined && options.startupRunId !== activeRun?.id) {
    // A historical Session can report terminal evidence, but its old startup
    // must not bind a new Session under a successor's active Run.
    throw new RuntimeHookRunFenceError("Runtime observation Hook startup does not match its exact launch Run.");
  }
  // Collection of an exactly accepted terminal fact is not a new action by
  // the Role. A successor's active Agent or revoked execution permission
  // cannot erase the original AgentRun's evidence.
  const existingExecutionObservation = (options.terminal === true || options.attemptId !== undefined)
    && (acceptedBinding !== null || matchesProviderTurn);
  // A Draft's planning Turn runs before activation by design, so it never has an
  // active execution lifecycle to admit it here. Admission is delegated to the
  // one shared invariant that already pairs a Turn purpose with a Task state, so
  // a Draft still cannot produce execution observations while the planning
  // conversation can report its own runtime.
  const planningObservation = activeRun !== null
    && activeRun.purpose === "planning"
    && activeRun.roleName === roleName
    && runPurposeAdmitsTaskState(activeRun.purpose, task);
  if (!(task.status === "active" && task.executionGate.state === "enabled")
    && !(task.status === "completed" && options.sessionOnly === true)
    && !planningObservation
    && !existingExecutionObservation) {
    throw new RuntimeHookRunFenceError("Runtime observation Hook Task does not accept this lifecycle boundary.");
  }
  const runtimeIdentity = role === null ? null : taskRoleRuntimeIdentity(role, activeRun);
  if (!existingExecutionObservation && (runtimeIdentity === null || runtimeIdentity.agentId !== agentId
    || runtimeIdentity.adapterId !== adapterId
    || (sessions !== null && sessions.activeAgentId !== agentId))) {
    throw new RuntimeHookRunFenceError("Runtime observation Hook Role or Agent is not current.");
  }
  const lifecycleMailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId,
    roleName
  }));
  const directProviderTurn = matchesProviderTurn && providerTurn.runId === undefined;
  const sessionOnlyObservation = options.sessionOnly === true
    || (options.startupSession === undefined && options.terminal !== true
      && acceptedBinding === null && !matchesProviderTurn);
  if (acceptedBinding === null && (directProviderTurn || sessionOnlyObservation)) {
    const observedSession = directProviderTurn ? executionSession : session;
    if (observedSession === undefined
      || observedSession.adapterId !== adapterId
      || observedSession.nativeSessionId !== nativeSessionId
      || observedSession.effective.workspace.root !== workspace) {
      throw new RuntimeHookRunFenceError("Runtime observation Hook Session does not match durable state.");
    }
    return {
      taskId,
      roleName,
      agentId,
      ...(directProviderTurn ? { receiptId: providerTurn.attemptId } : {}),
      nativeSessionId,
      workspace
    };
  }
  const inputReceiptId = matchesProviderTurn
    ? providerTurn.attemptId
    : providerTurn !== null
    && providerTurn !== undefined
    && managedProviderTurnId(providerTurn) === activeRun?.id
    ? providerTurn.attemptId
    : activeRun === null ? undefined : formatRunReceiptId(taskId, activeRun.id);
  const startupRunId = options.startupSession === undefined ? undefined : activeRun?.id;
  const startupIntent = startupRunId !== undefined
    && !hasRuntimeCleanupObligation(lifecycleMailbox);
  const startupRun = startupRunId === undefined
    ? null
    : store.getRun(taskId, startupRunId);
  const replacementStartup = options.startupSession !== undefined
    && session !== undefined
    && sessions !== null
    && startupIntent
    && startupRun?.mode === "new"
    && session.status === "ended";
  const resumedStartup = startupIntent
    && startupRun?.mode === "resume"
    && session !== undefined
    && session.adapterId === adapterId
    && session.nativeSessionId === nativeSessionId
    && session.effective.workspace.root === workspace;
  // New Session identity is provided by the native adapter, not a launch token.
  const preallocatedStartup = options.startupSession === "preallocated"
    && (session === undefined || replacementStartup)
    && startupIntent
    && startupRun?.mode === "new";
  const discoveredStartup = options.startupSession === "discovered"
    && (session === undefined || replacementStartup)
    && startupIntent
    && startupRun?.mode === "new";
  const registeredRunId = acceptedBinding === null && matchesProviderTurn
    ? managedProviderTurnId(providerTurn) ?? undefined
    : undefined;
  if (options.terminal === true && acceptedBinding === null && registeredRunId === undefined) {
    throw new RuntimeHookRunFenceError("Runtime observation Hook terminal has no exact accepted execution binding.");
  }
  const terminalRun = acceptedBinding !== null
    ? store.getRun(taskId, acceptedBinding.fence.runId!)
    : registeredRunId === undefined
    ? null
    : store.getRun(taskId, registeredRunId);
  const exactTerminal = terminalRun !== null
    && terminalRun.status !== "active"
    && terminalRun.roleName === roleName
    && terminalRun.effective.agentId === agentId
    && terminalRun.effective.adapterId === adapterId
    && session !== undefined;
  if (activeRun === null
    && !preallocatedStartup
    && !discoveredStartup
    && !resumedStartup
    && !exactTerminal
    && registeredRunId === undefined
    && acceptedBinding === null) {
    throw new RuntimeHookRunFenceError("Runtime observation Hook has no matching durable in-flight AgentRun.");
  }
  const runId = acceptedBinding?.fence.runId
    ?? registeredRunId
    ?? activeRun?.id
    ?? startupRunId;
  const run = acceptedBinding !== null || registeredRunId !== undefined
    ? terminalRun
    : store.getActiveRun(taskId, roleName);
  if (run === null
    || run.id !== runId
    || (acceptedBinding === null && registeredRunId === undefined && !exactTerminal && run.status !== "active")
    || run.roleName !== roleName
    || run.effective.agentId !== agentId
    || run.effective.adapterId !== adapterId) {
    throw new RuntimeHookRunFenceError("Runtime observation Hook AgentRun does not match durable active state.");
  }
  if (run.effective.workspace.root !== workspace) {
    throw new RuntimeHookRunFenceError("Runtime observation Hook workspace does not match the durable AgentRun snapshot.");
  }
  if (session !== undefined && acceptedBinding === null && !matchesProviderTurn && !replacementStartup && !resumedStartup) {
    if (session.adapterId !== adapterId
      || session.nativeSessionId !== nativeSessionId
      || session.effective.workspace.root !== workspace) {
      throw new RuntimeHookRunFenceError("Runtime observation Hook Session does not match durable state.");
    }
  } else if (acceptedBinding === null && !matchesProviderTurn && (session === undefined || replacementStartup)) {
    if (!discoveredStartup && !preallocatedStartup) {
      throw new RuntimeHookRunFenceError("Runtime observation Hook has no matching new-Session intent.");
    }
  }
  return {
    taskId,
    roleName,
    agentId,
    runId,
    ...(acceptedBinding?.fence.receiptId === undefined
      ? inputReceiptId === undefined ? {} : { receiptId: inputReceiptId }
      : { receiptId: acceptedBinding.fence.receiptId }),
    nativeSessionId,
    workspace
  };
}

function knownContinuationBinding(
  events: readonly TaskEvent[],
  expected: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    nativeSessionId: string;
    continuationId: string;
  }>
): RuntimeObservation | null {
  const matches = events
    .map(runtimeObservationFromTaskEvent)
    .filter((observation): observation is RuntimeObservation => observation !== null
      && observation.kind.startsWith("continuation.")
      && observation.fence.taskId === expected.taskId
      && observation.fence.roleName === expected.roleName
      && observation.fence.agentId === expected.agentId
      && observation.fence.nativeSessionId === expected.nativeSessionId
      && observation.fence.continuationId === expected.continuationId
      && observation.fence.runId !== undefined)
    .sort((left, right) => (
      left.receivedAt.localeCompare(right.receivedAt)
      || (left.sequence ?? -1) - (right.sequence ?? -1)
      || (left.ordinal ?? -1) - (right.ordinal ?? -1)
      || left.eventId.localeCompare(right.eventId)
    ));
  const binding = matches.at(-1) ?? null;
  if (binding === null) return null;
  if (matches.some((candidate) => candidate.fence.runId !== binding.fence.runId
    || candidate.fence.receiptId !== binding.fence.receiptId)) {
    throw new RuntimeHookRunFenceError("Runtime observation Hook continuation has conflicting durable AgentRun bindings.");
  }
  return binding;
}

function acceptedRunBinding(
  events: readonly TaskEvent[],
  expected: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    nativeSessionId: string;
    nativeTurnId?: string;
    attemptId?: string;
  }>
): RuntimeObservation | null {
  if (expected.nativeTurnId === undefined && expected.attemptId === undefined) return null;
  const matches = events
    .map(runtimeObservationFromTaskEvent)
    .filter((observation): observation is RuntimeObservation => observation !== null
      && ["turn.accepted", "turn.completed", "turn.failed", "turn.cancelled"].includes(observation.kind)
      && observation.fence.taskId === expected.taskId
      && observation.fence.roleName === expected.roleName
      && observation.fence.agentId === expected.agentId
      && observation.fence.nativeSessionId === expected.nativeSessionId
      && (
        (expected.attemptId !== undefined && observation.fence.receiptId === expected.attemptId)
        || (expected.nativeTurnId !== undefined && observation.fence.nativeTurnId === expected.nativeTurnId)
      )
      && observation.fence.runId !== undefined)
    .sort((left, right) => (
      left.receivedAt.localeCompare(right.receivedAt)
      || (left.sequence ?? -1) - (right.sequence ?? -1)
      || (left.ordinal ?? -1) - (right.ordinal ?? -1)
      || left.eventId.localeCompare(right.eventId)
    ));
  const binding = matches.at(-1) ?? null;
  if (binding === null) return null;
  if (matches.some((candidate) => (
    (expected.attemptId !== undefined && candidate.fence.receiptId !== expected.attemptId)
    || (expected.nativeTurnId !== undefined && candidate.fence.nativeTurnId !== undefined
      && candidate.fence.nativeTurnId !== expected.nativeTurnId)
    || candidate.fence.runId !== binding.fence.runId
    || candidate.fence.receiptId !== binding.fence.receiptId))) {
    throw new RuntimeHookRunFenceError("Runtime observation Hook native Turn has conflicting durable AgentRun bindings.");
  }
  return binding;
}

function requireIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new RuntimeHookRunFenceError(`${label} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new RuntimeHookRunFenceError(`${label} is invalid.`);
  }
  return normalized;
}
