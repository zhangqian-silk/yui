import type Database from "better-sqlite3";

/** Classify only known v19 Git conflicts. Manual strategy and CAS blockers
 * keep their meaning. Never synthesize candidate/Job success or edit history. */
export function migrateIntegrationContinuation(db: Database.Database): void {
  const rows = db.prepare("SELECT task_id, integration_id, payload FROM integration_attempts").all() as {
    task_id: string; integration_id: string; payload: string;
  }[];
  const update = db.prepare("UPDATE integration_attempts SET status = ?, payload = ? WHERE task_id = ? AND integration_id = ?");
  for (const row of rows) {
    const attempt = JSON.parse(row.payload);
    if (attempt.schemaVersion !== 6 || attempt.status !== "blocked") continue;
    const source = attempt.source;
    const summary = attempt.conflict?.summary;
    if (typeof summary !== "string") continue;
    const ordinary = (source?.kind === "upstream" && source.strategy === "rebase"
      && summary.startsWith("Upstream rebase conflicts"))
      || (source?.kind === "work-item" && source.strategy === "merge"
        && summary.startsWith("WorkItem merge conflicts"))
      || (source?.kind === "work-item" && source.strategy === "cherry-pick"
        && summary.startsWith(`WorkItem ${source.workItemId} commit `)
        && summary.includes(" conflicts with "));
    if (!ordinary) continue;
    update.run("conflicted", JSON.stringify({ ...attempt, status: "conflicted" }), row.task_id, row.integration_id);
  }
}
