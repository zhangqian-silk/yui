import { createHash } from "node:crypto";
import { createGlobalRoleMessage, type GlobalRoleMessage } from "../message/message.js";
import { redactAgentErrorText, serializeAgentErrorRaw } from "../runtime/agentError.js";
import type { TaskStore } from "../storage/taskStore.js";
import { summaryMetadata, summaryText } from "../output/boundedRead.js";

const FAILURE_HEADER = "Yui Global failure evidence ";
const RECOVERY_HEADER = "Yui Global recovery evidence ";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

/** This is a projection of original Message documents, never a persisted
 * aggregate or a new handling/recovery state. Exact observations remain in the
 * existing record-only Message history. Polling the same identity is a no-op. */
function diagnosticIdentity(store: TaskStore, roleName: string, identity: string, facts: unknown) {
  const value = object(facts), fence = object(value.fence);
  const failure = object(value.failure), retry = object(value.retry);
  const error = object(failure.error ?? value.error ?? retry.error);
  const sessions = store.getGlobalRoleSessionSet(roleName);
  const binding = sessions?.providerBinding;
  const nativeSessionId = value.nativeSessionId ?? fence.nativeSessionId ?? retry.nativeSessionId
    ?? sessions?.sessions[sessions.activeAgentId]?.nativeSessionId;
  const source = {
    roleName, nativeSessionId,
    host: binding?.authority.holderId,
    endpointImplementation: value.endpointImplementation,
    hostImplementation: value.hostImplementation,
    controlCapabilities: value.controlCapabilities,
    driverId: fence.driverId ?? binding?.providerNamespace,
    source: error.source,
    phase: error.phase,
    reason: value.reason, cause: value.cause,
    agentId: fence.agentId ?? sessions?.activeAgentId, providerNamespace: binding?.providerNamespace,
    accountScope: binding?.accountScope
  };
  const classified = typeof nativeSessionId === "string" && (
    typeof error.code === "string" && error.code !== "unknown"
    || value.reason === "host-terminal-unobservable" && typeof value.cause === "string");
  const classification = {
    ...source, category: error.category, code: error.code, cause: value.cause,
    detail: value.reason === "host-terminal-unobservable" ? hash(value.detail ?? null) : undefined,
    // Explicit impact, not Turn IDs or free-form provider text.
    inputDisposition: error.inputDisposition ?? failure.inputDisposition,
    sessionDisposition: error.sessionDisposition ?? failure.sessionDisposition,
    confirmed: ["submitting", "accepted", "delivery-unknown", "completed", "failed", "cancelled"].includes(value.confirmed)
      ? value.confirmed : undefined,
    status: value.status,
    // Unclassified failures must never be guessed equivalent.
    unclassified: classified ? undefined : identity
  };
  return { key: hash(classification), source, summary: summaryText(redactAgentErrorText(String(
    error.message ?? value.detail ?? value.reason ?? "Runtime failure; inspect original evidence"))
    .replace(/[\u0000-\u001f\u007f]/gu, " ")) };
}

type DiagnosticEvidence = { key: string; source: Record<string, any>; summary: string };
type DiagnosticGroup = {
  key: string; episode: string; source: Record<string, any>; summary: string;
  count: number; firstAt: string; lastAt: string;
  firstEvidence: string; latestEvidence: string; recoveredAt?: string; recoveryEvidence?: string;
};

function evidence(message: GlobalRoleMessage): Record<string, any> | undefined {
  if (message.kind !== "system" || ![FAILURE_HEADER, RECOVERY_HEADER].some(header => message.body.startsWith(header))) return;
  try { return object(JSON.parse(message.body.slice(message.body.indexOf("\n") + 1))); } catch { return; }
}

export function runtimeDiagnosticGroups(messages: readonly GlobalRoleMessage[]): DiagnosticGroup[] {
  const groups: DiagnosticGroup[] = [];
  const active = new Map<string, DiagnosticGroup>();
  for (const message of messages) {
    const value = evidence(message);
    if (!value) continue;
    if (message.body.startsWith(RECOVERY_HEADER)) {
      for (const [key, group] of active) {
        if (group.source.nativeSessionId !== value.nativeSessionId || group.source.host !== value.host
          || value.reason !== undefined && group.source.reason !== value.reason
          || value.reason === undefined && group.source.phase !== "turn-execute"
            && group.source.phase !== "turn-submit") continue;
        group.recoveredAt = message.createdAt;
        group.recoveryEvidence = message.id;
        active.delete(key);
      }
      continue;
    }
    const diagnostic = value.diagnostic as DiagnosticEvidence | undefined;
    if (typeof diagnostic?.key !== "string") continue; // Old evidence remains in ordinary history.
    const existing = active.get(diagnostic.key);
    if (existing) {
      existing.count++;
      existing.lastAt = message.createdAt;
      existing.latestEvidence = message.id;
    } else {
      const group = { ...diagnostic, episode: message.id, count: 1,
        firstAt: message.createdAt, lastAt: message.createdAt,
        firstEvidence: message.id, latestEvidence: message.id };
      groups.push(group);
      active.set(diagnostic.key, group);
    }
  }
  return groups;
}

