import type { AgentRun } from "../agentRun/agentRun.js";
import { providerRetryProjection } from "../runtime/providerRetry.js";
import type { TaskStore } from "../storage/taskStore.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";
import { TASK_COMPLETION_PUBLISHED_TREE_AUTHORIZED_EVENT } from "../task/publicationReference.js";
import { RUN_INPUT_MAX_DELTAS, requireRunContextSnapshotRef } from "./runInputContract.js";
import { requireIdentity } from "../domain/validation.js";
import { assertWorkItemDependenciesCompleted } from "../workItem/dependencyGate.js";
import { governingWorkItemCandidate, workItemExecutionGroupById, type WorkItem } from "../workItem/workItem.js";
import {
  formatGitArtifactRef,
  validateGitArtifactRef
} from "../artifacts/gitArtifactRef.js";
import { managedWorkspaceKey } from "../worktree/managedWorkspace.js";
import {
  contextContentDigest,
  contextSnapshotRef,
  createContextSnapshot,
  validateContextSnapshot,
  type ContextRef,
  type ContextSnapshot,
  type ContextSnapshotRef,
  type ContextSnapshotScope
} from "./contextSnapshot.js";
import { MAX_SYNTHESIS_SOURCE_RUNS, sourceRunContextValue } from "./sourceRunContext.js";

export const RUN_CONTEXT_PACK_SCHEMA_VERSION = 1 as const;
export const RUN_CONTEXT_PACK_MAX_REFS = 256;
export const RUN_CONTEXT_PACK_MAX_BYTES = 8 * 1024 * 1024;
export const RUN_CONTEXT_EXPAND_MAX_BYTES = 4 * 1024 * 1024;

export type AgentRunContextView = "operator" | "leader" | "worker" | "reviewer" | "global";
export type AgentRunContextSummary = Readonly<{
  refId: string;
  store: string;
  summary: string;
  digest: string;
}>;
export type AgentRunContextBudgetResult = Readonly<{
  maxRefs: number;
  returnedRefs: number;
  maxBytes: number;
  returnedBytes: number;
  truncated: false;
}>;
export type AgentRunContextPack = Readonly<{
  schemaVersion: typeof RUN_CONTEXT_PACK_SCHEMA_VERSION;
  identity: Readonly<{
    taskId: string;
    runId: string;
    roleName: string;
    purpose: AgentRun["purpose"];
    agentId: string;
    adapterId: string;
    workspace: string;
  }>;
  snapshot: ContextSnapshotRef;
  input: AgentRun["inputs"][number]["input"];
  authority: Readonly<{
    view: AgentRunContextView;
    readableRefs: readonly ContextRef[];
    writableProjectIds: readonly string[];
  }>;
  pointers: readonly ContextRef[];
  summaries: readonly AgentRunContextSummary[];
  deltas: readonly ContextRef[];
  completion: Readonly<{
    allowedActions: readonly string[];
    exactRunRef: string;
  }>;
  budget: AgentRunContextBudgetResult;
  digest: string;
  liveTaskState: AgentRunContextLiveTaskState;
}>;

/**
 * What is true on the Task right now, read when the Pack was built.
 *
 * Everything else in the Pack is the frozen contract this AgentRun was handed. A
 * long-running AgentRun can be handed that contract and then find the Task has
 * moved on: another Role may still be executing, or a Task-final Review may
 * still be in flight. Without this block a Leader has to already suspect that
 * and go ask, which is exactly the situation where it will not.
 *
 * These are record pointers, not content, and they gate nothing. They sit
 * outside the content digest on purpose: that digest is the delta cursor for
 * the frozen refs and must not move just because the world moved.
 */
export type AgentRunContextLiveTaskState = Readonly<{
  providerRetries: readonly Readonly<{
    roleName: string;
    retry: ReturnType<typeof import("../runtime/providerRetry.js").providerRetryProjection>;
  }>[];
  activeRuns: readonly Readonly<{
    runId: string;
    roleName: string;
    purpose: AgentRun["purpose"];
    workItemId?: string;
    reviewRoundId?: string;
  }>[];
  activeTaskReviews: readonly Readonly<{
    reviewRoundId: string;
    reviewerRoleName: string;
    status: "pending" | "running";
  }>[];
}>;

type MaterializedRef = Readonly<{ ref: ContextRef; value: unknown }>;

