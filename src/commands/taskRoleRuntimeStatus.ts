import { isDeepStrictEqual } from "node:util";

import type { RoleAgentSession } from "../executor/agentExecutor.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import { runExecutionObservation, type AgentRun } from "../agentRun/agentRun.js";
import type { TaskRole } from "../role/role.js";
import {
  hasRuntimeCleanupObligation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { TmuxRolePaneState } from "../tmux/tmuxManager.js";
import type { WorkItem } from "../workItem/workItem.js";
import { currentProviderConversation, managedProviderTurnId, type ProviderTurnStatus } from "../runtime/providerRuntimeIdentity.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import {
  isRoleRunStalled,
  latestStallProgressAt
} from "../scheduler/roleRunStall.js";
import {
  createRuntimeObservation,
  runtimeObservationFromTaskEvent,
  type RuntimeObservation,
  type RuntimeUsageSnapshot
} from "../runtime/runtimeObservation.js";
import {
  classifyRuntimeHealth,
  projectRuntimeObservation,
  projectRuntimeTaskEvents,
  runtimeDisplayStatus,
  type RuntimeHealthLayer,
  type RuntimeDisplayStatus
} from "../runtime/runtimeProjection.js";
import { latestRunDurableProgressAt } from "../scheduler/roleRunStall.js";
import { resolveRuntimeHealth } from "../config/yuiConfig.js";
import { builtinDriverIdForAdapter } from "../runtime/builtinAgentDrivers.js";
import { formatRunReceiptId } from "../task/taskRecordReference.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";
import type { AgentHostSnapshot } from "../runtime/agentHost.js";
import {
  projectSessionTokenMetrics,
  resolveSessionTokenIdentity,
  type SessionTokenMetrics
} from "../runtime/sessionTokenMetrics.js";

export type TaskRoleHealth =
  | "idle"
  | "starting"
  | "awaiting-provider-acceptance"
  | "running"
  | "ready"
  | "waiting"
  | "blocked-input"
  | "needs-attention"
  | "failed";

export type TaskRoleTmuxStatus = Readonly<{
  state: "missing" | "running" | "exited";
  target?: string;
  dead?: boolean;
  pid?: number;
  currentCommand?: string;
}>;

export type TaskRoleWorkspaceStatus =
  | Readonly<{ managed: false; path: string }>
  | Readonly<{ managed: true } & ManagedWorkspace>;

export type TaskRoleSessionRecoveryStatus = Readonly<{
  taskId: string;
  roleName: string;
  runtimeCleanupPending: boolean;
}>;

export type TaskRoleRuntimeStatus = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  desiredRevision: number;
  effectiveLaunch: EffectiveLaunchSnapshot | null;
  launchDrift: boolean;
  runSessionDrift: boolean;
  health: TaskRoleHealth;
  healthReason: string;
  host?: TaskRoleHostObservation;
  openInputRequestCount: number;
  role: TaskRole;
  activeRun: AgentRun | null;
  execution?: ReturnType<typeof runExecutionObservation>;
  /**
   * Issue 09: the most recently updated AgentRun for this Role, regardless of
   * status. Lets the status display both axes — the last AgentRun outcome and the
   * current/last Session lifecycle — so a Session that stops after a AgentRun
   * completed is never read back as a AgentRun failure.
   */
  lastRun: AgentRun | null;
  activeWork: WorkItem | null;
  nativeSession: RoleAgentSession | null;
  runtimeCleanupPending: boolean;
  tmux: TaskRoleTmuxStatus;
  workspace: TaskRoleWorkspaceStatus;
  sessionTokens: SessionTokenMetrics;
  runtime: Readonly<{
    driverId: string;
    status: RuntimeDisplayStatus;
    healthLayer: RuntimeHealthLayer;
    healthReason: string;
    lastActivityAt?: string;
    lastSemanticProgressAt: string;
    activeOperations: readonly string[];
    waitingReason?: "user" | "permission" | "external";
    usage?: RuntimeUsageSnapshot;
    observerStatus?: "healthy" | "degraded" | "unavailable";
    observerDetail?: string;
  }> | null;
  stall: Readonly<{
    active: boolean;
    progressAt?: string;
    kind?: "delivery-stalled" | "workflow-not-progressing";
  }>;
}>;

export type TaskRoleHostObservation = Readonly<{
  snapshot?: AgentHostSnapshot;
  detail?: string;
}>;

