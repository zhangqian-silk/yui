import type { GlobalRoleSessionSet } from "../executor/agentExecutor.js";
import type { GlobalRoleMessage } from "./message.js";
import { providerRetryPending } from "../runtime/providerRetry.js";
import type { WorkMailbox } from "../coordination/workMailbox.js";
import { hasRuntimeCleanupObligation } from "../runtime/lifecycleReservation.js";

/** Bounded, derived diagnostics only; never an acknowledgement or recovery authority. */
export function globalInputBacklog(
  pending: readonly GlobalRoleMessage[], sessions: GlobalRoleSessionSet | null, now = new Date(),
  mailboxes: { attention?: WorkMailbox | null; lifecycle?: WorkMailbox | null } = {}
) {
  const first = pending[0];
  const run = sessions?.providerBinding?.run;
  const session = sessions?.sessions[sessions.activeAgentId];
  const authority = sessions?.providerBinding?.authority;
  const batches = [mailboxes.attention?.pending, mailboxes.attention?.processing?.batch]
    .filter(batch => batch != null);
  const coalescedFactCount = batches.reduce((count, batch) => count + batch.requestCount, 0);
  let reason = "ready";
  let recovery = "The Controller delivers at the next legal opportunity; do not duplicate the input.";
  if (first === undefined && coalescedFactCount === 0) reason = "empty";
  else if (hasRuntimeCleanupObligation(mailboxes.lifecycle ?? null)) {
    reason = "lifecycle-cleanup";
    recovery = "Complete the existing exact-owner stop/replacement; queued input cannot revive the Session.";
  }
  else if (session?.status !== "active") {
    reason = session === undefined ? "session-unavailable" : "session-stopped";
    recovery = "Inspect Session lifecycle. Explicit stop/replacement is not undone by background delivery.";
  } else if (authority?.owner !== "controller") {
    reason = "external-or-unknown-writer";
    recovery = "Resolve the current writer/authority explicitly; no background takeover is allowed.";
  } else if (providerRetryPending(sessions?.providerBinding)) {
    reason = "provider-retry";
    recovery = "The existing bounded Provider retry owns this input; inspect session retry before intervening.";
  } else if (run && ["submitting", "accepted", "delivery-unknown"].includes(run.status)) {
    reason = run.status === "accepted" ? "in-flight-or-unobserved-terminal" : run.status;
    recovery = "Age does not prove a stalled Turn. Periodic reconciliation asks only the original Host for exact retained terminal evidence. Inspect recent runtime-attention Messages if the Host is unobservable; never resend unknown input.";
  } else if (first?.inbox) {
    reason = "agent-inbox-handling";
    recovery = "Read the exact inbox original and prior handling claim; explicitly acknowledge after processing. No automatic replay or timeout release.";
  } else if (first?.control && first.control.outcome !== "rejected") {
    reason = "message-acceptance-unresolved";
    recovery = "Inspect this original Message's exact control receipt; do not replay or bypass uncertain input.";
  } else if (first?.interruptThen) {
    reason = "reserved-interrupt-then";
    recovery = "Only the original Session, authority and exact terminal release the reserved continuation.";
  } else if (first?.deliveryTarget && (first.deliveryTarget.agentId !== sessions?.activeAgentId
    || first.deliveryTarget.nativeSessionId !== session.nativeSessionId)) {
    reason = "stale-target";
    recovery = "Unsubmitted stale messages are retained with a nondelivery reason; no cross-Session input copy.";
  }
  const oldestCreatedAt = [...pending.map(message => message.createdAt), ...batches.map(batch => batch.firstQueuedAt)]
    .reduce<string | null>((oldest, at) => oldest === null || at < oldest ? at : oldest, null);
  return {
    pendingCount: pending.length, coalescedFactCount, oldestCreatedAt,
    oldestAgeMs: oldestCreatedAt === null ? null : Math.max(0, now.getTime() - Date.parse(oldestCreatedAt)),
    reason, recovery,
    target: session === undefined ? null : {
      agentId: session.agentId, nativeSessionId: session.nativeSessionId,
      authority: authority ?? null, attemptId: run?.attemptId ?? null, nativeTurnId: run?.nativeTurnId ?? null
    },
    messages: pending.slice(0, 8).map(message => ({
      id: message.id, createdAt: message.createdAt, deliveryTarget: message.deliveryTarget ?? null,
      control: message.control ?? null, interruptThen: message.interruptThen ?? null
    })),
    omittedMessages: Math.max(0, pending.length - 8)
  };
}
