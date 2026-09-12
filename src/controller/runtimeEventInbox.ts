import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import {
  createRuntimeObservation,
  isRuntimeTokenEvidence,
  type RuntimeObservation
} from "../runtime/runtimeObservation.js";
import type { AgentRunFailureReason } from "../agentRun/agentRun.js";
import {
  boundedRunFailureDiagnostic,
  transportAgentResult
} from "../domain/agentResultTransport.js";
import {
  readAgentHostObservationSource,
  type AgentHostObservationSource
} from "../runtime/agentHostProtocol.js";

export const MAX_RUNTIME_EVENT_FILE_BYTES = 16 * 1024 * 1024;

const RUNTIME_EVENT_DIRECTORY = join("runtime", "inbox");
const INVALID_RUNTIME_EVENT_DIRECTORY = join("runtime", "inbox-invalid");
const EVENT_ID_PATTERN = /^turn-[a-f0-9]{64}$/;

export type RuntimeObservationInboxEvent = Readonly<{
  schemaVersion: 1;
  id: string;
  type: "runtime-observation";
  receivedAt: string;
  scope: "task" | "global";
  taskId?: string;
  observation: RuntimeObservation;
  /** v1 Host wire facts are resolved by the current Controller, never the producer. */
  host?: AgentHostObservationSource;
}>;

export type RuntimeRunTerminalOutcome =
  | Readonly<{ status: "completed"; output: string }>
  | Readonly<{
      status: "failed";
      diagnostic: string;
      failureReason: AgentRunFailureReason;
      output?: string;
    }>;

export type RuntimeRunTerminalInput = Readonly<{
  scope: "task" | "global";
  taskId?: string;
  roleName: string;
  agentId: string;
  adapterId: "codex" | "claude";
  nativeSessionId: string;
  nativeTurnId: string;
  runId?: string;
  title?: string;
  providerStatus: "completed" | "failed" | "cancelled";
  outcome: RuntimeRunTerminalOutcome;
}>;

export type RuntimeRunTerminalEvent = Readonly<{
  schemaVersion: 1;
  id: string;
  type: "native-turn-terminal";
  receivedAt: string;
}> & RuntimeRunTerminalInput;

/**
 * f7/rr5: A DurableJob reached a terminal state. The supervisor delivers
 * this to the runtime inbox so the Controller wakes immediately instead of
 * waiting for the next poll. The state change already committed; this event
 * is the durable terminal channel (dual-channel with the Leader wakeup).
 */
export type RuntimeDurableJobTerminalInput = Readonly<{
  scope: "task";
  taskId: string;
  jobId: string;
  status: "succeeded" | "failed" | "timed-out" | "cancelled" | "unknown-needs-attention";
  outcome: string;
}>;

export type RuntimeDurableJobTerminalEvent = Readonly<{
  schemaVersion: 1;
  id: string;
  type: "durable-job-terminal";
  receivedAt: string;
}> & RuntimeDurableJobTerminalInput;

export type RuntimeLifecycleEvent =
  | RuntimeObservationInboxEvent
  | RuntimeRunTerminalEvent
  | RuntimeDurableJobTerminalEvent;

export type RuntimeEventEnqueueResult<TEvent extends RuntimeLifecycleEvent = RuntimeLifecycleEvent> =
  Readonly<{
    event: TEvent;
    created: boolean;
  }>;

/** Test-only synchronization seam; production callers leave it unset. */
export type RuntimeEventInboxHooks = Readonly<{
  /** Called after admission is checked while the coordination lock is held. */
  afterAdmission?: () => void;
}>;

/**
 * Durable ingress for facts emitted by native Agent hooks. It deliberately
 * owns no TaskStore lock: immutable files are acknowledged only after the
 * Controller commits their authoritative aggregate effect.
 */
export class FileRuntimeEventInbox {
  private readonly directory: string;

  constructor(
    readonly home: string,
    private readonly now: () => Date = () => new Date(),
    private readonly hooks: RuntimeEventInboxHooks = {}
  ) {
    this.directory = join(home, RUNTIME_EVENT_DIRECTORY);
  }

