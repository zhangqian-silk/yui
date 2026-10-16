import type Database from "better-sqlite3";
import { validateDurableJob, type DurableJob } from "../../job/durableJob.js";
import { definitionFromTaskRun } from "../../job/jobDefinition.js";

export function migrateJobDefinitions(db: Database.Database): void {
  const rows = db.prepare("SELECT task_id, job_id, payload FROM durable_jobs").all() as Array<{
    task_id: string; job_id: string; payload: string;
  }>;
  for (const row of rows) {
    const original = JSON.parse(row.payload);
    if (original.taskId !== row.task_id || original.id !== row.job_id
      || original.definitionId !== undefined || original.definitionRevision !== undefined || original.trigger !== undefined) {
      throw new Error(`Invalid 1.8 Job identity: ${row.task_id}/${row.job_id}.`);
    }
    const run: DurableJob = validateDurableJob({
      ...original, definitionId: original.id, definitionRevision: 1,
      trigger: { source: "migration", key: original.operation.requestId }
    });
    db.prepare("INSERT INTO storage_migration_archive(migration_version,family,record_key,payload) VALUES(?,?,?,?)")
      .run(9, "durable_jobs", `${row.task_id}/${row.job_id}`, row.payload);
    db.prepare("INSERT INTO job_definitions VALUES(?,?,?)")
      .run(row.task_id, run.definitionId, JSON.stringify(definitionFromTaskRun(run)));
    db.prepare("UPDATE durable_jobs SET payload=? WHERE task_id=? AND job_id=?")
      .run(JSON.stringify(run), row.task_id, row.job_id);
  }
}
