import { runExecutionObservation, type AgentRun } from "../agentRun/agentRun.js";
import { isGitArtifactRefString, parseGitArtifactRef } from "../artifacts/gitArtifactRef.js";
import { taskNotFound, usageError } from "../errors/cliError.js";
import type { TaskEvent } from "../event/taskEvent.js";
import { expandTaskMessageResult, type TaskMessage } from "../message/message.js";
import { taskMessagePresentation } from "../interaction/notificationPresentation.js";
import { currentManagedRuntime, resolveManagedTaskReader } from "../runtime/managedCaller.js";
import { hasManagedIdentity } from "../runtime/managedIdentity.js";
import { providerRetrySummary } from "../runtime/providerRetry.js";
import type { ContextRecordFamily, ContextRecordQuery } from "../storage/contextRecords.js";
import type { TaskStore } from "../storage/taskStore.js";
import { projectTaskRemoteDeliveryFromStore } from "../task/remoteDeliveryService.js";
import { retiredTaskRecordIds, TASK_RECORD_RETIRED_EVENT } from "../task/taskRecordRetirement.js";
import { managedWorkspaceKey } from "../worktree/managedWorkspace.js";
import { contextContentDigest } from "./contextSnapshot.js";
import { sourceRunContextValue } from "./sourceRunContext.js";
import { boundedDocument, fitsReadBudget, summaryText, recordPage, readDigest, type ReadPageOptions } from "../output/boundedRead.js";
import { taskBriefGuard, taskPhase } from "./taskPhase.js";
import { CONTEXT_FAMILIES } from "./contextFamilies.js";

const MAX_RECORDS = 64;
const MAX_VALUE_BYTES = 2048;
const MAX_PAGE_BYTES = 24 * 1024;
const MAX_EVENTS = 100;
const MAX_ATTENTION_REFS = 8;
// The current read is a working index, not a replay of configuration, workspace
// inventories and requirements on every wake. Exact bodies use the same scoped,
// digest-checked inspect path regardless of how small a record happens to be.
const INDEX_ONLY_FAMILIES = new Set([
  "task", "task-brief", "remote-delivery", "role", "project-policy",
  "managed-workspace", "task-decision", "task-message", "run", "work-item", "project-knowledge"
]);
type Ref = Readonly<{ store: string; refId: string; revision: string; digest: string }>;
type Entry = Readonly<{ ref: Ref; value: unknown }>;
type Cursor = Readonly<{ taskId: string; source: string; sequence: number; revision: number }>;
type PageCursor = Cursor & Readonly<{ after: number; baseline: string }>;
export type ContextObservation = Readonly<{
  source: string;
  observedAt: string;
  coverage: "known" | "partial" | "unknown";
  status: "available" | "unavailable";
  value?: unknown;
  omitted?: boolean;
}>;
export type ContextObservationProvider = Readonly<{
  source: string;
  read: (core: Readonly<ReturnType<typeof readTaskContext>>, signal: AbortSignal) =>
    Promise<Readonly<{ coverage: ContextObservation["coverage"]; value: unknown }>>;
}>;

/** A current read model, not a second snapshot store or a delivery receipt.
 * Every public path checks the same scope before reading, counting or paging.
 */
