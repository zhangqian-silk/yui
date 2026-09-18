import { createHash } from "node:crypto";

import type { ProviderLifecycleObservation } from "../controller/runtimeEventProcessor.js";
import type { TaskStore } from "../storage/taskStore.js";
import { serializeAgentErrorRaw, standardAgentError } from "./agentError.js";
import {
  providerContinuationKey,
  type ProviderContinuation
} from "./providerContinuation.js";
import { projectProviderContinuations } from "./runtimeContinuationProjection.js";
import {
  reconcileKnownDetachedContinuations,
  type ProviderContinuationMetadataPort,
  type ProviderReconcileResult,
  type ProviderReconcileSchedule
} from "./providerRuntimeReconciler.js";
import {
  createRuntimeObservation,
  runtimeObservationFromTaskEvent,
  type RuntimeObservationFence,
  type RuntimeObservation
} from "./runtimeObservation.js";

type DetachedContinuationCandidate = Readonly<{
  continuation: ProviderContinuation;
  fence: RuntimeObservationFence;
}>;

export type ProviderContinuationObservationSink = Readonly<{
  observeRuntimeObservation(
    observation: RuntimeObservation,
    now?: Date
  ): ProviderLifecycleObservation;
}>;

/**
 * Low-frequency, metadata-only recovery for already-known detached children.
 * No launch/model method is reachable through this object. The backoff is an
 * advisory cache; committed observations remain the only durable authority.
 */
export class ProviderContinuationReconciliationService {
  readonly #schedules = new Map<string, ProviderReconcileSchedule>();

  constructor(
    private readonly store: Pick<TaskStore, "listTasks" | "listEvents">,
    private readonly sink: ProviderContinuationObservationSink,
    private readonly metadata: ProviderContinuationMetadataPort
  ) {}

  async reconcile(now: Date): Promise<readonly string[]> {
    const changedTaskIds = new Set<string>();
    for (const task of this.store.listTasks().filter((entry) => (
      entry.status === "active" && entry.executionGate.state === "enabled"
    ))) {
      const events = this.store.listEvents(task.id);
      const groups = groupDetachedContinuations(
        projectProviderContinuations(events),
        events.map(runtimeObservationFromTaskEvent)
          .filter((entry): entry is RuntimeObservation => entry !== null)
      );
      for (const [groupKey, candidates] of groups) {
        const group = candidates.map(({ continuation }) => continuation);
        const previous = this.#schedules.get(groupKey);
        if (previous !== undefined && Date.parse(previous.nextReconcileAt) > now.getTime()) {
          continue;
        }
        let result: ProviderReconcileResult;
        try {
          result = await reconcileKnownDetachedContinuations({
            port: this.metadata,
            continuations: group,
            ...(previous === undefined ? {} : { previous }),
            now
          });
        } catch (error) {
          // One malformed identity group must not restart or block the
          // Controller. Keep it writer-owned and retry through the same
          // bounded, metadata-only schedule.
          result = {
            continuations: group, quality: "unavailable", changed: false,
            schedule: failureSchedule(groupKey, previous, now),
            failure: standardAgentError({
              source: "yui", phase: "turn-reconcile",
              message: error instanceof Error ? error.message : String(error),
              raw: serializeAgentErrorRaw(error)
            })
          };
        }
        if (result.schedule === null) this.#schedules.delete(groupKey);
        else this.#schedules.set(groupKey, result.schedule);
        if (result.failure !== undefined) {
          const failure = result.failure;
          // One original failure and one circuit-limit notice, not one wake per
          // poll. Existing observations deduplicate across Controller restarts.
          const digest = createHash("sha256").update(JSON.stringify([
            task.id, candidates.map(entry => entry.fence), failure.raw,
            result.schedule?.circuitOpenUntil === undefined ? "unavailable" : "circuit-open"
          ])).digest("hex");
          const eventId = `continuation-reconcile-error:${digest}`;
          if (!events.some(event => event.payload.eventId === eventId
            || event.type === "runtime.agent-error" && event.payload.sourceEventId === eventId)) {
            const observation = createRuntimeObservation({
              schemaVersion: 1, eventId, semanticKey: eventId,
              kind: "observer.health", authority: "controller",
              receivedAt: now.toISOString(), observedAt: now.toISOString(),
              fence: candidates[0]!.fence,
              payload: {
                sourceId: "continuation-metadata", observerStatus: "unavailable",
                observerDetail: failure.message,
                failure: { error: { ...failure, raw: serializeAgentErrorRaw({
                  failure, targets: group.map(entry => entry.identity),
                  schedule: result.schedule,
                  confirmed: "Metadata query did not prove quiescence; existing writer ownership is preserved.",
                  unknown: "Continuation execution, result and external effects."
                }) } }
              }
            });
            if (this.sink.observeRuntimeObservation(observation, now) === "applied") changedTaskIds.add(task.id);
          }
        }
        for (let index = 0; index < group.length; index += 1) {
          const before = group[index]!;
          const after = result.continuations[index]!;
          if (sameContinuationState(before, after)) continue;
          const disposition = this.sink.observeRuntimeObservation(
            reconciliationObservation(after, candidates[index]!.fence, now),
            now
          );
          if (disposition === "applied") changedTaskIds.add(after.taskId);
        }
      }
    }
    return Object.freeze([...changedTaskIds].sort());
  }
}