export function taskRoleHostDiagnostic(host: TaskRoleHostObservation): string {
  const snapshot = host.snapshot;
  if (snapshot === undefined) return `unavailable: ${host.detail ?? "Host could not be read"}`;
  const delivery = snapshot.eventDelivery;
  return [
    `Provider Host=${snapshot.state}`,
    delivery === undefined ? "event delivery=unreported (legacy Host)" :
      `pending facts=${delivery.pending}; native terminals awaiting acknowledgement=${delivery.pendingTerminals}`,
    delivery?.failure === undefined ? undefined :
      `reporting failure (${delivery.failure.stage}, ${delivery.failure.observedAt}): ${delivery.failure.detail}`,
    snapshot.detail
  ].filter(Boolean).join("; ");
}

/** Overlay live reporting evidence without rewriting Run/Provider/business truth. */
export function withTaskRoleHostObservation(
  status: TaskRoleRuntimeStatus, host?: TaskRoleHostObservation
): TaskRoleRuntimeStatus {
  if (host === undefined) return status;
  const snapshot = host.snapshot;
  if (snapshot !== undefined && (snapshot.nativeSessionId !== status.nativeSession?.nativeSessionId
    || snapshot.adapterId !== status.nativeSession?.adapterId)) {
    return { ...status, host: { detail: "Host does not match the recorded native Session." } };
  }
  const reportingNeedsAttention = snapshot !== undefined && (
    snapshot.state === "failed" || snapshot.state === "exited"
    || snapshot.eventDelivery?.failure !== undefined
    || (snapshot.eventDelivery?.pendingTerminals ?? 0) > 0
  );
  return {
    ...status, host,
    ...(reportingNeedsAttention ? {
      health: "needs-attention" as const,
      healthReason: `${taskRoleHostDiagnostic(host)}. Formal Run status and business acceptance are unchanged.`
    } : {})
  };
}

export function inspectTaskRoleRuntimeStatuses(
  taskId: string,
  roles: readonly TaskRole[],
  store: TaskStore,
  panes: readonly TmuxRolePaneState[],
  now = new Date()
): TaskRoleRuntimeStatus[] {
  const taskOpenInputRequestCount = store.listInputRequests(taskId)
    .filter((request) => request.status === "open").length;
  const panesByRole = new Map<string, TmuxRolePaneState>();
  for (const pane of panes) {
    const current = panesByRole.get(pane.roleName);
    if (current === undefined || current.dead && !pane.dead) panesByRole.set(pane.roleName, pane);
  }
  return roles.map((role) => inspectTaskRoleRuntimeStatus(
    taskId,
    role,
    store,
    panesByRole.get(role.name),
    role.name === "leader" ? taskOpenInputRequestCount : 0,
    now
  ));
}

