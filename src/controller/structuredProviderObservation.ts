import { randomUUID } from "node:crypto";

import { callController, ControllerClientError } from "../core/controllerClient.js";
import { builtinAgentDriverRegistry } from "../runtime/builtinAgentDrivers.js";
import { standardAgentError } from "../runtime/agentError.js";
import type { ProviderDeliveryFailure } from "../runtime/agentError.js";
import { transportAgentResult } from "../domain/agentResultTransport.js";
import {
  createRuntimeObservation,
  runtimeObservationSemanticKey,
  type RuntimeObservation,
  type RuntimeObservationKind,
  type RuntimeObservationPayload
} from "../runtime/runtimeObservation.js";
import type {
  StructuredProviderTurnReceipt,
  StructuredProviderTurnStarted,
  StructuredProviderTurnTerminal,
  StructuredProviderGoal
} from "../runtime/structuredProviderHost.js";
import { runtimeLifecycleSignalKey } from "../runtime/lifecycleReservation.js";
import { isForeignHandoverLockHeld } from "../release/runtimeRelease.js";
import { FileRuntimeEventInbox } from "./runtimeEventInbox.js";
import {
  AGENT_HOST_EVENT_PROTOCOL,
  type AgentHostObservationSource,
  type AgentHostEventDelivery
} from "../runtime/agentHostProtocol.js";
import { redactAgentErrorText } from "../runtime/agentError.js";

let structuredSequence = 0;
let deliveryFailure: AgentHostEventDelivery["failure"];
// Only live diagnostics for this process's immutable files, not another queue.
// No payload, retry, or authoritative delivery state is kept in this map.
const emittedEvents = new Map<string, Readonly<{
  home: string; taskId: string; roleName: string; nativeSessionId?: string; terminal: boolean;
}>>();

/** A live transport observation, independent of Provider state and Run truth. */
export function structuredProviderEventDelivery(
  home: string, environment: NodeJS.ProcessEnv, nativeSessionId?: string
): AgentHostEventDelivery {
  try {
    const inbox = new FileRuntimeEventInbox(home);
    const pending = [];
    for (const [id, entry] of emittedEvents) {
      if (entry.home !== home) continue;
      if (!inbox.has(id)) { emittedEvents.delete(id); continue; }
      if (entry.taskId === environment.YUI_TASK_ID && entry.roleName === environment.YUI_ROLE
        && (nativeSessionId === undefined || entry.nativeSessionId === nativeSessionId)) pending.push(entry);
    }
    return {
      pending: pending.length,
      pendingTerminals: pending.filter(event => event.terminal).length,
      ...(deliveryFailure === undefined ? {} : { failure: deliveryFailure })
    };
  } catch (error) {
    return { pending: 0, pendingTerminals: 0, failure: deliveryFault("persistence", error) };
  }
}

function deliveryFault(stage: "persistence" | "controller", error: unknown): NonNullable<AgentHostEventDelivery["failure"]> {
  return {
    stage, detail: redactAgentErrorText(error instanceof Error ? error.message : String(error)),
    observedAt: new Date().toISOString()
  };
}

export async function publishStructuredProviderAttachmentExit(input: Readonly<{
  home: string; environment: NodeJS.ProcessEnv; nativeSessionId: string;
  attemptId?: string; nativeTurnId?: string; failed: boolean; observedAt: string;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const owner = describeHostIdentity(input.environment, adapterId, input.nativeSessionId);
  await persistAndApply(input.home, [observation({
    kind: input.failed ? "session.failed" : "session.ended", observedAt: input.observedAt,
    sequence: nextStructuredSequence(), ordinal: 0,
    fence: {
      taskId: owner.taskId, roleName: owner.roleName, agentId: owner.agentId, driverId: driver.id,
      nativeSessionId: input.nativeSessionId, conversationId: input.nativeSessionId,
      ...(input.attemptId === undefined ? {} : { receiptId: input.attemptId }),
      ...(input.nativeTurnId === undefined ? {} : { nativeTurnId: input.nativeTurnId })
    }
  })], input.environment);
}

export async function publishStructuredProviderActivity(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  activity: import("../runtime/structuredProviderHost.js").StructuredProviderActivity;
}>): Promise<void> {
  const activity = input.activity;
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const owner = describeHostIdentity(input.environment, adapterId, activity.nativeSessionId);
  const event = observation({
    kind: activity.phase === "model" ? "activity.observed" : `operation.${activity.phase}`,
    observedAt: activity.observedAt, sequence: nextStructuredSequence(), ordinal: 0,
    fence: {
      taskId: owner.taskId, roleName: owner.roleName,
      agentId: owner.agentId, driverId: driver.id,
      nativeSessionId: activity.nativeSessionId, conversationId: activity.conversationId,
      receiptId: activity.attemptId,
      ...(activity.nativeTurnId === undefined ? {} : { nativeTurnId: activity.nativeTurnId })
    },
    payload: activity.phase === "model"
      ? { activity: "model", activityId: activity.id }
      : { operation: "tool", operationId: activity.id }
  });
  await persistAndApply(input.home, [event], input.environment);
}

