import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  knowledgeProposalFingerprint, validateProject,
  type KnowledgeProposal, type Project, type ProjectKnowledge
} from "../../repository/project.js";

type PreviousProposal = Omit<KnowledgeProposal, "schemaVersion"> & { schemaVersion: 1 };
type PreviousKnowledge = Omit<ProjectKnowledge, "schemaVersion" | "version" | "history" | "scope" | "expiresWhen">
  & { schemaVersion: 1 };
type PreviousProject = Omit<Project, "knowledge" | "knowledgeProposals"> & {
  knowledge: PreviousKnowledge[];
  knowledgeProposals: PreviousProposal[];
};

/**
 * The declared 1.2 -> 1.3 payload transition. Never used by ordinary readers.
 * Version 1 is the observed pre-migration head, not a claim that no earlier
 * edits happened. Existing proposals and frozen Context snapshots retain their
 * original identities, decisions and evidence; snapshots are never rewritten.
 */
export function migrateProjectKnowledge(db: Database.Database): void {
  const rows = db.prepare("SELECT id, payload FROM projects ORDER BY id").all() as Array<{ id: string; payload: string }>;
  for (const row of rows) {
    const project = JSON.parse(row.payload) as PreviousProject;
    if (project.id !== row.id || !Array.isArray(project.knowledge) || !Array.isArray(project.knowledgeProposals)) {
      throw new Error(`Invalid 1.2 Project knowledge container: ${row.id}.`);
    }
    const knowledgeProposals: KnowledgeProposal[] = project.knowledgeProposals.map(proposal => {
      if (proposal.schemaVersion !== 1) throw new Error(`Invalid 1.2 Knowledge proposal: ${proposal.id}.`);
      const sourceKey = [proposal.projectId, proposal.source.taskId, proposal.source.decisionId ?? "",
        proposal.source.milestoneId ?? "", proposal.source.commitSha ?? ""].join("|");
      const previousFingerprint = createHash("sha256")
        .update(`${sourceKey}\u0000${proposal.title}\u0000${proposal.body}`).digest("hex");
      if (proposal.fingerprint !== previousFingerprint) {
        throw new Error(`Invalid 1.2 Knowledge fingerprint: ${proposal.id}.`);
      }
      return { ...proposal, schemaVersion: 2, fingerprint: knowledgeProposalFingerprint(proposal) };
    });
    const knowledge: ProjectKnowledge[] = project.knowledge.map(entry => {
      if (entry.schemaVersion !== 1 || "version" in entry || "history" in entry
        || "scope" in entry || "expiresWhen" in entry) {
        throw new Error(`Invalid 1.2 Project knowledge: ${entry.id}.`);
      }
      const proposal = knowledgeProposals.find(candidate => candidate.id === entry.provenance?.proposalId);
      const backed = proposal !== undefined && proposal.status === "accepted"
        && proposal.knowledgeId === entry.id && proposal.title === entry.title && proposal.body === entry.body
        && proposal.source.taskId === entry.provenance?.taskId
        && proposal.source.decisionId === entry.provenance?.decisionId
        && proposal.source.milestoneId === entry.provenance?.milestoneId
        && proposal.source.commitSha === entry.provenance?.commitSha;
      return {
        ...entry, schemaVersion: 2, version: 1, history: [],
        ...(backed ? {
          ...(proposal.scope === undefined ? {} : { scope: proposal.scope }),
          ...(proposal.expiresWhen === undefined ? {} : { expiresWhen: proposal.expiresWhen }),
          provenance: { ...entry.provenance!, fingerprint: proposal.fingerprint }
        } : {})
      };
    });
    const migrated = validateProject({ ...project, knowledge, knowledgeProposals });
    db.prepare("UPDATE projects SET payload=? WHERE id=?").run(JSON.stringify(migrated), row.id);
  }
}