export function readTaskContext(
  store: TaskStore, taskId: string, environment: NodeJS.ProcessEnv = {}
) {
  return store.readTransaction((reader) => {
    const scope = authorizeContext(reader, taskId, environment);
    const sources = authorizedSources(reader, scope, true);
    const count = sources.reduce((total, source) => total + source.count, 0);
    const cursor = currentCursor(reader, taskId);
    const phase = taskPhase(reader, scope.task);
    const phaseSource = phase?.activation?.source;
    const priorMessageId = phaseSource?.priorMessageId;
    // Reserve a small, classified view before ordinary history consumes the
    // page. Counts and samples come from the exact same authorized read.
    const attention = summarizeAttention(reader, taskId);
    let bytes = Buffer.byteLength(JSON.stringify(attention));
    const records: Array<{ ref: Ref; summary?: string; value?: unknown; omitted: boolean;
      execution?: ReturnType<typeof currentRunExecution> }> = [];
    let runtimeEvents: TaskEvent[] | undefined;
    page: for (const source of sources) for (const entry of source.read()) {
      if (records.length >= MAX_RECORDS) break page;
      if (records.filter(record => record.ref.store === source.family).length >= 8) continue;
      if (entry.ref.store === "run") runtimeEvents ??= reader.listEventsByType(taskId, ["runtime.agent-error"]);
      const valueBytes = Buffer.byteLength(JSON.stringify(entry.value));
      const content = valueBytes > MAX_VALUE_BYTES || INDEX_ONLY_FAMILIES.has(entry.ref.store)
        ? { ref: entry.ref, summary: summarizeEntry(reader, entry), omitted: true }
        : { ...entry, omitted: false };
      const revisedAfterActivation = entry.ref.store === "task-message" && phaseSource?.ref !== undefined
        && reader.queryContextRecords(taskId, {
          family: "task-event", eventTypes: ["message.updated"], eventMessageId: entry.ref.refId,
          afterSequence: sequence(phaseSource.ref.refId), limit: 0
        }).count > 0;
      const record = { ...content,
        ...(entry.ref.store === "task-message" && phase?.activation?.disposition === "adopted"
          && priorMessageId !== undefined ? {
            phaseRelation: revisedAfterActivation ? "revised-after-activation-request"
              : entry.ref.refId === phaseSource?.messageId ? "activation-source"
              : Number(entry.ref.refId.slice("message-".length)) <= Number(priorMessageId.slice("message-".length))
                ? "recorded-before-activation-request" : "recorded-after-activation-request"
          } : {}),
        ...(entry.ref.store === "run" ? {
        execution: currentRunExecution(reader, entry.value as AgentRun, runtimeEvents)
      } : {}), ...(entry.ref.store === "role" ? {
        providerRetry: providerRetrySummary(reader.getTaskRoleSessionSet(taskId,
          (entry.value as { name: string }).name)?.providerBinding,
          `yui task role session retry ${taskId} ${(entry.value as { name: string }).name} show --json`)
      } : {}) };
      const size = Buffer.byteLength(JSON.stringify(record));
      if (bytes + size > MAX_PAGE_BYTES) break page;
      records.push(record);
      bytes += size;
    }
    const result = {
      taskId, coreCursor: encode(cursor), throughCursor: encode(cursor),
      view: "current",
      phase,
      briefWriteGuard: taskBriefGuard(reader, scope.task),
      caller: scope.caller === undefined ? { kind: "unmanaged-or-global" } : {
        taskId: scope.caller.taskId,
        role: scope.caller.roleName,
        executionAuthority: scope.caller.taskId !== taskId ? "reference-only"
          : currentManagedRuntime(reader, environment, taskId)?.executionAuthority ?? "historical-read-only"
      },
      collections: Object.entries(sources.reduce((counts, source) => {
        counts[source.family] = (counts[source.family] ?? 0) + source.count;
        return counts;
      }, {} as Record<string, number>)).map(([store, total]) => ({
        store, total, returned: records.filter(record => record.ref.store === store).length
      })),
      discovery: `task context list ${taskId} --store <store>`,
      commandDiscovery: {
        help: "yui help", describe: "yui --json help",
        skillCheck: "yui session skills --json",
        ownInbox: "yui inbox list --view current --json",
        note: "Help and completion share the current caller's offline command view. Follow that view for operation-specific discovery; execution always revalidates authority."
      },
      detail: `task context inspect ${taskId} --store <store> --ref <refId> --digest <digest>`,
      attention,
      records, count,
      omitted: { records: count - records.length, values: records.filter((r) => r.omitted).length },
      observations: [] as ContextObservation[],
      limits: { records: MAX_RECORDS, valueBytes: MAX_VALUE_BYTES, pageBytes: 32 * 1024, recordBytes: MAX_PAGE_BYTES,
        attentionRefsPerCategory: MAX_ATTENTION_REFS, attentionRefBytesPerCategory: MAX_VALUE_BYTES }
    };
    // Account for nested retry facts, collection counts, commands and JSON
    // structure together. Exact omitted records stay discoverable by family.
    while (!fitsReadBudget(result) && records.length > 0) {
      records.pop();
      result.collections.forEach(collection => {
        collection.returned = records.filter(record => record.ref.store === collection.store).length;
      });
      result.omitted = { records: count - records.length, values: records.filter(record => record.omitted).length };
    }
    if (!fitsReadBudget(result)) throw usageError("Context identities exceed the response budget; use scoped discovery.");
    return result;
  });
}

/** Keep live delivery/attempt facts, but do not replay retry diagnostics and
 * history into the working index. Exact Run inspect below retains the full
 * observation, under the same authorization and document-pagination contract.
 */
