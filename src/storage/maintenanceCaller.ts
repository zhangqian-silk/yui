import { join } from "node:path";
import Database from "../sqlite/driver.js";
import type { GlobalRole } from "../role/role.js";
import type { GlobalRoleSessionSet, TaskRoleSessionSet } from "../executor/agentExecutor.js";
import { hasManagedIdentity } from "../runtime/managedIdentity.js";
import { ManagedRuntimeDriftError, requireManagedGlobalCaller } from "../runtime/managedCaller.js";
import { sessionCallerEnvironment } from "../runtime/sessionCaller.js";
import { validateStoredRecord, type StoredRecordTable } from "./recordValidation.js";
import { inspectSqliteSchema, storageMinorUpgradePlan, validateSqliteSchemaObjects } from "./sqliteSchema.js";
import { CURRENT_DATABASE_FILENAME } from "./storageSchema.js";

/**
 * Maintenance must authenticate before migration, without opening a current-only
 * business Store. The declared 1.x migrations preserve these Role/Session
 * envelopes and physical tables. Read only those records in one SQLite snapshot;
 * this grants no old-format business reads, writes or implicit migration.
 */
export function maintenanceCallerEnvironment(
  home: string, env: NodeJS.ProcessEnv, operatorOnly = true
): NodeJS.ProcessEnv {
  if (!hasManagedIdentity(env)) return env;
  const db = new Database(join(home, CURRENT_DATABASE_FILENAME), { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const schema = inspectSqliteSchema(db);
      if (storageMinorUpgradePlan(schema.currentVersion) === null) {
        throw new ManagedRuntimeDriftError("Maintenance cannot authenticate an unsupported Home storage version.");
      }
      validateSqliteSchemaObjects(db, schema.currentVersion);
      const read = <T>(table: StoredRecordTable, where: string, params: string[]): T | null => {
        const row = db.prepare(`SELECT payload FROM ${table} WHERE ${where}`).get(...params) as
          { payload: string } | undefined;
        if (!row) return null;
        const value: unknown = JSON.parse(row.payload);
        validateStoredRecord(table, value);
        return value as T;
      };
      const registry = {
        getGlobalRole: (name: string) => read<GlobalRole>("global_roles", "name=?", [name]),
        getGlobalRoleSessionSet: (name: string) =>
          read<GlobalRoleSessionSet>("global_role_session_sets", "name=?", [name]),
        getTaskRoleSessionSet: (task: string, role: string) =>
          read<TaskRoleSessionSet>("role_session_sets", "task_id=? AND role_name=?", [task, role]),
        listRuntimeSessionCandidates: () => {
          // Read canonical sets, not a derived index that could be stale. Only
          // active bindings participate, exactly as in normal caller discovery.
          const rows = db.prepare(`
            SELECT 'global_role_session_sets' AS source, payload FROM global_role_session_sets
            UNION ALL SELECT 'role_session_sets' AS source, payload FROM role_session_sets
          `).all() as { source: StoredRecordTable; payload: string }[];
          return rows.flatMap(row => {
            const set = JSON.parse(row.payload) as GlobalRoleSessionSet | TaskRoleSessionSet;
            validateStoredRecord(row.source, set);
            const session = set.sessions[set.activeAgentId];
            if (!session || session.status !== "active") return [];
            return [{ owner: set.owner, agentId: session.agentId, adapterId: session.adapterId,
              nativeSessionId: session.nativeSessionId, sessionUpdatedAt: set.updatedAt }];
          });
        }
      };
      const current = sessionCallerEnvironment(registry, env);
      if (current.YUI_SESSION_SCOPE !== "global" || current.YUI_ROLE !== "operator") {
        if (!operatorOnly) return current; // Doctor keeps normal scoped authorization below.
        throw new ManagedRuntimeDriftError("Home maintenance requires the user or current Operator, not a Task or custom Role.");
      }
      requireManagedGlobalCaller(registry, current);
      return current;
    })();
  } finally { db.close(); }
}
