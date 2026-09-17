import { createHash } from "node:crypto";
import { createGlobalRoleMessage } from "../message/message.js";
import { serializeAgentErrorRaw } from "../runtime/agentError.js";
import type { TaskStore } from "../storage/taskStore.js";

/** Global observations have no Task event history. Keep original failed
 * attempts as ordinary record-only Messages before replacing the live binding. */
export function recordGlobalRuntimeFailure(
  store: TaskStore, roleName: string, identity: string, facts: unknown, now: Date
): string {
  const header = `Yui Global failure evidence ${createHash("sha256").update(identity).digest("hex")}\n`;
  const previous = store.listGlobalRoleMessages(roleName).find(message =>
    message.kind === "system" && message.body.startsWith(header));
  if (previous !== undefined) return `${roleName}/${previous.id}`;
  const message = createGlobalRoleMessage(store.nextGlobalRoleMessageId(), roleName,
    header + serializeAgentErrorRaw(facts), "system", { type: "system" }, now);
  store.saveGlobalRoleMessage(message);
  return `${roleName}/${message.id}`;
}

/** Reuse the Global Message inbox for an exact failure, not a recovery queue.
 * A failed Operator cannot be asked to retry its own diagnostic automatically. */
export function recordGlobalRuntimeAttention(
  store: TaskStore,
  roleName: string,
  identity: string,
  facts: unknown,
  now: Date
): void {
  // A Home may have a custom Global Role without an Operator. Keep its own
  // diagnostic readable; never create a Role or launch a substitute Agent.
  const recipient = store.getGlobalRole("operator") === null ? roleName : "operator";
  const requestId = `runtime-attention:${createHash("sha256").update(`${roleName}\0${identity}`).digest("hex")}`;
  if (store.listGlobalRoleMessages(recipient).some(message => message.inputControl?.requestId === requestId)) return;
  const message = createGlobalRoleMessage(store.nextGlobalRoleMessageId(), recipient, [
    `Global Role ${roleName} needs attention. No recovery or new authority is implied.`,
    "Inspect the exact Session and original input before choosing a next action; unknown effects must not be replayed.",
    `Original failed attempts remain in Role ${roleName}'s record-only failure Messages; failureRef names the latest evidence.`,
    serializeAgentErrorRaw(facts)
  ].join("\n"), "system", { type: "system" }, now, { inputControl: { action: "queue", requestId } });
  store.saveGlobalRoleMessage(recipient === roleName ? {
    ...message,
    notDelivered: { reason: "runtime-needs-attention; retained for user or successor inspection", at: now.toISOString() }
  } : message);
}
