import { enqueueRoleRunDispatch } from "../coordination/workMailboxQueue.js";
import { createRunInput } from "../context/runInputContract.js";
import {
  contextSnapshotDeltaRefIds,
  freezeRunContextSnapshot
} from "../context/runContextPack.js";
import { contextSnapshotRef } from "../context/contextSnapshot.js";
import { roleAgentSessionResumeMode } from "../executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../executor/effectiveLaunch.js";
import { createTaskEvent } from "../event/taskEvent.js";
import {
  startReviewRound,
  type ReviewRound
} from "../review/reviewRound.js";
import type { TaskStore } from "../storage/taskStore.js";
import { createRun, type AgentRun } from "../agentRun/agentRun.js";
import {
  type ReviewExecutionGroup
} from "./workItemExecution.js";

export type ReviewSynthesisProducer = Readonly<{
  laneId: string;
  roleName: string;
  runId: string;
}>;

export function selectedReviewSynthesisProducers(
  store: Pick<TaskStore, "getRun">,
  round: ReviewRound,
  group: ReviewExecutionGroup,
  sourceRunIds: readonly string[]
): readonly ReviewSynthesisProducer[] {
  if (sourceRunIds.length === 0 || new Set(sourceRunIds).size !== sourceRunIds.length) {
    throw new Error("Synthesis requires explicit, distinct source AgentRun references.");
  }
  return sourceRunIds.map((runId) => {
    const run = store.getRun(round.taskId, runId);
    const lane = group.lanes.find(({ id }) => id === run?.executionLaneId);
    if (run === null
      || lane === undefined
      || !["completed", "failed"].includes(run.status)
      || run.purpose !== "review"
      || run.reviewRoundId !== round.id
      || run.executionGroupId !== group.id
      || run.executionLaneId !== lane.id
      || run.roleName !== lane.roleName
      || run.result === undefined) {
      throw new Error(
        `Synthesis source is not an exact terminal Review Producer result: `
        + `${group.id}/${runId}.`
      );
    }
    return {
      laneId: lane.id,
      roleName: lane.roleName,
      runId: run.id
    };
  });
}

/** Called within the caller's transaction after Task authority is checked. */
export function dispatchReviewSynthesis(
  store: TaskStore,
  taskId: string,
  reviewRoundId: string,
  sourceRunIds: readonly string[],
  now: Date
): AgentRun {
  const task = store.getTask(taskId);
  if (task === null || task.status !== "active" || task.executionGate.state !== "enabled") {
    throw new Error(`Task execution is not enabled: ${taskId}.`);
  }
  const round = store.getReviewRound(taskId, reviewRoundId);
  if (round === null || round.status !== "running") {
    throw new Error(`ReviewRound is not running: ${taskId}/${reviewRoundId}.`);
  }
  const group = round.executionGroup;
  if (group === undefined) throw new Error(`ReviewRound has no ExecutionGroup: ${round.id}.`);
  const producers = selectedReviewSynthesisProducers(store, round, group, sourceRunIds);
  const existing = store.listRuns(taskId).filter((run) => (
    run.purpose === "review"
    && run.reviewRoundId === round.id
    && run.sourceExecutionGroupId === group.id
  ));
  if (existing.length > 0 || round.reviewerRunId !== undefined) {
    throw new Error(`Synthesis already exists for ${group.id}; retry its AgentRun explicitly.`);
  }
  const role = store.getRole(taskId, round.reviewerRoleName);
  if (role === null) {
    throw new Error(`Review main Role is missing: ${taskId}/${round.reviewerRoleName}.`);
  }
  if (store.getActiveRun(taskId, role.name) !== null) {
    throw new Error(`Review main Role already has an active AgentRun: ${role.name}.`);
  }
  const workspace = store.getReviewRoundWorkspace(taskId, round.id);
  if (workspace === null) {
    throw new Error(`Review main workspace is missing: ${taskId}/${round.id}.`);
  }
  const effective = resolveEffectiveLaunch({
    store,
    role,
    purpose: "review",
    workspace,
    reviewRoundId: round.id,
    reviewBaseCommit: round.reviewBaseCommit
  });
  const snapshot = freezeRunContextSnapshot(store, {
    taskId,
    roleName: role.name,
    purpose: "review",
    ...(round.workItemId === undefined ? {} : { workItemId: round.workItemId }),
    reviewRoundId: round.id,
    sourceExecutionGroupId: group.id,
    workspace
  }, now, "leader", group.assignment.contextSnapshotRef, sourceRunIds);
  const run = createRun(
    store.nextRunId(taskId),
    taskId,
    role.name,
    roleAgentSessionResumeMode(
      store.getTaskRoleSessionSet(taskId, role.name),
      effective.agentId,
      effective
    ),
    createRunInput({
      source: {
        type: "yui",
        channel: round.workItemId === undefined ? "task-dispatch" : "workitem-dispatch"
      },
      directive: synthesisDirective(group, producers),
      contextSnapshotRef: contextSnapshotRef(snapshot),
      deltaRefIds: contextSnapshotDeltaRefIds(store, snapshot)
    }),
    now,
    {
      ...(round.workItemId === undefined ? {} : { workItemId: round.workItemId }),
      purpose: "review",
      reviewRoundId: round.id,
      sourceExecutionGroupId: group.id,
      workspace,
      effective
    }
  );
  store.saveRun(run);
  store.saveReviewRound(taskId, startReviewRound(round, run.id));
  store.saveActiveRun(run);
  enqueueRoleRunDispatch(store, {
    taskId,
    roleName: role.name,
    runId: run.id,
    reason: "review-synthesis-ready",
    occurredAt: now
  });
  store.saveEvent(taskId, createTaskEvent(
    store.nextEventId(taskId),
    taskId,
    "run.review-dispatched",
    {
      runId: run.id,
      role: run.roleName,
      purpose: run.purpose,
      mode: run.mode,
      agent: `${run.effective.agentId}/${run.effective.adapterId}`,
      component: run.effective.component,
      effectiveRevision: String(run.effective.sourceDesiredRevision),
      profileAccess: run.effective.profileAccess,
      effectivePermission: run.effective.permission.strategy,
      writeProjectIds: run.effective.writeProjectIds.join(",") || "none",
      reviewRoundId: round.id,
      sourceExecutionGroupId: group.id
    },
    now
  ));
  return run;
}

function synthesisDirective(
  group: ReviewExecutionGroup,
  producers: readonly ReviewSynthesisProducer[]
): string {
  return [
    "Act as the main Reviewer over the explicitly selected Producer results in the supplied order.",
    "Expand each exact source AgentRun from the frozen Context Snapshot and consume its original result text plus Core-authored system evidence.",
    "Resolve disagreements through review judgment against the frozen candidate. Do not rerun, retry, append, select, or abandon Lanes.",
    "Return one complete original review result for the Leader; Yui Core does not parse or validate its semantic structure.",
    JSON.stringify({
      schemaVersion: 1,
      sourceExecutionGroupId: group.id,
      producers
    }, null, 2)
  ].join("\n\n");
}
