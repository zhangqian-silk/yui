import { isDeepStrictEqual } from "node:util";

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
import type { TaskStore } from "../storage/taskStore.js";
import { createRun, type AgentRun } from "../agentRun/agentRun.js";
import {
  currentWorkItemExecutionGroup,
  type WorkItem
} from "../workItem/workItem.js";
import {
  type WorkItemExecutionGroup
} from "./workItemExecution.js";

export type WorkItemSynthesisProducer = Readonly<{
  laneId: string;
  roleName: string;
  runId: string;
}>;

export function selectedWorkItemSynthesisProducers(
  store: Pick<TaskStore, "getRun">,
  item: WorkItem,
  group: WorkItemExecutionGroup,
  sourceRunIds: readonly string[]
): readonly WorkItemSynthesisProducer[] {
  if (sourceRunIds.length === 0 || new Set(sourceRunIds).size !== sourceRunIds.length) {
    throw new Error("Synthesis requires explicit, distinct source AgentRun references.");
  }
  return sourceRunIds.map((runId) => {
    const run = store.getRun(item.taskId, runId);
    const lane = group.lanes.find(({ id }) => id === run?.executionLaneId);
    if (run === null
      || lane === undefined
      || !["completed", "failed"].includes(run.status)
      || run.purpose !== "execution"
      || run.workItemId !== item.id
      || run.executionGroupId !== group.id
      || run.executionLaneId !== lane.id
      || run.roleName !== lane.roleName
      || run.result === undefined) {
      throw new Error(
        `Synthesis source is not an exact terminal Producer result: ${group.id}/${runId}.`
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
export function dispatchWorkItemSynthesis(
  store: TaskStore,
  taskId: string,
  workItemId: string,
  sourceRunIds: readonly string[],
  now: Date
): AgentRun {
  const task = store.getTask(taskId);
  if (task === null || task.status !== "active" || task.executionGate.state !== "enabled") {
    throw new Error(`Task execution is not enabled: ${taskId}.`);
  }
  const item = store.getWorkItem(taskId, workItemId);
  if (item === null || item.status !== "open") {
    throw new Error(`WorkItem is not open: ${taskId}/${workItemId}.`);
  }
  const group = currentWorkItemExecutionGroup(item);
  if (group === undefined) throw new Error(`WorkItem has no ExecutionGroup: ${item.id}.`);
  const producers = selectedWorkItemSynthesisProducers(store, item, group, sourceRunIds);
  const existing = store.listRuns(taskId).some((run) => (
    run.purpose === "execution"
    && run.workItemId === item.id
    && run.sourceExecutionGroupId === group.id
  ));
  if (existing) throw new Error(`Synthesis already exists for ${group.id}; retry its AgentRun explicitly.`);
  if (item.assignee === undefined) {
    throw new Error(`Replicated WorkItem has no main assignee: ${item.id}.`);
  }
  const role = store.getRole(taskId, item.assignee);
  if (role === null) throw new Error(`WorkItem main Role is missing: ${taskId}/${item.assignee}.`);
  if (store.getActiveRun(taskId, role.name) !== null) {
    throw new Error(`WorkItem main Role already has an active AgentRun: ${role.name}.`);
  }
  const workspace = role.name === "leader" || task.projectBindings.length === 0
    ? store.getTaskWorkspace(taskId)
    : store.getWorkItemWorkspace(taskId, item.id);
  if (workspace === null) {
    throw new Error(`WorkItem main workspace is missing: ${taskId}/${item.id}.`);
  }
  const visibleProjectIds = workspace.entries.map(({ projectId }) => projectId).sort();
  const taskProjectIds = task.projectBindings.map(({ projectId }) => projectId).sort();
  const writableProjectIds = workspace.entries
    .filter(({ access }) => access === "write")
    .map(({ projectId }) => projectId)
    .sort();
  if (!isDeepStrictEqual(visibleProjectIds, taskProjectIds)
    || !isDeepStrictEqual(writableProjectIds, [...item.writeProjectIds].sort())) {
    throw new Error(`WorkItem main workspace does not match its approved scope: ${item.id}.`);
  }
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "execution",
    workspace,
    workItemWriteProjectIds: item.writeProjectIds
  });
  const snapshot = freezeRunContextSnapshot(store, {
    taskId,
    roleName: role.name,
    purpose: "execution",
    workItemId: item.id,
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
      source: { type: "yui", channel: "workitem-dispatch" },
      directive: synthesisDirective(group, producers),
      contextSnapshotRef: contextSnapshotRef(snapshot),
      deltaRefIds: contextSnapshotDeltaRefIds(store, snapshot)
    }),
    now,
    {
      workItemId: item.id,
      sourceExecutionGroupId: group.id,
      workspace,
      effective
    }
  );
  store.saveRun(run);
  store.saveActiveRun(run);
  enqueueRoleRunDispatch(store, {
    taskId,
    roleName: role.name,
    runId: run.id,
    reason: "workitem-synthesis-ready",
    occurredAt: now
  });
  store.saveEvent(taskId, createTaskEvent(
    store.nextEventId(taskId),
    taskId,
    "run.dispatched",
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
      workItemId: item.id,
      sourceExecutionGroupId: group.id
    },
    now
  ));
  return run;
}

function synthesisDirective(
  group: WorkItemExecutionGroup,
  producers: readonly WorkItemSynthesisProducer[]
): string {
  return [
    "Synthesize the explicitly selected Producer results in the supplied order.",
    "Expand each exact source AgentRun from the frozen Context Snapshot and consume its original result text plus Core-authored system evidence.",
    "Do not rerun, retry, append, or abandon any Lane. Form the final WorkItem result from these records.",
    JSON.stringify({
      schemaVersion: 1,
      sourceExecutionGroupId: group.id,
      producers
    }, null, 2)
  ].join("\n\n");
}
