import { usageError } from "../errors/cliError.js";
import type { TaskFinalReviewContract } from "../review/taskFinalReviewContract.js";
import type { TaskStore } from "../storage/taskStore.js";
import type {
  CandidateGitSnapshot,
  DirectTaskMainSnapshot
} from "../workItem/workItem.js";
import type { FileTaskWorkspacePreparer } from "./taskWorkspacePreparer.js";

/** Read the existing source owner once and freeze its exact Candidate evidence. */
export async function snapshotWorkItemCandidate(
  store: TaskStore,
  preparer: Pick<FileTaskWorkspacePreparer, "snapshotCandidateWorkspace" | "snapshotDirectTaskMain">,
  taskId: string,
  workItemId: string,
  taskFinalReviewContract?: TaskFinalReviewContract
): Promise<Readonly<{
  candidateGitSnapshot?: CandidateGitSnapshot;
  directTaskMainSnapshot?: DirectTaskMainSnapshot;
}>> {
  const item = store.getWorkItem(taskId, workItemId);
  if (item === null) throw usageError(`Work Item not found: ${taskId}/${workItemId}.`);
  const workspace = store.getWorkItemWorkspace(taskId, workItemId);
  if (workspace !== null) {
    return { candidateGitSnapshot: await preparer.snapshotCandidateWorkspace(workspace) };
  }
  // Read-only results freeze their summary/artifact evidence, not Git output.
  if (item.writeProjectIds.length === 0) return {};
  if (taskFinalReviewContract === undefined) {
    throw usageError(
      `Work Item ${taskId}/${workItemId} has no managed Candidate workspace. `
      + `Use yui task work isolate ${taskId}/${workItemId} before implementing writable work.`
    );
  }
  // Preserve the existing exact Task-final metadata-only Candidate contract.
  // It is not the ordinary route for a new independently accepted code result.
  const main = store.getTaskWorkspace(taskId);
  if (main === null) return {};
  if (main.owner.type !== "task") {
    throw usageError(`Task has no authoritative main workspace: ${taskId}.`);
  }
  try {
    return {
      directTaskMainSnapshot: await preparer.snapshotDirectTaskMain(main, item.writeProjectIds)
    };
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}
