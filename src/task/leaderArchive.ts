import { createHash } from "node:crypto";
import { createTaskEvent } from "../event/taskEvent.js";
import { runTaskCommand } from "../commands/taskCommands.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { TaskWorkspaceCoordinator } from "../repository/taskWorkspaceCoordinator.js";
import { archiveExecutionChecks, archiveSettlementChecks } from "./archivePreflight.js";
import { admitLeaderArchive, assertLeaderArchiveAdmission } from "./leaderArchiveAuthority.js";
import { assertTaskRemoteDeliveryIntegrated, createTaskRemoteDeliveryProof } from "./remoteDeliveryService.js";
import type { TaskReviewCandidate } from "../review/reviewRound.js";
import { selectNewTaskRoleSession } from "../executor/agentExecutor.js";

export type LeaderArchiveRequest = Readonly<{
  sourceMessage: string;
  purpose: string;
  requestId: string;
}>;
export type LeaderArchivePort = (
  taskId: string, environment: NodeJS.ProcessEnv, request: LeaderArchiveRequest
) => Promise<unknown>;

/** A single foreground Controller operation survives stopping its requesting
 * Session. It has no retry worker: uncertain receipts are inspected, not
 * replayed. All existing settlement, delivery and cleanup checks remain. */
export async function archiveLeaderTask(
  store: TaskStore, coordinator: TaskWorkspaceCoordinator,
  taskId: string, environment: NodeJS.ProcessEnv, request: LeaderArchiveRequest
): Promise<unknown> {
  const inputDigest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const previous = store.listEvents(taskId).find(event =>
    event.type === "task.leader-archive-started" && event.payload.requestId === request.requestId);
  if (previous) {
    if (previous.payload.inputDigest !== inputDigest) throw new Error("Archive request id names different input.");
    const result = store.listEvents(taskId).find(event =>
      event.type === "task.leader-archive-result" && event.payload.requestId === request.requestId);
    return { taskId, requestId: request.requestId, status: result?.payload.status ?? "unknown",
      detail: result?.payload.detail, replayed: true };
  }
  const admission = admitLeaderArchive(store, taskId, environment, request.sourceMessage, request.purpose);
  const task = store.getTask(taskId)!;
  const settlement = archiveSettlementChecks(store, task);
  if (settlement.length) throw new Error(`Archive is unsettled: ${JSON.stringify(settlement)}`);
  const session = store.getTaskRoleSessionSet(taskId, "leader");
  const ownInput = session?.providerBinding?.run;
  // Only the requesting no-Run Leader may be stopped as part of this action.
  // Another Run, Job, unknown input, or then handoff is not archive authority.
  const ownResources = `role:${taskId}/leader`;
  const execution = archiveExecutionChecks(store, taskId).filter(check =>
    !(check.resource === ownResources
      && ownInput?.runId === undefined && ownInput?.status === "accepted"
      && ["unresolved-provider-input", "unresolved-mailbox"].includes(check.reason)));
  if (execution.length) throw new Error(`Archive execution is unresolved: ${JSON.stringify(execution)}`);
  if (store.listMessages(taskId).some(message => message.interruptThen?.targetNativeSessionId === admission.source.nativeSessionId
    && message.continuation === undefined && message.interruptThen.notDeliveredReason === undefined)) {
    throw new Error("Settle the original input handoff before archive.");
  }
  let candidate: TaskReviewCandidate | null = null;
  const workspace = store.getTaskWorkspace(taskId);
  if (task.projectBindings.length && workspace) {
    const snapshot = await coordinator.preparer.snapshotDirectTaskMain(workspace,
      task.projectBindings.map(binding => binding.projectId));
    candidate = { schemaVersion: 1, projects: snapshot.projects.map(project => ({
      projectId: project.projectId, commit: project.headCommit
    })) };
  }
  const proof = createTaskRemoteDeliveryProof(store, task, candidate);
  assertTaskRemoteDeliveryIntegrated(proof.delivery);
  for (const owned of store.listManagedWorkspaces(taskId)) {
    const disposition = owned.owner.type === "work-item"
      && store.getWorkItem(taskId, owned.owner.workItemId)?.status === "retired" ? "abandoned" : "integrated";
    const checks = await coordinator.preparer.inspectWorkspaceCleanup(owned, disposition);
    if (checks.some(check => !(owned.owner.type === "task" && check.reason === "git-worktree-registrations"))) {
      throw new Error(`Archive workspace is not clean/removable: ${JSON.stringify(checks)}`);
    }
  }
  // Reauthenticate after asynchronous inspection, before the first effect.
  admitLeaderArchive(store, taskId, environment, request.sourceMessage, request.purpose);
  assertLeaderArchiveAdmission(store, taskId, admission);
  const record = (type: string, payload: Record<string, string>) => store.transaction(tx =>
    tx.saveEvent(taskId, createTaskEvent(tx.nextEventId(taskId), taskId, type,
      { requestId: request.requestId, ...payload }, new Date())));
  const started = store.transaction(tx => {
    assertLeaderArchiveAdmission(tx, taskId, admission);
    const events = tx.listEvents(taskId);
    const prior = events.find(event => event.type === "task.leader-archive-started"
      && event.payload.requestId === request.requestId);
    if (prior) {
      if (prior.payload.inputDigest !== inputDigest) throw new Error("Archive request id names different input.");
      return false;
    }
    const unsettled = events.find(event => event.type === "task.leader-archive-started"
      && !events.some(result => result.type === "task.leader-archive-result"
        && result.payload.requestId === event.payload.requestId));
    if (unsettled) throw new Error(`Inspect unresolved archive ${unsettled.payload.requestId} before another operation.`);
    tx.saveEvent(taskId, createTaskEvent(tx.nextEventId(taskId), taskId, "task.leader-archive-started",
      { requestId: request.requestId, inputDigest, authorizationSource: JSON.stringify(admission.source) }, new Date()));
    return true;
  });
  if (!started) return { taskId, requestId: request.requestId, status: "unknown", replayed: true };
  try {
    await coordinator.runtime.stopTaskRoleSessions(taskId, ["leader"]);
    store.transaction(tx => {
      assertLeaderArchiveAdmission(tx, taskId, admission);
      const stopped = tx.getTaskRoleSessionSet(taskId, "leader");
      const current = stopped?.sessions[stopped.activeAgentId];
      if (!stopped || current?.nativeSessionId !== admission.source.nativeSessionId
        || current.status !== "ended" || current.endReason !== "stopped") {
        throw new Error("Leader Session changed before archive runtime retirement.");
      }
      // Retain the exact stopped caller in history and clear its resumable
      // binding. Generic workspace cleanup must not stop that caller again:
      // the first verified stop already released its physical owner records.
      tx.saveTaskRoleSessionSet(selectNewTaskRoleSession(stopped, stopped.activeAgentId, new Date()));
    });
    const cleanup = await coordinator.cleanupTaskForArchive(taskId, "integrated");
    if (cleanup.status !== "removed") throw new Error(cleanup.error ?? `Archive cleanup ${cleanup.status}.`);
    runTaskCommand(["archive", taskId, "--integrated"], store, {
      environment, archiveLeaderAdmission: admission, archiveRemoteDeliveryProof: proof
    });
    record("task.leader-archive-result", { status: "archived" });
    return { taskId, requestId: request.requestId, status: "archived" };
  } catch (error) {
    record("task.leader-archive-result", { status: store.getTask(taskId)?.status === "archived" ? "archived" : "failed",
      detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