  enqueueObservation(
    input: RuntimeObservation,
    host?: AgentHostObservationSource
  ): RuntimeEventEnqueueResult<RuntimeObservationInboxEvent> {
    const observation = createRuntimeObservation(input);
    const scope = observation.fence.taskId === undefined ? "global" : "task";
    const event = Object.freeze({
      schemaVersion: 1 as const,
      id: runtimeEventId("runtime-observation", { observation }),
      type: "runtime-observation" as const,
      receivedAt: observation.receivedAt,
      scope,
      ...(observation.fence.taskId === undefined
        ? {}
        : { taskId: observation.fence.taskId }),
      observation,
      ...(host === undefined ? {} : { host: readAgentHostObservationSource(host) })
    });
    return this.publish(event);
  }

  enqueueRunTerminal(
    input: RuntimeRunTerminalInput
  ): RuntimeEventEnqueueResult<RuntimeRunTerminalEvent> {
    const normalized = normalizeNativeTurnTerminalInput(input);
    return this.publish(Object.freeze({
      schemaVersion: 1,
      id: runtimeEventId("native-turn-terminal", normalized),
      type: "native-turn-terminal",
      receivedAt: this.now().toISOString(),
      ...normalized
    }));
  }

  enqueueDurableJobTerminal(
    input: RuntimeDurableJobTerminalInput
  ): RuntimeEventEnqueueResult<RuntimeDurableJobTerminalEvent> {
    const normalized = normalizeDurableJobTerminalInput(input);
    return this.publish(Object.freeze({
      schemaVersion: 1,
      id: runtimeEventId("durable-job-terminal", normalized),
      type: "durable-job-terminal",
      receivedAt: this.now().toISOString(),
      ...normalized
    }));
  }

  list(): RuntimeLifecycleEvent[] {
    if (!existsSync(this.directory)) return [];
    const events: RuntimeLifecycleEvent[] = [];
    for (const name of readdirSync(this.directory).filter((entry) => entry.endsWith(".json"))) {
      try {
        const id = name.slice(0, -".json".length);
        assertEventId(id);
        const event = this.read(id);
        if (event !== null) events.push(event);
      } catch (error) {
        if (!(error instanceof RuntimeEventInboxError)
          || error.code !== "RUNTIME_EVENT_INVALID") {
          throw error;
        }
        try {
          this.quarantine(name);
        } catch {
          // One unreadable entry must not block independent durable events.
        }
      }
    }
    return events.sort(compareRuntimeEvents);
  }

