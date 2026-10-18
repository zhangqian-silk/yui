import { join } from "node:path";
import Database from "../sqlite/driver.js";
import type { GlobalRole } from "../role/role.js";
import type { GlobalRoleSessionSet } from "../executor/agentExecutor.js";
import { hasManagedIdentity } from "../runtime/managedIdentity.js";
import { ManagedRuntimeDriftError, requireManagedGlobalCaller } from "../runtime/managedCaller.js";
import { sessionCallerEnvironment } from "../runtime/sessionCaller.js";
import { validateStoredRecord, type StoredRecordTable } from "./recordValidation.js";
import { inspectSqliteSchema, storageMinorUpgradePlan, validateSqliteSchemaObjects } from "./sqliteSchema.js";
import { CURRENT_DATABASE_FILENAME, inspectStorageSchema } from "./storageSchema.js";
import { findNativeSessionSets } from "./nativeSessionLookup.js";

/**
 * Read-only caller resolution, also usable before maintenance/migration and by
 * offline discovery. The declared 1.x migrations preserve these Role/Session
 * envelopes and physical tables. Read only those records in one SQLite snapshot.
 * operatorOnly adds the maintenance gate; ordinary execution still applies its
 * current storage, Session and domain checks. No implicit migration or setup.
 */
export function maintenanceCallerEnvironment(
  home: string, env: NodeJS.ProcessEnv, operatorOnly = true
): NodeJS.ProcessEnv {
  if (!hasManagedIdentity(env) && env.CODEX_THREAD_ID === undefined) return env;
  // A genuinely new Home has no managed registrations. Do not initialize it
  // here: setup remains the explicit owner. Existing invalid storage fails closed.
  if (!hasManagedIdentity(env) && inspectStorageSchema(home).status === "uninitialized") {
    return sessionCallerEnvironment({ findNativeSessionSets: () => [] }, env);
  }
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
        findNativeSessionSets: (nativeIds: readonly string[]) => findNativeSessionSets(db, nativeIds)
      };
      const current = sessionCallerEnvironment(registry, env);
      if (!hasManagedIdentity(current)) return current;
      if (current.YUI_SESSION_SCOPE !== "global" || current.YUI_ROLE !== "operator") {
        if (!operatorOnly) return current; // Execution retains its normal scoped checks.
        throw new ManagedRuntimeDriftError("Home maintenance requires the user or current Operator, not a Task or custom Role.");
      }
      requireManagedGlobalCaller(registry, current);
      return current;
    })();
  } finally { db.close(); }
}
