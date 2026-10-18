import { BASELINE_SCHEMA_CHECKSUM, BASELINE_SCHEMA_SQL, SCHEDULE_SCHEMA_CHECKSUM, storageMinorUpgradePlan } from "../../dist/storage/sqliteSchema.js";

export function usePre118Layout(db) {
  db.exec("DROP TABLE agent_job_runs;");
  db.prepare("UPDATE storage_schema SET checksum=?").run(storageMinorUpgradePlan("1.17")[0].sourceChecksum);
}

/** Restore the declared Role foreign key before labeling a fixture pre-1.14. */
export function usePre114Layout(db) {
  usePre118Layout(db);
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
