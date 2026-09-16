import { createTaskEvent, type TaskEvent, type TaskEventPayload } from "../event/taskEvent.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import { redactAgentErrorText, type StandardAgentError } from "../runtime/agentError.js";
import { captureAgentFailureContext } from "../runtime/agentFailureContext.js";
import type { TaskStore } from "../storage/taskStore.js";

type ErrorEvidence = Readonly<{
  runId?: string; attemptId?: string; observationEventId?: string;
  nativeSessionId?: string; nativeTurnId?: string; errorName?: string;
  causeName?: string; hostState?: string; registrationDisposition?: string; lastOutput?: string;
}>;

/** One persistence boundary. Ingress owns Provider classification, execution
 * fences and routing; this writer never invents an execution or recovery plan. */
export function recordTaskAgentError(
  store: TaskStore,
  input: Readonly<{
    taskId: string; roleName: string; sourceEventId: string;
    agentId: string; adapterId: string; driverId: string;
    error: StandardAgentError; effective?: EffectiveLaunchSnapshot; evidence?: ErrorEvidence;
  }>,
  now: Date
): Readonly<{ event: TaskEvent; created: boolean }> {
  return store.transaction(tx => {
    const error = input.error;
    const payload: TaskEventPayload = {
      ...Object.fromEntries(Object.entries(input.evidence ?? {}).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string" && (entry[0] === "lastOutput" || entry[1].trim().length > 0))),
      sourceEventId: input.sourceEventId, roleName: input.roleName,
      agentId: input.agentId, adapterId: input.adapterId, driverId: input.driverId,
      source: error.source, phase: error.phase, category: error.category, code: error.code,
      message: redactAgentErrorText(error.message), raw: redactAgentErrorText(error.raw),
      inputDisposition: error.inputDisposition, sessionDisposition: error.sessionDisposition,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: String(error.retryAfterMs) })
    };
    const identity = ["sourceEventId", "roleName", "agentId", "adapterId", "driverId",
      "source", "phase", "category", "code", "inputDisposition", "sessionDisposition",
      "runId", "attemptId", "nativeSessionId", "nativeTurnId", "observationEventId",
      "message", "errorName", "causeName", "hostState", "registrationDisposition",
      "retryAfterMs", "lastOutput", ...(payload.attemptId === undefined ? ["raw"] : [])];
    const duplicate = [...tx.listEventsByType(input.taskId, ["runtime.agent-error"])].reverse().find(event =>
      identity.every(key => event.payload[key] === payload[key]));
    // Keep the first original raw cause/configuration for a fixed failure.
    // Changed normalized facts are distinct evidence, not a replay.
    if (duplicate !== undefined) return { event: duplicate, created: false };
    const event = createTaskEvent(tx.nextEventId(input.taskId), input.taskId, "runtime.agent-error", {
      ...payload,
      capabilityContext: captureAgentFailureContext(input.effective,
        input.effective === undefined ? null : tx.getConfiguredAgent(input.effective.agentId))
    }, now);
    tx.saveEvent(input.taskId, event);
    return { event, created: true };
  });
}