/** An exact provider item id is evidence of visible input, not an inferred
 * human author. The original managed request is never replaced.
 */
export async function publishStructuredProviderInputObserved(input: Readonly<{
  home: string; environment: NodeJS.ProcessEnv;
  observed: import("../runtime/structuredProviderHost.js").StructuredProviderInputObserved;
}>): Promise<void> {
  const observed = input.observed;
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const fence = describeHostIdentity(input.environment, adapterId, observed.nativeSessionId);
  await persistAndApply(input.home, [observation({
    kind: "input.accepted", observedAt: observed.observedAt, sequence: nextStructuredSequence(), ordinal: 0,
    fence: { ...fence, driverId: builtinAgentDriverRegistry().requireByAdapterId(adapterId).id,
      conversationId: observed.conversationId, nativeTurnId: observed.nativeTurnId,
      receiptId: `native-input:${observed.nativeTurnId}/${observed.inputId}` },
    payload: { input: observed.input }
  })], input.environment);
}

export async function publishStructuredProviderStarted(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  started: StructuredProviderTurnStarted;
}>): Promise<void> {
  if (input.started.clientOwned) return;
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const fence = describeHostIdentity(
    input.environment,
    adapterId,
    input.started.nativeSessionId
  );
  const receiptId = `direct:${input.started.nativeTurnId}`;
  const startedObservation = observation({
    kind: "turn.accepted",
    observedAt: input.started.observedAt,
    sequence: nextStructuredSequence(),
    ordinal: 0,
    fence: {
      taskId: fence.taskId,
      roleName: fence.roleName,
      agentId: fence.agentId,
      driverId: driver.id,
      conversationId: input.started.conversationId,
      nativeSessionId: input.started.nativeSessionId,
      nativeTurnId: input.started.nativeTurnId,
      receiptId
    },
    payload: input.started.input === undefined ? {} : { input: input.started.input }
  });
  await persistAndApply(
    input.home,
    [startedObservation],
    input.environment
  );
}

export async function publishStructuredProviderAccepted(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  receipt: StructuredProviderTurnReceipt;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const fence = describeHostIdentity(
    input.environment,
    adapterId,
    input.receipt.nativeSessionId
  );
  const observedAt = input.receipt.acceptedAt;
  const commonFence = {
    taskId: fence.taskId,
    roleName: fence.roleName,
    agentId: fence.agentId,
    driverId: driver.id,
    conversationId: input.receipt.conversationId,
    nativeSessionId: input.receipt.nativeSessionId,
    ...(input.receipt.nativeTurnId === undefined ? {} : {
      nativeTurnId: input.receipt.nativeTurnId
    }),
    // The structured Host owns the exact input attempt identity. Runtime
    // descriptor receipts name the AgentRun bootstrap and must not overwrite a
    // continuation or human-takeover AgentRun.
    receiptId: input.receipt.attemptId
  };
  const baseSequence = nextStructuredSequence();
  // Opening owns the Session lifecycle. A receipt arriving after
  // its terminal must not reopen either lifecycle as an acceptance side effect.
  const observations = [observation({
    kind: "turn.accepted",
    authority: input.receipt.acceptance === "transport" ? "transport" : "provider-structured",
    observedAt,
    sequence: baseSequence,
    ordinal: 0,
    fence: commonFence
  })];
  await persistAndApply(input.home, observations, input.environment);
}

