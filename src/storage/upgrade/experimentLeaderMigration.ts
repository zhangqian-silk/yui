import type Database from "../../sqlite/driver.js";
import { requireKnownFields } from "../../domain/validation.js";
import { validateGlobalRole, type GlobalRole, type TaskRole } from "../../role/role.js";
import { createExperimentLeaderFromRole } from "../../role/roleTemplate.js";

/** 1.32 stored only a parent binding. Freeze its effective configuration once,
 * inside the central upgrade transaction; never rewrite Sessions or Runs. */
export function migrateExperimentLeaders(db: Database.Database): void {
  const rows = db.prepare("SELECT task_id, role_name, payload FROM task_roles").all() as
    { task_id: string; role_name: string; payload: string }[];
  const update = db.prepare("UPDATE task_roles SET payload=? WHERE task_id=? AND role_name=?");
  for (const row of rows) {
    const local = JSON.parse(row.payload);
    if (local.template === undefined) continue;
    requireKnownFields(local, ["schemaVersion", "taskId", "name", "template", "workspace", "launchRevision",
      "createdAt", "updatedAt", "executionEnvironment", "instanceCode"], "1.32 inherited Task Role");
    if (local.template !== "experiment-leader" || local.name !== "leader"
      || local.taskId !== row.task_id || local.name !== row.role_name || local.schemaVersion !== 1
      || !Number.isSafeInteger(local.launchRevision) || local.launchRevision < 1
      || !Number.isFinite(Date.parse(local.createdAt)) || !Number.isFinite(Date.parse(local.updatedAt))) {
      throw new Error("Invalid 1.32 inherited Task Leader binding.");
    }
    const parentRow = db.prepare("SELECT payload FROM global_roles WHERE name='leader'").get() as
      { payload: string } | undefined;
    if (!parentRow) throw new Error("ExperimentLeader migration requires the global Leader template.");
    const parent = validateGlobalRole(JSON.parse(parentRow.payload) as GlobalRole);
    if (parent.name !== "leader") throw new Error("Invalid global Leader template.");
    const { jobOwner: _jobOwner, ...configuration } = parent;
    const copied = createExperimentLeaderFromRole({
      ...configuration, ...local, launchRevision: parent.launchRevision + local.launchRevision
    } as TaskRole);
    update.run(JSON.stringify(copied), row.task_id, row.role_name);
  }
}
