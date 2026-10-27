import type { GlobalRoleSessionSet } from "../executor/agentExecutor.js";
import type { GlobalRole } from "../role/role.js";
import { currentProviderConversation } from "./providerRuntimeIdentity.js";
import { providerRetrySummary } from "./providerRetry.js";

/** Read-only provenance. Writer selection is not live Host/transport health. */
export function globalSessionHealth(role: GlobalRole, sessions: GlobalRoleSessionSet | null) {
  const session = sessions?.sessions[role.activeAgentId];
  const binding = sessions?.providerBinding;
  const matches = session !== undefined && binding != null
    && sessions?.activeAgentId === role.activeAgentId
    && currentProviderConversation(binding).conversationId === session.nativeSessionId;
  const turn = matches ? binding.run : null;
  const retry = binding?.retry?.nativeSessionId === session?.nativeSessionId && matches
    ? providerRetrySummary(binding) : null;
  const failure = turn?.status === "failed" || turn?.status === "rejected" ? turn.failure : undefined;
  return {
    desiredRevision: role.launchRevision,
    effectiveRevision: session?.effective.sourceDesiredRevision ?? null,
    configurationDrift: session === undefined ? null
      : session.effective.sourceDesiredRevision !== role.launchRevision,
    nativeSessionId: session?.nativeSessionId ?? null,
    nativeTurn: turn == null ? null : {
      attemptId: turn.attemptId, nativeTurnId: turn.nativeTurnId, status: turn.status
    },
    currentFailure: failure === undefined ? null : {
      ref: failure.ref, source: failure.error.source, phase: failure.error.phase,
      category: failure.error.category, code: failure.error.code,
      inputDisposition: failure.error.inputDisposition,
      sessionDisposition: failure.error.sessionDisposition
    },
    retry,
    historicalBinding: binding != null && !matches,
    hostObservation: "unobserved" as const,
    note: "Selected/active writer state is not delivery or terminal-observation health. "
      + "Inspect exact Host capabilities and runtime diagnostics; Controller restart does not refresh a live Host."
  };
}
