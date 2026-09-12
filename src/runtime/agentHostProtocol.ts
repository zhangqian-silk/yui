import { createSessionOwnerIdentity, type SessionOwnerIdentity } from "./sessionOwnerIdentity.js";

/** Independent of CLI/RPC and Home schema. Keep v1 readable while v1 Hosts live. */
export const AGENT_HOST_EVENT_PROTOCOL = "yui-agent-host-events/v1" as const;
export const AGENT_HOST_CONTROL_PROTOCOL = "yui-agent-host/v5" as const;

export type AgentHostCompatibility = Readonly<{
  control: typeof AGENT_HOST_CONTROL_PROTOCOL;
  events: typeof AGENT_HOST_EVENT_PROTOCOL;
  rpc: number;
  storage: "controller-owned";
}>;

export type AgentHostEventDelivery = Readonly<{
  pending: number;
  pendingTerminals: number;
  failure?: Readonly<{
    stage: "persistence" | "controller";
    detail: string;
    observedAt: string;
  }>;
}>;

/** Untrusted ingress metadata, not a resolved Task/Run authority. No environment or secrets. */
export type AgentHostObservationSource = Readonly<{
  protocol: typeof AGENT_HOST_EVENT_PROTOCOL;
  adapterId: string;
  workspace: string;
  /** Only Session startup may use this explicit launch identity. Never a late event fallback. */
  startupRunId?: string;
  connection?: Readonly<{
    processOwner?: SessionOwnerIdentity;
    account?: Readonly<{ home: string; codexHome: string; nativeAccountHome?: string }>;
  }>;
}>;

export function readAgentHostObservationSource(value: unknown): AgentHostObservationSource {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent Host observation source is invalid.");
  }
  const source = value as AgentHostObservationSource;
  if (source.protocol !== AGENT_HOST_EVENT_PROTOCOL) {
    throw new Error("Agent Host event protocol is unsupported.");
  }
  if (source.connection !== undefined && (source.connection === null
    || typeof source.connection !== "object" || Array.isArray(source.connection))) {
    throw new Error("Agent Host connection evidence is invalid.");
  }
  if (source.connection?.processOwner !== undefined
    && (source.connection.processOwner.schemaVersion !== 2
      || source.connection.processOwner.kind !== "yui-session-owner")) {
    throw new Error("Agent Host process custody wire contract is invalid.");
  }
  const text = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > 4096) {
      throw new Error("Agent Host observation identity is invalid.");
    }
    return value;
  };
  return {
    protocol: AGENT_HOST_EVENT_PROTOCOL,
    adapterId: text(source.adapterId),
    workspace: text(source.workspace),
    ...(source.startupRunId === undefined ? {} : { startupRunId: text(source.startupRunId) }),
    ...(source.connection === undefined ? {} : {
      connection: {
        ...(source.connection.processOwner === undefined ? {} : {
          processOwner: createSessionOwnerIdentity({
            ...source.connection.processOwner,
            recordedAt: new Date(source.connection.processOwner.recordedAt)
          })
        }),
        ...(source.connection.account === undefined ? {} : {
          account: {
            home: text(source.connection.account.home),
            codexHome: text(source.connection.account.codexHome),
            ...(source.connection.account.nativeAccountHome === undefined ? {} : {
              nativeAccountHome: text(source.connection.account.nativeAccountHome)
            })
          }
        })
      }
    })
  };
}