export function renderTaskRoleRuntimeStatus(status: TaskRoleRuntimeStatus): string {
  const activeRun = status.activeRun === null
    ? "-"
    : `${status.activeRun.id} (${status.execution?.delivery ?? "unobserved"})`;
  const lastRun = status.activeRun !== null || status.lastRun === null
    ? undefined
    : `${status.lastRun.id} (${status.lastRun.status}${
      status.lastRun.result === undefined ? "" : ` at ${status.lastRun.result.completedAt}`
    })`;
  const activeWork = status.activeWork === null
    ? "-"
    : `${status.activeWork.id} (${status.activeWork.status}) ${status.activeWork.title}`;
  // Both lines name the execution component, as the Role view does. The
  // connection plan cannot stand in for it here either: two different ACP
  // products would print identically, and this display exists to say what is
  // actually running.
  const nativeSession = status.nativeSession === null
    ? "not recorded"
    : `${status.nativeSession.nativeSessionId} (${status.nativeSession.status}, ${
      status.nativeSession.effective.component
    }, effective r${status.nativeSession.effective.sourceDesiredRevision})`;
  const effectiveLaunch = status.effectiveLaunch === null
    ? "not started"
    : `${status.effectiveLaunch.agentId}/${status.effectiveLaunch.component}; r${status.effectiveLaunch.sourceDesiredRevision}; Profile intent=${status.effectiveLaunch.profileAccess}; permission=${status.effectiveLaunch.permission.strategy}`;
  const tmux = status.tmux.state === "missing"
    ? "missing"
    : [
        status.tmux.state,
        status.tmux.currentCommand === undefined ? undefined : `command=${status.tmux.currentCommand}`,
        status.tmux.pid === undefined ? undefined : `pid=${status.tmux.pid}`,
        status.tmux.target
      ].filter((value): value is string => value !== undefined).join(", ");
  const workspaceDetails = status.workspace.managed
    ? status.workspace.entries.map((entry) => (
        `  Project          ${entry.directory} (${entry.access}) ${entry.branch} @ ${
          entry.baseCommit
        }`
      ))
    : [];
  const runtime = status.runtime === null
    ? "not observable"
    : [
        `${status.runtime.driverId}: ${status.runtime.status}`,
        `health=${status.runtime.healthLayer}`,
        `health reason=${status.runtime.healthReason}`,
        status.runtime.lastActivityAt === undefined
          ? undefined
          : `last activity=${status.runtime.lastActivityAt}`,
        `last semantic progress=${status.runtime.lastSemanticProgressAt}`,
        status.runtime.activeOperations.length === 0
          ? undefined
          : `operations=${status.runtime.activeOperations.join(",")}`,
        status.runtime.observerStatus === undefined
          ? undefined
          : `observer=${status.runtime.observerStatus}${
              status.runtime.observerDetail === undefined
                ? ""
                : ` (${status.runtime.observerDetail})`
            }`
      ].filter((value): value is string => value !== undefined).join("; ");
  const sessionTokens = [
    `total=${sessionCumulativeTokenLabel(status.sessionTokens)}`,
    `max-request-input=${status.sessionTokens.maximumRequestInput.status === "observed"
      ? status.sessionTokens.maximumRequestInput.inputTokens
      : "unobserved"}`
  ].join("; ");
  return [
    `Task Role status: ${status.taskId}/${status.roleName}`,
    "",
    `  Health           ${status.health}`,
    `  Reason           ${status.healthReason}`,
    `  Open inputs      ${status.openInputRequestCount}`,
    `  Agent            ${status.agentId}`,
    `  Desired launch   r${status.desiredRevision}; Profile intent=${status.role.defaultAccess}`,
    `  Effective launch ${effectiveLaunch}`,
    `  Desired drift    ${status.effectiveLaunch === null
      ? "-"
      : status.launchDrift ? "pending next launch" : "none"}`,
    `  AgentRun/session     ${status.runSessionDrift ? "snapshot mismatch" : "snapshot consistent"}`,
    `  Active work      ${activeWork}`,
    `  Active run       ${activeRun}`,
    ...(lastRun === undefined ? [] : [`  Last turn        ${lastRun}`]),
    `  AgentRun attention   ${status.stall.active
      ? `needs-attention (${status.stall.kind ?? "workflow-not-progressing"}; no workflow progress since ${status.stall.progressAt ?? "unknown"})`
      : "none"}`,
    `  Native session   ${nativeSession}`,
    `  AgentRuntime    ${runtime}`,
    ...(status.host === undefined ? [] : [`  Host reporting   ${taskRoleHostDiagnostic(status.host)}`]),
    `  Session tokens   ${sessionTokens}`,
    `  Runtime cleanup  ${status.runtimeCleanupPending ? "pending" : "none"}`,
    `  tmux pane        ${tmux}`,
    `  Workspace        ${
      status.workspace.managed ? status.workspace.root : status.workspace.path
    }`,
    ...workspaceDetails
  ].join("\n").concat("\n");
}

export function taskRoleActiveWorkLabel(status: TaskRoleRuntimeStatus): string {
  if (status.activeWork !== null) return `${status.activeWork.id}: ${status.activeWork.title}`;
  return status.activeRun === null ? "-" : status.activeRun.id;
}

/** Issue 09: compact last-AgentRun outcome label for the Role list table. */
export function taskRoleLastRunLabel(status: TaskRoleRuntimeStatus): string {
  if (status.activeRun !== null) return `${status.activeRun.id} ${status.activeRun.status}`;
  if (status.lastRun === null) return "-";
  return `${status.lastRun.id} ${status.lastRun.status}`;
}

export function taskRoleNativeSessionLabel(status: TaskRoleRuntimeStatus): string {
  if (status.runtimeCleanupPending && status.nativeSession === null) return "unbound (cleanup-pending)";
  return status.nativeSession?.status ?? "unbound";
}

