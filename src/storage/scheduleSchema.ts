/** Additive storage 1.9 -> 1.10. No old records are rewritten. */
export const SCHEDULE_SCHEMA_SQL = `
CREATE TABLE schedules (
  scope_key TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  next_due TEXT,
  PRIMARY KEY(scope_key, schedule_id)
);
CREATE INDEX idx_schedules_due ON schedules(state, next_due);
`;
