import {
  normalizedUniqueText,
  requireIdentity,
  requireText
} from "../domain/validation.js";
import {
  validateContextSnapshotRef,
  type ContextSnapshotRef
} from "./contextSnapshot.js";

export const RUN_INPUT_PROTOCOL_VERSION = 1 as const;
export const RUN_INPUT_PROTOCOL = "yui-run/v1" as const;
export const RUN_INPUT_MAX_BYTES = 4 * 1024;
export const RUN_INPUT_MAX_DELTAS = 16;

export type AgentRunPurpose = "execution" | "review" | "global" | "planning";
export const YUI_RUN_INPUT_CHANNELS = [
  "user-message",
  "input-response",
  "task-dispatch",
  "workitem-dispatch",
  "message-continuation",
  "leader-wakeup",
  "leader-forced-wakeup"
] as const;

/**
 * Audit-only provenance for the party that submitted this input to the
 * Provider. Every input routed through Yui is `type: "yui"`, including a
 * relayed human message. Native provider UI input remains `user/direct`.
 */
export type AgentRunInputSource =
  | Readonly<{
      type: "yui";
      channel: typeof YUI_RUN_INPUT_CHANNELS[number];
    }>
  | Readonly<{ type: "user"; channel: "direct" }>
  | Readonly<{ type: "provider"; channel: "goal-continuation" | "visible-input" }>;
export type AgentRunSubject = Readonly<{
  taskId?: string;
  workItemId?: string;
  reviewRoundId?: string;
  executionGroupId?: string;
  executionLaneId?: string;
  sourceExecutionGroupId?: string;
}>;

export type AgentRunInput = Readonly<{
  schemaVersion: typeof RUN_INPUT_PROTOCOL_VERSION;
  source: AgentRunInputSource;
  directive?: string;
  /** Required on a Task Run's first input; optional on subsequent or Global inputs. */
  contextSnapshotRef?: ContextSnapshotRef;
  deltaRefIds: readonly string[];
}>;

export type AgentRunInputEnvelopeContext = Readonly<{
  runId: string;
  roleName: string;
  purpose: AgentRunPurpose;
  subject: AgentRunSubject;
}>;

export type AgentRunInputEnvelope = Readonly<{
  protocol: typeof RUN_INPUT_PROTOCOL;
  runId: string;
  source: AgentRunInputSource;
  roleName: string;
  purpose: AgentRunPurpose;
  subject: AgentRunSubject;
  contextSnapshotRef?: ContextSnapshotRef;
  deltaRefIds: readonly string[];
}>;

export function createRunInput(
  input: Omit<AgentRunInput, "schemaVersion">
): AgentRunInput {
  const common = normalizeInput(input);
  return Object.freeze({
    schemaVersion: RUN_INPUT_PROTOCOL_VERSION,
    ...common,
    ...(input.directive === undefined
      ? {}
      : { directive: requireText(input.directive, "AgentRun input directive") })
  });
}

export function validateRunInput(value: AgentRunInput): AgentRunInput {
  if (value.schemaVersion !== RUN_INPUT_PROTOCOL_VERSION) {
    throw new Error("AgentRun input must use schemaVersion 1.");
  }
  const normalized = createRunInput(value);
  if (JSON.stringify(normalized) !== JSON.stringify(value)) {
    throw new Error("AgentRun input is not canonical.");
  }
  return value;
}

/** Execution must never substitute current Task facts for missing frozen evidence. */
export function requireRunContextSnapshotRef(
  input: Pick<AgentRunInput, "contextSnapshotRef">
): ContextSnapshotRef {
  if (input.contextSnapshotRef === undefined) {
    throw new Error("AgentRun Context Snapshot is required; preserve missing evidence for diagnosis.");
  }
  return validateContextSnapshotRef(input.contextSnapshotRef);
}

export function createRunInputEnvelope(
  context: AgentRunInputEnvelopeContext,
  input: AgentRunInput
): AgentRunInputEnvelope {
  validateRunInput(input);
  const normalized = normalizeEnvelopeContext(context, input);
  return Object.freeze({
    protocol: RUN_INPUT_PROTOCOL,
    runId: normalized.runId,
    source: input.source,
    roleName: normalized.roleName,
    purpose: normalized.purpose,
    subject: normalized.subject,
    ...(input.contextSnapshotRef === undefined
      ? {}
      : { contextSnapshotRef: input.contextSnapshotRef }),
    deltaRefIds: input.deltaRefIds
  });
}

