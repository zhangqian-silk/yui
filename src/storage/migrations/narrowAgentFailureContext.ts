import { isAbsolute } from "node:path";
import type Database from "better-sqlite3";

/** Frozen v36 projection. Execution/Review/protocol data remains in audit only;
 * a metadata query must not require those unrelated contracts to stay current. */
export function migrateNarrowAgentFailureContext(db: Database.Database): void {
  const rows = db.prepare("SELECT task_id,event_id,payload FROM events WHERE type='runtime.agent-error'").all() as
    { task_id: string; event_id: string; payload: string }[];
  const archive = db.prepare(`INSERT INTO storage_migration_archive
    (migration_version,family,record_key,payload,content) VALUES(37,?,?,?,NULL)`);
  const update = db.prepare("UPDATE events SET payload=? WHERE task_id=? AND event_id=?");
  for (const row of rows) {
    const event = JSON.parse(row.payload);
    const raw = event?.payload?.capabilityContext;
    if (typeof raw !== "string") throw new Error(`Missing v36 failure context: ${row.task_id}/${row.event_id}.`);
    const context = JSON.parse(raw);
    const key = JSON.stringify([row.task_id, row.event_id]);
    const emptyIdentities: Record<string, string> = {};
    for (const field of ["runId", "nativeSessionId", "nativeTurnId"]) {
      if (event.payload[field] !== "") continue;
      emptyIdentities[field] = "";
      delete event.payload[field];
    }
    if (Object.keys(emptyIdentities).length) {
      archive.run("agent-error-empty-identities", key, JSON.stringify(emptyIdentities));
    }
    if (context?.status === "unavailable" && text(context.reason)) {
      if (Object.keys(emptyIdentities).length) update.run(JSON.stringify(event), row.task_id, row.event_id);
      continue;
    }
    const old = context?.effective;
    if (context?.status !== "recorded" || !/^[a-f0-9]{64}$/.test(context.agentFingerprint)
      || old?.schemaVersion !== 4 || !text(old.agentId)
      || !["codex", "claude", "acp"].includes(old.adapterId)
      || !text(old.workspace?.root) || !isAbsolute(old.workspace.root)) {
      throw new Error(`Invalid v36 failure context: ${row.task_id}/${row.event_id}.`);
    }
    const config: Record<string, unknown> = { adapterId: old.adapterId };
    for (const key of ["model", "effort", ...(old.adapterId === "codex" ? ["profile"] : []),
      ...(old.adapterId === "claude" ? ["settingsFile"] : [])]) {
      if (old[key] === undefined) continue;
      if (!text(old[key]) || key === "settingsFile" && !isAbsolute(old[key])) {
        throw new Error(`Invalid v36 failure ${key}: ${row.task_id}/${row.event_id}.`);
      }
      config[key] = old[key];
    }
    if (old.adapterId === "claude" && old.settingsSources !== undefined) {
      if (!Array.isArray(old.settingsSources) || old.settingsSources.some((source: unknown) => !text(source))
        || new Set(old.settingsSources).size !== old.settingsSources.length) {
        throw new Error(`Invalid v36 settings sources: ${row.task_id}/${row.event_id}.`);
      }
      config.settingsSources = old.settingsSources;
    }
    archive.run("agent-error-context", key, raw);
    event.payload.capabilityContext = JSON.stringify({
      status: "recorded", agentId: old.agentId, cwd: old.workspace.root, config,
      agentFingerprint: context.agentFingerprint
    });
    update.run(JSON.stringify(event), row.task_id, row.event_id);
  }
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}