export function freezeRunContextSnapshot(
  store: TaskStore,
  run: Readonly<Pick<
    AgentRun,
    "taskId" | "roleName" | "purpose" | "workItemId" | "reviewRoundId"
      | "sourceExecutionGroupId" | "workspace"
  >>,
  now: Date,
  frozenBy: "leader" | "controller" = "controller",
  baselineRef?: ContextSnapshotRef,
  sourceRunIds?: readonly string[]
): ContextSnapshot {
  if (baselineRef !== undefined) {
    const baseline = store.getContextSnapshot(run.taskId, baselineRef.id);
    if (baseline === null
      || baseline.taskId !== run.taskId
      || baselineRef.taskId !== run.taskId
      || baseline.digest !== baselineRef.digest
      || baseline.sequence !== baselineRef.sequence
      || baseline.scope !== "stage"
      || baselineRef.scope !== baseline.scope
      || baseline.scopeRef !== baselineRef.scopeRef) {
      throw new Error(`AgentRun Context baseline is missing or drifted: ${baselineRef.id}.`);
    }
    validateContextSnapshot(baseline);
    const overlays = [
      ...collectRunContextOverlays(store, run),
      ...collectSourceRunContext(store, run, sourceRunIds)
    ];
    const resources = [...new Map([...baseline.resources, ...overlays].map((entry) => [
      contextRefIdentity(entry.ref),
      entry
    ])).values()].sort((left, right) => (
      contextRefIdentity(left.ref).localeCompare(contextRefIdentity(right.ref))
    ));
    const previous = store.listContextSnapshots(run.taskId)
      .filter((candidate) => candidate.scope === baseline.scope
        && candidate.scopeRef === baseline.scopeRef)
      .sort((left, right) => left.sequence - right.sequence)
      .at(-1);
    const snapshot = createContextSnapshot({
      id: store.nextContextSnapshotId(run.taskId),
      taskId: run.taskId,
      scope: baseline.scope,
      scopeRef: baseline.scopeRef,
      sequence: (previous?.sequence ?? baseline.sequence) + 1,
      refs: resources.map(({ ref }) => ref),
      resources,
      ...(baseline.repoCommit === undefined ? {} : { repoCommit: baseline.repoCommit }),
      acceptRefs: baseline.acceptRefs,
      parentRef: contextSnapshotRef(baseline),
      frozenAt: now,
      frozenBy
    });
    store.saveContextSnapshot(snapshot);
    return snapshot;
  }
  const scope: ContextSnapshotScope = run.reviewRoundId !== undefined
    ? "stage"
    : run.workItemId !== undefined
      ? "workitem"
      : "task";
  const scopeRef = run.reviewRoundId ?? run.workItemId;
  const materialized = collectAuthorizedContext(store, run);
  const previous = store.listContextSnapshots(run.taskId)
    .filter((candidate) => candidate.scope === scope && candidate.scopeRef === scopeRef)
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
  const snapshot = createContextSnapshot({
    id: store.nextContextSnapshotId(run.taskId),
    taskId: run.taskId,
    scope,
    ...(scopeRef === undefined ? {} : { scopeRef }),
    sequence: (previous?.sequence ?? 0) + 1,
    refs: materialized.map(({ ref }) => ref),
    resources: materialized,
    acceptRefs: run.workItemId === undefined ? [] : [`work-item:${run.workItemId}:acceptance`],
    ...(previous === undefined ? {} : { parentRef: contextSnapshotRef(previous) }),
    frozenAt: now,
    frozenBy
  });
  store.saveContextSnapshot(snapshot);
  return snapshot;
}

/**
 * Freeze the shared, role-neutral ContextSnapshot anchored by one WorkItem
 * ExecutionAssignment. AgentRun snapshots remain role-specific; this record is
 * the durable Assignment baseline and freezes the current WorkItem facts so
 * the Group never depends on ambient latest state.
 */