function currentRunExecution(store: TaskStore, run: AgentRun, events?: TaskEvent[]) {
  const binding = store.getTaskRoleSessionSet(run.taskId, run.roleName)?.providerBinding;
  const execution = runExecutionObservation(run, binding, events);
  return { ...execution, retry: execution.retry === null ? null : providerRetrySummary(binding,
    `yui task role session retry ${run.taskId} ${run.roleName} show --json`) };
}

function summarizeAttention(store: TaskStore, taskId: string) {
  const group = () => ({ count: 0, refs: [] as Ref[], omittedRefs: 0 });
  const attention = {
    openInputs: group(), pendingOperations: group(), unknownOperations: group(), messages: group()
  };
  for (const [category, family, statuses] of [
    ["openInputs", "input-request", ["open"]],
    ["pendingOperations", "job", ["queued", "running"]],
    ["unknownOperations", "job", ["unknown-needs-attention"]],
    ["messages", "task-message", undefined]
  ] as const) {
    const page = store.queryContextRecords(taskId, {
      family, statuses, descending: category === "messages",
      unhandledMessages: category === "messages", limit: MAX_ATTENTION_REFS
    });
    const summary = attention[category];
    summary.count = page.count;
    let bytes = 0;
    for (const { id, value } of page.records) {
      const ref = materialize(family, id, value).ref;
      const size = Buffer.byteLength(JSON.stringify(ref)) + 1;
      if (bytes + size > MAX_VALUE_BYTES) break;
      summary.refs.push(ref);
      bytes += size;
    }
    summary.omittedRefs = summary.count - summary.refs.length;
  }
  return attention;
}

/** Delta is immutable Task event history, not latest mutable record contents
 * mislabeled as an old snapshot. Inspect/read explicitly obtains current facts.
 * A continuation carries the first page's fixed upper event bound.
 */
export function readTaskContextDelta(
  store: TaskStore, taskId: string,
  input: Readonly<{ after: string; continuation?: string; limit?: number }>,
  environment: NodeJS.ProcessEnv = {}
) {
  return store.readTransaction((reader) => {
    authorizeContext(reader, taskId, environment);
    const start = decode(input.after, taskId);
    const now = currentCursor(reader, taskId);
    const continuation = input.continuation === undefined ? undefined : decodePage(input.continuation, taskId);
    if (continuation !== undefined && continuation.baseline !== encode(start)) {
      throw usageError("Context continuation belongs to a different baseline; restart from the original starting cursor.");
    }
    const bound = continuation ?? now;
    const after = continuation?.after ?? start.sequence;
    if (start.source !== now.source || bound.source !== now.source
      || start.sequence > bound.sequence || after < start.sequence || after > bound.sequence
      || start.revision > bound.revision
      || bound.sequence > now.sequence || start.revision > now.revision || bound.revision > now.revision) {
      throw usageError(`Context cursor is outside the current Task history; reread task context ${taskId} for a new bounded baseline.`);
    }
    const limit = input.limit ?? MAX_EVENTS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENTS) {
      throw usageError(`Context delta limit must be between 1 and ${MAX_EVENTS}.`);
    }
    const selected = reader.queryContextRecords(taskId, {
      family: "task-event",
      afterSequence: after, throughSequence: bound.sequence, limit
    });
    const page: Array<{ ref: Ref; value?: unknown; omitted: boolean }> = [];
    let bytes = 0;
    for (const { value } of selected.records) {
      const event = value as TaskEvent;
      const entry = materialize("task-event", event.id, event);
      const record = Buffer.byteLength(JSON.stringify(event)) > MAX_VALUE_BYTES
        ? { ref: entry.ref, omitted: true }
        : { ...entry, omitted: false };
      const size = Buffer.byteLength(JSON.stringify(record));
      if (page.length >= limit || bytes + size > MAX_PAGE_BYTES) break;
      page.push(record);
      bytes += size;
    }
    const last = page.at(-1)?.ref.refId;
    const more = selected.count > page.length;
    const through = { taskId, source: bound.source, sequence: bound.sequence, revision: bound.revision };
    return {
      taskId, kind: "event-history" as const, fromCursor: encode(start),
      events: page, count: selected.count, complete: !more, throughCursor: encode(through),
      stateChanged: start.revision !== bound.revision,
      currentRead: `task context ${taskId}`,
      ...(more && last !== undefined
        ? { continuation: encode({ ...through, after: sequence(last), baseline: encode(start) }) } : {}),
      observations: [] as ContextObservation[]
    };
  });
}

