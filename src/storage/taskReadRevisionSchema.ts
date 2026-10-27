/** Storage 1.24 definition: immutable once published. These are cache tokens,
 * not a second Task state or a CAS/authorization source. Triggers cover every
 * source family, including direct SQL, deletions and rolled-back transactions.
 */
export const TASK_READ_REVISION_SOURCES = [
  "events", "turns", "work_items", "review_rounds", "change_sets",
  "integration_attempts", "input_requests", "durable_jobs", "messages"
] as const;

export const TASK_READ_REVISION_SCHEMA_SQL = `
CREATE TABLE task_read_revisions (
  task_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL
);
${TASK_READ_REVISION_SOURCES.map(table => `
CREATE TRIGGER ${table}_read_ai AFTER INSERT ON ${table}
BEGIN
  INSERT INTO task_read_revisions VALUES (NEW.task_id, 1)
  ON CONFLICT(task_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER ${table}_read_ad AFTER DELETE ON ${table}
BEGIN
  INSERT INTO task_read_revisions VALUES (OLD.task_id, 1)
  ON CONFLICT(task_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER ${table}_read_au AFTER UPDATE ON ${table}
BEGIN
  INSERT INTO task_read_revisions VALUES (NEW.task_id, 1)
  ON CONFLICT(task_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO task_read_revisions
    SELECT OLD.task_id, 1 WHERE OLD.task_id != NEW.task_id
  ON CONFLICT(task_id) DO UPDATE SET revision = revision + 1;
END;
`).join("")}`;
