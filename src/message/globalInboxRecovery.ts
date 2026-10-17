import { createHash } from "node:crypto";
import type { TaskStore } from "../storage/taskStore.js";
import { createGlobalRoleMessage, type GlobalRoleMessage } from "./message.js";
import { hasRuntimeCleanupObligation, runtimeLifecycleTarget } from "../runtime/lifecycleReservation.js";
import { currentProviderConversation } from "../runtime/providerRuntimeIdentity.js";
import { INBOX_CHECK_PREFIX } from "./inboxTurn.js";

const requestId = (agentId: string, nativeSessionId: string) => `${INBOX_CHECK_PREFIX}recovery:${
  createHash("sha256").update(JSON.stringify([agentId, nativeSessionId])).digest("hex")}`;

/** Derive a single initialization notice from existing retained claims. New
 * Sessions are created only by the existing authorized lifecycle path. A
 * restart can finish notice creation, but cannot select or replace a Session. */
export function globalInboxRecovery(store: TaskStore, roleName: string, now: Date): GlobalRoleMessage | undefined {
  return store.transaction(tx => {
    const sessions = tx.getGlobalRoleSessionSet(roleName);
    const session = sessions?.sessions[sessions.activeAgentId];
    const binding = sessions?.providerBinding;
    if (!session || session.status !== "active" || !session.nativeSessionId || !binding
      || binding.authority.owner !== "controller"
      || currentProviderConversation(binding).conversationId !== session.nativeSessionId
      || binding.run && ["submitting", "accepted", "delivery-unknown"].includes(binding.run.status)
      || hasRuntimeCleanupObligation(tx.getWorkMailbox(runtimeLifecycleTarget({ scope: "global", roleName })))) return;
    if (tx.queryGlobalRoleMessages(roleName, { handling: true, handlingExceptSession: {
      agentId: session.agentId, nativeSessionId: session.nativeSessionId
    }, limit: 0 }).count === 0) return;
    const id = requestId(session.agentId, session.nativeSessionId);
    const existing = tx.queryGlobalRoleMessages(roleName, { requestId: id, limit: 1 }).messages[0];
    if (existing) return existing;
    const notice = {
      ...createGlobalRoleMessage(tx.nextGlobalRoleMessageId(), roleName, [
        "Yui-Summary: This successor has retained inbox handling obligations; inspect original evidence before settlement.",
        "Read current Session Context and yui inbox list --view history --json. Read the exact original, original claim and prior effects.",
        "This is initialization only: do not replay old input, retarget its delivery, or infer business completion.",
        "After handling under current authority, explicitly acknowledge the original entry without replacing its claim.",
        "Uncertain external effects require verification or a real user decision. New queued input remains separate."
      ].join("\n"), "system", { type: "system" }, now, {
        inputControl: { action: "queue", requestId: id, expectedSessionId: session.nativeSessionId }
      }),
      deliveryTarget: { agentId: session.agentId, nativeSessionId: session.nativeSessionId }
    };
    tx.saveGlobalRoleMessage(notice);
    return notice;
  });
}
