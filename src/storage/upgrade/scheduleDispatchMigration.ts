import type Database from "better-sqlite3";
import { validateSchedule, type Schedule } from "../../schedule/schedule.js";

/** Keep valid historical Session authority; never infer a service grant. */
export function migrateScheduleDispatch(db: Database.Database): void {
  const rows = db.prepare("SELECT rowid,scope_key,schedule_id,payload FROM schedules").all() as
    { rowid: number; scope_key: string; schedule_id: string; payload: string }[];
  for (const row of rows) {
    const old = JSON.parse(row.payload);
    if (old.target !== undefined || old.authorization?.kind !== undefined) throw new Error("Unexpected Schedule shape in storage 1.15.");
    const next = validateSchedule({ ...old, target: { kind: "existing-job" },
      authorization: { ...old.authorization, kind: "session" } } as Schedule);
    db.prepare("INSERT INTO storage_migration_archive(migration_version,family,record_key,payload) VALUES(?,?,?,?)")
      .run(16, "schedules", `${row.scope_key}/${row.schedule_id}`, row.payload);
    db.prepare("UPDATE schedules SET payload=? WHERE rowid=?").run(JSON.stringify(next), row.rowid);
  }
}
