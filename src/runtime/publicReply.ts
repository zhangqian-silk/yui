/** Volatile public streaming projection only. History remains native-owned;
 * this cannot authorize execution or prove a terminal. */
export type PublicReply = Readonly<{
  nativeSessionId: string; turnId: string; id: string; text: string; truncated: boolean;
}>;

export function foldPublicReply(
  previous: PublicReply | undefined, nativeSessionId: string,
  method: string, params: Readonly<Record<string, unknown>>
): PublicReply | undefined {
  if (params.threadId !== nativeSessionId) return previous;
  if (method === "turn/started") return undefined;
  if (typeof params.turnId !== "string") return previous;
  if (method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
    const same = previous?.id === params.itemId && previous.turnId === params.turnId;
    const text = (same ? previous!.text : "") + params.delta;
    return { nativeSessionId, turnId: params.turnId, id: params.itemId,
      text: text.slice(0, 6000), truncated: text.length > 6000 || !!(same && previous!.truncated) };
  }
  if ((method === "item/started" || method === "item/completed")
    && params.item !== null && typeof params.item === "object") {
    const item = params.item as Record<string, unknown>;
    if (item.type === "agentMessage" && typeof item.id === "string" && typeof item.text === "string") {
      return { nativeSessionId, turnId: params.turnId, id: item.id,
        text: item.text.slice(0, 6000), truncated: item.text.length > 6000 };
    }
  }
  return previous;
}
