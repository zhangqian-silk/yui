/** Only explicit, identity-bound native lifecycle events invalidate context.
 * Absence of an event never proves that instructions are still in memory. */
export function isNativeContextRecovery(
  adapter: "codex" | "claude",
  nativeSessionId: string,
  message: Readonly<Record<string, unknown>>
): boolean {
  if (adapter === "claude") {
    return message.type === "system" && message.subtype === "compact_boundary"
      && message.session_id === nativeSessionId;
  }
  const params = message.params as Record<string, unknown> | undefined;
  if (!params || params.threadId !== nativeSessionId) return false;
  if (message.method === "thread/compacted") return true;
  const item = params.item as Record<string, unknown> | undefined;
  return message.method === "item/completed" && item?.type === "contextCompaction";
}
