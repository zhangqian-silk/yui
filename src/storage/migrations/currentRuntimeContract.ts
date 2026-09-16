import type Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { requireIdentity, requirePositiveInteger, requireText, requireTimestamp } from "../../domain/validation.js";
import { readHistoricalVerificationPlan } from "./verificationPlanV1.js";

/** Immutable audit only: no current executor or cache lookup reads this table.
 * Raw payloads and binary logs survive retiring their executable contracts. */
export const CURRENT_RUNTIME_CONTRACT_SQL = `
CREATE TABLE storage_migration_archive (
  migration_version INTEGER NOT NULL,
  family TEXT NOT NULL,
  record_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  content BLOB,
  PRIMARY KEY (migration_version, family, record_key)
);
`;

/** Read-only blockers, shared by preflight and the actual 34→35 transaction.
 * An old admitted execution/physical owner must settle through its original
 * contract. Neither an upgrade nor a directory name proves it is safe to drop. */
export function preflightCurrentRuntimeContract(db: Database.Database): void {
  const gate = db.prepare(`SELECT task_id,integration_id FROM integration_attempts
    WHERE status NOT IN ('committed','superseded','failed')
      AND json_type(payload,'$.gatePlanDigest') IS NOT NULL LIMIT 1`)
    .get() as { task_id: string; integration_id: string } | undefined;
  if (gate) throw new Error(`Current verification cutover requires the admitted gate to settle: ${gate.task_id}/${gate.integration_id}. Continue or abort it with the old release.`);
  const owner = db.prepare(`SELECT process_key FROM session_owners
    WHERE json_extract(payload,'$.providerRoot.attribution')='launch-env' LIMIT 1`)
    .get() as { process_key: string } | undefined;
  if (owner) throw new Error(`Retired Session owner attribution requires explicit old-release reconciliation: ${owner.process_key}. Preserve its process evidence; no owner was rewritten.`);
  if (db.name !== ":memory:" && db.name !== "") {
    const directory = join(dirname(db.name), "runtime", "session-owners");
    let files: string[];
    try { files = readdirSync(directory).filter(name => name.endsWith(".json")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      files = [];
    }
    if (files.length) throw new Error(`Retired file Session owners remain at ${directory}. Inspect and release their exact resources with the old release, then archive the files outside the active Home before upgrading.`);
  }
  for (const row of historicalIntegrations(db)) {
    const value = JSON.parse(row.payload);
    if (!["committed", "superseded", "failed"].includes(value.status)) {
      throw new Error(`Historical Integration must be explicitly settled before retirement: ${row.task_id}/${row.integration_id}.`);
    }
    const workspace = db.prepare(`SELECT 1 FROM managed_workspaces WHERE task_id=?
      AND json_extract(payload,'$.owner.integrationAttemptId')=? LIMIT 1`).get(row.task_id, row.integration_id);
    const job = db.prepare(`SELECT 1 FROM durable_jobs WHERE task_id=?
      AND json_extract(payload,'$.owner.integrationAttemptId')=?
      AND (status IN ('queued','running') OR (status='unknown-needs-attention'
        AND json_type(payload,'$.acknowledgedAt') IS NULL)) LIMIT 1`).get(row.task_id, row.integration_id);
    const adoption = db.prepare(`SELECT 1 FROM events WHERE task_id=?
      AND type='publication.candidate-adopted'
      AND json_extract(payload,'$.payload.integrationId')=? LIMIT 1`).get(row.task_id, row.integration_id);
    if (workspace || job || adoption) {
      throw new Error(`Historical Integration still has execution or delivery references: ${row.task_id}/${row.integration_id}. Preserve the Home and resolve/export its original evidence before upgrading.`);
    }
  }
}

/** Frozen v34 contract retirement. Existing migration definitions are unchanged.
 * Only active verification configuration changes; old proof is never relabelled
 * as current success. Historical Integration bytes become ordinary Task Events. */
export function migrateCurrentRuntimeContract(db: Database.Database): void {
  preflightCurrentRuntimeContract(db);
  const archive = db.prepare(`INSERT INTO storage_migration_archive
    (migration_version,family,record_key,payload,content) VALUES(35,?,?,?,?)`);
  for (const row of db.prepare("SELECT id,payload FROM projects").all() as { id: string; payload: string }[]) {
    const project = JSON.parse(row.payload);
    let changed = false;
    let plans = 0;
    const knowledge = project.knowledge.map((entry: { status: string; body: string }) => {
      if (entry.status !== "active") return entry;
      let value;
      try { value = JSON.parse(entry.body); } catch { return entry; }
      if (!value || typeof value !== "object" || value.kind !== "verification-plan") return entry;
      if (++plans > 1 || value.schemaVersion !== 1 || Object.hasOwn(value, "mode")) {
        throw new Error(`Invalid v34 verification configuration: ${row.id}. Preserve it for diagnosis.`);
      }
      readHistoricalVerificationPlan(value);
      const { l1: _retired, ...current } = value;
      changed = true;
      return { ...entry, body: JSON.stringify({ ...current, schemaVersion: 2 }) };
    });
    if (changed) {
      archive.run("project", row.id, row.payload, null);
      db.prepare("UPDATE projects SET payload=? WHERE id=?").run(JSON.stringify({ ...project, knowledge }), row.id);
    }
  }
  const artifacts = db.prepare("SELECT key,project_id,payload FROM gate_artifacts WHERE level='L1'")
    .all() as { key: string; project_id: string; payload: string }[];
  for (const row of artifacts) {
    const value = JSON.parse(row.payload);
    if (value.schemaVersion !== 1 || value.level !== "L1" || value.key !== row.key
      || value.projectId !== row.project_id || !/^[a-f0-9]{64}$/.test(row.key)
      || !["complete", "incomplete"].includes(value.status)
      || !["unknown", "succeeded", "failed"].includes(value.outcome)
      || (value.status === "incomplete") !== (value.outcome === "unknown")
      || !Array.isArray(value.steps)) {
      throw new Error(`Invalid retired L1 evidence: ${row.key}. Preserve it for diagnosis.`);
    }
    validateRetiredGate(value);
    archive.run("gate-artifact", row.key, row.payload, null);
    const logs = db.prepare("SELECT step_name,log_content,log_digest,log_bytes FROM gate_artifact_logs WHERE artifact_key=?")
      .all(row.key) as { step_name: string; log_content: Buffer; log_digest: string; log_bytes: number }[];
    for (const { log_content, ...metadata } of logs) {
      if (metadata.log_bytes !== log_content.length
        || metadata.log_digest !== createHash("sha256").update(log_content).digest("hex")) {
        throw new Error(`Corrupted retired L1 log: ${row.key}/${metadata.step_name}. Preserve it for diagnosis.`);
      }
      archive.run("gate-artifact-log", JSON.stringify([row.key, metadata.step_name]),
        JSON.stringify(metadata), log_content);
    }
    db.prepare("DELETE FROM gate_artifact_logs WHERE artifact_key=?").run(row.key);
    db.prepare("DELETE FROM gate_artifacts WHERE key=?").run(row.key);
  }
  const at = new Date().toISOString();
  for (const row of historicalIntegrations(db)) {
    const value = JSON.parse(row.payload);
    if (value.schemaVersion !== 6 || value.taskId !== row.task_id || value.id !== row.integration_id
      || !/^integration-[1-9][0-9]*$/.test(value.id)
      || !Array.isArray(value.source.changeSetIds) || value.source.changeSetIds.length === 0
      || value.source.changeSetIds.some((id: unknown) => typeof id !== "string" || !/^change-set-[1-9][0-9]*$/.test(id))
      || new Set(value.source.changeSetIds).size !== value.source.changeSetIds.length
      || !Array.isArray(value.checkCommands) || value.checkCommands.some((command: unknown) => !text(command))
      || typeof value.rerunChecks !== "boolean" || !text(value.projectId) || !text(value.targetRef)
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.beforeCommit)
      || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))
      || !Number.isFinite(Date.parse(value.endedAt))
      || (value.status === "committed" && (value.afterCommit !== value.candidateCommit
        || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.afterCommit) || !text(value.summary)))) {
      throw new Error(`Invalid historical Integration: ${row.task_id}/${row.integration_id}. Preserve it for diagnosis.`);
    }
    const sequence = (db.prepare(`SELECT max(
      coalesce((SELECT high_water FROM id_sequences WHERE task_id=? AND kind='event'),0),
      coalesce((SELECT max(CAST(substr(event_id,7) AS INTEGER)) FROM events WHERE task_id=?),0)
    ) AS value`).get(row.task_id, row.task_id) as { value: number }).value + 1;
    const event = { schemaVersion: 2, id: `event-${sequence}`, taskId: row.task_id,
      type: "integration.source-retired", createdAt: at,
      payload: { integrationId: row.integration_id, record: row.payload, disposition: "audit-only" } };
    db.prepare("INSERT INTO events(task_id,event_id,type,occurred_at,payload) VALUES(?,?,?,?,?)")
      .run(row.task_id, event.id, event.type, at, JSON.stringify(event));
    db.prepare(`INSERT INTO id_sequences(task_id,kind,high_water) VALUES(?,'event',?)
      ON CONFLICT(task_id,kind) DO UPDATE SET high_water=max(high_water,excluded.high_water)`).run(row.task_id, sequence);
    // Preserve the retired identity's high-water mark so it cannot be reused.
    const integrationSequence = Number(row.integration_id.slice("integration-".length));
    if (!Number.isSafeInteger(integrationSequence) || integrationSequence < 1) throw new Error("Invalid retired Integration identity.");
    db.prepare(`INSERT INTO id_sequences(task_id,kind,high_water) VALUES(?,'integrationAttempt',?)
      ON CONFLICT(task_id,kind) DO UPDATE SET high_water=max(high_water,excluded.high_water)`).run(row.task_id, integrationSequence);
    db.prepare("DELETE FROM integration_attempts WHERE task_id=? AND integration_id=?").run(row.task_id, row.integration_id);
  }
}

