import type { TaskStore } from "../storage/taskStore.js";
import { sendAgentHostRunControl, reconcileAgentHostTurn, AGENT_HOST_CONTROL_PROTOCOL,
  type AgentHostControlResult } from "../runtime/agentHost.js";
import { currentProviderConversation } from "../runtime/providerRuntimeIdentity.js";
import { hasRuntimeCleanupObligation, runtimeLifecycleTarget } from "../runtime/lifecycleReservation.js";
import { markGlobalRoleMessageNotDelivered, type GlobalRoleMessage } from "../message/message.js";
import { providerRetryPending } from "../runtime/providerRetry.js";
import { settleGlobalRetryInput } from "../message/globalProviderRetry.js";
import { globalMessagePresentation } from "../interaction/notificationPresentation.js";
import { recordGlobalRuntimeAttention } from "./globalRuntimeAttention.js";

/** Messages are the only queue. Host's atomic begin arbitrates native writers. */
export async function deliverGlobalInputs(
  home: string,
  store: TaskStore,
  ensure: (roleName: string) => Promise<void>,
  onError: (error: unknown) => void,
  options: { reconcile?: boolean; now?: Date } = {}
): Promise<void> {
  for (const role of store.listGlobalRoles()) {
    try {
      let pending = store.queryGlobalRoleMessages(role.name, { pending: true, limit: 64 }).messages;
      if (hasRuntimeCleanupObligation(store.getWorkMailbox(
        runtimeLifecycleTarget({ scope: "global", roleName: role.name })))) continue;
      let sessions = store.getGlobalRoleSessionSet(role.name);
      // A detached Host keeps an active Session and may reconnect. An explicit
      // Session stop/switch must not be undone by background notification work.
      if (sessions !== null && sessions.sessions[sessions.activeAgentId]?.status !== "active") continue;
      if (sessions?.providerBinding?.retry !== undefined && !providerRetryPending(sessions.providerBinding)) {
        store.transaction(tx => settleGlobalRetryInput(tx, role.name,
          tx.getGlobalRoleSessionSet(role.name)?.providerBinding, new Date()));
        pending = store.queryGlobalRoleMessages(role.name, { pending: true, limit: 64 }).messages;
        if (pending.length === 0) continue;
      }
      if (providerRetryPending(sessions?.providerBinding)) continue;
      let current = sessions?.providerBinding?.run;
      const bindingBefore = sessions?.providerBinding;
      if (options.reconcile && current != null
        && ["submitting", "accepted", "delivery-unknown"].includes(current.status)
        && bindingBefore?.authority.owner === "controller" && bindingBefore.authority.holderId !== undefined) {
        const ownedTurn = current;
        // Only ask the original Host to republish evidence it already holds.
        // Busy, unknown, unavailable and older Hosts never authorize replay,
        // Session creation, native reads through another client, or timeout settlement.
        let observed: AgentHostControlResult | undefined;
        try {
          observed = await reconcileAgentHostTurn({
            home, scope: "global", roleName: role.name,
            control: { protocol: AGENT_HOST_CONTROL_PROTOCOL, type: "reconcile-turn",
              nativeSessionId: currentProviderConversation(bindingBefore).conversationId,
              attemptId: current.attemptId, nativeTurnId: current.nativeTurnId,
              authority: { epoch: bindingBefore.authority.epoch, owner: "controller",
                holderId: bindingBefore.authority.holderId } }
          });
          if (observed.reconciliation === "unsupported") {
            throw new Error("Host does not advertise reconcile-turn. Preserve the accepted input and original Host; consume retained Inbox evidence or use an explicitly authorized, quiescence-verified refresh.");
          }
          if (observed.outcome === "rejected" || ["idle", "failed", "exited"].includes(observed.snapshot.state)
            && observed.reconciliation !== "terminal-republished") {
            throw new Error(observed.failure?.detail ?? observed.snapshot.detail ?? "Host cannot reconcile this exact terminal.");
          }
        } catch (error) {
          store.transaction(tx => recordGlobalRuntimeAttention(tx, role.name,
            `terminal-reconcile:${currentProviderConversation(bindingBefore).conversationId}:${ownedTurn.attemptId}`,
            { attemptId: ownedTurn.attemptId, nativeTurnId: ownedTurn.nativeTurnId,
              nativeSessionId: currentProviderConversation(bindingBefore).conversationId,
              reason: "host-terminal-unobservable",
              cause: observed === undefined ? "host-control-unavailable"
                : observed.reconciliation === "unsupported" ? "host-control-unsupported"
                : observed.outcome === "rejected" ? "host-control-rejected" : "exact-terminal-not-retained",
              hostState: observed?.snapshot.state ?? null,
              endpointImplementation: observed?.snapshot.endpointImplementation ?? null,
              hostImplementation: observed?.snapshot.hostImplementation ?? null,
              controlCapabilities: observed?.snapshot.controlCapabilities ?? null,
              eventDelivery: observed?.snapshot.eventDelivery ?? null,
              // Endpoint generation is not a loaded Host/package version.
              inputKind: ownedTurn.attemptId.startsWith("direct:") ? "direct" : "managed",
              detail: error instanceof Error ? error.message : String(error),
              recovery: "Inspect the original Host, Session, input and raw Inbox. Controller restart preserves live Hosts; it does not upgrade their loaded observation code. Restore the supported observation path, or explicitly stop/replace with exact native quiescence evidence. Missing eventDelivery means unreported, not healthy. Do not resend unknown input.",
              confirmed: ownedTurn.status, unknown: "Native terminal and remaining writer ownership." },
            options.now ?? new Date()));
          continue;
        }
        sessions = store.getGlobalRoleSessionSet(role.name);
        current = sessions?.providerBinding?.run;
        if (sessions?.sessions[sessions.activeAgentId]?.status !== "active"
          || providerRetryPending(sessions?.providerBinding)
          || hasRuntimeCleanupObligation(store.getWorkMailbox(
            runtimeLifecycleTarget({ scope: "global", roleName: role.name })))) continue;
        pending = store.queryGlobalRoleMessages(role.name, { pending: true, limit: 64 }).messages;
        if (pending.length === 0) continue;
      }
      if (store.queryGlobalRoleMessages(role.name, { handling: true, limit: 0 }).count > 0) continue;
      // Interrupt-then reserves the next legal slot even behind a large queue.
      const reservedPage = store.queryGlobalRoleMessages(role.name, {
        pending: true, interruptThen: true, limit: 64
      });
      const reserved = reservedPage.messages;
      const obsolete = reserved.filter(message => {
        const claim = message.interruptThen;
        return claim !== undefined && (sessions?.activeAgentId !== claim.targetAgentId
          || sessions.sessions[claim.targetAgentId]?.nativeSessionId !== claim.targetNativeSessionId
          || sessions.providerBinding?.authority.epoch !== claim.targetAuthorityEpoch
          || sessions.providerBinding.authority.holderId !== claim.targetAuthorityHolderId);
      });
      for (const message of obsolete) store.updateGlobalRoleMessage(
        markGlobalRoleMessageNotDelivered(message, "native-session-or-authority-changed", new Date()));
      const obsoleteIds = new Set(obsolete.map(message => message.id));
      pending = pending.filter(message => !obsoleteIds.has(message.id));
      if (pending.length === 0) continue;
      if (reservedPage.count > reserved.length && obsolete.length === reserved.length) continue;
      if (current != null && ["submitting", "accepted", "delivery-unknown"].includes(current.status)) continue;
      const matchesTarget = (message: GlobalRoleMessage) => message.deliveryTarget === undefined
        || sessions?.activeAgentId === message.deliveryTarget.agentId
          && sessions.sessions[message.deliveryTarget.agentId]?.nativeSessionId === message.deliveryTarget.nativeSessionId;
      const claims = reserved.filter(message => !obsolete.includes(message));
      let next: GlobalRoleMessage | undefined;
      if (claims.length > 0) {
        next = claims.find(message => {
          const claim = message.interruptThen!;
          const binding = sessions?.providerBinding;
          return current?.attemptId === claim.targetAttemptId
            && ["completed", "failed", "cancelled"].includes(current.status)
            && sessions?.activeAgentId === claim.targetAgentId
            && sessions.sessions[claim.targetAgentId]?.nativeSessionId === claim.targetNativeSessionId
            && binding?.authority.owner === "controller"
            && binding.authority.epoch === claim.targetAuthorityEpoch
            && binding.authority.holderId === claim.targetAuthorityHolderId;
        });
        if (next === undefined) continue;
      } else {
        // Retain each stale original with its exact failure, but do not spend
        // one reconciliation interval per unsent notice before reaching user
        // input for the successor. An existing attempt/uncertain control still
        // fences the queue; target mismatch alone is not non-acceptance.
        next = pending.find(message => {
          if (matchesTarget(message)
            || current?.attemptId === `global-input:${role.name}/${message.id}`
            || message.control !== undefined && message.control.outcome !== "rejected") return true;
          store.updateGlobalRoleMessage(markGlobalRoleMessageNotDelivered(message, "native-session-changed", new Date()));
          return false;
        });
      }
      if (next === undefined || next.inbox !== undefined) continue;
      const attemptId = `global-input:${role.name}/${next.id}`;
      if (current?.attemptId === attemptId) continue;
      if (next.control !== undefined && next.control.outcome !== "rejected") continue;
      if (!matchesTarget(next)) {
        store.updateGlobalRoleMessage(markGlobalRoleMessageNotDelivered(next, "native-session-changed", new Date()));
        continue;
      }
      await ensure(role.name);
      sessions = store.getGlobalRoleSessionSet(role.name);
      if (hasRuntimeCleanupObligation(store.getWorkMailbox(
        runtimeLifecycleTarget({ scope: "global", roleName: role.name })))
        || sessions?.sessions[sessions.activeAgentId]?.status !== "active") continue;
      const binding = sessions?.providerBinding;
      if (binding == null || binding.authority.owner !== "controller") continue;
      const nativeSessionId = currentProviderConversation(binding).conversationId;
      const persisted = store.queryGlobalRoleMessages(role.name, { id: next.id, limit: 1 }).messages[0];
      if (persisted === undefined || persisted.inbox !== undefined || JSON.stringify(persisted) !== JSON.stringify(next)) continue;
      const claim = next.interruptThen;
      if (!matchesTarget(next) || claim !== undefined
        && (sessions?.activeAgentId !== claim.targetAgentId
          || nativeSessionId !== claim.targetNativeSessionId
          || binding.authority.epoch !== claim.targetAuthorityEpoch
          || binding.authority.holderId !== claim.targetAuthorityHolderId
          || binding.run?.attemptId !== claim.targetAttemptId
          || !["completed", "failed", "cancelled"].includes(binding.run.status))) {
        store.updateGlobalRoleMessage(markGlobalRoleMessageNotDelivered(next, "native-session-changed", new Date()));
        continue;
      }
      if (next.deliveryTarget === undefined) {
        next = { ...next, deliveryTarget: { agentId: sessions!.activeAgentId, nativeSessionId } };
        store.updateGlobalRoleMessage(next);
      }
      const result = await sendAgentHostRunControl({
        home, scope: "global", roleName: role.name,
        control: {
          protocol: AGENT_HOST_CONTROL_PROTOCOL, type: "submit-turn", nativeSessionId,
          authority: { epoch: binding.authority.epoch, owner: "controller",
            holderId: binding.authority.holderId! },
          run: { attemptId, boundedText: globalMessagePresentation(role.name, next.id, next) }
        }
      });
      if (result.outcome === "rejected") {
        store.transaction(tx => {
          const latest = tx.queryGlobalRoleMessages(role.name, { id: next!.id, limit: 1 }).messages[0];
          if (latest === undefined || latest.inbox !== undefined || latest.delivery !== undefined || latest.notDelivered !== undefined) return;
          const turn = tx.getGlobalRoleSessionSet(role.name)?.providerBinding?.run;
          if (providerRetryPending(tx.getGlobalRoleSessionSet(role.name)?.providerBinding)) return;
          // A later canonical acceptance wins over transport diagnostics.
          if (turn?.attemptId === attemptId && ["accepted", "completed", "failed", "cancelled"].includes(turn.status)) return;
          const unknown = result.failure?.inputDisposition === "unknown" || result.snapshot.state === "delivery-unknown";
          const updated = { ...latest, control: {
            requestId: latest.inputControl?.requestId ?? latest.interruptThen!.requestId,
            receiptId: attemptId, outcome: unknown ? "delivery-unknown" : "rejected",
            observedAt: new Date().toISOString()
          } } as GlobalRoleMessage;
          tx.updateGlobalRoleMessage(unknown ? updated : markGlobalRoleMessageNotDelivered(updated,
            result.failure?.detail ?? result.snapshot.detail ?? "provider-input-rejected", new Date()));
        });
      }
    } catch (error) {
      onError(new Error(`Global input delivery failed for ${role.name}: `
        + `${error instanceof Error ? error.message : String(error)}. `
        + "Inspect the persisted Message and attempt before retrying; delivery is not inferred.",
      { cause: error }));
    }
  }
}
