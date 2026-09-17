import {
  AgentDriverRegistry,
  type AgentDriverCapabilities,
  type AgentDriver,
  type AgentDriverMappedHook,
  type AgentDriverNativeHook
} from "./agentDriver.js";
import type {
  RuntimeObservationKind,
  RuntimeObservationPayload
} from "./runtimeObservation.js";
import {
  claudeTranscriptObserver,
  codexTranscriptObserver,
  transcriptObserverSource
} from "./builtinTranscriptObserver.js";
import {
  mapAcpAgentError,
  mapClaudeAgentError,
  mapCodexAgentError
} from "./builtinAgentErrorMappers.js";
import { serializeAgentErrorRaw, standardAgentError } from "./agentError.js";
import { transportAgentResult } from "../domain/agentResultTransport.js";

export const CODEX_DRIVER_ID = "openai/codex";
export const CLAUDE_CODE_DRIVER_ID = "anthropic/claude-code";
/**
 * The Agent Client Protocol Driver is named after the protocol, not a product:
 * every ACP Agent is observed through this one entry, so adding a second ACP
 * CLI needs a launch descriptor and no new Driver.
 */
export const ACP_DRIVER_ID = "acp/agent-client-protocol";

export function builtinDriverIdForAdapter(adapterId: string): string {
  return builtinAgentDriverRegistry().requireByAdapterId(adapterId).id;
}

const STRUCTURED_CLI_CAPABILITIES: AgentDriverCapabilities = Object.freeze({
  surfaces: Object.freeze(["interactive-cli", "managed-protocol"] as const),
  lifecycle: Object.freeze({
    host: "persistent" as const,
    providerProcess: "persistent" as const,
    nativeConversationResume: "exact" as const,
    // Yui deliberately does not guess provider compaction behavior from token
    // counters. A future Driver may upgrade these only with exact native facts.
    compaction: "unknown" as const,
    compactionEvents: "unavailable" as const,
    contextUsage: "cumulative-only" as const,
    inSessionContinuation: true,
    deliveryDeduplication: "unsupported" as const
  }),
  control: Object.freeze({
    start: true,
    resume: true,
    sendTurn: true,
    interrupt: true,
    // Conservative default: a Driver that has not stated otherwise is assumed
    // to cancel by stopping the process Yui owns.
    interruptDelivery: "owned-process" as const,
    stop: true
  }),
  conversation: Object.freeze({
    persistentIdentity: "exact" as const,
    crossProcessResume: true,
    readback: "partial" as const
  }),
  input: Object.freeze({
    startTurn: true,
    steer: "fenced" as const,
    inject: "unavailable" as const,
    acceptance: "exact" as const,
    idempotency: "unavailable" as const
  }),
  descendants: Object.freeze({
    lineage: "partial" as const,
    detachedQuery: "partial" as const,
    resultRouting: "partial" as const
  }),
  bounded: Object.freeze({ structuredTerminal: true }),
  observation: Object.freeze({
    sessionIdentity: "exact",
    sessionBootstrap: "discovered",
    preInputReadiness: "unavailable",
    promptAcceptance: "exact",
    turnLifecycle: "exact",
    goalLifecycle: "partial",
    // Transcript sources may emit an explicit activity identity separately
    // from usage snapshots. Numeric token values never decide runtime health.
    operations: Object.freeze(["tool", "subagent"] as const),
    waiting: Object.freeze(["permission"] as const),
    usage: "streaming-cumulative",
    delivery: "ordered-best-effort"
  })
});