export function inspectTaskContext(
  store: TaskStore, taskId: string, selector: Readonly<{ store: string; refId: string; digest?: string; cursor?: string }>,
  environment: NodeJS.ProcessEnv = {}
) {
  const response = readTaskContextResource(store, taskId, selector, environment);
  return boundedDocument(response, `task:${taskId}/${selector.store}/${selector.refId}`, selector.cursor);
}

/** CLI spelling shared by explicit dispatch selection and grouped reading. */
export function parseExactContextRef(selector: string) {
  const match = /^([^/]+)\/(.+)@([0-9a-f]{64})$/u.exec(selector);
  if (match === null)
    throw usageError(`Invalid required Context reference: ${selector}. Use store/refId@digest from the applicable Context pointers or list/inspect.`);
  return { store: match[1]!, refId: match[2]!, digest: match[3]! };
}

/** Explicit independent originals, one shared transport budget. Reuse the
 * single-reference authorization/digest checks on every page. No implicit
 * discovery, partial success, cached values or read/handling receipts.
 */
export function inspectTaskContextBatch(
  store: TaskStore, taskId: string, selectors: unknown, cursor?: string,
  environment: NodeJS.ProcessEnv = {}
) {
  if (!Array.isArray(selectors) || selectors.length < 1 || selectors.length > 8)
    throw usageError("Context batch requires 1..8 exact references.");
  const seen = new Set<string>();
  const refs = selectors.map((value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw usageError("Context batch reference requires store, refId and digest.");
    const ref = value as Record<string, unknown>;
    if (Object.keys(ref).some(key => !["store", "refId", "digest", "revision"].includes(key))
      || typeof ref.store !== "string" || !ref.store
      || typeof ref.refId !== "string" || !ref.refId
      || typeof ref.digest !== "string" || !/^[a-f0-9]{64}$/.test(ref.digest)
      || ref.revision !== undefined && typeof ref.revision !== "string")
      throw usageError("Context batch reference requires exact store, refId and digest; revision is optional metadata.");
    const key = JSON.stringify([ref.store, ref.refId]);
    if (seen.has(key)) throw usageError("Duplicate Context batch reference.");
    seen.add(key);
    return { store: ref.store, refId: ref.refId, digest: ref.digest };
  });
  // All-or-error: a stale/forbidden source cannot be silently skipped. Each
  // source is independently digest-pinned; this is not a new cross-record
  // snapshot. A continuation is additionally bound to the complete response.
  const items = refs.map(ref => readTaskContextResource(store, taskId, ref, environment));
  return boundedDocument({ taskId, items }, `task:${taskId}/context-batch:${readDigest(refs)}`, cursor);
}

/** The same authorized read as inspect, before transport pagination. */
export function readTaskContextResource(
  store: TaskStore, taskId: string, selector: Readonly<{ store: string; refId: string; digest?: string }>,
  environment: NodeJS.ProcessEnv = {}
) {
  return store.readTransaction((reader) => {
    const scope = authorizeContext(reader, taskId, environment);
    const value = inspectValue(reader, scope, selector);
    if (value === null) throw usageError("Context reference is unavailable in the caller's current scope.");
    const entry = materialize(selector.store, selector.refId, value);
    if (selector.digest !== undefined && entry.ref.digest !== selector.digest) {
      throw usageError("Context reference changed; read its current reference before inspecting again.", undefined, {
        currentRef: entry.ref
      });
    }
    const expansion = selector.store === "task-message"
      ? expandTaskMessageResult(value as TaskMessage, (task, run) => reader.getRun(task, run))
      : undefined;
    const response = { ...entry, ...(expansion !== undefined && "result" in expansion
      ? { result: expansion.result } : {}),
      ...(selector.store === "run" ? { execution: runExecutionObservation(value as AgentRun,
        reader.getTaskRoleSessionSet(taskId, (value as AgentRun).roleName)?.providerBinding,
        reader.listEventsByType(taskId, ["runtime.agent-error"])) } : {}),
    };
    return response;
  });
}

/** Discover one authorized family without copying its bodies or unrelated Task
 * state. Content-version cursors fail explicitly if the collection changes.
 */
