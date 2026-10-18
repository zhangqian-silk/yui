import { isDeepStrictEqual } from "node:util";
import type { TaskStore } from "../storage/taskStore.js";
import type { ProviderRuntimeBinding } from "../runtime/providerRuntimeIdentity.js";
import { currentProviderConversation } from "../runtime/providerRuntimeIdentity.js";
import type { AgentJobRun, JobAgentAttempt, JobAgentRecipient } from "./agentJob.js";

export function jobAttemptOwnsInput(store: TaskStore, attempt: JobAgentAttempt, binding: ProviderRuntimeBinding): boolean {
  const { recipient, messageId } = attempt;
  const inputs = [binding.run?.input];
  if (binding.run && binding.retry?.currentAttemptId === binding.run.attemptId) inputs.push(binding.retry.input);
  return inputs.some(input => {
    if (recipient.scope === "global") return input?.kind === "message"
      && input.roleName === recipient.roleName && input.messageId === messageId;
    if (input?.kind === "wake" && input.taskId === recipient.taskId) return store.getTaskWake(recipient.taskId, input.wakeId)
      ?.refs?.some(ref => ref.type === "message" && ref.id === messageId) === true;
    return input?.kind === "run" && input.taskId === recipient.taskId
      && store.listMessages(recipient.taskId).find(message => message.id === messageId)?.continuation?.runId === input.runId;
  });
}

/** Collect existing Provider evidence at its owning transaction. No submission,
 * retry, inferred business result, or transcript parsing occurs here. */
export function recordJobAgentObservation(store: TaskStore, recipient: JobAgentRecipient,
  binding: ProviderRuntimeBinding | null | undefined, now: Date): void {
  if (!binding?.run) return;
  for (const run of store.listAgentJobRunsForRole(recipient)) {
    const last = run.attempts.at(-1)!;
    if (!jobAttemptOwnsInput(store, last, binding)) continue;
    const turn = binding.run;
    const attempts = [...run.attempts];
    let attempt = last;
    if (turn.nativeTurnId && ["accepted", "completed", "failed", "cancelled"].includes(turn.status)) {
      const execution = { nativeSessionId: currentProviderConversation(binding).conversationId,
        attemptId: turn.attemptId, nativeTurnId: turn.nativeTurnId };
      if (last.execution && !isDeepStrictEqual(last.execution, execution)) {
        const retry = binding.retry;
        // Only the existing bounded retry owner may prove a successor of the
        // same original input. Session changes/other native Turns never do.
        if (run.businessResult || retry?.currentAttemptId !== execution.attemptId
          || retry.failureAttemptId !== last.execution.attemptId || retry.failedNativeTurnId !== last.execution.nativeTurnId
          || retry.nativeSessionId !== last.execution.nativeSessionId) continue;
        attempts[attempts.length - 1] = { ...last, terminal: last.terminal ?? { status: "failed", observedAt: retry.updatedAt } };
        attempt = { messageId: last.messageId, recipient: last.recipient, createdAt: turn.submittedAt, execution };
        attempts.push(attempt);
      } else attempt = { ...last, execution };
      if (["completed", "failed", "cancelled"].includes(turn.status)) attempt = { ...attempt,
        terminal: attempt.terminal ?? { status: turn.status as "completed" | "failed" | "cancelled", observedAt: now.toISOString() } };
      attempts[attempts.length - 1] = attempt;
    }
    const status = run.businessResult ? run.status : turn.status === "delivery-unknown" ? "unknown-needs-attention"
      : attempt.execution ? "running" : run.status;
    if (status === run.status && isDeepStrictEqual(attempts, run.attempts)) continue;
    const next: AgentJobRun = { ...run, status, attempts,
      updatedAt: new Date(Math.max(now.getTime(), Date.parse(run.updatedAt))).toISOString() };
    store.saveAgentJobRun(next);
  }
}