export const BUILTIN_AGENT_DRIVERS: readonly AgentDriver[] = Object.freeze([
  Object.freeze({
    id: CLAUDE_CODE_DRIVER_ID,
    label: "Claude Code",
    protocolVersion: 1,
    adapterId: "claude",
    capabilities: Object.freeze({
      ...STRUCTURED_CLI_CAPABILITIES,
      input: Object.freeze({
        ...STRUCTURED_CLI_CAPABILITIES.input,
        // Serialized stream input is not exact native steering.
        steer: "unavailable" as const
      }),
      observation: Object.freeze({
        ...STRUCTURED_CLI_CAPABILITIES.observation,
        sessionBootstrap: "preallocated" as const,
        preInputReadiness: "exact" as const,
        usage: "event-snapshot" as const
      })
    }),
    runtime: Object.freeze({
      nativeSessionId: ({ payload }: AgentDriverNativeHook) => (
        optionalIdentityFrom(payload, ["session_id"])
      ),
      nativeTurnId: ({ hookEventName, payload }: AgentDriverNativeHook) => (
        optionalIdentityFrom(payload, hookEventName === "MessageDisplay"
          ? ["prompt_id", "turn_id"] : ["prompt_id"])
      ),
      mapError: mapClaudeAgentError,
      mapHook: ({ hookEventName, payload, occurrenceId }: AgentDriverNativeHook) => (
        mapClaudeHook(hookEventName, payload, occurrenceId)
      ),
      classifyHook: ({ hookEventName, payload }: AgentDriverNativeHook) => Object.freeze({
        ...(hookEventName === "SessionStart" && payload.source === "startup"
          ? { startupSession: "preallocated" as const }
          : {}),
        terminal: isTerminalHook(hookEventName),
        ...(hookEventName !== "SubagentStop" ? {} : {
          continuationId: firstIdentity(payload, ["agent_id"], "Claude subagent id"),
        })
      }),
      observer: Object.freeze({
        source: (input: AgentDriverNativeHook) => transcriptObserverSource(
          CLAUDE_CODE_DRIVER_ID,
          input
        ),
        sample: claudeTranscriptObserver
      })
    })
  }),
  Object.freeze({
    id: CODEX_DRIVER_ID,
    label: "Codex",
    protocolVersion: 1,
    adapterId: "codex",
    capabilities: Object.freeze({
      ...STRUCTURED_CLI_CAPABILITIES,
      surfaces: Object.freeze(["interactive-cli", "managed-protocol"] as const),
      conversation: Object.freeze({
        persistentIdentity: "exact" as const,
        crossProcessResume: true,
        readback: "exact" as const
      }),
      input: Object.freeze({
        startTurn: true,
        steer: "fenced" as const,
        inject: "fenced" as const,
        acceptance: "exact" as const,
        idempotency: "unavailable" as const
      }),
      control: Object.freeze({
        ...STRUCTURED_CLI_CAPABILITIES.control,
        // Managed Codex interrupts its Turn through the App Server, which
        // leaves the Session (and its process) alive.
        interruptDelivery: "native" as const
      }),
      descendants: Object.freeze({
        lineage: "partial" as const,
        detachedQuery: "partial" as const,
        resultRouting: "partial" as const
      }),
      observation: Object.freeze({
        ...STRUCTURED_CLI_CAPABILITIES.observation,
        // Managed Codex uses its Yui-owned proxy subscription to the shared
        // App Server event stream.
        // Turn lifecycle is exact; Yui does not install per-thread Hooks merely
        // to manufacture tool/wait/usage observations.
        operations: Object.freeze([] as const),
        waiting: Object.freeze([] as const),
        goalLifecycle: "exact" as const,
        usage: "unavailable" as const
      })
    }),
    runtime: Object.freeze({
      nativeSessionId: ({ payload }: AgentDriverNativeHook) => (
        optionalIdentityFrom(payload, ["session_id"])
      ),
      nativeTurnId: ({ payload }: AgentDriverNativeHook) => (
        optionalIdentityFrom(payload, ["turn_id", "prompt_id"])
      ),
      mapError: mapCodexAgentError,
      mapHook: ({ hookEventName, payload, occurrenceId }: AgentDriverNativeHook) => (
        mapCodexHook(hookEventName, payload, occurrenceId)
      ),
      classifyHook: ({ hookEventName, payload }: AgentDriverNativeHook) => Object.freeze({
        ...(hookEventName === "SessionStart"
          ? { startupSession: "discovered" as const }
          : {}),
        terminal: isTerminalHook(hookEventName),
        ...(hookEventName !== "SubagentStop" ? {} : {
          continuationId: subagentId(payload),
        })
      }),
      observer: Object.freeze({
        source: (input: AgentDriverNativeHook) => transcriptObserverSource(
          CODEX_DRIVER_ID,
          input
        ),
        sample: codexTranscriptObserver
      })
    })
  }),
  Object.freeze({
    id: ACP_DRIVER_ID,
    label: "Agent Client Protocol",
    protocolVersion: 1,
    adapterId: "acp",
    /**
     * Declared from ACP v1 itself, not from any product's abilities.
     *
     * ACP is a client-driven JSON-RPC protocol: Yui owns the pipe and learns
     * everything from request/response pairs, so there is no Hook ingress and
     * no transcript file to sample. Several capabilities are therefore
     * genuinely unavailable rather than merely unimplemented, and saying so is
     * what keeps managed admission fail-closed.
     */
    capabilities: Object.freeze({
      // No interactive surface: `acp` mode is a machine protocol on stdio.
      surfaces: Object.freeze(["managed-protocol"] as const),
      lifecycle: Object.freeze({
        host: "persistent" as const,
        providerProcess: "persistent" as const,
        // `session/load` is ACP's exact Conversation resume, so the protocol
        // does define one and managed admission — which runs adapter-wide,
        // before any connection exists — is right to see it here. What a
        // *given* Agent implements is negotiated per connection via
        // `agentCapabilities.loadSession`, and that answer cannot be predicted
        // by a static table. The live Session therefore reports its own
        // recoverability after the handshake, and that value, not this one, is
        // what gets published and stored. An Agent that never advertised
        // `loadSession` also fails loudly inside `session/load` rather than
        // silently degrading a running Turn.
        nativeConversationResume: "exact" as const,
        compaction: "unknown" as const,
        compactionEvents: "unavailable" as const,
        contextUsage: "unavailable" as const,
        inSessionContinuation: true,
        deliveryDeduplication: "unsupported" as const
      }),
      control: Object.freeze({
        start: true,
        resume: true,
        sendTurn: true,
        // `session/cancel` is a notification the Agent MUST answer with the
        // `cancelled` stop reason, but halting the work is only a SHOULD.
        interrupt: true,
        interruptDelivery: "native" as const,
        stop: true
      }),
      conversation: Object.freeze({
        // `session/new` returns the Agent's own Session id.
        persistentIdentity: "exact" as const,
        // Same as `nativeConversationResume`: `session/load` is how ACP carries
        // a Conversation across processes, so the capability exists. Whether
        // this Agent honours it is the live Session's answer, not this table's.
        crossProcessResume: true,
        // `session/load` replays the Conversation, but ACP exposes no way to
        // read back a Session's history without reloading it.
        readback: "unavailable" as const
      }),
      input: Object.freeze({
        startTurn: true,
        // One Turn is one `session/prompt` request; ACP defines no way to add
        // input to a Turn already in flight.
        steer: "unavailable" as const,
        inject: "unavailable" as const,
        // The prompt response IS the terminal, so ACP defines no separate
        // acceptance message. This is a permanent protocol fact, not a
        // per-Agent gap: a completed pipe write is all that can be observed
        // before the Turn's own result arrives.
        acceptance: "unavailable" as const,
        idempotency: "unavailable" as const
      }),
      descendants: Object.freeze({
        lineage: "unavailable" as const,
        detachedQuery: "unavailable" as const,
        resultRouting: "unavailable" as const
      }),
      // The prompt response carries an explicit stopReason, which is an exact
      // structured terminal for the Turn that requested it.
      bounded: Object.freeze({ structuredTerminal: true }),
      observation: Object.freeze({
        sessionIdentity: "exact" as const,
        sessionBootstrap: "discovered" as const,
        // ACP has no "ready" signal beyond `initialize` answering.
        preInputReadiness: "unavailable" as const,
        promptAcceptance: "unavailable" as const,
        // The terminal status and its correlation to the exact request are
        // both exact. What ACP lacks is intermediate progress, which is
        // recorded as absent operations and usage rather than by understating
        // the lifecycle Yui does observe.
        turnLifecycle: "exact" as const,
        goalLifecycle: "unavailable" as const,
        operations: Object.freeze([] as const),
        waiting: Object.freeze([] as const),
        usage: "unavailable" as const,
        delivery: "host-only" as const
      })
    }),
    runtime: Object.freeze({
      // ACP delivers no Hooks. Identity comes from the protocol Session the
      // managed Endpoint already holds, so there is no payload to mine here —
      // and inventing a Turn id from a JSON-RPC request id would present a
      // Yui-owned value as a Provider identity.
      nativeSessionId: ({ payload }: AgentDriverNativeHook) => (
        optionalIdentityFrom(payload, ["sessionId"])
      ),
      nativeTurnId: () => undefined,
      mapError: mapAcpAgentError,
      mapHook: ({ hookEventName }: AgentDriverNativeHook): readonly MappedHook[] => {
        throw new Error(`ACP Driver receives no native Hooks: ${hookEventName}.`);
      },
      classifyHook: ({ hookEventName }: AgentDriverNativeHook) => {
        throw new Error(`ACP Driver receives no native Hooks: ${hookEventName}.`);
      }
    })
  })
]);

