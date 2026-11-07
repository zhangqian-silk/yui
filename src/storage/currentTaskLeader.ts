import { join } from "node:path";
import Database from "../sqlite/driver.js";
import { validateSqliteSchema } from "./sqliteSchema.js";
import { resolveTaskRoleTemplate, validateStoredTaskRole, type StoredTaskRole } from "../role/roleTemplate.js";
import { validateGlobalRole, type GlobalRole } from "../role/role.js";

/** A bounded read for pre-input metadata/offline discovery. Do not import the
 * entire control-plane Store into the native Host's instruction-loading path. */
export function readCurrentTaskLeader(home: string, taskId: string) {
  const db = new Database(join(home, "yui.db"), { readonly: true, fileMustExist: true });
  try {
    validateSqliteSchema(db);
    return db.transaction(() => {
      const row = db.prepare("SELECT payload FROM task_roles WHERE task_id=? AND role_name='leader'")
        .get(taskId) as { payload: string } | undefined;
      if (!row) return null;
      const role = JSON.parse(row.payload) as StoredTaskRole;
      validateStoredTaskRole(role);
      const parentRow = role.template === undefined ? undefined
        : db.prepare("SELECT payload FROM global_roles WHERE name='leader'").get() as { payload: string } | undefined;
      const parent = parentRow ? validateGlobalRole(JSON.parse(parentRow.payload) as GlobalRole) : null;
      return resolveTaskRoleTemplate(role, parent);
    })();
  } finally { db.close(); }
}