export function listTaskContext(
  store: TaskStore, taskId: string, family: string,
  options: ReadPageOptions & { view?: string; status?: string; after?: string; workItemId?: string } = {},
  environment: NodeJS.ProcessEnv = {}
) {
  return store.readTransaction(reader => {
    const scope = authorizeContext(reader, taskId, environment);
    if (options.view !== undefined && !["current", "all"].includes(options.view)) {
      throw usageError("Context list view must be current or all.");
    }
    const sources = authorizedSources(reader, scope, options.view === "current", family, true);
    if (!CONTEXT_FAMILIES.includes(family)) throw usageError(`Unknown Context store: ${family}.`);
    if (options.after !== undefined && !Number.isFinite(Date.parse(options.after))) throw usageError("Invalid --after timestamp.");
    const retiredKind = family === "task-message" ? "message" : family === "run" ? "run" : undefined;
    const retired = retiredKind === undefined ? undefined
      : retiredTaskRecordIds(reader.listEventsByType(taskId, [TASK_RECORD_RETIRED_EVENT]), retiredKind);
    const records: Array<{ ref: Ref; summary: string; status?: unknown }> = [];
    for (const source of sources) {
      for (let offset = 0; offset < source.count; offset += MAX_RECORDS) {
        for (const entry of source.read(offset)) {
          const value = entry.value as Record<string, unknown>;
          if (options.status !== undefined && value.status !== options.status
            || options.workItemId !== undefined && value.workItemId !== options.workItemId
            || options.after !== undefined && Date.parse(String(value.createdAt)) <= Date.parse(options.after)) continue;
          records.push({ ref: entry.ref, summary: summarizeEntry(reader, entry),
            ...(retired === undefined ? {} : { history: retired.has(entry.ref.refId) ? "retired" : "active" }),
            ...Object.fromEntries(["status", "kind", "type", "createdAt", "roleName", "assignee", "purpose", "workItemId", "reviewRoundId"]
              .filter(key => typeof value[key] === "string").map(key => [key, value[key]])) });
        }
      }
    }
    return recordPage(records, `task:${taskId}/${family}/${JSON.stringify({
      view: options.view ?? "all", status: options.status, after: options.after, workItemId: options.workItemId
    })}`, options);
  });
}

export function listContextMessages(
  store: TaskStore, taskId: string, environment: NodeJS.ProcessEnv = {}
): TaskMessage[] {
  return store.readTransaction((reader) => {
    authorizeContext(reader, taskId, environment);
    return reader.listMessages(taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  });
}

/** Optional read-only providers receive only the caller's bounded core view.
 * No Store, credentials or mutation port is exposed. An unavailable provider
 * cannot prevent returning the core. This is a trusted in-process port, not a
 * JavaScript sandbox; executable plugin admission belongs to its owner.
 */
export async function withContextObservations(
  core: ReturnType<typeof readTaskContext>,
  providers: readonly ContextObservationProvider[],
  timeoutMs = 250
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000 || providers.length > 8) {
    throw usageError("Optional Context providers exceed the bounded observation budget.");
  }
  const observations = await Promise.all(providers.map(async (provider): Promise<ContextObservation> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => provider.read(freeze(JSON.parse(JSON.stringify(core))), controller.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs);
        })
      ]);
      if (!["known", "partial", "unknown"].includes(value.coverage)
        || Buffer.byteLength(JSON.stringify(value)) > MAX_VALUE_BYTES) throw new Error("unbounded observation");
      return { source: summaryText(provider.source, 200), observedAt: new Date().toISOString(),
        coverage: value.coverage, status: "available", value: JSON.parse(JSON.stringify(value.value)) };
    } catch {
      return { source: summaryText(provider.source, 200), observedAt: new Date().toISOString(),
        coverage: "unknown", status: "unavailable" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }));
  const result = { ...core, observations: [] as ContextObservation[] };
  for (const observation of observations) {
    result.observations.push(observation);
    if (!fitsReadBudget(result)) {
      result.observations.pop();
      const { value: _value, ...identity } = observation;
      result.observations.push({ ...identity, omitted: true });
      if (!fitsReadBudget(result)) result.observations.pop();
    }
  }
  return { ...result, omittedObservations: observations.length - result.observations.length };
}

/** Authenticate ordinary reads of the local user's resource. Task/Assignment
 * ownership is execution scope, not a confidentiality boundary. This does not
 * switch Home, impersonate a target Role, or relax explicit global Job limits.
 * Filesystem access and the authenticated Web/Controller transport remain the
 * resource boundary of this single-user local product. */