  read(id: string): RuntimeLifecycleEvent | null {
    assertEventId(id);
    const path = this.eventPath(id);
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
    if (
      !metadata.isFile()
      || (metadata.mode & 0o777) !== 0o600
      || metadata.size > MAX_RUNTIME_EVENT_FILE_BYTES
    ) {
      throw invalidEvent(`Runtime event file is invalid: ${id}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw invalidEvent(`Runtime event JSON is invalid: ${id}`);
    }
    const event = parseRuntimeEvent(decodeInboxV1(value));
    if (event.id !== id || runtimeEventId(event.type, event) !== id) {
      throw invalidEvent(`Runtime event identity is invalid: ${id}`);
    }
    return event;
  }

  /** Producer-local delivery diagnostics need only existence, never a read of
   * another version's payload or permission to quarantine another producer. */
  has(id: string): boolean {
    assertEventId(id);
    try { lstatSync(this.eventPath(id)); return true; }
    catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  acknowledge(id: string): boolean {
    assertEventId(id);
    try {
      unlinkSync(this.eventPath(id));
      fsyncDirectory(this.directory);
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  acknowledgeMany(ids: readonly string[]): string[] {
    if (ids.length === 0) return [];
    const acknowledged: string[] = [];
    try {
      for (const id of ids) {
        assertEventId(id);
        try {
          unlinkSync(this.eventPath(id));
          acknowledged.push(id);
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
      }
    } finally {
      // Preserve the old per-event durability guarantee even when a later
      // unlink in the batch fails after earlier entries were removed.
      if (acknowledged.length > 0) fsyncDirectory(this.directory);
    }
    return acknowledged;
  }

  private publish<TEvent extends RuntimeLifecycleEvent>(
    event: TEvent
  ): RuntimeEventEnqueueResult<TEvent> {
    this.hooks.afterAdmission?.();
    if (event.type === "runtime-observation"
      && isRuntimeTokenEvidence(event.observation)) {
      const existing = this.list().find((candidate) => (
        candidate.type === "runtime-observation"
        && candidate.taskId === event.taskId
        && candidate.observation.eventId === event.observation.eventId
      ));
      if (existing !== undefined) {
        return { event: existing as TEvent, created: false };
      }
    }
    return this.publishUnlocked(event);
  }

  private publishUnlocked<TEvent extends RuntimeLifecycleEvent>(
    event: TEvent
  ): RuntimeEventEnqueueResult<TEvent> {
    const content = `${JSON.stringify(encodeInboxV1(event))}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_RUNTIME_EVENT_FILE_BYTES) {
      throw new RuntimeEventInboxError(
        "RUNTIME_EVENT_TOO_LARGE",
        "Runtime event exceeds the durable inbox limit."
      );
    }
    ensureInboxDirectory(this.directory);
    const target = this.eventPath(event.id);
    const temporary = join(
      this.directory,
      `.${event.id}.tmp-${process.pid}-${randomUUID()}`
    );
    let descriptor: number | null = null;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
      );
      writeFileSync(descriptor, content, "utf8");
      fchmodSync(descriptor, 0o600);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      try {
        linkSync(temporary, target);
        unlinkSync(temporary);
        fsyncDirectory(this.directory);
        return { event, created: true };
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const existing = this.read(event.id);
        if (existing === null) return { event, created: false };
        if (!hasSameIdentity(existing, event)) {
          throw new RuntimeEventInboxError(
            "RUNTIME_EVENT_CONFLICT",
            `Runtime event id conflicts with an existing file: ${event.id}`
          );
        }
        return { event: existing as TEvent, created: false };
      }
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  }

