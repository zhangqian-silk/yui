import type { Project, ProjectKnowledge } from "../repository/project.js";

/** Portable policy, not the machine's Project registration or approval queue.
 * Explicit project/resource commands remain the authority for those facts.
 */
export function projectPolicyContext(project: Project) {
  return {
    schemaVersion: 1 as const,
    id: project.id,
    name: project.name,
    aliases: project.aliases,
    stableBranch: project.stableBranch,
    developmentBranch: project.developmentBranch,
    ...(project.remoteUrl === undefined ? {} : { remoteUrl: project.remoteUrl }),
    status: project.status
  };
}

/** One effective version. Older revisions are read explicitly through Project
 * Knowledge; already frozen snapshots keep their original full values.
 */
export function projectKnowledgeContext(projectId: string, entry: ProjectKnowledge) {
  const { history: _history, ...current } = entry;
  return { projectId, ...current };
}
