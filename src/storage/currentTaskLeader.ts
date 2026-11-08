import { join } from "node:path";
import Database from "../sqlite/driver.js";
import { validateSqliteSchema } from "./sqliteSchema.js";
import { validateTaskRole, type TaskRole } from "../role/role.js";

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
      return validateTaskRole(JSON.parse(row.payload) as TaskRole);
    })();
  } finally { db.close(); }
}