  private eventPath(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  private quarantine(name: string): void {
    const invalidDirectory = join(this.home, INVALID_RUNTIME_EVENT_DIRECTORY);
    ensureInboxDirectory(invalidDirectory);
    const source = join(this.directory, name);
    // One semantic ingress identity owns one quarantine slot. Repeated poison
    // entries replace neither the first diagnostic nor create an event storm.
    const target = join(invalidDirectory, name);
    try {
      try {
        linkSync(source, target);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
      unlinkSync(source);
      fsyncDirectory(this.directory);
      fsyncDirectory(invalidDirectory);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}

export class RuntimeEventInboxError extends Error {
  constructor(
    readonly code:
      | "RUNTIME_EVENT_CONFLICT"
      | "RUNTIME_EVENT_INVALID"
      | "RUNTIME_EVENT_MISSING"
      | "RUNTIME_EVENT_TOO_LARGE",
    message: string
  ) {
    super(message);
    this.name = "RuntimeEventInboxError";
  }
}

function runtimeEventId(
  type: RuntimeLifecycleEvent["type"],
  input: RuntimeRunTerminalInput
    | RuntimeDurableJobTerminalInput
    | Readonly<{ observation: RuntimeObservation }>
): string {
  if (type === "runtime-observation") {
    const observation = (input as Readonly<{ observation: RuntimeObservation }>).observation;
    return `turn-${createHash("sha256").update(JSON.stringify([
      2,
      type,
      observation.fence.taskId ?? null,
      observation.fence.roleName,
      observation.semanticKey
    ])).digest("hex")}`;
  }
  if (type === "durable-job-terminal") {
    const job = input as RuntimeDurableJobTerminalInput;
    return `turn-${createHash("sha256").update(JSON.stringify([
      1,
      type,
      job.scope,
      job.taskId,
      job.jobId,
      job.status,
      job.outcome
    ])).digest("hex")}`;
  }
  const provider = input as RuntimeRunTerminalInput;
  const common = [
    1,
    type,
    provider.scope,
    provider.taskId ?? null,
    provider.roleName,
    provider.agentId,
    provider.adapterId,
    provider.nativeSessionId,
    provider.nativeTurnId,
    provider.runId ?? null
  ];
  return `turn-${createHash("sha256").update(JSON.stringify(common)).digest("hex")}`;
}

function normalizeNativeTurnTerminalInput(
  input: RuntimeRunTerminalInput
): RuntimeRunTerminalInput {
  const scope = input.scope;
  if (scope !== "task" && scope !== "global") throw invalidEvent();
  if (!["completed", "failed", "cancelled"].includes(input.providerStatus)) throw invalidEvent();
  const outcome = normalizeRuntimeRunTerminalOutcome(input.outcome);
  if (outcome.status === "completed" && input.providerStatus !== "completed") {
    throw invalidEvent("Only a completed Provider Turn may carry a completed Agent result.");
  }
  const common = {
    scope,
    roleName: requireIdentityText(input.roleName, "Role name"),
    agentId: requireIdentityText(input.agentId, "Agent id"),
    adapterId: input.adapterId,
    nativeSessionId: requireIdentityText(input.nativeSessionId, "Native session id"),
    nativeTurnId: requireIdentityText(input.nativeTurnId, "Provider native Turn id"),
    ...(input.runId === undefined
      ? {}
      : { runId: requireIdentityText(input.runId, "AgentRun id") }),
    ...(input.title === undefined
      ? {}
      : { title: requireIdentityText(input.title, "Session title") }),
    providerStatus: input.providerStatus,
    outcome
  } as const;
  if (common.adapterId !== "codex" && common.adapterId !== "claude") throw invalidEvent();
  return scope === "task"
    ? { ...common, taskId: requireIdentityText(input.taskId, "Task id") }
    : common;
}

function normalizeRuntimeRunTerminalOutcome(
  input: unknown
): RuntimeRunTerminalOutcome {
  if (!isObject(input)) {
    throw invalidEvent("Runtime AgentRun terminal outcome is invalid.");
  }
  if (input.status === "completed") return transportAgentResult(input.output);
  if (input.status !== "failed"
    || ![
      "startup-failed",
      "runtime-failed",
      "delivery-unknown",
      "missing-result",
      "workspace-unavailable",
      "workspace-dirty",
      "workspace-branch-mismatch",
      "cancelled"
    ]
      .includes(input.failureReason)) {
    throw invalidEvent("Runtime AgentRun failure outcome is invalid.");
  }
  return {
    status: "failed",
    diagnostic: boundedRunFailureDiagnostic(input.diagnostic),
    failureReason: input.failureReason,
    ...(typeof input.output === "string" && transportAgentResult(input.output).status === "completed"
      ? { output: input.output } : {})
  };
}

/** The already deployed inbox v1 is a transport envelope, not a second domain
 * schema. Keep its wire keys and opaque ids stable so pre-upgrade pending
 * facts remain readable atomically. Public/in-process values use runId.
 * Retire this codec only with a new inbox protocol after all v1 producers
 * and pending files have drained; do not introduce dual domain-store reads.
 */
function inboxReference(value: Record<string, any>, encode: boolean): Record<string, any> {
  const from = encode ? "runId" : "turnId";
  const to = encode ? "turnId" : "runId";
  if (Object.hasOwn(value, to)) throw invalidEvent("Inbox v1 reference uses the wrong wire shape.");
  const { [from]: id, ...rest } = value;
  return id === undefined ? rest : { ...rest, [to]: id };
}

function inboxEnvelope(value: unknown, encode: boolean): unknown {
  if (!isObject(value)) throw invalidEvent();
  if (value.type === "native-turn-terminal") return inboxReference(value, encode);
  if (value.type !== "runtime-observation") return value;
  if (!isObject(value.observation) || !isObject(value.observation.fence)) throw invalidEvent();
  const observation = value.observation;
  let payload = observation.payload;
  if (isObject(payload?.failure)) {
    const from = encode ? "runTerminal" : "turnTerminal";
    const to = encode ? "turnTerminal" : "runTerminal";
    const { [from]: terminal, ...failure } = payload.failure;
    payload = { ...payload, failure: terminal === undefined ? failure : { ...failure, [to]: terminal } };
  }
  return { ...value, observation: { ...observation, payload,
    fence: inboxReference(observation.fence, encode) } };
}
function encodeInboxV1(value: RuntimeLifecycleEvent): unknown { return inboxEnvelope(value, true); }
function decodeInboxV1(value: unknown): unknown { return inboxEnvelope(value, false); }

function normalizeDurableJobTerminalInput(
  input: RuntimeDurableJobTerminalInput
): RuntimeDurableJobTerminalInput {
  if (input.scope !== "task") throw invalidEvent();
  const terminalStatuses = [
    "succeeded", "failed", "timed-out", "cancelled", "unknown-needs-attention"
  ] as const;
  if (!terminalStatuses.includes(input.status as typeof terminalStatuses[number])) {
    throw invalidEvent();
  }
  return {
    scope: "task",
    taskId: requireIdentityText(input.taskId, "Task id"),
    jobId: requireIdentityText(input.jobId, "Job id"),
    status: input.status,
    outcome: requireIdentityText(input.outcome, "Job outcome")
  };
}

function parseRuntimeEvent(value: unknown): RuntimeLifecycleEvent {
  if (!isObject(value)) throw invalidEvent();
  switch (value.type) {
    case "runtime-observation": return parseRuntimeObservationEvent(value);
    case "native-turn-terminal": return parseNativeTurnTerminalEvent(value);
    case "durable-job-terminal": return parseDurableJobTerminalEvent(value);
    default: throw invalidEvent();
  }
}

function parseRuntimeObservationEvent(
  value: Record<string, any>
): RuntimeObservationInboxEvent {
  const expected = [
    "schemaVersion", "id", "type", "receivedAt", "scope", "observation",
    ...(value.host === undefined ? [] : ["host"]),
    ...(value.taskId === undefined ? [] : ["taskId"])
  ];
  if (value.schemaVersion !== 1 || !hasExactKeys(value, expected)) throw invalidEvent();
  const observation = createRuntimeObservation(value.observation as RuntimeObservation);
  const scope = observation.fence.taskId === undefined ? "global" : "task";
  if (value.scope !== scope
    || (scope === "task" && value.taskId !== observation.fence.taskId)
    || value.receivedAt !== observation.receivedAt) {
    throw invalidEvent("Runtime observation envelope does not match its canonical fence.");
  }
  return Object.freeze({
    schemaVersion: 1,
    id: requireIdentityText(value.id, "Event id"),
    type: "runtime-observation",
    receivedAt: observation.receivedAt,
    scope,
    ...(scope === "task" ? { taskId: observation.fence.taskId! } : {}),
    observation,
    ...(value.host === undefined ? {} : { host: parseHostSource(value.host) })
  });
}

function parseHostSource(value: unknown): AgentHostObservationSource {
  try { return readAgentHostObservationSource(value); }
  catch (error) { throw invalidEvent(error instanceof Error ? error.message : String(error)); }
}

function parseDurableJobTerminalEvent(
  value: Record<string, any>
): RuntimeDurableJobTerminalEvent {
  const expected = [
    "schemaVersion", "id", "type", "receivedAt", "scope", "taskId",
    "jobId", "status", "outcome"
  ];
  if (value.schemaVersion !== 1 || !hasExactKeys(value, expected)) throw invalidEvent();
  const normalized = normalizeDurableJobTerminalInput(
    value as RuntimeDurableJobTerminalInput
  );
  return Object.freeze({
    schemaVersion: 1,
    id: requireIdentityText(value.id, "Event id"),
    type: "durable-job-terminal",
    receivedAt: requireTimestamp(value.receivedAt),
    ...normalized
  });
}

function parseNativeTurnTerminalEvent(value: Record<string, any>): RuntimeRunTerminalEvent {
  const scope = value.scope;
  const expected = scope === "task"
    ? [
        "schemaVersion", "id", "type", "receivedAt", "scope", "taskId",
        "roleName", "agentId", "adapterId", "nativeSessionId", "nativeTurnId",
        "providerStatus", "outcome",
        ...(value.runId === undefined ? [] : ["runId"]),
        ...(value.title === undefined ? [] : ["title"])
      ]
    : [
        "schemaVersion", "id", "type", "receivedAt", "scope",
        "roleName", "agentId", "adapterId", "nativeSessionId", "nativeTurnId",
        "providerStatus", "outcome",
        ...(value.runId === undefined ? [] : ["runId"]),
        ...(value.title === undefined ? [] : ["title"])
      ];
  if ((scope !== "task" && scope !== "global")
    || value.schemaVersion !== 1
    || !hasExactKeys(value, expected)) throw invalidEvent();
  const receivedAt = requireTimestamp(value.receivedAt);
  const normalized = normalizeNativeTurnTerminalInput({
    scope,
    ...(scope === "task" ? { taskId: value.taskId } : {}),
    roleName: value.roleName,
    agentId: value.agentId,
    adapterId: value.adapterId,
    nativeSessionId: value.nativeSessionId,
    nativeTurnId: value.nativeTurnId,
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    ...(value.title === undefined ? {} : { title: value.title }),
    providerStatus: value.providerStatus,
    outcome: value.outcome
  });
  return Object.freeze({
    schemaVersion: 1,
    id: requireIdentityText(value.id, "Event id"),
    type: "native-turn-terminal",
    receivedAt,
    ...normalized
  });
}

function requireIdentityText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw invalidEvent();
  const text = value.trim();
  if (text.length === 0 || text.length > 1_024) {
    throw invalidEvent(`${label} is invalid.`);
  }
  return text;
}

function requireTimestamp(value: unknown): string {
  const timestamp = requireIdentityText(value, "Received at");
  if (!Number.isFinite(Date.parse(timestamp))) throw invalidEvent();
  return timestamp;
}

function ensureInboxDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertEventId(id: string): void {
  if (!EVENT_ID_PATTERN.test(id)) throw invalidEvent("Runtime event id is invalid.");
}

function hasSameIdentity(left: RuntimeLifecycleEvent, right: RuntimeLifecycleEvent): boolean {
  if (left.type === "runtime-observation" && right.type === "runtime-observation"
    && !isDeepStrictEqual(left.host, right.host)) return false;
  if (left.type === "runtime-observation" && right.type === "runtime-observation"
    && ["turn.completed", "turn.failed", "turn.cancelled"].includes(left.observation.kind)) {
    return left.id === right.id
      && left.observation.kind === right.observation.kind
      && isDeepStrictEqual(left.observation.fence, right.observation.fence)
      && isDeepStrictEqual(left.observation.payload, right.observation.payload);
  }
  return left.id === right.id
    && left.type === right.type
    && left.scope === right.scope
    && left.taskId === right.taskId
    && (!("roleName" in left) || !("roleName" in right) || left.roleName === right.roleName)
    && (!("agentId" in left) || !("agentId" in right) || left.agentId === right.agentId)
    && (!("adapterId" in left) || !("adapterId" in right) || left.adapterId === right.adapterId)
    && (!("nativeSessionId" in left)
      || !("nativeSessionId" in right)
      || left.nativeSessionId === right.nativeSessionId)
    && (!("runId" in left) || !("runId" in right) || left.runId === right.runId)
    && (!("jobId" in left) || !("jobId" in right) || left.jobId === right.jobId);
}

type RuntimeEventOrderKey = Pick<RuntimeLifecycleEvent, "receivedAt" | "id"> & Readonly<{
  observation?: RuntimeObservation;
}>;

function compareRuntimeEvents(
  left: RuntimeEventOrderKey,
  right: RuntimeEventOrderKey
): number {
  const receivedAt = left.receivedAt.localeCompare(right.receivedAt);
  if (receivedAt !== 0) return receivedAt;
  const sequence = (left.observation?.sequence ?? -1) - (right.observation?.sequence ?? -1);
  if (sequence !== 0) return sequence;
  const ordinal = (left.observation?.ordinal ?? -1) - (right.observation?.ordinal ?? -1);
  if (ordinal !== 0) return ordinal;
  return left.id.localeCompare(right.id);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function invalidEvent(message = "Runtime event is invalid."): RuntimeEventInboxError {
  return new RuntimeEventInboxError("RUNTIME_EVENT_INVALID", message);
}