export function validateRunInputEnvelope(
  value: AgentRunInputEnvelope
): AgentRunInputEnvelope {
  if (value.protocol !== RUN_INPUT_PROTOCOL) {
    throw new Error("AgentRun input protocol is unsupported.");
  }
  normalizeEnvelope(value);
  const serialized = serializeRunInputEnvelope(value);
  if (Buffer.byteLength(serialized, "utf8") > RUN_INPUT_MAX_BYTES) {
    throw new Error("AgentRun input envelope exceeds its protocol byte limit.");
  }
  return value;
}

export function serializeRunInputEnvelope(value: AgentRunInputEnvelope): string {
  if (value.protocol !== RUN_INPUT_PROTOCOL) {
    throw new Error("AgentRun input protocol is unsupported.");
  }
  const normalized = normalizeEnvelope(value);
  if (normalized.purpose !== "global") requireRunContextSnapshotRef(normalized);
  const subject = Object.entries(normalized.subject)
    .map(([key, id]) => `${key}:${id}`)
    .join(",");
  const snapshot = normalized.contextSnapshotRef;
  const lines = [
    "Yui AgentRun input. Follow the Session Manifest and injected Skills.",
    `${normalized.subject.taskId === undefined ? "" : `task=${normalized.subject.taskId} `}run=${normalized.runId} role=${normalized.roleName}`,
    `source=${normalized.source.type}/${normalized.source.channel} purpose=${normalized.purpose} subject=${subject || "global"} snapshot=${snapshot === undefined ? "none" : `${snapshot.id}@${snapshot.digest}`}`,
    normalized.deltaRefIds.length === 0
      ? "delta=none"
      : `delta=${normalized.deltaRefIds.join(",")}`,
    ...(normalized.subject.taskId === undefined ? [] : [
      `Load the exact AgentRun context: yui task run context ${normalized.subject.taskId}/${normalized.runId} --json.`
    ]),
    "Use the Session Manifest's CLI entry. Fail closed if the exact Context is unavailable or mismatched.",
    "Then read the relevant referenced requirements and perform the assigned work. Context loading is not the deliverable.",
    "During planning, fulfill the user's Draft discussion request without starting delivery before it is requested."
  ];
  const serialized = lines.join("\n");
  if (Buffer.byteLength(serialized, "utf8") > RUN_INPUT_MAX_BYTES) {
    throw new Error("AgentRun input envelope exceeds its protocol byte limit.");
  }
  return serialized;
}

/**
 * Bounded infrastructure-recovery input for an already-submitted AgentRun. It resumes
 * the provider-native transcript after Host/child replacement and never
 * replays the Assignment or its directive.
 */
export function serializeRunHostRecoveryEnvelope(
  value: AgentRunInputEnvelope
): string {
  const normalized = normalizeEnvelope(value);
  const serialized = [
    "Yui Host recovery for an existing AgentRun.",
    `${normalized.subject.taskId === undefined ? "" : `task=${normalized.subject.taskId} `}turn=${normalized.runId} role=${normalized.roleName}`,
    "Resume the same native conversation from its latest durable state. Do not repeat completed work or replay the original input.",
    "Load the exact AgentRun context or delta only if needed, then continue the same AgentRun."
  ].join("\n");
  if (Buffer.byteLength(serialized, "utf8") > RUN_INPUT_MAX_BYTES) {
    throw new Error("AgentRun Host recovery envelope exceeds its protocol byte limit.");
  }
  return serialized;
}

function normalizeInput(input: Readonly<{
  source: AgentRunInputSource;
  contextSnapshotRef?: ContextSnapshotRef;
  deltaRefIds: readonly string[];
}>): Omit<AgentRunInput, "schemaVersion" | "directive"> {
  const source = normalizeSource(input.source);
  const snapshot = input.contextSnapshotRef === undefined
    ? undefined
    : validateContextSnapshotRef(input.contextSnapshotRef);
  const deltaRefIds = normalizedUniqueText(
    input.deltaRefIds,
    "AgentRun input delta ref"
  );
  if (deltaRefIds.length > RUN_INPUT_MAX_DELTAS) {
    throw new Error(`AgentRun input supports at most ${RUN_INPUT_MAX_DELTAS} delta refs.`);
  }
  return {
    source,
    ...(snapshot === undefined ? {} : { contextSnapshotRef: snapshot }),
    deltaRefIds
  };
}