export function inspectTaskRoleSessionRecovery(
  taskId: string,
  roleName: string,
  store: TaskStore
): TaskRoleSessionRecoveryStatus {
  const target = runtimeLifecycleTarget({ scope: "task", taskId, roleName });
  const runtimeMailbox = store.getWorkMailbox(target);
  return {
    taskId,
    roleName,
    runtimeCleanupPending: hasRuntimeCleanupObligation(runtimeMailbox)
  };
}

export function taskRoleOpenInputLabel(status: TaskRoleRuntimeStatus): string {
  return status.roleName === "leader" && status.openInputRequestCount > 0
    ? String(status.openInputRequestCount)
    : "-";
}

export function taskRoleTmuxLabel(status: TaskRoleRuntimeStatus): string {
  if (status.tmux.state !== "running") return status.tmux.state;
  return status.tmux.currentCommand === undefined
    ? "running"
    : `running (${status.tmux.currentCommand})`;
}

function inspectTaskRoleRuntimeStatus(
  taskId: string,
  role: TaskRole,
  store: TaskStore,
  pane: TmuxRolePaneState | undefined,
  openInputRequestCount: number,
  now: Date
): TaskRoleRuntimeStatus {
  const activeRun = store.getActiveRun(taskId, role.name);
  // The last AgentRun outcome is a separate axis from the Session lifecycle. A
  // Session that stops after its AgentRun completed must not retroactively turn
  // that AgentRun into a failure; the status display keeps both visible.
  const lastRun = operationalTaskRecords(
    store.listRuns(taskId),
    store.listEvents(taskId),
    "run"
  )
    .filter((candidate) => candidate.roleName === role.name)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
    ?? null;
  const activeWork = activeRun?.workItemId === undefined
    ? null
    : store.getWorkItem(taskId, activeRun.workItemId);
  const sessions = store.getTaskRoleSessionSet(taskId, role.name);
  const effectiveAgentId = activeRun?.effective.agentId ?? sessions?.activeAgentId;
  const nativeSession = effectiveAgentId === undefined
    ? null
    : sessions?.sessions[effectiveAgentId] ?? null;
  const effectiveLaunch = activeRun?.effective ?? nativeSession?.effective ?? null;
  const runSessionDrift = activeRun !== null
    && nativeSession !== null
    && !isDeepStrictEqual(activeRun.effective, nativeSession.effective);
  const recovery = inspectTaskRoleSessionRecovery(taskId, role.name, store);
  const tmux: TaskRoleTmuxStatus = pane === undefined
    ? { state: "missing" }
    : {
        state: pane.dead ? "exited" : "running",
        target: pane.target,
        dead: pane.dead,
        ...(pane.pid === undefined ? {} : { pid: pane.pid }),
        currentCommand: pane.currentCommand
      };
  // The active AgentRun snapshot is authoritative for the live Role session. It
  // may point at a ReviewRound-owned workspace, which is intentionally
  // distinct from the WorkItem Develop workspace.
  const actualWorkspaceRoot = effectiveLaunch?.workspace.root ?? role.workspace;
  const managedWorkspace = activeRun?.workspace
    ?? store.listManagedWorkspaces(taskId).find(({ root }) => root === actualWorkspaceRoot)
    ?? null;
  const workspace: TaskRoleWorkspaceStatus = managedWorkspace === null
    ? { managed: false, path: actualWorkspaceRoot }
    : { ...managedWorkspace, managed: true };
  const events = store.listEvents(taskId);
  const sessionTokens = projectSessionTokenMetrics(
    events,
    resolveSessionTokenIdentity(nativeSession === null
      ? null
      : { taskId, roleName: role.name, ...nativeSession })
  );
  const runtime = projectTaskRoleRuntime(
    activeRun,
    nativeSession,
    tmux,
    events,
    store.getWorkMailbox({ kind: "role", taskId, roleName: role.name }),
    store,
    taskId,
    role.name,
    now
  );
  const stalled = activeRun !== null && isRoleRunStalled(events, activeRun.id);
  const stallProgressAt = activeRun === null
    ? undefined
    : latestStallProgressAt(events, activeRun.id);
  const stallKind = activeRun === null
    ? undefined
    : latestStallKind(events, activeRun.id);
  const execution = activeRun === null ? undefined
    : runExecutionObservation(activeRun, sessions?.providerBinding, events);
  const conversation = sessions?.providerBinding == null
    ? undefined : currentProviderConversation(sessions.providerBinding);
  const currentProvider = nativeSession !== null
    && conversation?.conversationId === nativeSession.nativeSessionId
    ? sessions?.providerBinding : undefined;
  const computedHealth = calculateHealth(
    role,
    activeRun,
    lastRun,
    nativeSession,
    recovery.runtimeCleanupPending,
    tmux,
    openInputRequestCount,
    stalled,
    runtime,
    currentProvider?.run?.status,
    currentProvider != null && conversation?.recoverability === "unrecoverable"
  );
  const retainedInput = sessions?.providerBinding?.run;
  const health = nativeSession === null && retainedInput != null
    && ["submitting", "accepted", "delivery-unknown"].includes(retainedInput.status)
    ? { health: "needs-attention" as const,
        healthReason: `Session cache is unbound; retained native input is ${retainedInput.status}. Inspect or replace this Role's Session.` }
    : execution !== undefined && computedHealth.health === "running" && execution.delivery !== "accepted"
    ? { health: execution?.delivery === "delivery-unknown" ? "needs-attention" as const : "awaiting-provider-acceptance" as const,
        healthReason: `Execution record is open; native admission is ${execution?.delivery ?? "unobserved"}.` }
    : computedHealth;
  const stall = activeRun === null
    ? { active: false }
    : {
        active: stalled,
        ...(stallProgressAt === undefined
          ? {}
          : { progressAt: stallProgressAt }),
        ...(stallKind === undefined ? {} : { kind: stallKind })
      };
  return {
    ...recovery,
    agentId: effectiveLaunch?.agentId ?? role.activeAgentId,
    desiredRevision: role.launchRevision,
    effectiveLaunch,
    launchDrift: effectiveLaunch !== null
      && effectiveLaunch.sourceDesiredRevision !== role.launchRevision,
    runSessionDrift,
    ...health,
    openInputRequestCount,
    role,
    activeRun,
    lastRun,
    activeWork,
    ...(execution === undefined ? {} : { execution }),
    nativeSession,
    tmux,
    workspace,
    sessionTokens,
    runtime,
    stall
  };
}

