import { isDeepStrictEqual } from "node:util";
import type { AgentRun } from "../agentRun/agentRun.js";
import { readRunContextSnapshot } from "../context/runContextPack.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { ProviderRuntimeBinding } from "../runtime/providerRuntimeIdentity.js";
import type { ProviderRetry } from "../runtime/providerRetry.js";
import { runtimeObservationFromTaskEvent } from "../runtime/runtimeObservation.js";
import type { TaskMessage } from "../message/message.js";

/**
 * An explicit current-owner retry may follow an undelivered message
 * continuation, rather than the retry's original business input. Recover the
 * native anchor from durable evidence only; never schedule here or renew its
 * budget. Native latest-failed-Turn and background checks still run at submit.
 */
export function taskRunRecovery(
  store: TaskStore, binding: ProviderRuntimeBinding, current: AgentRun
): ProviderRetry | undefined {
  if (!verifiedRecoveryChain(store, binding, current, false)) return undefined;
  const { currentAttemptId: _attempt, successorRunId: _successor,
    successorReviewRoundId: _round, ...retained } = binding.retry!;
  return { ...retained, input: binding.run!.input!, status: "waiting", successorAutomatic: false,
    previousRunId: current.id, failedAttemptId: binding.run!.attemptId };
}

/** Read-only handling authority for the exact original Message. Its recipient,
 * continuation, claim and delivery receipts are never rewritten or requeued. */
export function recoveredMessageContinuation(
  store: TaskStore, message: Pick<TaskMessage, "taskId" | "recipient"> & Partial<TaskMessage>,
  current: AgentRun
): boolean {
  const target = message.continuation?.runId;
  if (target === undefined || message.id === undefined || message.taskId !== current.taskId
    || message.recipient?.roleName !== current.roleName
    || message.recipient.workItemId !== current.workItemId || message.recipient.reviewRoundId !== current.reviewRoundId) return false;
  const binding = store.getTaskRoleSessionSet(current.taskId, current.roleName)?.providerBinding;
  if (binding == null || !verifiedRecoveryChain(store, binding, current, true)) return false;
  const events = store.listEventsByType(current.taskId, ["run.retried"]);
  const visited = new Set<string>();
  let id = current.id;
  while (id !== target) {
    if (visited.has(id)) return false;
    visited.add(id);
    const edge = events.find(e => e.payload.runId === id);
    if (edge?.payload.previousRunId === undefined) return false;
    id = edge.payload.previousRunId;
  }
  const source = store.getRun(current.taskId, target);
  if (source?.inputs[0]?.input.source.channel !== "message-continuation") return false;
  return readRunContextSnapshot(store, current).resources.some(entry => {
    if (entry.ref.store !== "task-message" || entry.ref.refId !== message.id) return false;
    const frozen = entry.value as Partial<TaskMessage>;
    return frozen.body === message.body && frozen.createdAt === message.createdAt
      && isDeepStrictEqual(frozen.recipient, message.recipient);
  });
}