function historicalIntegrations(db: Database.Database) {
  return db.prepare(`SELECT task_id,integration_id,payload FROM integration_attempts
    WHERE json_extract(payload,'$.source.kind')='historical-change-sets' ORDER BY task_id,integration_id`)
    .all() as { task_id: string; integration_id: string; payload: string }[];
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

/** The retired v34 artifact shape, frozen here rather than accepted by current
 * GateArtifact readers. It is archived verbatim, never made into an L2 proof. */
function validateRetiredGate(value: any): void {
  requireIdentity(value.projectId, "Retired GateArtifact projectId");
  for (const field of ["key", "planDigest", "toolchainDigest"]) {
    if (typeof value[field] !== "string" || !/^[a-f0-9]{64}$/.test(value[field])) {
      throw new Error(`Invalid retired GateArtifact ${field}.`);
    }
  }
  const commit = (sha: unknown) => {
    if (typeof sha !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)) throw new Error("Invalid retired gate commit.");
  };
  commit(value.commit);
  if (value.boundary !== undefined) {
    requireText(value.boundary.targetRef, "Retired gate target");
    commit(value.boundary.baseHead);
  }
  const identity = { projectId: value.projectId, level: value.level, commit: value.commit,
    planDigest: value.planDigest, toolchainDigest: value.toolchainDigest,
    ...(value.boundary === undefined ? {} : { boundary: value.boundary }) };
  if (createHash("sha256").update(canonical(identity)).digest("hex") !== value.key) {
    throw new Error("Retired gate key does not match its original identity.");
  }
  const names = new Set<string>();
  for (const step of value.steps) {
    requireIdentity(step.name, "Retired gate step name");
    if (names.has(step.name)) throw new Error("Duplicate retired gate step.");
    names.add(step.name);
    requireText(step.command, "Retired gate command");
    if (!["passed", "failed", "skipped"].includes(step.outcome)) throw new Error("Invalid retired gate step outcome.");
    requirePositiveInteger(step.durationMs + 1, "Retired gate duration");
    requireText(step.logPath, "Retired gate log path");
    if (step.logPath.startsWith("/") || step.logPath.includes("..")
      || typeof step.logDigest !== "string" || !/^[a-f0-9]{64}$/.test(step.logDigest)
      || !Number.isSafeInteger(step.logBytes) || step.logBytes < 0) throw new Error("Invalid retired gate log metadata.");
  }
  if (Object.hasOwn(value, "potentialReuseCount")) throw new Error("Invalid v34 retired gate counter.");
  requirePositiveInteger(value.reuseCount + 1, "Retired gate reuse count");
  requireTimestamp(value.createdAt, "Retired gate createdAt");
  requireTimestamp(value.lastUsedAt, "Retired gate lastUsedAt");
  if (value.completedAt !== undefined) requireTimestamp(value.completedAt, "Retired gate completedAt");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