export function freezeWorkItemExecutionAssignmentContextSnapshot(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    workItemId: string;
    executionGroupId: string;
  }>,
  now: Date
): ContextSnapshot {
  const task = store.getTask(input.taskId);
  if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
  const workItem = store.getWorkItem(input.taskId, input.workItemId);
  if (workItem === null) throw new Error(`WorkItem not found: ${input.workItemId}.`);
  const materialized: MaterializedRef[] = [
    materialize("L2", "task", task.id, task),
    materialize("L3", "work-item", workItem.id, workItem)
  ];
  materialized.push(...candidateArtifacts(task.id, workItem.candidates));
  assertWorkItemDependenciesCompleted(store, workItem);
  for (const dependencyId of workItem.dependsOn) {
    const dependency = store.getWorkItem(task.id, dependencyId);
    if (dependency === null) throw new Error(`WorkItem dependency disappeared: ${dependencyId}.`);
    materialized.push(materialize("L3", "accepted-work-item", dependency.id, dependency));
    materialized.push(...candidateArtifacts(task.id, dependency.candidates));
  }
  for (const binding of task.projectBindings) {
    const project = store.getProject(binding.projectId);
    if (project === null) throw new Error(`AgentRun Project not found: ${binding.projectId}.`);
    const { knowledge, ...projectPolicy } = project;
    materialized.push(materialize("L1", "project-policy", project.id, projectPolicy));
    for (const entry of knowledge.filter(({ status }) => status === "active")) {
      materialized.push(materialize(
        "L1",
        "project-knowledge",
        `${project.id}:${entry.id}`,
        { projectId: project.id, ...entry }
      ));
    }
  }
  const resources = [...new Map(materialized.map((entry) => [
    contextRefIdentity(entry.ref),
    entry
  ])).values()].sort((left, right) => (
    contextRefIdentity(left.ref).localeCompare(contextRefIdentity(right.ref))
  ));
  const assignmentSnapshot = createContextSnapshot({
    id: store.nextContextSnapshotId(task.id),
    taskId: task.id,
    scope: "stage",
    scopeRef: input.executionGroupId,
    sequence: 1,
    refs: resources.map(({ ref }) => ref),
    resources,
    acceptRefs: [`work-item:${workItem.id}:acceptance`],
    frozenAt: now,
    frozenBy: "controller"
  });
  store.saveContextSnapshot(assignmentSnapshot);
  return assignmentSnapshot;
}

/**
 * Freeze the role-neutral baseline for one Reviewer ExecutionGroup before
 * admission. Delayed or retried sibling Lanes reuse the same immutable
 * ReviewRound/Task/Project values and add only their Role overlay.
 */
export function freezeReviewStageContextSnapshot(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    reviewRoundId: string;
    executionGroupId: string;
  }>,
  now: Date
): ContextSnapshot {
  const existing = store.listContextSnapshots(input.taskId)
    .filter((candidate) => candidate.scope === "stage"
      && candidate.scopeRef === input.executionGroupId
      && candidate.parentRef === undefined)
    .sort((left, right) => left.sequence - right.sequence)
    .at(0);
  if (existing !== undefined) return validateContextSnapshot(existing);

  const round = store.getReviewRound(input.taskId, input.reviewRoundId);
  if (round === null) throw new Error(`ReviewRound not found: ${input.reviewRoundId}.`);
  const materialized = collectAuthorizedContext(store, {
    taskId: input.taskId,
    roleName: round.reviewerRoleName,
    purpose: "review",
    ...(round.workItemId === undefined ? {} : { workItemId: round.workItemId }),
    reviewRoundId: round.id
  }).filter(({ ref }) => (
    ref.store !== "role-profile" && ref.store !== "managed-workspace"
  ));
  if (!materialized.some(({ ref }) => (
    ref.store === "review-round" && ref.refId === round.id
  ))) {
    throw new Error(`ReviewRound Context baseline is unavailable: ${round.id}.`);
  }
  const resources = [...new Map(materialized.map((entry) => [
    contextRefIdentity(entry.ref),
    entry
  ])).values()].sort((left, right) => (
    contextRefIdentity(left.ref).localeCompare(contextRefIdentity(right.ref))
  ));
  const snapshot = createContextSnapshot({
    id: store.nextContextSnapshotId(input.taskId),
    taskId: input.taskId,
    scope: "stage",
    scopeRef: input.executionGroupId,
    sequence: 1,
    refs: resources.map(({ ref }) => ref),
    resources,
    acceptRefs: round.workItemId === undefined ? [] : [`work-item:${round.workItemId}:acceptance`],
    frozenAt: now,
    frozenBy: "controller"
  });
  store.saveContextSnapshot(snapshot);
  return snapshot;
}

