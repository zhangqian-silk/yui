/** Storage 1.18: Agent Runs are not shell runs with fabricated Task/workspace fields. */
export const AGENT_JOB_SCHEMA_SQL = `
CREATE TABLE agent_job_runs (
  run_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX idx_agent_job_runs_owner ON agent_job_runs(scope_key, definition_id);
`;
