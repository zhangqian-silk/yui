import { statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { TaskStore } from "../storage/taskStore.js";
import { createRun } from "../agentRun/agentRun.js";
import { createRunInput } from "../context/runInputContract.js";
import { contextSnapshotRef } from "../context/contextSnapshot.js";
import { freezeRunContextSnapshot, readRunContextSnapshot } from "../context/runContextPack.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { createTaskMessage } from "../message/message.js";
import { assertRoleEnabled } from "../role/availability.js";
import { managedTaskSessionIdentity } from "../runtime/managedCaller.js";
import { currentProviderConversation } from "../runtime/providerRuntimeIdentity.js";
import { hasRuntimeLifecycleWork, runtimeLifecycleTarget } from "../runtime/lifecycleReservation.js";
import { resolveEffectiveLaunch, roleSessionMayContinue } from "../executor/effectiveLaunch.js";
import { updateRoleAgentSessionStatus, updateTaskRoleProviderRuntime } from "../executor/agentExecutor.js";
import { governingWorkItemCandidate, prepareWorkItemDispatch, updateWorkItemStatus } from "../workItem/workItem.js";
import { requireIdentity, requireText } from "../domain/validation.js";
import { builtinAgentDriverRegistry } from "../runtime/builtinAgentDrivers.js";
import { runtimeObservationTaskEventPayload } from "../runtime/runtimeObservation.js";
import { sameManagedWorkspaceIdentity } from "../worktree/managedWorkspace.js";

/**
 * Adopt this conversation's already accepted native Turn as a fresh execution.
 * The Role reports semantic intent; Core checks the immutable Assignment and
 * writer fences. There is deliberately no Provider send, dispatch queue or
 * free-form lifecycle setter here.
 */
export function continueWorkItem(
  store: TaskStore,
  input: Readonly<{ taskId: string; workItemId: string; requestId: string; input: string; expectedTurn: string }>,
  environment: NodeJS.ProcessEnv | undefined,
  now: Date
) {
  const requestId = requireIdentity(input.requestId, "Continuation request id");
  const expectedTurn = requireText(input.expectedTurn, "Expected native Turn");
  const original = requireText(input.input, "Original user request");
  if (Buffer.byteLength(original) > 12_000) throw new Error("Original user request exceeds 12000 bytes.");
  return store.transaction(tx => {
    const self = managedTaskSessionIdentity(environment);
    if (self === undefined || self.taskId !== input.taskId || self.nativeSessionId === undefined) {
      throw new Error("Continuation requires the original managed WorkItem conversation.");
    }
    const role = tx.getRole(input.taskId, self.roleName);
    const sessions = tx.getTaskRoleSessionSet(input.taskId, self.roleName);
    const session = sessions?.sessions[sessions.activeAgentId];
    const binding = sessions?.providerBinding;
    const events = tx.listEvents(input.taskId);
    if (!role || !sessions || !session || !binding
      || role.activeAgentId !== sessions.activeAgentId
      || session.nativeSessionId !== self.nativeSessionId
      || session.adapterId !== role.agentBindings[role.activeAgentId]?.adapterId
      || (self.workspace !== undefined && self.workspace !== session.effective.workspace.root)
      || (environment?.YUI_AGENT_ID !== undefined && environment.YUI_AGENT_ID !== session.agentId)
      || (environment?.YUI_ADAPTER_ID !== undefined && environment.YUI_ADAPTER_ID !== session.adapterId)
      || currentProviderConversation(binding).conversationId !== self.nativeSessionId
      || events.some(event => event.payload.revokedNativeSessionId === self.nativeSessionId)) {
      throw new Error("Original conversation ownership was replaced or revoked; use formal Leader recovery/handover.");
    }
    const prior = events.find(event => event.type === "work.continued" && event.payload.requestId === requestId);
    if (prior !== undefined) {
      const message = tx.listMessages(input.taskId).find(m => m.id === prior.payload.messageId);
      if (prior.payload.workItemId !== input.workItemId || prior.payload.nativeSessionId !== self.nativeSessionId
        || prior.payload.roleName !== self.roleName || prior.payload.nativeTurnId !== expectedTurn
        || message?.body !== original) {
        throw new Error("Continuation request id was reused with conflicting input.");
      }
      const run = tx.getRun(input.taskId, prior.payload.runId!);
      if (!run) throw new Error("Continuation receipt's AgentRun is missing; inspect the original receipt.");
      return { run, messageId: message.id, replayed: true };
    }
    const { task, item, previous, workspace, baseline } = retainedWorkItemAssignment(tx, input.taskId, self.roleName, input.workItemId);
    const turn = binding.run;
    if (!turn || turn.status !== "accepted" || turn.runId !== undefined
      || turn.nativeTurnId !== expectedTurn || !["controller", "human"].includes(binding.authority.owner)
      || turn.authorityEpoch !== binding.authority.epoch
      || currentProviderConversation(binding).recoverability === "unrecoverable") {
      throw new Error("Continuation needs this conversation's exact accepted, unbound native Turn. Restore the same Host/Turn or use formal recovery; never replay unknown input.");
    }
    const priorRepair = events.filter(event => event.type === "work.continued"
      && event.payload.workItemId === item.id).at(-1);
    const oldCandidate = governingWorkItemCandidate(item)
      ?? item.candidates.find(candidate => candidate.id === priorRepair?.payload.previousCandidateId);
    const reopened = prepareWorkItemDispatch(item.status === "accepted"
      ? updateWorkItemStatus(item, "open", now) : item, now);
    tx.saveWorkItem(task.id, reopened);
    const message = createTaskMessage(tx.nextMessageId(task.id), task.id, original,
      "role-result", { type: "role", roleName: role.name }, now, { workItemId: item.id });
    tx.saveMessage(task.id, message);
    const snapshot = freezeRunContextSnapshot(tx, {
      taskId: task.id, roleName: role.name, purpose: "execution", workItemId: item.id, workspace
    }, now, "controller", undefined, undefined,
    baseline.resources.filter(entry => entry.ref.evidenceOf === "dispatch-required"), "frozen");
    const run = createRun(tx.nextRunId(task.id), task.id, role.name, "resume", createRunInput({
      source: { type: "user", channel: "direct" }, directive: original,
      contextSnapshotRef: contextSnapshotRef(snapshot), deltaRefIds: [message.id]
    }), now, { workItemId: item.id, workspace, effective: previous.effective });
    tx.saveRun(run);
    tx.saveActiveRun(run);
    tx.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(
      updateRoleAgentSessionStatus(sessions, session.agentId, "active", now),
      { ...binding, run: { ...turn, runId: run.id } }, now));
    tx.saveEvent(task.id, createTaskEvent(tx.nextEventId(task.id), task.id, "work.continued", {
      requestId, workItemId: item.id, roleName: role.name, runId: run.id, previousRunId: previous.id,
      messageId: message.id, nativeSessionId: self.nativeSessionId, attemptId: turn.attemptId,
      nativeTurnId: turn.nativeTurnId, previousStatus: item.status,
      ...(oldCandidate === undefined ? {} : { previousCandidateId: oldCandidate.id })
    }, now));
    // Durable correlation of an already accepted Turn, not a second submission.
    // Retain it after the Provider's current-turn pointer moves on.
    tx.saveEvent(task.id, createTaskEvent(tx.nextEventId(task.id), task.id, "runtime.observation",
      runtimeObservationTaskEventPayload({
        schemaVersion: 1, eventId: `work-continue:${task.id}/${run.id}`,
        semanticKey: `work-continue:${task.id}/${run.id}`, kind: "turn.accepted", authority: "controller",
        receivedAt: now.toISOString(), fence: {
          taskId: task.id, roleName: role.name, agentId: session.agentId, runId: run.id,
          driverId: builtinAgentDriverRegistry().requireByAdapterId(session.adapterId).id,
          nativeSessionId: self.nativeSessionId, conversationId: self.nativeSessionId,
          nativeTurnId: turn.nativeTurnId, receiptId: turn.attemptId
        }, payload: { summary: "Associated the accepted native Turn with the authorized same-scope continuation." }
      }), now));
    return { run, messageId: message.id, replayed: false };
  });
}

