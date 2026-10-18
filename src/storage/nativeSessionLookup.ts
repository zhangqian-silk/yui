import type Database from "../sqlite/driver.js";
import type { RoleSessionSet } from "../executor/agentExecutor.js";
import { validateStoredRecord } from "./recordValidation.js";

/** Identity lookup includes terminal and replaced Sessions. The hot active
 * runtime projection cannot prove that an unknown caller is unmanaged.
 * Read existing canonical records; no second identity registry or schema. */
export function findNativeSessionSets(db: Database.Database, nativeIds: readonly string[]): RoleSessionSet[] {
  const ids = [...new Set(nativeIds)];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return (["role_session_sets", "global_role_session_sets"] as const).flatMap(table => {
    const rows = db.prepare(`SELECT payload FROM ${table}
      WHERE EXISTS (SELECT 1 FROM json_each(payload, '$.sessions')
        WHERE json_extract(value, '$.nativeSessionId') IN (${placeholders}))
      OR EXISTS (SELECT 1 FROM json_each(payload, '$.history')
        WHERE json_extract(value, '$.nativeSessionId') IN (${placeholders}))`)
      .all(...ids, ...ids) as { payload: string }[];
    return rows.map(row => {
      const set: unknown = JSON.parse(row.payload);
      validateStoredRecord(table, set);
      return set as RoleSessionSet;
    });
  });
}