function verifiedRecoveryChain(
  store: TaskStore, binding: ProviderRuntimeBinding, current: AgentRun, admitted: boolean
): boolean {
  const retry = binding.retry;
  const turn = binding.run;
  const conversation = binding.conversations.find(c => c.epoch === binding.currentConversationEpoch);
  if (binding.providerNamespace !== "openai/codex"
    || retry === undefined || retry.status === "recovered" || retry.failedNativeTurnId === undefined
    || binding.authority.owner !== "controller" || retry.authorityEpoch !== binding.authority.epoch
    || conversation?.conversationId !== retry.nativeSessionId
    || turn?.runId !== current.id
    || turn.authorityEpoch !== binding.authority.epoch || turn.retrySupported !== true
    || turn.input?.kind !== "run" || turn.input.taskId !== current.taskId
    || current.purpose !== "execution") return false;
  if (admitted
    ? current.status !== "active" || turn.status !== "accepted"
      || retry.currentAttemptId !== turn.attemptId || retry.successorRunId !== current.id
      || retry.successorAutomatic !== false
    : current.status !== "failed" || turn.status !== "rejected"
      || turn.nativeTurnId !== undefined || turn.input.runId !== current.id) return false;

  const runs = store.listRuns(current.taskId).filter(r => r.roleName === current.roleName);
  const start = runs.findIndex(r => r.result?.provider?.attemptId === retry.failureAttemptId
    && r.result.provider.nativeTurnId === retry.failedNativeTurnId
    && r.result.provider.conversationId === retry.nativeSessionId
    && r.result.provider.status === "failed" && r.status === "failed");
  const end = runs.findIndex(r => r.id === current.id);
  if (start < 0 || end <= start || end !== runs.length - 1) return false;
  if (runs.slice(start, end + 1).some(run => run.purpose !== current.purpose
    || run.workItemId !== current.workItemId || run.reviewRoundId !== current.reviewRoundId
    || run.executionGroupId !== current.executionGroupId || run.executionLaneId !== current.executionLaneId
    || run.sourceExecutionGroupId !== current.sourceExecutionGroupId
    || !isDeepStrictEqual(run.effective, current.effective)
    || !isDeepStrictEqual(run.workspace, current.workspace))) return false;
  const events = store.listEventsByType(current.taskId,
    ["runtime.agent-error", "runtime.observation", "run.retried", "message.continuation"]);
  const anchor = events.findIndex(event => {
    const observation = runtimeObservationFromTaskEvent(event);
    return observation?.kind === "turn.failed"
      && observation.fence.roleName === current.roleName
      && observation.fence.runId === runs[start]!.id
      && observation.fence.nativeSessionId === retry.nativeSessionId
      && observation.fence.receiptId === retry.failureAttemptId
      && observation.fence.nativeTurnId === retry.failedNativeTurnId
      && observation.payload.failure?.error.inputDisposition === "accepted"
      && observation.payload.failure.error.sessionDisposition === "recoverable";
  });
  if (anchor < 0) return false;
  // Reject any intervening accepted/unknown input, including an unowned native
  // Turn. Timestamps or absence of a Run result are not non-submission proof.
  for (const event of events.slice(anchor + 1)) {
    if (event.payload.roleName !== current.roleName
      || event.payload.nativeSessionId !== retry.nativeSessionId) continue;
    if (event.type === "runtime.agent-error" && event.payload.inputDisposition !== "not-accepted"
      && !(event.payload.attemptId === retry.failureAttemptId
        && event.payload.nativeTurnId === retry.failedNativeTurnId
        && event.payload.phase === "turn-execute" && event.payload.inputDisposition === "accepted")) return false;
    if (event.type !== "runtime.observation") continue;
    const observation = runtimeObservationFromTaskEvent(event);
    if (admitted && observation?.fence.receiptId === turn.attemptId
      && observation.fence.runId === current.id && observation.fence.nativeTurnId === turn.nativeTurnId
      && observation.kind !== "input.delivery-unknown") continue;
    if (observation === null || observation.kind === "input.accepted"
      || observation.kind === "input.delivery-unknown"
      || observation.kind.startsWith("turn.")
        && observation.fence.nativeTurnId !== retry.failedNativeTurnId) return false;
  }
  for (let i = start + 1; i <= end; i++) {
    const prior = runs[i - 1]!;
    const run = runs[i]!;
    if (!(admitted && i === end)) {
      if (run.status !== "failed" || run.result?.provider !== undefined
        || run.result?.failureReason !== "runtime-failed") return false;
      const errors = events.filter(e => e.type === "runtime.agent-error" && e.payload.runId === run.id);
      const proof = errors.find(({ payload: p }) => p.roleName === current.roleName
        && p.agentId === run.effective.agentId && p.nativeSessionId === retry.nativeSessionId
        && p.source === "host" && p.adapterId === "codex" && p.driverId === "openai/codex"
        && p.phase === "turn-submit" && p.inputDisposition === "not-accepted"
        && p.errorName === "CodexPreSubmissionError" && p.registrationDisposition === "committed"
        && p.attemptId !== undefined);
      if (proof === undefined || errors.some(e => e.payload.inputDisposition !== "not-accepted")
        || i === end && proof.payload.attemptId !== turn.attemptId) return false;
    }
    if (events.some(e => e.type === "run.retried"
      && e.payload.runId === run.id && e.payload.previousRunId === prior.id)) continue;
    if (run.inputs[0]?.input.source.channel !== "message-continuation"
      || !events.some(e => e.type === "message.continuation" && e.payload.runId === run.id)) return false;
    const snapshot = readRunContextSnapshot(store, run);
    if (!snapshot.resources.some(r => r.ref.store === "source-run" && r.ref.refId === prior.id)) return false;
  }
  return true;
}
