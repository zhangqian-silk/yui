import type Database from "better-sqlite3";
import { processBusinessResult } from "../../job/jobBusinessResult.js";
import { validateDurableJob, type JobRun } from "../../job/durableJob.js";

/** Preserve raw history and derive only what each original result actually proves. */
export function migrateJobBusinessResults(db: Database.Database): void {
  for (const table of ["durable_jobs", "global_job_runs"] as const) {
    const rows = db.prepare(`SELECT rowid, payload FROM ${table}`).all() as { rowid: number; payload: string }[];
    for (const row of rows) {
      const run = JSON.parse(row.payload) as JobRun;
      if (run.businessResult !== undefined) throw new Error("Unexpected business result in storage 1.14.");
      validateDurableJob(run);
      if (!run.result) continue;
      const migrated = validateDurableJob({ ...run, businessResult: processBusinessResult(run, run.result) });
      db.prepare("INSERT INTO storage_migration_archive(migration_version,family,record_key,payload) VALUES(?,?,?,?)")
        .run(15, table, `${"taskId" in run ? run.taskId : "global"}/${run.id}`, row.payload);
      db.prepare(`UPDATE ${table} SET payload=? WHERE rowid=?`).run(JSON.stringify(migrated), row.rowid);
    }
  }
}