/** Steer settles an additional input, never the parent AgentRun's initial delivery. */
export async function publishStructuredProviderInputSettlement(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  nativeSessionId: string;
  nativeTurnId: string;
  attemptId: string;
  boundedText: string;
  status: "accepted" | "rejected" | "unknown";
  failure?: ProviderDeliveryFailure;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const fence = describeHostIdentity(input.environment, adapterId, input.nativeSessionId);
  const entry = observation({
    kind: input.status === "accepted" ? "input.accepted"
      : input.status === "rejected" ? "input.rejected" : "input.delivery-unknown",
    observedAt: new Date().toISOString(),
    sequence: nextStructuredSequence(),
    ordinal: 0,
    fence: {
      taskId: fence.taskId,
      roleName: fence.roleName,
      agentId: fence.agentId,
      driverId: driver.id,
      conversationId: input.nativeSessionId,
      nativeSessionId: input.nativeSessionId,
      nativeTurnId: input.nativeTurnId,
      receiptId: input.attemptId
    },
    payload: {
      input: input.boundedText,
      ...(input.failure === undefined ? {} : {
        failure: {
          error: standardAgentError({
            source: "host",
            phase: "turn-submit",
            message: input.failure.detail,
            raw: input.failure.raw ?? input.failure.detail,
            inputDisposition: input.status === "unknown" ? "unknown" : "not-accepted"
          })
        }
      })
    }
  });
  await persistAndApply(input.home, [entry], input.environment);
}

export async function publishStructuredProviderOpened(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  startupRunId?: string;
  conversationId: string;
  nativeSessionId: string;
  recoverability: "unknown" | "recoverable";
  observedAt: string;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const startupSession = driver.capabilities.observation.sessionBootstrap;
  const fence = describeHostIdentity(
    input.environment,
    adapterId,
    input.nativeSessionId
  );
  const commonFence = {
    taskId: fence.taskId,
    roleName: fence.roleName,
    agentId: fence.agentId,
    driverId: driver.id,
    conversationId: input.conversationId,
    nativeSessionId: input.nativeSessionId
  };
  const sequence = nextStructuredSequence();
  const observations = [observation({
    kind: startupSession === "preallocated" ? "session.ready" : "session.started",
    observedAt: input.observedAt,
    sequence,
    ordinal: 0,
    fence: commonFence
  }), observation({
    kind: "conversation.observed",
    observedAt: input.observedAt,
    sequence,
    ordinal: 1,
    fence: commonFence,
    payload: { recoverability: input.recoverability }
  })];
  await persistAndApply(input.home, observations, input.environment, undefined, input.startupRunId);
}

export async function publishStructuredProviderGoal(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  conversationId: string;
  goal: StructuredProviderGoal | null;
  observedAt?: string;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const fence = describeHostIdentity(
    input.environment,
    adapterId,
    input.conversationId
  );
  const goal = input.goal;
  const observedAt = input.observedAt ?? goal?.updatedAt ?? new Date().toISOString();
  const goalObservation = observation({
    kind: goal === null ? "goal.cleared" : "goal.updated",
    observedAt,
    sequence: nextStructuredSequence(),
    ordinal: 0,
    fence: {
      taskId: fence.taskId,
      roleName: fence.roleName,
      agentId: fence.agentId,
      driverId: driver.id,
      conversationId: input.conversationId,
      nativeSessionId: input.conversationId
    },
    payload: goal === null ? {} : {
      goalStatus: goal.status,
      goalObjective: goal.objective,
      goalUpdatedAt: goal.updatedAt,
      ...(goal.nativeTurnId === undefined ? {} : { goalNativeTurnId: goal.nativeTurnId }),
      ...(goal.tokenBudget === undefined ? {} : { goalTokenBudget: goal.tokenBudget })
    }
  });
  await persistAndApply(input.home, [goalObservation], input.environment);
}

export async function publishStructuredConversationRecoverability(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  conversationId: string;
  recoverability: "recoverable" | "unrecoverable";
  observedAt: string;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const fence = describeHostIdentity(
    input.environment,
    adapterId,
    input.conversationId
  );
  const sequence = nextStructuredSequence();
  const observationFence = {
    taskId: fence.taskId,
    roleName: fence.roleName,
    agentId: fence.agentId,
    driverId: driver.id,
    conversationId: input.conversationId,
    nativeSessionId: input.conversationId
  };
  const observations: RuntimeObservation[] = [observation({
    kind: "conversation.observed",
    observedAt: input.observedAt,
    sequence,
    ordinal: 1,
    fence: observationFence,
    payload: { recoverability: input.recoverability }
  })];
  await persistAndApply(input.home, observations, input.environment);
}

