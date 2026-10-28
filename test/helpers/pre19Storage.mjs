import { BASELINE_SCHEMA_CHECKSUM, BASELINE_SCHEMA_SQL, SCHEDULE_SCHEMA_CHECKSUM, storageMinorUpgradePlan } from "../../dist/storage/sqliteSchema.js";
import { TASK_READ_REVISION_SOURCES } from "../../dist/storage/taskReadRevisionSchema.js";

export function usePre124Layout(db) {
  db.exec("DROP INDEX idx_runtime_observation_semantic; DROP INDEX idx_runtime_observation_event");
  for (const table of TASK_READ_REVISION_SOURCES) {
    for (const suffix of ["ai", "ad", "au"]) db.exec(`DROP TRIGGER ${table}_read_${suffix}`);
  }
  db.exec("DROP TABLE task_read_revisions");
  db.prepare("UPDATE storage_schema SET checksum=?").run(storageMinorUpgradePlan("1.23")[0].sourceChecksum);
}

export function usePre120Layout(db) {
  usePre124Layout(db);
  db.exec("DROP TABLE agent_job_runs;");
  db.prepare("UPDATE storage_schema SET checksum=?").run(storageMinorUpgradePlan("1.19")[0].sourceChecksum);
}

/** Restore the declared Role foreign key before labeling a fixture pre-1.14. */
export function usePre114Layout(db) {
  usePre120Layout(db);
  db.exec(`ALTER TABLE global_role_session_sets RENAME TO session_sets_fixture;
    ${BASELINE_SCHEMA_SQL.match(/CREATE TABLE global_role_session_sets \([\s\S]*?\n\);/)[0]}
    INSERT INTO global_role_session_sets SELECT * FROM session_sets_fixture;
    DROP TABLE session_sets_fixture;
    ${BASELINE_SCHEMA_SQL.match(/CREATE INDEX idx_global_provider_retry[\s\S]*?;/)[0]}`);
  db.prepare("UPDATE storage_schema SET checksum=?").run(SCHEDULE_SCHEMA_CHECKSUM);
}

/** Construct the declared pre-1.9 physical layout, not a mislabeled current DB. */
export function usePre19Layout(db) {
  usePre114Layout(db);
  db.exec("DROP TABLE schedules; DROP TABLE job_definitions; DROP TABLE global_job_runs;");
  db.prepare("UPDATE storage_schema SET checksum=?").run(BASELINE_SCHEMA_CHECKSUM);
}