/** Bounded changed-ref hint between one frozen Snapshot and its exact parent. */
export function contextSnapshotDeltaRefIds(
  store: TaskStore,
  snapshot: ContextSnapshot
): readonly string[] {
  validateContextSnapshot(snapshot);
  if (snapshot.parentRef === undefined) return Object.freeze([]);
  const parent = store.getContextSnapshot(snapshot.taskId, snapshot.parentRef.id);
  if (parent === null
    || parent.digest !== snapshot.parentRef.digest
    || parent.sequence !== snapshot.parentRef.sequence) {
    throw new Error(`Context Snapshot parent is missing or drifted: ${snapshot.parentRef.id}.`);
  }
  validateContextSnapshot(parent);
  const previous = new Map(parent.refs.map((ref) => [ref.refId, ref]));
  const changed = snapshot.refs.filter((ref) => {
    const before = previous.get(ref.refId);
    return before === undefined
      || before.digest !== ref.digest
      || before.revision !== ref.revision
      || before.store !== ref.store
      || before.layer !== ref.layer;
  }).map(({ refId }) => refId);
  return Object.freeze([...new Set(changed)].sort().slice(0, RUN_INPUT_MAX_DELTAS));
}

export function buildRunContextPack(store: TaskStore, taskId: string, runId: string): AgentRunContextPack {
  const run = requireExactRun(store, taskId, runId);
  const snapshot = readRunContextSnapshot(store, run);
  const pointers = snapshot.refs;
  if (pointers.length > RUN_CONTEXT_PACK_MAX_REFS) {
    throw new Error(`AgentRun Context exceeds ${RUN_CONTEXT_PACK_MAX_REFS} authorized refs.`);
  }
  const view = contextView(run);
  const writableProjectIds = run.effective.executionAuthority === "planning"
    ? [] : run.effective.writeProjectIds;
  const summaries = pointers.map((ref) => Object.freeze({
    refId: ref.refId,
    store: ref.store,
    summary: ref.summary ?? `${ref.store} ${ref.refId}`,
    digest: ref.digest
  }));
  const body = {
    schemaVersion: RUN_CONTEXT_PACK_SCHEMA_VERSION,
    identity: Object.freeze({
      taskId,
      runId: runId,
      roleName: run.roleName,
      purpose: run.purpose,
      agentId: run.effective.agentId,
      adapterId: run.effective.adapterId,
      workspace: run.effective.workspace.root
    }),
    snapshot: contextSnapshotRef(snapshot),
    input: run.inputs[0]!.input,
    authority: Object.freeze({ view, readableRefs: pointers, writableProjectIds }),
    pointers,
    summaries,
    deltas: pointers.filter((ref) => run.inputs[0]!.input.deltaRefIds.includes(ref.refId)),
    completion: Object.freeze({
      allowedActions: completionActions(view, run.effective.executionAuthority),
      exactRunRef: `${taskId}/${runId}`
    })
  };
  const digest = contextContentDigest(body);
  const preliminaryBytes = Buffer.byteLength(JSON.stringify({ ...body, digest }), "utf8");
  if (preliminaryBytes > RUN_CONTEXT_PACK_MAX_BYTES) {
    throw new Error(`AgentRun Context Pack exceeds ${RUN_CONTEXT_PACK_MAX_BYTES} bytes.`);
  }
  const pack = Object.freeze({
    ...body,
    budget: Object.freeze({
      maxRefs: RUN_CONTEXT_PACK_MAX_REFS,
      returnedRefs: pointers.length,
      maxBytes: RUN_CONTEXT_PACK_MAX_BYTES,
      returnedBytes: preliminaryBytes,
      truncated: false as const
    }),
    digest,
    liveTaskState: readLiveTaskState(store, taskId)
  });
  return pack;
}

/** Reads the Task's current in-flight execution, outside the frozen contract. */
function readLiveTaskState(store: TaskStore, taskId: string): AgentRunContextLiveTaskState {
  const activeRuns = store.listActiveRuns(taskId)
    .map((run) => Object.freeze({
      runId: run.id,
      roleName: run.roleName,
      purpose: run.purpose,
      ...(run.workItemId === undefined ? {} : { workItemId: run.workItemId }),
      ...(run.reviewRoundId === undefined ? {} : { reviewRoundId: run.reviewRoundId })
    }));
  const activeTaskReviews = store.listReviewRounds(taskId)
    .filter((round) => (
      round.scope === "task"
      && (round.status === "pending" || round.status === "running")
    ))
    .map((round) => Object.freeze({
      reviewRoundId: round.id,
      reviewerRoleName: round.reviewerRoleName,
      status: round.status as "pending" | "running"
    }));
  return Object.freeze({
    providerRetries: Object.freeze(store.listRoleSessionSets(taskId).flatMap(set => set.providerBinding?.retry === undefined
      ? [] : [{ roleName: set.owner.roleName, retry: providerRetryProjection(set.providerBinding) }])),
    activeRuns: Object.freeze(activeRuns),
    activeTaskReviews: Object.freeze(activeTaskReviews)
  });
}