export function resolveContextReader(store: TaskStore, environment: NodeJS.ProcessEnv) {
  const caller = resolveManagedTaskReader(store, environment);
  if (caller === undefined && environment.YUI_SESSION_SCOPE === "global" && environment.YUI_ROLE !== "operator") {
    throw usageError("Only Operator may read Task context from a global Session.");
  }
  if (caller === undefined && environment.YUI_SESSION_SCOPE === undefined
    && hasManagedIdentity(environment)) {
    throw usageError("Incomplete managed Context caller identity.");
  }
  if (environment.YUI_SESSION_SCOPE !== undefined && !["task", "global"].includes(environment.YUI_SESSION_SCOPE)) {
    throw usageError("Incomplete managed Context caller identity.");
  }
  return caller;
}

function authorizeContext(store: TaskStore, taskId: string, environment: NodeJS.ProcessEnv) {
  const caller = resolveContextReader(store, environment);
  const task = store.getTask(taskId);
  if (task === null) throw taskNotFound(taskId);
  return { task, caller };
}

/** Independent record commands authenticate against the same resource boundary. */
export function assertTaskReadable(store: TaskStore, taskId: string, environment: NodeJS.ProcessEnv = {}) {
  authorizeContext(store, taskId, environment);
}

function roleProfile(role: NonNullable<ReturnType<TaskStore["getRole"]>>) {
  return {
    name: role.name, defaultAccess: role.defaultAccess, description: role.description,
    responsibilities: role.responsibilities ?? [], constraints: role.constraints ?? [],
    skills: role.skills ?? [], launchRevision: role.launchRevision
  };
}

/** Resolve just the requested family. Families without a singular Store read
 * use their existing list primitive, without constructing unrelated Context.
 */
function inspectValue(
  store: TaskStore,
  { task, caller }: ReturnType<typeof authorizeContext>,
  { store: family, refId }: Readonly<{ store: string; refId: string }>
): unknown | null {
  const taskId = task.id;
  switch (family) {
    case "task": return refId === taskId ? task : null;
    case "task-brief": return refId === taskId ? store.getTaskBrief(taskId) : null;
    case "remote-delivery": return refId === taskId
      ? projectTaskRemoteDeliveryFromStore(store, task) : null;
    case "role": return store.getRole(taskId, refId);
    case "role-profile": {
      const role = store.getRole(taskId, refId);
      return role === null ? null : roleProfile(role);
    }
    case "project-policy":
    case "project-knowledge": {
      const binding = task.projectBindings.find(({ projectId }) => family === "project-policy"
        ? projectId === refId : refId.startsWith(`${projectId}:`));
      if (binding === undefined) return null;
      const project = store.getProject(binding.projectId);
      if (project === null) return null;
      const { knowledge, ...policy } = project;
      if (family === "project-policy") return policy;
      const entry = knowledge.find((item) => item.status === "active" && `${project.id}:${item.id}` === refId);
      return entry === undefined ? null : { projectId: project.id, ...entry };
    }
    case "input-request": return store.getInputRequest(taskId, refId);
    case "work-item": return store.getWorkItem(taskId, refId);
    case "accepted-work-item": {
      const item = store.getWorkItem(taskId, refId);
      return item?.status === "accepted" ? item : null;
    }
    case "candidate": {
      const parts = refId.split("/");
      if (parts.length !== 2) return null;
      return store.getWorkItem(taskId, parts[0]!)?.candidates
        .find((candidate) => candidate.id === parts[1]) ?? null;
    }
    case "task-message":
    case "publication":
    case "task-event":
      return store.queryContextRecords(taskId, { family, ids: [refId], limit: 1 }).records[0]?.value ?? null;
    case "run": return store.getRun(taskId, refId);
    case "source-run": {
      const run = store.getRun(taskId, refId);
      return run === null ? null : sourceRunContextValue(run);
    }
    case "review-round": return store.getReviewRound(taskId, refId);
    case "artifact": {
      // A file artifact is addressed by its self-certifying commit-pinned refId
      // (git:<commit>:<relativePath>). Resolve it to the pure pointer only; the
      // bytes are read on the async `artifact.read` path, never synchronously in
      // this transaction.
      if (!isGitArtifactRefString(refId)) return null;
      try {
        const pinned = parseGitArtifactRef(refId, taskId);
        return {
          taskId: pinned.taskId,
          commit: pinned.commit,
          relativePath: pinned.relativePath,
          ...(pinned.digest === undefined ? {} : { digest: pinned.digest })
        };
      } catch { return null; }
    }
    case "environment-preparation": return store.getEnvironmentPreparation(taskId, refId);
    case "change-set": return store.getChangeSet(taskId, refId);
    case "managed-workspace": {
      // Existing frozen AgentRun overlays use the Task/Role alias; owner keys
      // identify the durable workspace in current Task reads.
      if (caller?.taskId === taskId && caller.currentRunId !== undefined && refId === `${taskId}/${caller.roleName}`) {
        return store.getRun(taskId, caller.currentRunId)?.workspace ?? null;
      }
      return store.listManagedWorkspaces(taskId)
        .find((workspace) => managedWorkspaceKey(workspace.owner) === refId) ?? null;
    }
    case "mailbox": {
      if (refId === "task") return store.getWorkMailbox({ kind: "task", taskId });
      const roleName = refId.startsWith("role:") ? refId.slice("role:".length) : undefined;
      return roleName !== undefined && store.getRole(taskId, roleName) !== null
        ? store.getWorkMailbox({ kind: "role", taskId, roleName }) : null;
    }
    case "task-decision": return store.getDecision(taskId, refId);
    case "task-milestone": return store.getMilestone(taskId, refId);
    case "job": return store.getDurableJob(taskId, refId);
    default: return null;
  }
}

