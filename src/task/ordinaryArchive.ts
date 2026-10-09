import { runTaskCommand, validateTaskArchiveRequest } from "../commands/taskCommands.js";
import type { TaskCommandOptions } from "../commands/taskCommandTypes.js";
import type { TaskWorkspaceCoordinator } from "../repository/taskWorkspaceCoordinator.js";
import type { TaskReviewCandidate } from "../review/reviewRound.js";
import { taskArchiveDiagnostics } from "./archiveDiagnostics.js";
import { assertTaskRemoteDeliveryIntegrated, createTaskRemoteDeliveryProof } from "./remoteDeliveryService.js";

/** The local user's ordinary archive path. No force, abandonment, source
 * impersonation, or private cleanup policy is accepted by this port. */
export async function archiveOrdinaryTask(
  coordinator: TaskWorkspaceCoordinator, taskId: string, options: TaskCommandOptions
) {
  const { store, preparer } = coordinator;
  const args = [taskId, "--integrated"];
  validateTaskArchiveRequest(args, store, options);
  const task = store.getTask(taskId)!;
  if (task.status !== "archived") {
    let candidate: TaskReviewCandidate | null = null;
    if (task.status === "cancelled" && task.projectBindings.length) {
      await preparer.prepareTaskWorkspace(taskId);
      const workspace = store.getTaskWorkspace(taskId);
      if (!workspace || workspace.owner.type !== "task" || workspace.owner.taskId !== taskId) {
        throw new Error(`Task has no authoritative main workspace: ${taskId}.`);
      }
      const snapshot = await preparer.snapshotDirectTaskMain(workspace,
        task.projectBindings.map(binding => binding.projectId));
      candidate = { schemaVersion: 1, projects: snapshot.projects.map(project => ({
        projectId: project.projectId, commit: project.headCommit
      })) };
    }
    const proof = createTaskRemoteDeliveryProof(store, task, candidate);
    assertTaskRemoteDeliveryIntegrated(proof.delivery);
    await coordinator.prepareTaskForArchive(taskId);
    runTaskCommand(["archive", ...args], store, { ...options, archiveRemoteDeliveryProof: proof });
    await coordinator.cleanupArchivedTask(taskId, "integrated");
  }
  const current = store.getTask(taskId)!;
  return { task: current, ...taskArchiveDiagnostics(store, current) };
}