export function builtinAgentDriverRegistry(): AgentDriverRegistry {
  const registry = new AgentDriverRegistry();
  for (const descriptor of BUILTIN_AGENT_DRIVERS) registry.register(descriptor);
  return registry;
}

type MappedHook = AgentDriverMappedHook;

function mapClaudeHook(
  name: string,
  payload: Readonly<Record<string, unknown>>,
  occurrenceId?: string
): MappedHook | readonly MappedHook[] {
  switch (name) {
    case "SessionStart":
      return [
        payload.source === "startup"
          ? mapped("session.ready")
          : mapped("session.started"),
        mapped("conversation.observed", { recoverability: "recoverable" })
      ];
    case "UserPromptSubmit":
      return mapped("turn.accepted");
    case "PreToolUse":
      return operation("operation.started", "tool", firstIdentity(payload, ["tool_use_id"], "Claude tool id"));
    case "PostToolUse":
      return operation("operation.completed", "tool", firstIdentity(payload, ["tool_use_id"], "Claude tool id"));
    case "PostToolUseFailure":
      return operation("operation.failed", "tool", firstIdentity(payload, ["tool_use_id"], "Claude tool id"));
    case "PermissionRequest":
      return mapped("turn.waiting", {
        reason: "permission",
        waitId: requireOccurrence(occurrenceId)
      });
    case "MessageDisplay": {
      const messageId = optionalIdentityFrom(payload, ["message_id"]);
      const index = typeof payload.index === "number" && Number.isSafeInteger(payload.index)
        ? String(payload.index)
        : undefined;
      return mapped("activity.observed", {
        activity: "model",
        activityId: messageId === undefined
          ? requireOccurrence(occurrenceId)
          : `${messageId}:${index ?? "message"}`
      });
    }
    case "SubagentStart": {
      const continuationId = firstIdentity(payload, ["agent_id"], "Claude subagent id");
      return [
        operation("operation.started", "subagent", continuationId),
        mapped("continuation.started", {
          execution: "active",
          outcome: "pending",
          attachment: "attached",
          observationQuality: "exact",
          mayWriteWorkspace: true
        }, { continuationId })
      ];
    }
    case "SubagentStop": {
      const continuationId = firstIdentity(payload, ["agent_id"], "Claude subagent id");
      const summary = claudeSummary(payload);
      return [
        operation("operation.completed", "subagent", continuationId),
        ...(summary.summary === undefined ? [] : [
          mapped("continuation.reported", {
            execution: "quiescent",
            outcome: "unknown",
            attachment: "attached",
            observationQuality: "exact",
            mayWriteWorkspace: false,
            reportId: continuationId,
            ...summary
          }, { continuationId })
        ]),
        mapped("continuation.settled", {
          execution: "quiescent",
          // SubagentStop also fires on interrupted queries. Its current
          // payload has no outcome/status field; a report is not success.
          outcome: "unknown",
          attachment: "attached",
          observationQuality: "exact",
          mayWriteWorkspace: false,
          ...summary
        }, { continuationId })
      ];
    }
    case "Stop": {
      const complete = claudeBackgroundEmpty(payload);
      return [
        mapped("turn.completed", optionalResultOutput(payload)),
        mapped("native-work.snapshot", {
          // Current Stop fields are optional lists, never the invented
          // background_tasks_complete boolean. Only explicit empty lists
          // prove that no background work or scheduled wake remains.
          snapshotComplete: complete,
          observationQuality: complete ? "exact" : "partial"
        })
      ];
    }
    case "StopFailure":
      return mapped("turn.failed", claudeFailure(payload));
    case "SessionEnd":
      // Native CLI exit ends this local Provider attachment, not the
      // resumable Conversation. Durable Session end is an explicit Yui
      // mutation or a Provider fact that the Conversation is unrecoverable.
      return [];
    default:
      throw new Error(`Claude Code Driver does not support Hook event: ${name}.`);
  }
}

