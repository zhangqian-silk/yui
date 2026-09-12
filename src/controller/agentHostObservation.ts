import type { TaskStore } from "../storage/taskStore.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { builtinAgentDriverRegistry } from "../runtime/builtinAgentDrivers.js";
import { createRuntimeObservation, type RuntimeObservation } from "../runtime/runtimeObservation.js";
import { readAgentHostObservationSource } from "../runtime/agentHostProtocol.js";
import type { RuntimeObservationInboxEvent } from "./runtimeEventInbox.js";
import {
  resolveRuntimeHookRunFence, RuntimeHookRunFenceError, type RuntimeHookRunFenceOptions
} from "./runtimeHookRunFence.js";

export class AgentHostObservationDeferred extends Error {}

/** Resolve wire facts only here, using the Controller's current authoritative
 * store. The producer's launch Run is never a substitute for input identity. */
export function resolveAgentHostObservation(
  store: TaskStore,
  event: RuntimeObservationInboxEvent
): RuntimeObservation {
  const host = readAgentHostObservationSource(event.host);
  const input = createRuntimeObservation(event.observation);
  const { fence, kind } = input;
  const hostKinds = [
    "host.observed", "session.started", "session.ready", "session.ended", "session.failed",
    "conversation.observed", "goal.updated", "goal.cleared",
    "turn.accepted", "turn.completed", "turn.failed", "turn.cancelled",
    "input.accepted", "input.rejected", "input.delivery-unknown",
    "operation.started", "operation.completed", "operation.failed", "activity.observed"
  ];
  if (!hostKinds.includes(kind)
    || (kind === "host.observed" ? input.authority !== "host"
      : input.authority !== "provider-structured" && !(kind === "turn.accepted" && input.authority === "transport"))) {
    throw new RuntimeHookRunFenceError("Agent Host fact exceeds its event authority.");
  }
  let driver;
  try { driver = builtinAgentDriverRegistry().requireByAdapterId(host.adapterId); }
  catch { throw new RuntimeHookRunFenceError("Agent Host adapter is unsupported."); }
  if (fence.taskId === undefined || event.taskId !== fence.taskId
    || event.scope !== "task" || fence.runId !== undefined
    || fence.nativeSessionId === undefined
    || driver.id !== fence.driverId
    || (host.connection !== undefined && kind !== "host.observed")) {
    throw new RuntimeHookRunFenceError("Agent Host fact source does not match its observation.");
  }
  const sessionStartup = ["session.started", "session.ready", "host.observed"].includes(kind)
    || (kind === "conversation.observed" && host.startupRunId !== undefined);
  const sessionFact = sessionStartup
    || ["conversation.observed", "goal.updated", "goal.cleared"].includes(kind);
  const directStart = kind === "turn.accepted" && fence.receiptId === `direct:${fence.nativeTurnId}`;
  const additionalInput = kind.startsWith("input.") && (
    fence.receiptId?.startsWith("native-input:") || fence.receiptId?.startsWith("turn-input:")
    || fence.receiptId?.startsWith("steer:")
  );
  const terminal = ["turn.completed", "turn.failed", "turn.cancelled", "session.ended", "session.failed"].includes(kind);
  const sessions = store.getTaskRoleSessionSet(fence.taskId, fence.roleName);
  const session = sessions?.sessions[fence.agentId];
  if (kind === "host.observed" && host.startupRunId === undefined
    && (session === undefined || session.status === "ended")) {
    const role = store.getRole(fence.taskId, fence.roleName);
    const task = store.getTask(fence.taskId);
    if (role?.activeAgentId === fence.agentId && role.workspace === host.workspace
      && task !== null && ["active", "draft"].includes(task.status)) {
      // A runless Session launch is adopted by the existing launch coordinator
      // after its Host returns the native id. Retain custody until that commit;
      // it must not itself authorize or invent the Session.
      throw new AgentHostObservationDeferred("Awaiting exact Session adoption.");
    }
  }
  const knownStartup = sessionStartup && store.listEvents(fence.taskId).some(e =>
    e.type === "runtime.observation" && e.payload.eventId === input.eventId);
  const startup = sessionStartup && host.startupRunId !== undefined && !knownStartup;
  const options: RuntimeHookRunFenceOptions = {
    ...(fence.nativeTurnId === undefined || sessionFact || directStart ? {} : { nativeTurnId: fence.nativeTurnId }),
    ...(fence.receiptId === undefined || additionalInput || sessionFact || directStart
      ? {} : { attemptId: fence.receiptId }),
    ...(terminal || additionalInput ? { terminal: true } : {}),
    ...((sessionFact && !startup) || directStart || (terminal && fence.receiptId === undefined) ? { sessionOnly: true } : {}),
    ...(!sessionFact && !directStart ? { exactInput: true } : {}),
    ...(startup ? {
      startupRunId: host.startupRunId,
      startupSession: driver.capabilities.observation.sessionBootstrap
    } : {})
  };
  // Idempotent replay of an already applied startup must not be rejected just
  // because its Run has since ended. All raw fields still match the saved fact.
  const resolved = resolveRuntimeHookRunFence({
    YUI_SESSION_SCOPE: "task", YUI_TASK_ID: fence.taskId,
    YUI_ROLE: fence.roleName, YUI_AGENT_ID: fence.agentId,
    YUI_ADAPTER_ID: host.adapterId, YUI_WORKSPACE: host.workspace
  }, host.adapterId, fence.nativeSessionId, options, store);
  return createRuntimeObservation({
    ...input,
    fence: {
      ...fence,
      ...(resolved.runId === undefined ? {} : { runId: resolved.runId }),
      ...(fence.receiptId === undefined && resolved.receiptId !== undefined
        ? { receiptId: resolved.receiptId } : {})
    }
  });
}

/** Custody and account evidence share the same exact Session validation and
 * commit/ACK boundary as activity. They contain locations, never credentials. */
export function recordAgentHostConnection(
  store: TaskStore,
  event: RuntimeObservationInboxEvent,
  input: RuntimeObservation,
  now: Date
): void {
  const host = readAgentHostObservationSource(event.host);
  const connection = host.connection;
  if (connection === undefined) throw new RuntimeHookRunFenceError("Host connection evidence is missing.");
  const fence = input.fence;
  const owner = connection.processOwner;
  if (owner !== undefined) {
    if (owner.owner.scope !== "task" || owner.owner.taskId !== fence.taskId
      || owner.owner.roleName !== fence.roleName || owner.agentId !== fence.agentId
      || owner.adapterId !== host.adapterId || owner.nativeSessionId !== fence.nativeSessionId
      || owner.providerRoot.attribution !== "owned-child") {
      throw new RuntimeHookRunFenceError("Host process custody does not match its exact Session.");
    }
    store.saveSessionOwner(owner);
  }
  if (connection.account !== undefined) {
    if (host.adapterId !== "codex") throw new RuntimeHookRunFenceError("Native account evidence requires Codex.");
    const exists = store.listEvents(fence.taskId!).some(e => e.type === "runtime.native-connection-bound"
      && e.payload.roleName === fence.roleName && e.payload.agentId === fence.agentId
      && e.payload.nativeSessionId === fence.nativeSessionId);
    if (!exists) store.saveEvent(fence.taskId!, createTaskEvent(
      store.nextEventId(fence.taskId!), fence.taskId!, "runtime.native-connection-bound", {
        roleName: fence.roleName, agentId: fence.agentId, nativeSessionId: fence.nativeSessionId!,
        ...connection.account
      }, now
    ));
  }
}
