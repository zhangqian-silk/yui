/** Additive DDL for storage 1.9; the published baseline is unchanged. */
export const JOB_SCHEMA_SQL = `
CREATE TABLE job_definitions (
  scope_key TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (scope_key, definition_id)
);
CREATE TABLE global_job_runs (
  run_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX idx_global_job_runs_status ON global_job_runs(status);
`;