function claudeSummary(payload: Readonly<Record<string, unknown>>): RuntimeObservationPayload {
  const summary = optionalText(payload.last_assistant_message);
  return summary === undefined ? {} : { summary };
}

function claudeBackgroundEmpty(payload: Readonly<Record<string, unknown>>): boolean {
  return Array.isArray(payload.background_tasks) && payload.background_tasks.length === 0
    && Array.isArray(payload.session_crons) && payload.session_crons.length === 0;
}

function mapCodexHook(
  name: string,
  payload: Readonly<Record<string, unknown>>,
  occurrenceId?: string
): MappedHook | readonly MappedHook[] {
  switch (name) {
    case "SessionStart":
      return [
        mapped("session.started"),
        mapped("conversation.observed", { recoverability: "recoverable" })
      ];
    case "UserPromptSubmit":
      return mapped("turn.accepted");
    case "PreToolUse":
      return operation("operation.started", "tool", toolId(payload));
    case "PostToolUse":
      return operation("operation.completed", "tool", toolId(payload));
    case "PostToolUseFailure":
      return operation("operation.failed", "tool", toolId(payload));
    case "PermissionRequest":
      return mapped("turn.waiting", {
        reason: "permission",
        waitId: optionalIdentityFrom(payload, ["tool_use_id", "call_id", "tool_call_id"])
          ?? requireOccurrence(occurrenceId)
      });
    case "SubagentStart":
      return [
        operation("operation.started", "subagent", subagentId(payload)),
        continuationObservation("continuation.started", payload, {
          execution: "active",
          outcome: "pending",
          attachment: "attached",
          observationQuality: "partial",
          mayWriteWorkspace: true
        })
      ];
    case "SubagentStop":
      return [
        operation("operation.completed", "subagent", subagentId(payload)),
        continuationObservation("continuation.reported", payload, {
          execution: "unknown",
          outcome: "unknown",
          attachment: "attached",
          observationQuality: "partial",
          mayWriteWorkspace: true,
          reportId: reportId(payload),
          ...optionalSummary(payload)
        })
      ];
    case "Stop":
      return mapped("turn.completed", optionalResultOutput(payload));
    case "SessionEnd":
      return [];
    default:
      throw new Error(`Codex Driver does not support Hook event: ${name}.`);
  }
}