function sessionCumulativeTokenLabel(metrics: SessionTokenMetrics): string {
  const total = metrics.cumulativeTotal;
  if (total.status === "unobserved") return "unobserved";
  const breakdown = [
    `input=${total.inputTokens}`,
    `output=${total.outputTokens}`,
    ...(total.cachedInputTokens === undefined ? [] : [`cached-input=${total.cachedInputTokens}`]),
    ...(total.reasoningTokens === undefined ? [] : [`reasoning=${total.reasoningTokens}`])
  ];
  return `${total.totalTokens} (${breakdown.join(", ")})`;
}

function latestStallKind(
  events: ReturnType<TaskStore["listEvents"]>,
  runId: string
): "delivery-stalled" | "workflow-not-progressing" | undefined {
  const event = [...events]
    .filter((candidate) => candidate.type === "run.stalled"
      && candidate.payload.runId === runId
      && candidate.payload.status !== "diagnostic-only")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  return event?.payload.kind === "delivery-stalled" || event?.payload.kind === "workflow-not-progressing"
    ? event.payload.kind
    : undefined;
}

function calculateHealth(
  role: TaskRole,
  activeRun: AgentRun | null,
  lastRun: AgentRun | null,
  nativeSession: RoleAgentSession | null,
  runtimeCleanupPending: boolean,
  tmux: TaskRoleTmuxStatus,
  openInputRequestCount: number,
  stalled: boolean,
  runtime: TaskRoleRuntimeStatus["runtime"],
  nativeInputStatus?: ProviderTurnStatus,
  nativeConversationUnrecoverable = false
): Pick<TaskRoleRuntimeStatus, "health" | "healthReason"> {
  if (runtimeCleanupPending && nativeSession === null) {
    return {
      health: "needs-attention",
      healthReason: "the native Session is unbound; verified runtime cleanup is pending"
    };
  }
  if (nativeSession?.status === "ended" && nativeSession.endReason === "failed") {
    // A broken Session only fails a live AgentRun. When the last AgentRun already
    // completed, the Session death is a lifecycle event, not a AgentRun failure —
    // surface it as attention with the persisted AgentRun outcome.
    if (activeRun !== null) {
      return { health: "failed", healthReason: "the active native session is broken" };
    }
    return {
      health: "needs-attention",
      healthReason: lastRun === null
        ? "the native session is broken"
        : `the native session is broken; last AgentRun ${lastRun.id} ${lastRun.status}`
    };
  }
  if (tmux.state === "exited") {
    if (nativeSession?.status === "ended" && nativeSession.endReason === "stopped"
      && activeRun === null && !runtimeCleanupPending
      && !["submitting", "accepted", "delivery-unknown"].includes(nativeInputStatus ?? "")) {
      return role.name === "leader" && openInputRequestCount > 0
        ? { health: "blocked-input", healthReason: `${openInputRequestCount} durable InputRequest(s) still require user input` }
        : { health: "idle", healthReason: "the Session was deliberately stopped; no native input remains unsettled" };
    }
    return {
      health: "needs-attention",
      healthReason: "the tmux pane exited; Provider Conversation/continuation state is unobservable"
    };
  }
  if (activeRun !== null) {
    if (tmux.state !== "running") {
      return { health: "needs-attention", healthReason: "the active AgentRun has no live tmux pane" };
    }
    if (stalled) {
      return {
        health: "needs-attention",
        healthReason: "the live active AgentRun has no durable progress in the configured stall window"
      };
    }
    if (runtime !== null) {
      switch (runtime.healthLayer) {
        case "broken":
          return { health: "failed", healthReason: runtime.healthReason };
        case "stopped":
        case "ready":
        case "awaiting-provider-acceptance":
        case "runtime-unobservable":
        case "starting":
          return { health: "needs-attention", healthReason: runtime.healthReason };
        case "diagnostic-needed":
          return runtime.observerStatus === "degraded" || runtime.observerStatus === "unavailable"
            ? { health: "needs-attention", healthReason: runtime.healthReason }
            : { health: "running", healthReason: runtime.healthReason };
        case "waiting-user":
          return { health: "blocked-input", healthReason: runtime.healthReason };
        case "waiting-permission":
        case "waiting-external":
          return { health: "waiting", healthReason: runtime.healthReason };
        case "quiet":
        case "active-quiet":
        case "model-active":
        case "tool-active":
        case "subagent-active":
        default:
          // Short silence is a hint, not a failure. Only deterministic
          // dead/broken evidence or the durable stall window escalates.
          return { health: "running", healthReason: runtime.healthReason };
      }
    }
    return {
      health: "starting",
      healthReason: "the active AgentRun is awaiting Provider runtime observations"
    };
  }
  if (nativeSession?.status === "active" && tmux.state !== "running") {
    return { health: "needs-attention", healthReason: "the native session is running without a live tmux pane" };
  }
  if (nativeSession?.status === "ended" && tmux.state === "running") {
    return { health: "needs-attention", healthReason: "a stopped native session has a live tmux pane" };
  }
  if (nativeSession?.status === "active" && tmux.state === "running") {
    if (nativeConversationUnrecoverable) {
      return { health: "needs-attention", healthReason: "the native conversation cannot resume; stop its idle Session and explicitly select a new one" };
    }
    if (nativeInputStatus === "submitting") {
      return { health: "awaiting-provider-acceptance", healthReason: "native input is submitting; no AgentRun is required for a notification" };
    }
    if (nativeInputStatus === "accepted") {
      return { health: "running", healthReason: "accepted native input is awaiting its terminal, independently of AgentRun records" };
    }
    if (nativeInputStatus === "delivery-unknown") {
      return { health: "needs-attention", healthReason: "native input disposition is unknown; absence of an AgentRun does not prove idle" };
    }
  }
  if (role.name === "leader" && openInputRequestCount > 0) {
    return {
      health: "blocked-input",
      healthReason: `${openInputRequestCount} open InputRequest${openInputRequestCount === 1 ? "" : "s"} require user input`
    };
  }
  return tmux.state === "running"
    ? { health: "ready", healthReason: "the native Agent pane is ready without active work" }
    : { health: "idle", healthReason: "there is no active work or live tmux pane" };
}

