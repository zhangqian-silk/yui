import { BASELINE_SCHEMA_CHECKSUM } from "../../dist/storage/sqliteSchema.js";

/** Construct the declared pre-1.9 physical layout, not a mislabeled current DB. */
export function usePre19Layout(db) {
  db.exec("DROP TABLE schedules; DROP TABLE job_definitions; DROP TABLE global_job_runs;");
  db.prepare("UPDATE storage_schema SET checksum=?").run(BASELINE_SCHEMA_CHECKSUM);
}