function mapped(
  kind: RuntimeObservationKind,
  payload: RuntimeObservationPayload = {},
  fence?: AgentDriverMappedHook["fence"]
): MappedHook {
  return Object.freeze({
    kind,
    payload: Object.freeze({ ...payload }),
    ...(fence === undefined ? {} : { fence: Object.freeze({ ...fence }) })
  });
}

function continuationObservation(
  kind: "continuation.started" | "continuation.reported" | "continuation.settled",
  native: Readonly<Record<string, unknown>>,
  payload: RuntimeObservationPayload
): MappedHook {
  const continuationId = subagentId(native);
  return mapped(kind, payload, {
    continuationId,
    ...(optionalIdentityFrom(native, ["parent_agent_id", "parent_subagent_id"]) === undefined
      ? {}
      : {
          parentContinuationId: optionalIdentityFrom(
            native,
            ["parent_agent_id", "parent_subagent_id"]
          )
        })
  });
}

function reportId(payload: Readonly<Record<string, unknown>>): string {
  return optionalIdentityFrom(payload, ["report_id", "message_id", "agent_id", "subagent_id"])
    ?? subagentId(payload);
}

function operation(
  kind: "operation.started" | "operation.completed" | "operation.failed",
  operationKind: "tool" | "subagent",
  operationId: string
): MappedHook {
  return mapped(kind, { operationId, operation: operationKind });
}

