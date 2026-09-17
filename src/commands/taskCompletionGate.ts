import { usageError } from "../errors/cliError.js";
import {
  NodeGitWorkspace,
  type GitWorkspacePort
} from "../repository/gitWorkspace.js";
import { isCompletedTaskReviewEvidence } from "../review/reviewAcceptance.js";
import type { ReviewRound, TaskReviewCandidate } from "../review/reviewRound.js";
import type { TaskStore } from "../storage/taskStore.js";
import { publicationExternalKey } from "../task/publicationReference.js";
import type { Task } from "../task/task.js";
import {
  workspaceProjectEntry,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";

type CompletionGateOptions = Readonly<{
  git?: GitWorkspacePort;
}>;

export type TaskCompletionPublishedTreeProof = Readonly<{
  taskId: string;
  projectId: string;
  publicationId: string;
  reviewRoundId?: string;
  localCommit: string;
  remoteCommit: string;
  tree: string;
}>;

/**
 * Verify the one supported ancestry waiver before `task complete` mutates any
 * durable state. The explicit Publication must be the current verified merged
 * record, bind the exact physical Task head (and, when WorkItems exist, its
 * completed final Review), and name an ancestry-divergent commit with the
 * exact same Git tree.
 */
export async function verifyTaskCompletionPublishedTree(
  taskId: string,
  publicationId: string,
  store: TaskStore,
  options: Pick<CompletionGateOptions, "git"> = {}
): Promise<TaskCompletionPublishedTreeProof> {
  const task = store.getTask(taskId);
  if (task === null) throw usageError(`Task not found: ${taskId}.`);
  if (task.status !== "active") {
    throw usageError(`Task is not active: ${task.id}.`);
  }
  const publication = requireCurrentVerifiedPublication(store, task.id, publicationId);
  const binding = task.projectBindings.find(({ projectId }) => (
    projectId === publication.projectId
  ));
  if (binding === undefined) {
    throw usageError(
      `Publication ${publication.id} Project is not bound to Task ${task.id}: `
      + `${publication.projectId}.`
    );
  }
  if (publication.localCommit === undefined || publication.remoteCommit === undefined) {
    throw usageError(
      `Publication ${publication.id} must record exact local and remote commits.`
    );
  }

  const workspace = requireTaskWorkspace(store, task);
  const git = options.git ?? new NodeGitWorkspace();
  const actualHeads = new Map<string, string>();
  for (const taskBinding of task.projectBindings) {
    const entry = workspaceProjectEntry(workspace, taskBinding.projectId);
    if (entry === undefined || entry.access !== "write") {
      throw usageError(
        `Task ${task.id} has no writable managed main workspace for Project ${taskBinding.projectId}.`
      );
    }
    const actualCommit = (await git.inspect(entry.path, "HEAD")).baseCommit;
    actualHeads.set(taskBinding.projectId, actualCommit);
  }
  const actualCandidate: TaskReviewCandidate = {
    schemaVersion: 1,
    projects: task.projectBindings.map(({ projectId }) => ({
      projectId,
      commit: actualHeads.get(projectId)!
    }))
  };
  const latestReview = acceptedTaskFinalReviews(store, task.id)
    .find((round) => (
      round.taskCandidate !== undefined
      && sameTaskCandidate(round.taskCandidate, actualCandidate)
    ));

  const entry = workspaceProjectEntry(workspace, publication.projectId)!;
  const localCommit = actualHeads.get(publication.projectId)!;
  if (publication.localCommit !== localCommit) {
    throw usageError(
      `Publication ${publication.id} local commit ${publication.localCommit} `
      + `does not match Task head ${localCommit}.`
    );
  }

  let remoteCommit: string;
  let localTree: string;
  let remoteTree: string;
  try {
    remoteCommit = (await git.inspect(entry.path, publication.remoteCommit)).baseCommit;
    [localTree, remoteTree] = await Promise.all([
      git.resolveTree(entry.path, localCommit),
      git.resolveTree(entry.path, remoteCommit)
    ]);
  } catch (error) {
    throw usageError(
      `Publication ${publication.id} commit/tree evidence is unavailable: `
      + `${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (remoteCommit !== publication.remoteCommit) {
    throw usageError(
      `Publication ${publication.id} remote commit changed: expected `
      + `${publication.remoteCommit}, found ${remoteCommit}.`
    );
  }
  const [localContainsRemote, remoteContainsLocal] = await Promise.all([
    git.isAncestor(entry.path, remoteCommit, localCommit),
    git.isAncestor(entry.path, localCommit, remoteCommit)
  ]);
  if (localContainsRemote || remoteContainsLocal) {
    throw usageError(
      `Publication ${publication.id} is not ancestry-divergent from Task head ${localCommit}; `
      + "use normal Task completion."
    );
  }
  if (localTree !== remoteTree) {
    throw usageError(
      `Publication ${publication.id} Git trees differ: `
      + `${localCommit}^{tree}=${localTree}, ${remoteCommit}^{tree}=${remoteTree}.`
    );
  }

  return {
    taskId: task.id,
    projectId: publication.projectId,
    publicationId: publication.id,
    ...(latestReview === undefined ? {} : { reviewRoundId: latestReview.id }),
    localCommit,
    remoteCommit,
    tree: localTree
  };
}

/** Re-derive every durable half of the asynchronous Git proof under the Task
 * completion transaction. The physical heads are the CLI snapshot captured
 * immediately before mutation; any record or head drift fails closed. */
export function assertTaskCompletionPublishedTreeProof(
  store: TaskStore,
  task: Task,
  publicationId: string,
  proof: TaskCompletionPublishedTreeProof | undefined,
  actualCandidate: TaskReviewCandidate
): TaskCompletionPublishedTreeProof {
  if (proof === undefined
    || proof.taskId !== task.id
    || proof.publicationId !== publicationId) {
    throw usageError(
      `Published-tree completion proof is missing or mismatched for ${task.id}/${publicationId}.`
    );
  }
  const publication = requireCurrentVerifiedPublication(store, task.id, publicationId);
  if (publication.projectId !== proof.projectId
    || publication.localCommit !== proof.localCommit
    || publication.remoteCommit !== proof.remoteCommit) {
    throw usageError(`Publication evidence changed before Task completion: ${publication.id}.`);
  }
  if (proof.reviewRoundId !== undefined) {
    const review = store.getReviewRound(task.id, proof.reviewRoundId);
    if (review === null
      || !isCompletedTaskReviewEvidence(store, review)
      || review.taskCandidate === undefined
      || !sameTaskCandidate(review.taskCandidate, actualCandidate)) {
      throw usageError(
        `Task-final Review evidence changed before published-tree completion: ${task.id}.`
      );
    }
  }
  const actualCommit = actualCandidate.projects.find(({ projectId }) => (
    projectId === proof.projectId
  ))?.commit;
  if (actualCommit !== proof.localCommit) {
    throw usageError(
      `Task head changed before published-tree completion: `
      + `${proof.projectId}@${actualCommit ?? "missing"}.`
    );
  }
  return proof;
}

function requireCurrentVerifiedPublication(
  store: TaskStore,
  taskId: string,
  publicationId: string
) {
  const publication = store.getPublicationReference(taskId, publicationId);
  if (publication === null) {
    throw usageError(`Publication reference not found: ${taskId}/${publicationId}.`);
  }
  const current = store.findPublicationReferenceByExternalKey(
    publicationExternalKey(publication)
  );
  if (current === null || current.taskId !== taskId || current.id !== publication.id) {
    throw usageError(
      `Publication ${publication.id} is not the current unsuperseded record for its external identity.`
    );
  }
  if (publication.state !== "merged" || publication.verification !== "verified") {
    throw usageError(
      `Publication ${publication.id} must be merged and verified before Task completion.`
    );
  }
  return publication;
}

function acceptedTaskFinalReviews(
  store: TaskStore,
  taskId: string
): readonly ReviewRound[] {
  return store.listReviewRounds(taskId)
    .filter((round) => isCompletedTaskReviewEvidence(store, round))
    .sort((left, right) => (
      right.id.localeCompare(left.id, undefined, { numeric: true })
    ));
}

function sameTaskCandidate(
  left: TaskReviewCandidate,
  right: TaskReviewCandidate
): boolean {
  return left.projects.length === right.projects.length
    && left.projects.every((project, index) => (
      project.projectId === right.projects[index]?.projectId
      && project.commit === right.projects[index]?.commit
    ));
}

function requireTaskWorkspace(store: TaskStore, task: Task): ManagedWorkspace {
  const workspace = store.getTaskWorkspace(task.id);
  if (workspace === null || workspace.owner.type !== "task") {
    throw usageError(`Task ${task.id} has no authoritative managed main workspace.`);
  }
  return workspace;
}