function projectTaskRoleRuntime(
  run: AgentRun | null,
  session: RoleAgentSession | null,
  tmux: TaskRoleTmuxStatus,
  events: ReturnType<TaskStore["listEvents"]>,
  _mailbox: ReturnType<TaskStore["getWorkMailbox"]>,
  store: TaskStore,
  taskId: string,
  roleName: string,
  now: Date
): TaskRoleRuntimeStatus["runtime"] {
  if (session === null) return null;
  const observed = store.getTaskRoleSessionSet(taskId, roleName)?.providerBinding?.run;
  // A newly admitted Run must not inherit the preceding input's receipt. A
  // terminal Run no longer occupies the active index, but its exact binding
  // still identifies the observations to render.
  const native = run !== null && managedProviderTurnId(observed) !== run.id ? undefined : observed;
  if (run === null && native == null) return null;
  let driverId: string;
  try {
    driverId = builtinDriverIdForAdapter(run?.effective.adapterId ?? session.adapterId);
  } catch {
    return null;
  }
  const createdAt = run?.createdAt ?? native!.submittedAt;
  const updatedAt = run?.updatedAt ?? native!.updatedAt;
  const receiptId = native?.attemptId ?? formatRunReceiptId(taskId, run!.id);
  const basicFence = {
    taskId,
    roleName,
    ...(run?.id === undefined && native?.runId === undefined ? {} : { runId: run?.id ?? native?.runId }),
    agentId: run?.effective.agentId ?? session.agentId,
    driverId,
    nativeSessionId: session.nativeSessionId,
    receiptId
  };
  const nativeTurnId = native?.nativeTurnId ?? runtimeNativeTurnId(events, basicFence);
  const fence = { ...basicFence, ...(nativeTurnId === undefined ? {} : { nativeTurnId }) };
  let projection = projectRuntimeTaskEvents(fence, createdAt, events);
  projection = projectRuntimeObservation(projection, createRuntimeObservation({
    schemaVersion: 4,
    eventId: `runtime-host-${receiptId}`,
    semanticKey: `runtime-host-${receiptId}`,
    kind: "host.observed",
    authority: "host",
    receivedAt: updatedAt,
    fence,
    payload: { alive: tmux.state === "running" }
  }));
  // The semantic progress fence is the same durable fold the scheduler stall
  // pass consumes, so CLI/Web/scheduler share one progress clock.
  const semanticProgress = (run === null ? undefined : latestRunDurableProgressAt(store, taskId, roleName, run.id))
    ?? { progressAt: createdAt };
  const classification = classifyRuntimeHealth({
    projection,
    semanticProgressAt: semanticProgress.progressAt,
    now,
    policy: resolveRuntimeHealth(store.getConfig().runtimeHealth)
  });
  return {
    driverId,
    status: runtimeDisplayStatus(projection),
    healthLayer: classification.layer,
    healthReason: classification.reason,
    lastSemanticProgressAt: classification.lastSemanticProgressAt,
    ...(classification.lastRuntimeActivityAt === undefined
      ? {}
      : { lastActivityAt: classification.lastRuntimeActivityAt }),
    activeOperations: classification.activeOperations,
    ...(projection.waitingReason === undefined
      ? {}
      : { waitingReason: projection.waitingReason }),
    ...(projection.usage === undefined ? {} : { usage: projection.usage }),
    ...(projection.observer.status === "unknown"
      ? {}
      : {
          observerStatus: projection.observer.status,
          ...(projection.observer.detail === undefined
            ? {}
            : { observerDetail: projection.observer.detail })
        })
  };
}

