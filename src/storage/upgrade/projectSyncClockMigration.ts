import type Database from "better-sqlite3";
import { resolveTimeZone } from "../../config/timeZone.js";
import { nextScheduleDue, validateSchedule, type Schedule } from "../../schedule/schedule.js";

/** 1.20 had no rule-edit provenance. Only revision 1 proves no user mutation.
 * Higher revisions may be dispatch, recovery OR an equal-valued user edit;
 * preserve them instead of guessing from interval values or generation.
 */
export function migrateProjectSyncClock(db: Database.Database): void {
  const now = new Date();
  const rows = db.prepare("SELECT rowid,scope_key,schedule_id,payload FROM schedules").all() as
    { rowid: number; scope_key: string; schedule_id: string; payload: string }[];
  for (const row of rows) {
    const old = JSON.parse(row.payload) as Schedule;
    if (!old.builtin || old.revision !== 1) continue;
    validateSchedule(old);
    // Confirm the declared install shape, in addition to the mutation evidence.
    if (old.generation !== 1 || old.rule.kind !== "interval" || old.rule.everyMs !== 21_600_000
      || Date.parse(old.rule.anchor) !== Date.parse(old.createdAt) + 21_600_000) continue;
    const config = db.prepare("SELECT payload FROM config WHERE id=1").get() as { payload: string } | undefined;
    const rule = { kind: "cron" as const, expression: "0 */6 * * *",
      timezone: resolveTimeZone(config ? JSON.parse(config.payload).timeZone : undefined) };
    const after = new Date(Math.max(now.getTime(), Date.parse(old.processedThrough ?? "") || 0));
    const next = validateSchedule({ ...old, rule, revision: old.revision + 1, generation: old.generation + 1,
      processedThrough: after.toISOString(), nextDue: nextScheduleDue(rule, after), updatedAt: now.toISOString() });
    db.prepare("INSERT INTO storage_migration_archive(migration_version,family,record_key,payload) VALUES(?,?,?,?)")
      .run(21, "schedules", `${row.scope_key}/${row.schedule_id}`, row.payload);
    db.prepare("UPDATE schedules SET payload=?,next_due=? WHERE rowid=?")
      .run(JSON.stringify(next), next.nextDue, row.rowid);
  }
}
