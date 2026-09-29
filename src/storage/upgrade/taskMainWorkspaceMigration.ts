import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { updateRole, validateTaskRole, type TaskRole } from "../../role/role.js";
import { validateRoleSessionSet, type TaskRoleSessionSet } from "../../executor/agentExecutor.js";
import { validateTask, type Task } from "../../task/task.js";
import { createManagedWorkspace } from "../../worktree/managedWorkspace.js";
import { managedTaskRoot } from "../homeLayout.js";

type PayloadRow = { task_id: string; payload: string };

/** 1.0 -> 1.1: give old workspace-free Tasks the same main owner as new activations. */
export function migrateTaskMainWorkspaces(
  db: Database.Database,
  home: string,
  createdRoots: string[]
): void {
  const candidates = (db.prepare("SELECT task_id, payload FROM task_records ORDER BY task_id").all() as PayloadRow[])
    .map(row => validateTask(JSON.parse(row.payload) as Task))
    .filter(task => task.cwd === undefined
      && (task.status === "active"
        || (task.status === "completed" && task.projectBindings.length === 0)));
  const taskRoot = managedTaskRoot(home);
  for (const task of candidates) {
    if (task.workspaceIdentity !== undefined
      || db.prepare("SELECT 1 FROM managed_workspaces WHERE owner_kind='task' AND owner_id=?")
        .get(`task:${task.id}`) !== undefined) {
      throw new Error(`Task ${task.id} has conflicting workspace state; preserve it for diagnosis.`);
    }
    if (db.prepare("SELECT 1 FROM active_turns WHERE task_id=? LIMIT 1").get(task.id) !== undefined) {
      throw new Error(`Task ${task.id} has an active Turn; settle it before workspace migration.`);
    }
    for (const row of db.prepare("SELECT payload FROM role_session_sets WHERE task_id=?")
      .all(task.id) as Array<{ payload: string }>) {
      const set = validateRoleSessionSet(JSON.parse(row.payload) as TaskRoleSessionSet);
      if (Object.values(set.sessions).some(session => session.status !== "ended")
        || set.providerBinding !== null) {
        throw new Error(`Task ${task.id} has a native Session or unsettled Provider binding; stop it before workspace migration.`);
      }
    }
    const root = join(taskRoot, task.id, "main");
    if (existsSync(root)) {
      throw new Error(`Task ${task.id} has an unowned main directory: ${root}.`);
    }
    // Existing Task directories may contain independently owned WorkItems.
    // Refuse symbolic ancestors before creating this Task's new main directory.
    for (let path = dirname(root); path !== dirname(resolve(home)); path = dirname(path)) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
        throw new Error(`Task ${task.id} workspace ancestor is a symlink: ${path}.`);
      }
    }
  }
  for (const task of candidates) {
    const root = join(taskRoot, task.id, "main");
    const missing: string[] = [];
    for (let path = root; !existsSync(path); path = dirname(path)) missing.push(path);
    for (const path of missing.reverse()) {
      mkdirSync(path, { mode: 0o700 });
      createdRoots.push(path);
    }
    if (realpathSync(root) !== root) {
      throw new Error(`Task ${task.id} main workspace is not a physical directory: ${root}.`);
    }
    const timestamp = new Date(Math.max(Date.now(), Date.parse(task.updatedAt))).toISOString();
    const workspace = createManagedWorkspace({
      owner: { type: "task", taskId: task.id }, root, entries: []
    }, new Date(timestamp));
    db.prepare(`INSERT INTO managed_workspaces
      (owner_kind,owner_id,task_id,path,payload,status,created_at,updated_at)
      VALUES ('task',?,?,?,?,?,?,?)`)
      .run(`task:${task.id}`, task.id, root, JSON.stringify(workspace), "active", timestamp, timestamp);
    const updatedTask = validateTask({ ...task, cwd: root, updatedAt: timestamp });
    db.prepare("UPDATE task_records SET payload=?,updated_at=? WHERE task_id=?")
      .run(JSON.stringify(updatedTask), timestamp, task.id);
    db.prepare("UPDATE tasks_catalog SET updated_at=? WHERE task_id=?")
      .run(timestamp, task.id);
    for (const row of db.prepare("SELECT role_name,payload FROM task_roles WHERE task_id=?")
      .all(task.id) as Array<{ role_name: string; payload: string }>) {
      const role = validateTaskRole(JSON.parse(row.payload) as TaskRole);
      const isolated = db.prepare(`SELECT 1 FROM managed_workspaces
        WHERE task_id=? AND owner_kind!='task' AND path=? LIMIT 1`)
        .get(task.id, role.workspace);
      if (isolated !== undefined) continue;
      const updatedRole = updateRole(role, { workspace: root }, new Date(timestamp));
      db.prepare("UPDATE task_roles SET payload=?,updated_at=? WHERE task_id=? AND role_name=?")
        .run(JSON.stringify(updatedRole), timestamp, task.id, row.role_name);
    }
  }
}