export async function publishStructuredProviderTerminal(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  terminal: StructuredProviderTurnTerminal;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const fence = describeHostIdentity(
    input.environment,
    adapterId,
    input.terminal.nativeSessionId
  );
  const kind: RuntimeObservationKind = input.terminal.status === "completed"
    ? "turn.completed"
    : input.terminal.status === "cancelled" ? "turn.cancelled" : "turn.failed";
  const transported = transportAgentResult(input.terminal.output);
  const payload: RuntimeObservationPayload = kind === "turn.completed"
    ? {
        ...(input.terminal.input === undefined ? {} : { input: input.terminal.input }),
        ...(transported.status === "completed"
          ? { output: transported.output }
          : transported.failureReason === "runtime-failed"
            ? { resultTransportDiagnostic: transported.diagnostic }
            : {})
      }
    : kind === "turn.failed"
      ? {
          failure: {
            error: standardAgentError({
              source: "provider",
              phase: "turn-execute",
              classification: driver.runtime.mapError({
                message: input.terminal.error ?? "Provider Turn failed.",
                raw: input.terminal.rawError
                  ?? input.terminal.error
                  ?? "Provider Turn failed without an error payload."
              }),
              message: input.terminal.error ?? "Provider Turn failed.",
              raw: input.terminal.rawError
                ?? input.terminal.error
                ?? "Provider Turn failed without an error payload.",
              inputDisposition: "accepted"
            })
          },
          summary: input.terminal.error ?? "Provider Turn failed.",
          ...(input.terminal.input === undefined ? {} : { input: input.terminal.input })
        }
      : {};
  const terminalObservation = observation({
    kind,
    observedAt: input.terminal.observedAt,
    sequence: nextStructuredSequence(),
    ordinal: 0,
    fence: {
      taskId: fence.taskId,
      roleName: fence.roleName,
      agentId: fence.agentId,
      driverId: driver.id,
      conversationId: input.terminal.conversationId,
      nativeSessionId: input.terminal.nativeSessionId,
      ...(input.terminal.nativeTurnId === undefined ? {} : {
        nativeTurnId: input.terminal.nativeTurnId
      }),
      ...(input.terminal.attemptId === undefined ? {} : { receiptId: input.terminal.attemptId })
    },
    payload: {
      ...payload,
      ...(kind !== "turn.completed" && transported.status === "completed"
        ? { output: transported.output } : {}),
      ...(input.terminal.input === undefined ? {} : { input: input.terminal.input })
    }
  });
  await persistAndApply(
    input.home,
    [terminalObservation],
    input.environment
  );
}

function observation(input: Readonly<{
  kind: RuntimeObservationKind;
  observedAt: string;
  sequence: number;
  ordinal: number;
  fence: RuntimeObservation["fence"];
  payload?: RuntimeObservationPayload;
  authority?: RuntimeObservation["authority"];
}>): RuntimeObservation {
  const eventId = `agent-host-${randomUUID()}`;
  const partial = {
    eventId,
    kind: input.kind,
    fence: input.fence,
    sequence: input.sequence,
    payload: input.payload ?? {}
  };
  return createRuntimeObservation({
    schemaVersion: 4,
    eventId,
    semanticKey: runtimeObservationSemanticKey(partial),
    kind: input.kind,
    authority: input.authority ?? "provider-structured",
    receivedAt: new Date().toISOString(),
    observedAt: input.observedAt,
    sequence: input.sequence,
    ordinal: input.ordinal,
    fence: input.fence,
    payload: input.payload ?? {}
  });
}

async function signalController(home: string, taskId: string, roleName: string): Promise<void> {
  await callController(home, "scheduler.signal", {
    key: runtimeLifecycleSignalKey({ scope: "task", taskId, roleName })
  }, { timeoutMs: 100 }).catch(() => {});
}

function nextStructuredSequence(): number {
  structuredSequence = (structuredSequence + 1) % Number.MAX_SAFE_INTEGER;
  return structuredSequence;
}

function requireIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