type EntrySource = { family: string; count: number; read(offset?: number): Iterable<Entry> };

function authorizedSources(store: TaskStore, { task, caller }: ReturnType<typeof authorizeContext>,
  current = false, requestedFamily?: string, discovery = false): EntrySource[] {
  const taskId = task.id;
  const sources: EntrySource[] = [];
  const add = (family: string, id: string, value: unknown) => {
    if ((requestedFamily === undefined || requestedFamily === family) && value !== null) {
      sources.push({ family, count: 1, read: () => [materialize(family, id, value)] });
    }
  };
  const query = (family: ContextRecordFamily, options: Partial<ContextRecordQuery> = {}) => {
    if (requestedFamily !== undefined && requestedFamily !== family) return;
    const selection = { ...options, family };
    const { count } = store.queryContextRecords(taskId, { ...selection, limit: 0 });
    // The bounded current index must not bury Task main behind alphabetically
    // earlier integration/review history. Full discovery keeps its stable order.
    const taskWorkspaceKey = managedWorkspaceKey({ type: "task", taskId });
    const preferredWorkspace = current && !discovery && family === "managed-workspace"
      ? store.getManagedWorkspace({ type: "task", taskId }) : null;
    sources.push({ family, count, *read(offset = 0) {
      if (preferredWorkspace !== null) yield materialize(family, taskWorkspaceKey, preferredWorkspace);
      for (const { id, value } of store.queryContextRecords(taskId, {
        ...selection, offset, limit: current && !discovery ? 8 : MAX_RECORDS
      }).records) {
        if (preferredWorkspace !== null && id === taskWorkspaceKey) continue;
        yield materialize(family, id, value);
      }
    } });
  };
  add("task", taskId, task);
  add("task-brief", taskId, store.getTaskBrief(taskId));
  if (requestedFamily === undefined || requestedFamily === "remote-delivery") {
    add("remote-delivery", taskId, projectTaskRemoteDeliveryFromStore(store, task));
  }
  for (const role of store.listRoles(taskId)) {
    add("role", role.name, role);
    if (!current) add("role-profile", role.name, roleProfile(role));
  }
  for (const binding of task.projectBindings) {
    const project = store.getProject(binding.projectId);
    if (project === null) continue;
    const { knowledge, ...policy } = project;
    add("project-policy", project.id, policy);
    for (const entry of knowledge.filter((k) => k.status === "active")) {
      add("project-knowledge", `${project.id}:${entry.id}`, { projectId: project.id, ...entry });
    }
  }
  // Current responsibilities and unanswered inputs precede historical bulk.
  query("input-request", { statuses: ["open"] });
  query("work-item", current ? { excludeStatuses: ["accepted", "retired"] } : {});
  if (!current) query("candidate");
  // File artifacts are not enumerated into the synchronous Context listing: the
  // core cursor does not cover file edits and an ambient directory index here
  // would be the forbidden update-time mirror (§3.7). Current artifacts are
  // listed on demand via the async `artifact.list` capability; frozen Candidate
  // artifacts remain reachable as commit-pinned pointers under their Candidate.
  if (!current) query("environment-preparation");
  if (!current || discovery) query("managed-workspace");
  if (caller?.taskId === taskId && caller.currentRunId !== undefined) {
    add("managed-workspace", `${taskId}/${caller.roleName}`,
      store.getRun(taskId, caller.currentRunId)?.workspace ?? null);
  }
  if (current && !discovery) query("managed-workspace");
  if (!current) query("change-set");
  query("task-message", { descending: true, unhandledMessages: current });
  query("run", { descending: true, ...(current ? { statuses: ["active"] } : {}) });
  query("review-round", { descending: true, ...(current ? { statuses: ["pending", "running"] } : {}) });
  if (!current) query("input-request", { excludeStatuses: ["open"] });
  if (!current) {
    add("mailbox", "task", store.getWorkMailbox({ kind: "task", taskId }));
    for (const role of store.listRoles(taskId)) {
      add("mailbox", `role:${role.name}`, store.getWorkMailbox({ kind: "role", taskId, roleName: role.name }));
    }
  }
  query("task-decision", current ? { statuses: ["active"] } : {});
  if (!current) {
    query("task-milestone");
    query("publication");
    query("task-event", { descending: true });
  }
  query("job", current ? { statuses: ["queued", "running", "unknown-needs-attention"] } : {});
  return sources;
}

