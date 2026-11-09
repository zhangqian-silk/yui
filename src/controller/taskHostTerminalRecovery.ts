import type { TaskStore } from "../storage/taskStore.js";
import { AGENT_HOST_CONTROL_PROTOCOL, reconcileAgentHostTurn } from "../runtime/agentHost.js";
import { currentProviderConversation } from "../runtime/providerRuntimeIdentity.js";
import { providerRetryPending } from "../runtime/providerRetry.js";

export type TaskHostTerminalObservation = {
  taskId: string; roleName: string; nativeSessionId: string; attemptId: string;
  state: string; reconciliation: string | null; outcome: string; observedAt: string;
};

/** Existing full reconciliation pass only; no new timer, input or Session. */
export async function recoverTaskHostTerminals(
  home: string, store: TaskStore, onError: (error: unknown) => void,
  reconcile = reconcileAgentHostTurn
): Promise<TaskHostTerminalObservation[]> {
  const observations: TaskHostTerminalObservation[] = [];
  for (const candidate of store.listRuntimeSessionCandidates({ scope: "task" })) {
    const owner = candidate.owner;
    if (owner.scope !== "task") continue;
    const binding = store.getTaskRoleSessionSet(owner.taskId, owner.roleName)?.providerBinding;
    const turn = binding?.run;
    if (binding === undefined || binding === null || turn == null || providerRetryPending(binding)
      || !["submitting", "accepted", "delivery-unknown"].includes(turn.status)
      || binding.authority.owner !== "controller" || binding.authority.holderId === undefined) continue;
    try {
      const result = await reconcile({ home, ...owner, control: {
        protocol: AGENT_HOST_CONTROL_PROTOCOL, type: "reconcile-turn",
        nativeSessionId: currentProviderConversation(binding).conversationId,
        attemptId: turn.attemptId, nativeTurnId: turn.nativeTurnId,
        authority: { epoch: binding.authority.epoch, owner: "controller", holderId: binding.authority.holderId }
      } });
      observations.push({ taskId: owner.taskId, roleName: owner.roleName,
        nativeSessionId: currentProviderConversation(binding).conversationId, attemptId: turn.attemptId,
        state: result.snapshot.state, reconciliation: result.reconciliation ?? null,
        outcome: result.outcome, observedAt: new Date().toISOString() });
      if (result.outcome === "rejected" || result.reconciliation === "unsupported") {
        throw new Error(result.failure?.detail
          ?? "Host terminal reconciliation is unsupported; retain the original input and inspect Host/Inbox evidence.");
      }
    } catch (error) {
      if (!observations.some(item => item.taskId === owner.taskId && item.roleName === owner.roleName)) {
        observations.push({ taskId: owner.taskId, roleName: owner.roleName,
          nativeSessionId: currentProviderConversation(binding).conversationId, attemptId: turn.attemptId,
          state: "unobservable", reconciliation: null, outcome: "unavailable", observedAt: new Date().toISOString() });
      }
      onError(new Error(`Task Host terminal recovery ${owner.taskId}/${owner.roleName}/${turn.attemptId}: `
        + `${error instanceof Error ? error.message : String(error)} No input was replayed.`, { cause: error }));
    }
  }
  return observations;
}