function failureSchedule(
  key: string,
  previous: ProviderReconcileSchedule | undefined,
  now: Date
): ProviderReconcileSchedule {
  const attempts = (previous?.attempts ?? 0) + 1;
  const errors = (previous?.consecutiveErrors ?? 0) + 1;
  const delay = Math.min(5 * 60_000, 2_000 * (2 ** Math.min(attempts - 1, 8)));
  return Object.freeze({
    key,
    attempts,
    consecutiveErrors: errors,
    nextReconcileAt: new Date(now.getTime() + delay).toISOString(),
    ...(errors < 5
      ? {}
      : { circuitOpenUntil: new Date(now.getTime() + 5 * 60_000).toISOString() })
  });
}

function groupDetachedContinuations(
  continuations: readonly ProviderContinuation[],
  observations: readonly RuntimeObservation[]
): Map<string, DetachedContinuationCandidate[]> {
  const groups = new Map<string, DetachedContinuationCandidate[]>();
  for (const continuation of continuations) {
    if (continuation.attachment !== "detached"
      || continuation.identityConflict
      || (continuation.execution !== "active" && continuation.execution !== "unknown")) {
      continue;
    }
    const key = [
      continuation.identity.providerNamespace,
      continuation.identity.accountScope,
      continuation.identity.conversationId
    ].join("\u0000");
    const source = [...observations].reverse().find((observation) => (
      observation.kind.startsWith("continuation.") && observation.fence.driverId === continuation.identity.providerNamespace && observation.fence.agentId === continuation.identity.accountScope && observation.fence.conversationId === continuation.identity.conversationId && observation.fence.continuationId === continuation.identity.continuationId
    ));
    // A projected continuation without its original durable fence cannot be
    // safely attached to a live AgentRun. Keep ownership conservative and let the
    // malformed identity remain visible instead of synthesizing a receipt.
    if (source === undefined) continue;
    const group = groups.get(key) ?? [];
    group.push({ continuation, fence: source.fence });
    groups.set(key, group);
  }
  return groups;
}

function sameContinuationState(
  left: ProviderContinuation,
  right: ProviderContinuation
): boolean {
  return left.execution === right.execution
    && left.outcome === right.outcome
    && left.attachment === right.attachment
    && left.observation === right.observation
    && left.mayWriteWorkspace === right.mayWriteWorkspace
    && left.durability === right.durability
    && left.resultRef === right.resultRef
    && left.lastProviderSequence === right.lastProviderSequence
    && left.identityConflict === right.identityConflict;
}

function reconciliationObservation(
  continuation: ProviderContinuation,
  sourceFence: RuntimeObservationFence,
  now: Date
): RuntimeObservation {
  const key = providerContinuationKey(continuation.identity);
  const state = [
    continuation.execution,
    continuation.outcome,
    continuation.observation,
    continuation.mayWriteWorkspace ? "writer" : "read-only",
    continuation.resultRef ?? "none",
    continuation.lastProviderSequence ?? "none"
  ].join(":");
  const digest = createHash("sha256").update(`${key}\u0000${state}`).digest("hex");
  const settled = continuation.execution === "quiescent"
    && continuation.observation === "exact";
  return createRuntimeObservation({
    schemaVersion: 1,
    eventId: `continuation-reconcile:${digest}`,
    semanticKey: `continuation-reconcile:${digest}`,
    kind: settled ? "continuation.settled" : "continuation.started",
    authority: "provider-structured",
    receivedAt: now.toISOString(),
    observedAt: now.toISOString(),
    ...(continuation.lastProviderSequence === undefined
      ? {}
      : { sequence: continuation.lastProviderSequence }),
    fence: {
      ...sourceFence,
      taskId: continuation.taskId,
      roleName: continuation.roleName,
      runId: continuation.runId,
      agentId: continuation.identity.accountScope,
      driverId: continuation.identity.providerNamespace,
      conversationId: continuation.identity.conversationId,
      nativeSessionId: continuation.identity.conversationId,
      continuationId: continuation.identity.continuationId,
      ...(continuation.parentContinuationId === undefined
        ? {}
        : { parentContinuationId: continuation.parentContinuationId })
    },
    payload: {
      execution: continuation.execution,
      outcome: continuation.outcome,
      attachment: "detached",
      observationQuality: continuation.observation,
      mayWriteWorkspace: continuation.mayWriteWorkspace,
      ...(continuation.resultRef === undefined ? {} : { resultRef: continuation.resultRef })
    }
  });
}