export function expandRunContextRef(
  store: TaskStore,
  taskId: string,
  runId: string,
  refId: string,
  refStore: string
): Readonly<{ ref: ContextRef; value: unknown; digest: string }> {
  requireIdentity(refStore, "Context ref store");
  const run = requireExactRun(store, taskId, runId);
  const snapshot = readRunContextSnapshot(store, run);
  const authorized = snapshot.refs.filter((ref) => (
    ref.refId === refId && ref.store === refStore
  ));
  const selector = `${refStore}/${refId}`;
  if (authorized.length !== 1) {
    throw new Error(`AgentRun Context ref is not uniquely authorized: ${selector}.`);
  }
  const materialized = snapshot.resources.find(({ ref }) => (
    contextRefIdentity(ref) === contextRefIdentity(authorized[0]!)
  ));
  if (materialized === undefined || materialized.ref.digest !== authorized[0]!.digest) {
    throw new Error(`AgentRun Context ref is unavailable or drifted: ${selector}.`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(materialized.value), "utf8");
  if (bytes > RUN_CONTEXT_EXPAND_MAX_BYTES) {
    throw new Error(`AgentRun Context expansion exceeds ${RUN_CONTEXT_EXPAND_MAX_BYTES} bytes.`);
  }
  return Object.freeze({
    ref: materialized.ref,
    value: materialized.value,
    digest: contextContentDigest({ ref: materialized.ref, value: materialized.value })
  });
}

/** Fail-closed delta cursor resolution for one immutable AgentRun lineage. */
export function buildRunContextDelta(
  store: TaskStore,
  taskId: string,
  runId: string,
  after: string
): Readonly<{ schemaVersion: 1; after: string; cursor: string; refs: readonly ContextRef[] }> {
  const pack = buildRunContextPack(store, taskId, runId);
  if (after === pack.digest || after === pack.snapshot.digest) {
    return Object.freeze({ schemaVersion: 1, after, cursor: pack.digest, refs: [] });
  }
  const run = requireExactRun(store, taskId, runId);
  const snapshot = readRunContextSnapshot(store, run);
  const parentDigest = snapshot.parentRef?.digest;
  if (!((parentDigest !== undefined && after === parentDigest)
    || (parentDigest === undefined && after === "none"))) {
    throw new Error("AgentRun Context delta cursor is outside the frozen Snapshot lineage.");
  }
  return Object.freeze({
    schemaVersion: 1,
    after,
    cursor: pack.digest,
    refs: pack.deltas
  });
}

function requireExactRun(store: TaskStore, taskId: string, runId: string): AgentRun {
  const run = store.getRun(taskId, runId);
  if (run === null || run.taskId !== taskId || run.id !== runId) {
    throw new Error(`AgentRun not found: ${taskId}/${runId}.`);
  }
  return run;
}

export function readRunContextSnapshot(
  store: Pick<TaskStore, "getContextSnapshot">,
  run: AgentRun
): ContextSnapshot {
  const expected = requireRunContextSnapshotRef(run.inputs[0]!.input);
  const snapshot = store.getContextSnapshot(run.taskId, expected.id);
  if (snapshot === null) throw new Error(`AgentRun Context Snapshot is missing: ${expected.id}.`);
  if (snapshot.id !== expected.id || snapshot.taskId !== run.taskId
    || expected.taskId !== run.taskId || snapshot.digest !== expected.digest
    || snapshot.sequence !== expected.sequence || snapshot.scope !== expected.scope
    || snapshot.scopeRef !== expected.scopeRef) {
    throw new Error(`AgentRun Context Snapshot identity drifted: ${expected.id}.`);
  }
  return validateContextSnapshot(snapshot);
}

function collectAuthorizedContext(
  store: TaskStore,
  run: Readonly<Pick<
    AgentRun,
    "taskId" | "roleName" | "purpose" | "workItemId" | "reviewRoundId"
      | "sourceExecutionGroupId" | "workspace"
  >>
): MaterializedRef[] {
  const task = store.getTask(run.taskId);
  if (task === null) throw new Error(`Task not found: ${run.taskId}.`);
  const view = contextView(run);
  const result: MaterializedRef[] = [materialize("L2", "task", task.id, task)];
  const brief = store.getTaskBrief(task.id);
  if (brief !== null && view === "leader") {
    result.push(materialize("L2", "task-brief", task.id, brief));
  }
  result.push(...collectRunContextOverlays(store, run));
  result.push(...collectSourceRunContext(store, run));
  if (run.workItemId !== undefined) {
    const item = store.getWorkItem(task.id, run.workItemId);
    if (item === null) throw new Error(`AgentRun WorkItem not found: ${run.workItemId}.`);
    result.push(materialize("L3", "work-item", item.id, item));
    result.push(...candidateArtifacts(task.id, item.candidates));
    if (view === "worker") {
      assertWorkItemDependenciesCompleted(store, item);
      for (const dependencyId of item.dependsOn) {
        const dependency = store.getWorkItem(task.id, dependencyId);
        if (dependency === null) throw new Error(`WorkItem dependency disappeared: ${dependencyId}.`);
        result.push(materialize("L3", "accepted-work-item", dependency.id, dependency));
        result.push(...candidateArtifacts(task.id, dependency.candidates));
      }
    }
  }
  if (run.reviewRoundId !== undefined) {
    const round = store.getReviewRound(task.id, run.reviewRoundId);
    if (round === null) throw new Error(`AgentRun ReviewRound not found: ${run.reviewRoundId}.`);
    result.push(materialize("L3", "review-round", round.id, round));
    if (round.scope === "task") {
      for (const item of store.listWorkItems(task.id).filter(({ status }) => status !== "retired")) {
        const candidate = governingWorkItemCandidate(item);
        if (candidate === undefined) continue;
        result.push(materialize("L3", "candidate", `${item.id}/${candidate.id}`, candidate));
        result.push(...candidateArtifacts(task.id, [candidate]));
      }
    }
    if (round.deltaRecheck !== undefined) {
      const previous = store.getReviewRound(task.id, round.deltaRecheck.previousReviewRoundId);
      const previousRun = previous?.reviewerRunId === undefined
        ? null
        : store.getRun(task.id, previous.reviewerRunId);
      if (previous === null
        || previous === undefined
        || previous.status !== "completed"
        || previousRun === null
        || previousRun.status !== "completed"
        || previousRun.result === undefined) {
        throw new Error(
          `Delta recheck source Review result is unavailable: ${
            round.deltaRecheck.previousReviewRoundId
          }.`
        );
      }
      result.push(materialize("L3", "review-round", previous.id, previous));
      result.push(materialize(
        "L4",
        "source-run",
        previousRun.id,
        sourceRunContextValue(previousRun)
      ));
    }
  }
  for (const binding of task.projectBindings) {
    const project = store.getProject(binding.projectId);
    if (project === null) throw new Error(`AgentRun Project not found: ${binding.projectId}.`);
    const { knowledge, ...projectPolicy } = project;
    result.push(materialize("L1", "project-policy", project.id, projectPolicy));
    for (const entry of knowledge.filter(({ status }) => status === "active")) {
      result.push(materialize(
        "L1",
        "project-knowledge",
        `${project.id}:${entry.id}`,
        { projectId: project.id, ...entry }
      ));
    }
  }
  if (view === "leader") {
    // File artifacts are NOT enumerated into the synchronous context pack: the
    // core cursor does not cover file edits, and an ambient directory listing
    // here would be exactly the forbidden update-time mirror (§3.7). The Leader
    // reads current artifacts on demand via the async `artifact.list` /
    // `artifact.read` capabilities; frozen Candidate artifacts still enter the
    // pack as commit-pinned pointers through candidateArtifacts().
    for (const preparation of store.listEnvironmentPreparations(task.id)) {
      result.push(materialize("L3", "environment-preparation", preparation.id, preparation));
    }
    for (const workspace of store.listManagedWorkspaces(task.id)) {
      result.push(materialize("L3", "managed-workspace", managedWorkspaceKey(workspace.owner), workspace));
    }
    for (const changeSet of store.listChangeSets(task.id)) {
      result.push(materialize("L3", "change-set", changeSet.id, changeSet));
    }
    const events = store.listEvents(task.id);
    for (const item of store.listWorkItems(task.id).filter(({ status }) => status !== "retired")) {
      result.push(materialize("L3", "work-item", item.id, item));
    }
    for (const decision of store.listDecisions(task.id)) {
      result.push(materialize("L2", "task-decision", decision.id, decision));
    }
    for (const milestone of store.listMilestones(task.id).slice(-16)) {
      result.push(materialize("L2", "task-milestone", milestone.id, milestone));
    }
    for (const round of store.listReviewRounds(task.id).slice(-16)) {
      result.push(materialize("L3", "review-round", round.id, round));
    }
    for (const run of operationalTaskRecords(
      store.listRuns(task.id),
      events,
      "run"
    ).slice(-24)) {
      result.push(materialize("L4", "run", run.id, run));
    }
    for (const message of operationalTaskRecords(
      store.listMessages(task.id),
      events,
      "message"
    ).slice(-16)) {
      result.push(materialize("L4", "task-message", message.id, message));
    }
    const publishedTreeAuthorizations = [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (event.type === "task.completed" || event.type === "task.reopened") break;
      if (event.type === TASK_COMPLETION_PUBLISHED_TREE_AUTHORIZED_EVENT) {
        publishedTreeAuthorizations.push(event);
      }
    }
    for (const event of publishedTreeAuthorizations.reverse().slice(-16)) {
      result.push(materialize("L4", "task-event", event.id, event));
    }
    for (const request of store.listOpenInputRequests([task.id])) {
      result.push(materialize("L4", "input-request", request.id, request));
    }
  }
  const unique = new Map(result.map((entry) => [contextRefIdentity(entry.ref), entry]));
  return [...unique.values()].sort((left, right) => (
    contextRefIdentity(left.ref).localeCompare(contextRefIdentity(right.ref))
  ));
}

/** Only artifacts attached to already-authorized candidates enter a bounded
 * Worker/Reviewer snapshot. Each is a commit-pinned pointer: the commit
 * self-certifies the frozen bytes, so the pointer is carried as pure data with
 * NO build-time Git read. The bytes are resolved lazily on the async expand
 * path (`artifact.read` at the pinned commit); the pointer survives cleanup of
 * the producing workspace and Session. */
function candidateArtifacts(
  taskId: string, candidates: WorkItem["candidates"]
): MaterializedRef[] {
  return candidates.flatMap((candidate) => (candidate.artifactRefs ?? []).map((ref) => {
    const pinned = validateGitArtifactRef(ref);
    if (pinned.taskId !== taskId) {
      throw new Error(`Candidate Artifact belongs to another Task: ${pinned.taskId}.`);
    }
    // The refId is the self-certifying string form; the value is the pure
    // pointer, never the bytes. inspectValue reconstructs the same pointer.
    return materialize("L3", "artifact", formatGitArtifactRef(pinned), {
      taskId: pinned.taskId,
      commit: pinned.commit,
      relativePath: pinned.relativePath,
      ...(pinned.digest === undefined ? {} : { digest: pinned.digest })
    });
  }));
}

/** Lane-specific context that may be layered over an immutable stage base. */
function collectRunContextOverlays(
  store: TaskStore,
  run: Readonly<Pick<
    AgentRun,
    "taskId" | "roleName" | "purpose" | "workItemId" | "reviewRoundId"
      | "sourceExecutionGroupId" | "workspace"
  >>
): MaterializedRef[] {
  const role = store.getRole(run.taskId, run.roleName);
  if (role === null) throw new Error(`AgentRun Role not found: ${run.taskId}/${run.roleName}.`);
  return [
    materialize("L1", "role-profile", role.name, {
      name: role.name,
      defaultAccess: role.defaultAccess,
      description: role.description,
      responsibilities: role.responsibilities ?? [],
      constraints: role.constraints ?? [],
      expectedOutput: role.expectedOutput,
      skills: role.skills ?? [],
      launchRevision: role.launchRevision
    }),
    ...("workspace" in run && run.workspace !== undefined
      ? [materialize(
          "L3",
          "managed-workspace",
          `${run.taskId}/${run.roleName}`,
          run.workspace
        )]
      : [])
  ];
}

function collectSourceRunContext(
  store: TaskStore,
  run: Readonly<Pick<
    AgentRun,
    "taskId" | "purpose" | "workItemId" | "reviewRoundId" | "sourceExecutionGroupId"
  >>,
  sourceRunIds?: readonly string[]
): MaterializedRef[] {
  if (run.sourceExecutionGroupId === undefined) return [];
  if (sourceRunIds === undefined || sourceRunIds.length === 0
    || sourceRunIds.length > MAX_SYNTHESIS_SOURCE_RUNS
    || new Set(sourceRunIds).size !== sourceRunIds.length) {
    throw new Error("Synthesis requires explicit, distinct source AgentRun references.");
  }
  const group = run.purpose === "execution"
    ? (() => {
        if (run.workItemId === undefined) {
          throw new Error("Execution synthesis source requires a WorkItem.");
        }
        const item = store.getWorkItem(run.taskId, run.workItemId);
        if (item === null) throw new Error(`AgentRun WorkItem not found: ${run.workItemId}.`);
        return workItemExecutionGroupById(item, run.sourceExecutionGroupId);
      })()
    : (() => {
        if (run.reviewRoundId === undefined) {
          throw new Error("Review synthesis source requires a ReviewRound.");
        }
        const round = store.getReviewRound(run.taskId, run.reviewRoundId);
        if (round === null) throw new Error(`AgentRun ReviewRound not found: ${run.reviewRoundId}.`);
        return round.executionGroup?.id === run.sourceExecutionGroupId
          ? round.executionGroup
          : undefined;
      })();
  if (group === undefined) {
    throw new Error(`Source ExecutionGroup not found: ${run.sourceExecutionGroupId}.`);
  }
  return sourceRunIds.map((runId): MaterializedRef => {
      const source = store.getRun(run.taskId, runId);
      const lane = group.lanes.find(({ id }) => id === source?.executionLaneId);
      if (source === null
        || lane === undefined
        || !["completed", "failed"].includes(source.status)
        || source.result === undefined
        || source.purpose !== run.purpose
        || source.workItemId !== run.workItemId
        || source.reviewRoundId !== run.reviewRoundId
        || source.executionGroupId !== group.id
        || source.executionLaneId !== lane.id
        || source.roleName !== lane.roleName) {
        throw new Error(`Selected source AgentRun is missing or drifted: ${group.id}/${runId}.`);
      }
      return materialize(
        "L4",
        "source-run",
        source.id,
        sourceRunContextValue(source)
      );
    });
}

/** The frozen refs, not the Group's changing lane state, define provenance. */
export function synthesisSourceRunIds(
  store: Pick<TaskStore, "getContextSnapshot">,
  run: AgentRun
): readonly string[] {
  const snapshot = readRunContextSnapshot(store, run);
  return snapshot.resources.filter(({ ref: entry, value }) => (
    entry.store === "source-run"
    && (value as { executionGroupId?: string }).executionGroupId === run.sourceExecutionGroupId
  )).map(({ ref: entry }) => entry.refId);
}

function materialize(layer: ContextRef["layer"], store: string, refId: string, value: unknown): MaterializedRef {
  const digest = contextContentDigest(value);
  const record = value as Record<string, unknown>;
  const revision = String(record.revision ?? record.updatedAt ?? record.createdAt ?? digest);
  const title = typeof record.title === "string"
    ? record.title
    : typeof record.summary === "string"
      ? record.summary
      : `${store} ${refId}`;
  return Object.freeze({
    ref: Object.freeze({
      layer,
      store,
      refId,
      revision,
      digest,
      summary: title.slice(0, 400)
    }),
    value
  });
}

function contextRefIdentity(ref: ContextRef): string {
  return `${ref.store}\0${ref.refId}\0${ref.revision}`;
}

function contextView(run: Readonly<Pick<AgentRun, "roleName" | "purpose">>): AgentRunContextView {
  if (run.purpose === "review") return "reviewer";
  if (run.roleName === "leader") return "leader";
  if (run.roleName === "operator") return "operator";
  return "worker";
}

function completionActions(
  view: AgentRunContextView,
  authority: AgentRun["effective"]["executionAuthority"]
): readonly string[] {
  if (authority === "planning") return Object.freeze(["finish-turn", "request-input", "request-activation"]);
  if (view === "leader") return Object.freeze(["finish-turn", "complete-task", "request-input"]);
  if (view === "reviewer") return Object.freeze(["checkpoint", "finish-turn"]);
  if (view === "operator") return Object.freeze(["answer-input", "recover"]);
  return Object.freeze(["checkpoint", "finish-turn"]);
}