/** Read-only admission shared by same-Turn continuation and idle Host restore.
 * A stopped Host is not a revoked identity. No fresh conversation, scope or
 * business state may be selected by this path. */
export function retainedWorkItemAssignment(
  tx: TaskStore, taskId: string, roleName: string, workItemId?: string
) {
    const role = tx.getRole(taskId, roleName);
    const sessions = tx.getTaskRoleSessionSet(taskId, roleName);
    const session = sessions?.sessions[sessions.activeAgentId];
    const binding = sessions?.providerBinding;
    const events = tx.listEvents(taskId);
    if (!role || !sessions || !session || !binding || role.activeAgentId !== sessions.activeAgentId
      || session.adapterId !== role.agentBindings[role.activeAgentId]?.adapterId
      || currentProviderConversation(binding).conversationId !== session.nativeSessionId
      || currentProviderConversation(binding).recoverability === "unrecoverable"
      || events.some(event => event.payload.revokedNativeSessionId === session.nativeSessionId)) {
      throw new Error("Original conversation ownership was replaced or revoked; use formal Leader recovery/handover.");
    }
    const task = tx.getTask(taskId);
    if (task?.status !== "active" || task.executionGate.state !== "enabled") {
      throw new Error("Task execution is stopped or not active; continuation cannot reopen or unpause a Task.");
    }
    assertRoleEnabled(role);
    if (hasRuntimeLifecycleWork(tx.getWorkMailbox(runtimeLifecycleTarget({
      scope: "task", taskId: task.id, roleName: role.name
    })))) throw new Error("Runtime stop/replacement is pending; preserve this input for formal recovery.");
    const runs = tx.listRuns(task.id);
    const previous = runs.filter(run => run.roleName === role.name).at(-1);
    const selectedWorkItemId = workItemId ?? previous?.workItemId;
    const item = selectedWorkItemId === undefined ? null : tx.getWorkItem(task.id, selectedWorkItemId);
    if (!item || !["open", "accepted"].includes(item.status) || item.assignee !== role.name) {
      throw new Error("WorkItem ownership changed or is retired; use formal Leader handover.");
    }
    if (item.workspaceDisposition !== undefined) {
      throw new Error("WorkItem workspace was released; formal recovery/handover is required, not a status reset.");
    }
    if (runs.some(run => run.status === "active" && (run.roleName === role.name || run.workItemId === item.id))) {
      throw new Error("An active AgentRun already owns this WorkItem or Role.");
    }
    if (!previous || previous.workItemId !== item.id || previous.purpose !== "execution"
      || previous.executionGroupId !== undefined || previous.sourceExecutionGroupId !== undefined
      || previous.result?.failureReason === "delivery-unknown"
      || runs.filter(run => run.workItemId === item.id && run.purpose === "execution").at(-1)?.id !== previous.id) {
      throw new Error("Original Assignment is unavailable, superseded, replicated or delivery-unknown; use formal recovery/handover.");
    }
    const ownerSession = previous.result?.provider?.conversationId
      ?? events.filter(event => event.type === "run.session-prepared" && event.payload.runId === previous.id)
        .at(-1)?.payload.nativeSessionId;
    if (ownerSession !== session.nativeSessionId || !roleSessionMayContinue(session.effective, previous.effective)
      || session.effective.executionAuthority !== "delivery") {
      throw new Error("Original Assignment's conversation or captured authority is incompatible.");
    }
    const baseline = readRunContextSnapshot(tx, previous);
    const frozen = baseline.resources.find(entry => entry.ref.store === "work-item" && entry.ref.refId === item.id)?.value;
    const contract = (value: typeof item) => ({
      objective: value.objective, acceptance: value.acceptance, dependsOn: value.dependsOn,
      assignee: value.assignee, writeProjectIds: value.writeProjectIds, baseRefs: value.baseRefs
    });
    if (!frozen || !isDeepStrictEqual(contract(frozen as typeof item), contract(item))) {
      throw new Error("WorkItem scope changed since the original Assignment; Leader must decide a new dispatch.");
    }
    const workspace = task.projectBindings.length === 0 || role.name === "leader"
      ? tx.getTaskWorkspace(task.id) : tx.getWorkItemWorkspace(task.id, item.id);
    if (!workspace || !previous.workspace
      || !sameManagedWorkspaceIdentity(workspace, previous.workspace)
      || !isDeepStrictEqual([...item.writeProjectIds].sort(), [...previous.effective.writeProjectIds].sort())
      || !isDeepStrictEqual(workspace.entries.map(e => e.projectId).sort(),
        task.projectBindings.map(p => p.projectId).sort())) {
      throw new Error("Original workspace or Project scope is no longer compatible; use formal recovery/handover.");
    }
    if (!roleSessionMayContinue(session.effective, resolveEffectiveLaunch({
      store: tx, role, purpose: "execution", workspace, workItemWriteProjectIds: item.writeProjectIds
    }))) {
      throw new Error("Current Role authority or execution environment no longer matches the original Assignment.");
    }
    for (const path of [workspace.root, ...workspace.entries.map(entry => entry.path)]) {
      try { if (!statSync(path).isDirectory()) throw new Error("not a directory"); }
      catch { throw new Error(`Retained workspace is unavailable: ${path}. Use formal recovery; no files were removed.`); }
    }
    if (tx.listReviewRounds(task.id).some(round => round.workItemId === item.id
      && ["pending", "running"].includes(round.status))) {
      throw new Error("A ReviewRound still owns this Candidate; settle it before repair.");
    }
    if (tx.listDurableJobs(task.id).some(job => job.owner.kind === "work-item" && job.owner.workItemId === item.id
      && (["queued", "running"].includes(job.status)
        || (job.status === "unknown-needs-attention" && job.acknowledgedAt === undefined)))) {
      throw new Error("WorkItem has unsettled Job execution; preserve its effects before continuation.");
    }
    return { task, item, previous, workspace, role, sessions, session, binding, baseline };
}
