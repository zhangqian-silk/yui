import type { AgentHostEventDelivery } from "./agentHostProtocol.js";

export type HostUpgradeFence = Readonly<{
  requestId: string;
  nativeSessionId: string;
  processInstanceId: string;
  hostGeneration: string;
}>;
export type HostUpgradeObservation = HostUpgradeFence & Readonly<{
  state: "waiting" | "drained" | "failed";
  detail?: string;
}>;

/** Host-local input admission fence. The existing lifecycle mailbox owns the
 * durable request; this gate owns only the actual loaded process's drain. */
export function createHostUpgradeGate() {
  let current: HostUpgradeObservation | undefined;
  let draining: Promise<void> | undefined;
  return {
    get observation() { return current; },
    get fenced() { return current !== undefined; },
    request(fence: HostUpgradeFence, identity: Omit<HostUpgradeFence, "requestId">) {
      if (fence.nativeSessionId !== identity.nativeSessionId
        || fence.processInstanceId !== identity.processInstanceId
        || fence.hostGeneration !== identity.hostGeneration) throw new Error("Host upgrade identity changed.");
      if (current && (fence.requestId !== current.requestId || fence.nativeSessionId !== current.nativeSessionId
        || fence.processInstanceId !== current.processInstanceId || fence.hostGeneration !== current.hostGeneration)) {
        throw new Error("Host already holds a different upgrade request.");
      }
      current ??= { requestId: fence.requestId, nativeSessionId: fence.nativeSessionId,
        processInstanceId: fence.processInstanceId, hostGeneration: fence.hostGeneration, state: "waiting" };
    },
    async drain(input: {
      busy: boolean;
      events: AgentHostEventDelivery;
      checkQuiescent(): Promise<boolean>;
      release(): Promise<void>;
    }) {
      if (!current || current.state !== "waiting") return;
      if (input.busy || input.events.pending !== 0 || input.events.pendingTerminals !== 0
        || input.events.unpersisted !== 0 || input.events.failure !== undefined) return;
      draining ??= (async () => {
        try {
          if (!await input.checkQuiescent()) return;
          await input.release();
          current = { ...current!, state: "drained" };
        } catch (error) {
          current = { ...current!, state: "failed",
            detail: error instanceof Error ? error.message : String(error) };
        }
      })();
      await draining;
      draining = undefined;
    }
  };
}