export function materialize(store: string, refId: string, value: unknown): Entry {
  const digest = contextContentDigest(value);
  const record = value as Record<string, unknown>;
  return { ref: { store, refId, revision: String(record.revision ?? record.updatedAt ?? record.createdAt ?? digest), digest }, value };
}
function currentCursor(store: TaskStore, taskId: string): Cursor {
  return { taskId, source: store.getHomeIdentity().homeId,
    sequence: store.latestEventSequence(taskId), revision: store.getStateRevision() };
}
function sequence(id: string): number {
  const result = /^event-(\d+)$/.exec(id);
  if (result === null || !Number.isSafeInteger(Number(result[1]))) throw usageError("Task event has an invalid sequence.");
  return Number(result[1]);
}
function encode(value: Cursor | PageCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decode(value: string, taskId: string): Cursor {
  try {
    if (value.length > 1024) throw new Error("size");
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString()) as Cursor;
    if (cursor.taskId !== taskId || typeof cursor.source !== "string"
      || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0
      || !Number.isSafeInteger(cursor.revision) || cursor.revision < 0) throw new Error("shape");
    return { taskId: cursor.taskId, source: cursor.source, sequence: cursor.sequence, revision: cursor.revision };
  } catch { throw usageError("Invalid or expired Context cursor for this Task; reread current Context for a new bounded baseline."); }
}
function decodePage(value: string, taskId: string): PageCursor {
  const base = decode(value, taskId);
  const cursor = JSON.parse(Buffer.from(value, "base64url").toString()) as PageCursor;
  if (!Number.isSafeInteger(cursor.after) || cursor.after < 0 || typeof cursor.baseline !== "string") {
    throw usageError("Invalid or expired Context continuation; reread current Context and start a new bounded window.");
  }
  return { ...base, after: cursor.after, baseline: cursor.baseline };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
function summarize(value: unknown): string {
  const record = value as Record<string, unknown>;
  return summaryText(["title", "name", "status", "type", "currentFocus", "root", "activeAgentId", "scope", "expiresWhen", "version", "objective", "question", "summary", "body"]
    .flatMap((key) => typeof record[key] === "string" || (key === "version" && typeof record[key] === "number")
      ? [`${key}: ${record[key]}`] : [])
    .join("; "));
}

/** Reuse producer-authored navigation, never generate a verdict or copy a
 * report. The authorized Message already permits its matching terminal result
 * through exact inspect; unrelated/malformed links cannot supply summaries.
 */
function summarizeEntry(store: TaskStore, entry: Entry): string {
  if (entry.ref.store === "task-message") {
    const message = entry.value as TaskMessage;
    const presentation = taskMessagePresentation(message, (taskId, runId) => {
      const run = store.getRun(taskId, runId);
      return run !== null && run.taskId === message.taskId
        && message.author.type === "role" && run.roleName === message.author.roleName
        && run.status !== "active" && run.result !== undefined ? run : null;
    });
    if (presentation.summary !== undefined) {
      // Include attribution in the existing budget without clipping qualifiers.
      const label = `Author summary (${presentation.summarySource})`;
      const text = `${label}: ${presentation.summary}`;
      return Buffer.byteLength(text) <= 512 ? text
        : `${label} omitted: exceeds discovery budget; read original.`;
    }
  }
  return summarize(entry.value);
}