function toolId(payload: Readonly<Record<string, unknown>>): string {
  return firstIdentity(payload, ["tool_use_id", "call_id", "tool_call_id"], "Tool operation id");
}

function subagentId(payload: Readonly<Record<string, unknown>>): string {
  return firstIdentity(payload, ["agent_id", "subagent_id"], "Subagent operation id");
}

function firstIdentity(
  payload: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  label: string
): string {
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "string" && value.trim().length > 0 && !value.includes("\0")) {
      return value.trim();
    }
  }
  throw new Error(`${label} is required.`);
}

function optionalIdentityFrom(
  payload: Readonly<Record<string, unknown>>,
  fields: readonly string[]
): string | undefined {
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "string" && value.trim().length > 0 && !value.includes("\0")) {
      return value.trim();
    }
  }
  return undefined;
}

function optionalSummary(
  payload: Readonly<Record<string, unknown>>,
  preferred = "last_assistant_message"
): RuntimeObservationPayload {
  for (const field of [preferred, "summary", "message"]) {
    const value = payload[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return { summary: value.trim() };
    }
  }
  return {};
}

function optionalResultOutput(
  payload: Readonly<Record<string, unknown>>
): RuntimeObservationPayload {
  const result = transportAgentResult(payload.last_assistant_message);
  return result.status === "completed"
    ? { output: result.output }
    : { resultTransportDiagnostic: result.diagnostic };
}

function claudeFailure(
  payload: Readonly<Record<string, unknown>>
): RuntimeObservationPayload {
  const code = firstIdentity(payload, ["error"], "Claude StopFailure error");
  const details = optionalText(payload.error_details);
  const lastOutput = optionalText(payload.last_assistant_message);
  const raw = serializeAgentErrorRaw(payload);
  const classification = mapClaudeAgentError({ message: code, raw });
  return {
    failure: {
      error: standardAgentError({
        source: "provider",
        phase: "turn-execute",
        classification,
        message: code,
        raw,
        inputDisposition: "accepted"
      }),
      ...(lastOutput === undefined ? {} : { lastOutput })
    },
    summary: [
      "Agent turn failed.",
      `error: ${code}`,
      ...(details === undefined ? [] : [`details: ${details}`]),
      ...(lastOutput === undefined ? [] : [`last_output: ${lastOutput}`])
    ].join("\n")
  };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isTerminalHook(name: string): boolean {
  return name === "Stop" || name === "StopFailure" || name === "SessionEnd";
}

function requireOccurrence(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error("Agent Driver Hook occurrence id is required.");
  }
  return value;
}
