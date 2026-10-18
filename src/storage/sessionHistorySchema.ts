/** Session history outlives Role deletion. It is identity evidence, not a
 * grant or an independently managed lifecycle. Payload format is unchanged. */
export const GLOBAL_SESSION_TABLE_SQL = `CREATE TABLE global_role_session_sets (
  name       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

export const GLOBAL_SESSION_RETRY_INDEX_SQL = `CREATE INDEX idx_global_provider_retry ON global_role_session_sets(
  json_extract(payload, '$.providerBinding.retry.status')
) WHERE json_extract(payload, '$.providerBinding.retry.status') IN ('waiting', 'in-flight');`;

export const SESSION_HISTORY_UPGRADE_SQL = `
ALTER TABLE global_role_session_sets RENAME TO global_role_session_sets_113;
${GLOBAL_SESSION_TABLE_SQL}
INSERT INTO global_role_session_sets SELECT * FROM global_role_session_sets_113;
DROP TABLE global_role_session_sets_113;
${GLOBAL_SESSION_RETRY_INDEX_SQL}
`;