export function runtimeDiagnosticEvidence(messages: readonly GlobalRoleMessage[], key: string) {
  return messages.filter(message => evidence(message)?.diagnostic?.key === key);
}

/** Global observations have no Task event history. Keep original failed
 * attempts as ordinary record-only Messages before replacing the live binding. */
export function recordGlobalRuntimeFailure(
  store: TaskStore, roleName: string, identity: string, facts: unknown, now: Date
): string {
  return recordFailure(store, roleName, identity, facts, now, [...store.listGlobalRoleMessages(roleName)]);
}

function recordFailure(
  store: TaskStore, roleName: string, identity: string, facts: unknown, now: Date,
  messages: GlobalRoleMessage[]
): string {
  const diagnostic = diagnosticIdentity(store, roleName, identity, facts);
  const header = `${FAILURE_HEADER}${hash([identity, diagnostic.key])}\n`;
  const previous = messages.find(message =>
    message.kind === "system" && message.body.startsWith(header));
  if (previous !== undefined) return `${roleName}/${previous.id}`;
  const message = createGlobalRoleMessage(store.nextGlobalRoleMessageId(), roleName,
    header + redactAgentErrorText(JSON.stringify({
      ...object(facts), diagnostic
    })), "system", { type: "system" }, now);
  store.saveGlobalRoleMessage(message);
  messages.push(message);
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
  // These observations run in the caller's transaction. Reuse that exact
  // history plus our appended record, rather than loading/parsing the whole
  // Role history twice on every unchanged Host failure.
  const messages = [...store.listGlobalRoleMessages(roleName)];
  const failureRef = recordFailure(store, roleName, identity, facts, now, messages);
  const diagnostic = diagnosticIdentity(store, roleName, identity, facts);
  const group = runtimeDiagnosticGroups(messages)
    .reverse().find(group => group.key === diagnostic.key && group.recoveredAt === undefined);
  const requestId = `runtime-attention:${hash([roleName, diagnostic.key, group?.episode ?? identity])}`;
  if (store.queryGlobalRoleMessages(recipient, { requestId, limit: 1 }).messages.length > 0) return;
  const message = createGlobalRoleMessage(store.nextGlobalRoleMessageId(), recipient, [
    `Yui-Summary: ${diagnostic.summary}`,
    `Global Role ${roleName} needs attention. No recovery or new authority is implied.`,
    "Inspect the exact Session and original input before choosing a next action; unknown effects must not be replayed.",
    `Original failed attempts remain in Role ${roleName}'s record-only failure Messages; failureRef names the latest evidence.`,
    redactAgentErrorText(JSON.stringify({ diagnosticKey: diagnostic.key, source: summaryMetadata(diagnostic.source), failureRef,
      read: `yui role message list ${roleName} --diagnostic ${diagnostic.key}` }))
  ].join("\n"), "system", { type: "system" }, now, { inputControl: { action: "queue", requestId } });
  store.saveGlobalRoleMessage(recipient === roleName ? {
    ...message,
    notDelivered: { reason: "runtime-needs-attention; retained for user or successor inspection", at: now.toISOString() }
  } : message);
}

/** Called only on an established exact successful observation. A diagnostic
 * recovery says nothing about Message handling, prior effects or Task outcome. */
export function recordGlobalRuntimeRecovery(
  store: TaskStore, roleName: string, identity: string,
  facts: { nativeSessionId: string; reason?: string; evidence: string }, now: Date
): void {
  const messages = store.listGlobalRoleMessages(roleName);
  const host = store.getGlobalRoleSessionSet(roleName)?.providerBinding?.authority.holderId;
  const active = runtimeDiagnosticGroups(messages).filter(group => !group.recoveredAt
    && group.source.nativeSessionId === facts.nativeSessionId && group.source.host === host
    && (facts.reason !== undefined ? group.source.reason === facts.reason
      : ["turn-execute", "turn-submit"].includes(group.source.phase)));
  if (active.length === 0) return;
  const header = `${RECOVERY_HEADER}${hash(identity)}\n`;
  if (messages.some(message => message.body.startsWith(header))) return;
  const message = createGlobalRoleMessage(store.nextGlobalRoleMessageId(), roleName,
    header + serializeAgentErrorRaw({ ...facts, host }), "system", { type: "system" }, now);
  store.saveGlobalRoleMessage(message);
  const recipient = store.getGlobalRole("operator") === null ? roleName : "operator";
  const notice = createGlobalRoleMessage(store.nextGlobalRoleMessageId(), recipient,
    `Yui-Summary: Global Role ${roleName} has new runtime recovery evidence; no input handling or Task completion is implied.\n`
      + JSON.stringify({ evidence: `${roleName}/${message.id}`, recoveredGroups: active.length }),
    "system", { type: "system" }, now,
    { inputControl: { action: "queue", requestId: `runtime-recovery:${hash([roleName, identity])}` } });
  store.saveGlobalRoleMessage(recipient === roleName ? { ...notice,
    notDelivered: { reason: "runtime-recovery; retained for user or successor inspection", at: now.toISOString() }
  } : notice);
}