function runtimeNativeTurnId(
  events: ReturnType<TaskStore["listEvents"]>,
  expected: Readonly<{
    taskId: string;
    roleName: string;
    runId?: string;
    agentId: string;
    driverId: string;
    nativeSessionId: string;
    receiptId: string;
  }>
): string | undefined {
  const observations = events
    .map(runtimeObservationFromTaskEvent)
    .filter((observation): observation is RuntimeObservation => observation !== null && observation.fence.taskId === expected.taskId && observation.fence.roleName === expected.roleName && observation.fence.runId === expected.runId && observation.fence.agentId === expected.agentId && observation.fence.driverId === expected.driverId && observation.fence.nativeSessionId === expected.nativeSessionId && observation.fence.receiptId === expected.receiptId && observation.fence.nativeTurnId !== undefined)
    .sort((left, right) => (
      left.receivedAt.localeCompare(right.receivedAt)
      || (left.sequence ?? -1) - (right.sequence ?? -1)
      || (left.ordinal ?? -1) - (right.ordinal ?? -1)
      || left.eventId.localeCompare(right.eventId)
    ));
  return observations.filter(({ kind }) => kind === "turn.accepted").at(-1)
    ?.fence.nativeTurnId
    ?? observations.at(-1)?.fence.nativeTurnId;
}