function normalizeEnvelopeContext(
  context: AgentRunInputEnvelopeContext,
  input: AgentRunInput
): AgentRunInputEnvelopeContext {
  const normalized = normalizeEnvelope({
    protocol: RUN_INPUT_PROTOCOL,
    runId: context.runId,
    source: input.source,
    roleName: context.roleName,
    purpose: context.purpose,
    subject: context.subject,
    ...(input.contextSnapshotRef === undefined
      ? {}
      : { contextSnapshotRef: input.contextSnapshotRef }),
    deltaRefIds: input.deltaRefIds
  });
  return {
    runId: normalized.runId,
    roleName: normalized.roleName,
    purpose: normalized.purpose,
    subject: normalized.subject
  };
}

function normalizeEnvelope(input: AgentRunInputEnvelope): AgentRunInputEnvelope {
  if (!(["execution", "review", "global", "planning"] as const).includes(input.purpose)) {
    throw new Error("Turn input purpose is invalid.");
  }
  const normalizedInput = normalizeInput(input);
  const subject = normalizeSubject(input.subject);
  if (normalizedInput.contextSnapshotRef !== undefined
    && normalizedInput.contextSnapshotRef.taskId !== subject.taskId) {
    throw new Error("AgentRun input Context Snapshot belongs to another Task.");
  }
  if (input.purpose !== "global" && subject.taskId === undefined) {
    throw new Error("A Task AgentRun input requires a Task subject.");
  }
  if (input.purpose === "review" && subject.reviewRoundId === undefined) {
    throw new Error("A review AgentRun input requires a ReviewRound subject.");
  }
  if (input.purpose === "planning"
    && (subject.workItemId !== undefined
      || subject.reviewRoundId !== undefined
      || subject.executionGroupId !== undefined
      || subject.sourceExecutionGroupId !== undefined)) {
    throw new Error("A planning Turn input carries only its Task subject.");
  }
  return {
    protocol: RUN_INPUT_PROTOCOL,
    runId: requireIdentity(input.runId, "AgentRun input AgentRun id"),
    source: normalizedInput.source,
    roleName: requireIdentity(input.roleName, "AgentRun input Role name"),
    purpose: input.purpose,
    subject,
    ...(normalizedInput.contextSnapshotRef === undefined
      ? {}
      : { contextSnapshotRef: normalizedInput.contextSnapshotRef }),
    deltaRefIds: normalizedInput.deltaRefIds
  };
}

function normalizeSubject(subject: AgentRunSubject): AgentRunSubject {
  const normalized = Object.fromEntries(
    Object.entries(subject).map(([key, value]) => [
      key,
      requireIdentity(value, `AgentRun input ${key}`)
    ])
  ) as AgentRunSubject;
  const allowed = [
    "taskId",
    "workItemId",
    "reviewRoundId",
    "executionGroupId",
    "executionLaneId",
    "sourceExecutionGroupId"
  ];
  if (Object.keys(normalized).some((key) => !allowed.includes(key))) {
    throw new Error("AgentRun input subject contains an unknown field.");
  }
  if ((normalized.executionGroupId === undefined) !== (normalized.executionLaneId === undefined)) {
    throw new Error("AgentRun input execution lineage is incomplete.");
  }
  if (normalized.sourceExecutionGroupId !== undefined
    && ((normalized.workItemId === undefined && normalized.reviewRoundId === undefined)
      || normalized.executionGroupId !== undefined)) {
    throw new Error(
      "AgentRun input source ExecutionGroup requires a WorkItem or Review main subject."
    );
  }
  if (normalized.taskId === undefined
    && (normalized.workItemId !== undefined || normalized.reviewRoundId !== undefined
      || normalized.executionGroupId !== undefined
      || normalized.sourceExecutionGroupId !== undefined)) {
    throw new Error("AgentRun input child subject requires a Task id.");
  }
  return Object.freeze(normalized);
}

function normalizeSource(source: AgentRunInputSource): AgentRunInputSource {
  if (source.type === "yui" && YUI_RUN_INPUT_CHANNELS.includes(source.channel)) {
    return Object.freeze({ type: "yui", channel: source.channel });
  }
  if (source.type === "user" && source.channel === "direct") {
    return Object.freeze({ type: "user", channel: "direct" });
  }
  if (source.type === "provider" && (source.channel === "goal-continuation" || source.channel === "visible-input")) {
    return Object.freeze({ type: "provider", channel: source.channel });
  }
  throw new Error("AgentRun input source is invalid.");
}
