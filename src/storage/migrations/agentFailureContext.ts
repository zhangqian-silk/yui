import type Database from "better-sqlite3";

/** Historical errors have no trustworthy launch snapshot. Preserve their raw
 * payloads and explicitly record that fact; never infer it from today's Role. */
export function migrateAgentFailureContext(db: Database.Database): void {
  const archive = db.prepare(`INSERT INTO storage_migration_archive
    (migration_version,family,record_key,payload,content) VALUES(36,'agent-error',?,?,NULL)`);
  const update = db.prepare("UPDATE events SET payload=? WHERE task_id=? AND event_id=?");
  const rows = db.prepare("SELECT task_id,event_id,payload FROM events WHERE type='runtime.agent-error'").all() as
    { task_id: string; event_id: string; payload: string }[];
  for (const row of rows) {
    const event = JSON.parse(row.payload);
    if (!event || event.schemaVersion !== 2 || event.type !== "runtime.agent-error" || event.taskId !== row.task_id
      || event.id !== row.event_id || !event.payload || typeof event.payload !== "object"
      || Array.isArray(event.payload) || Object.values(event.payload).some(value => typeof value !== "string")
      || Object.hasOwn(event.payload, "capabilityContext")) {
      throw new Error(`Invalid pre-context Agent error: ${row.task_id}/${row.event_id}.`);
    }
    archive.run(JSON.stringify([row.task_id, row.event_id]), row.payload);
    event.payload.capabilityContext = JSON.stringify({
      status: "unavailable", reason: "Launch configuration was not recorded by this historical error producer."
    });
    update.run(JSON.stringify(event), row.task_id, row.event_id);
  }
}
