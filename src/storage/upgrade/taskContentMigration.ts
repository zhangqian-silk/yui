import type Database from "better-sqlite3";
import { validateContextSnapshot } from "../../context/contextSnapshot.js";
import { storeSnapshotContent, type ContentMigrationEffects } from "../taskContent.js";

/** Preserve exact identities, values and digests. Only the storage encoding
 * changes; historical Context is never regenerated from today's records.
 */
export function migrateTaskContent(
  db: Database.Database, home: string, effects: ContentMigrationEffects
): void {
  const update = db.prepare("UPDATE context_snapshots SET payload=? WHERE task_id=? AND snapshot_id=?");
  const next = db.prepare(`SELECT task_id,snapshot_id,payload FROM context_snapshots
    WHERE (task_id,snapshot_id) > (?,?) ORDER BY task_id,snapshot_id LIMIT 1`);
  let cursor = ["", ""];
  for (;;) {
    // No active SQLite iterator across a write; no whole-Home payload load.
    const row = next.get(...cursor) as { task_id: string; snapshot_id: string; payload: string } | undefined;
    if (!row) break;
    const snapshot = validateContextSnapshot(JSON.parse(row.payload));
    if (snapshot.taskId !== row.task_id || snapshot.id !== row.snapshot_id) {
      throw new Error("Context Snapshot ownership differs from its database key.");
    }
    update.run(JSON.stringify(storeSnapshotContent(home, snapshot, effects)), row.task_id, row.snapshot_id);
    cursor = [row.task_id, row.snapshot_id];
  }
}