async function persistAndApply(
  home: string,
  observations: readonly RuntimeObservation[],
  environment: NodeJS.ProcessEnv,
  connection?: AgentHostObservationSource["connection"],
  startupRunId?: string
): Promise<void> {
  const inbox = new FileRuntimeEventInbox(home);
  const host: AgentHostObservationSource = {
    protocol: AGENT_HOST_EVENT_PROTOCOL,
    adapterId: requireIdentity(environment.YUI_ADAPTER_ID, "Agent adapter id"),
    workspace: requireIdentity(environment.YUI_WORKSPACE, "Yui workspace"),
    ...(connection === undefined ? {} : { connection })
  };
  let events;
  try {
    structuredProviderEventDelivery(home, environment); // prune ACKed local diagnostics
    events = observations.map(entry => inbox.enqueueObservation(entry, {
      ...host,
      ...(startupRunId === undefined ? {} : { startupRunId })
    }).event);
    for (const event of events) emittedEvents.set(event.id, {
      home, taskId: event.taskId!, roleName: event.observation.fence.roleName,
      nativeSessionId: event.observation.fence.nativeSessionId,
      terminal: ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.observation.kind)
    });
  } catch (error) {
    deliveryFailure = deliveryFault("persistence", error);
    throw error;
  }
  // The immutable inbox is authoritative. During a release/update handover the
  // old Controller is draining and the replacement is not ready yet; leave the
  // entries for normal inbox replay instead of turning a healthy Provider Turn
  // into a transport failure.
  if (isForeignHandoverLockHeld(home)) return;
  for (const entry of events) {
    let result: Readonly<{ outcome?: string }>;
    try {
      result = await callController(home, "runtime.host-observation-apply", { eventId: entry.id }, {
        // This is only an eager application hint after durable enqueue, not
        // native admission. Bound it like the wake signal so a frozen
        // Controller cannot serialize ten seconds of delay per tool event.
        timeoutMs: 100
      }) as Readonly<{ outcome?: string }>;
    } catch (error) {
      // Persistence already succeeded. A stopped, frozen or reconnecting
      // Controller only delays applying this exact observation; it does not
      // fail the native execution or poison its reusable Host.
      if (isForeignHandoverLockHeld(home)
        || (error instanceof ControllerClientError
          && ["CONTROLLER_NOT_RUNNING", "CONTROLLER_UNAVAILABLE", "CONTROLLER_TIMEOUT",
            "CONTROLLER_DELIVERY_UNKNOWN"].includes(error.code))) return;
      // The native fact is already durable. An incompatible/refusing
      // Controller is a reporting fault, not Provider execution failure.
      deliveryFailure = deliveryFault("controller", error);
      return;
    }
    // A fast Provider can accept the initial AgentRun before the scheduler call
    // that launched this Host has returned and committed `turn.pushed`. The
    // immutable inbox entry already makes that exact fenced fact durable;
    // `deferred` therefore means "retained for replay", not delivery failure.
    // The signal below schedules the replay after the transport transaction.
    if (result.outcome !== "applied" && result.outcome !== "deferred") {
      deliveryFailure = deliveryFault("controller",
        `Structured Provider observation was rejected: ${result.outcome ?? "unknown"}. Event: ${entry.id}`);
      return;
    }
  }
  if (deliveryFailure?.stage === "controller") deliveryFailure = undefined;
  await signalController(home, hostTaskId(environment), requireIdentity(environment.YUI_ROLE, "Role"));
}

/** Capture only identities the Host actually received; the current Controller
 * owns all TaskStore reads and resolves the exact attempt's Run at consumption. */
function describeHostIdentity(
  environment: NodeJS.ProcessEnv,
  adapterId: string,
  nativeSessionId: string
): Readonly<{ taskId: string; roleName: string; agentId: string; nativeSessionId: string }> {
  if (environment.YUI_ADAPTER_ID !== adapterId) throw new Error("Agent adapter id does not match.");
  return {
    taskId: hostTaskId(environment),
    roleName: requireIdentity(environment.YUI_ROLE, "Role name"),
    agentId: requireIdentity(environment.YUI_AGENT_ID, "Agent id"),
    nativeSessionId: requireIdentity(nativeSessionId, "Native Session id")
  };
}

function hostTaskId(environment: NodeJS.ProcessEnv): string {
  if (environment.YUI_SESSION_SCOPE !== "task") throw new Error("Agent Host observation requires Task scope.");
  return requireIdentity(environment.YUI_TASK_ID, "Task id");
}

export async function publishStructuredProviderConnection(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  startupRunId?: string;
  nativeSessionId: string;
  connection: NonNullable<AgentHostObservationSource["connection"]>;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const fence = describeHostIdentity(input.environment, adapterId, input.nativeSessionId);
  await persistAndApply(input.home, [observation({
    kind: "host.observed", observedAt: new Date().toISOString(),
    authority: "host", payload: { alive: true },
    sequence: nextStructuredSequence(), ordinal: 0,
    fence: { ...fence, driverId: builtinAgentDriverRegistry().requireByAdapterId(adapterId).id }
  })], input.environment, input.connection, input.startupRunId);
}
