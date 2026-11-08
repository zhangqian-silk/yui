import { createHash } from "node:crypto";
import { resolve, isAbsolute, relative, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";
import Database from "../sqlite/driver.js";
import { readHomeFilesystemId } from "../core/homeFilesystemIdentity.js";
import { CONFIG_DEFINITIONS } from "../config/configCatalog.js";
import { validateHomeId, validateHomeIdentity, type HomeIdentity } from "../repository/homeIdentity.js";
import { validateYuiConfig, type YuiConfig } from "./taskStore.js";
import { validateStoredRecord } from "./recordValidation.js";
import { inspectSqliteSchema, validateSqliteSchema, storageMinorUpgradePlan } from "./sqliteSchema.js";

export type HomeRepairRequest =
  | { kind: "config"; patch: unknown }
  | { kind: "identity"; backup: string };

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object; cannot reconstruct missing or unparseable data.");
  }
  return value as Record<string, unknown>;
}
function parse(raw: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Control record is invalid JSON; scoped repair cannot reconstruct it."); }
  return object(value);
}
function check(action: () => unknown) {
  try { action(); return { status: "ok" as const }; }
  catch (error) {
    return { status: "invalid" as const, error: error instanceof Error ? error.message : String(error) };
  }
}
function readState(db: Database.Database) {
  const meta = db.prepare("SELECT home_identity,revision FROM home_meta WHERE id=1").get() as
    { home_identity: string; revision: number } | undefined;
  const config = db.prepare("SELECT payload FROM config WHERE id=1").get() as { payload: string } | undefined;
  return { meta, config };
}

/** Read-only diagnostics deliberately bypass the ordinary strict singleton loader. */
export function inspectHomeRepair(db: Database.Database) {
  validateSqliteSchema(db);
  const state = readState(db);
  return {
    revision: check(() => {
      if (!state.meta || !Number.isSafeInteger(state.meta.revision) || state.meta.revision < 0) {
        throw new Error("Home revision is missing or invalid; scoped repair cannot reconstruct it.");
      }
    }),
    integrity: check(() => {
      if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("SQLite integrity check failed.");
    }),
    identity: check(() => {
      if (!state.meta) throw new Error("Home metadata row is missing; no identity will be generated.");
      validateHomeIdentity(parse(state.meta.home_identity) as HomeIdentity);
    }),
    config: check(() => {
      if (!state.config) throw new Error("Configuration row is missing; no defaults will be inserted.");
      validateYuiConfig(parse(state.config.payload) as YuiConfig);
    }),
    supported: {
      config: "Patch named fields in an existing JSON object; the complete result must validate.",
      identity: "Restore invalid identity metadata from a supplied database backup with the same surviving homeId.",
      configProperties: CONFIG_DEFINITIONS.map(({ key, property, domain }) => ({ key, property, domain }))
    }
  };
}

function configCandidate(db: Database.Database, home: string, raw: string, input: unknown): string {
  const current = parse(raw);
  if (check(() => validateYuiConfig(current as YuiConfig)).status === "ok") {
    throw new Error("Configuration is already valid; use ordinary config set/clear.");
  }
  const patch = object(input);
  if (Object.keys(patch).some(key => !["set", "remove"].includes(key))) throw new Error("Patch accepts only set and remove.");
  const set = patch.set === undefined ? {} : object(patch.set);
  const remove = patch.remove ?? [];
  if (!Array.isArray(remove) || remove.some(key => typeof key !== "string")
    || new Set(remove).size !== remove.length) throw new Error("remove must contain unique field names.");
  const writable = new Set<string>(CONFIG_DEFINITIONS.map(item => item.property));
  if (Object.keys(set).some(key => !writable.has(key))) throw new Error("set accepts only public configuration properties.");
  if (remove.includes("schemaVersion") || remove.some(key => Object.hasOwn(set, key))) {
    throw new Error("Cannot remove schemaVersion or both set and remove the same field.");
  }
  if (Object.keys(set).length + remove.length === 0) throw new Error("Patch must name at least one field.");
  const next = { ...current, ...set };
  for (const key of remove) {
    if (!Object.hasOwn(current, key)) throw new Error(`Cannot remove absent configuration field: ${key}.`);
    delete next[key];
  }
  validateYuiConfig(next as YuiConfig);
  // Preserve the reference/path checks of ordinary configuration commands.
  if (Object.hasOwn(set, "defaultAgent")) {
    if (typeof next.defaultAgent !== "string") throw new Error("defaultAgent must name a configured Agent.");
    const row = db.prepare("SELECT payload FROM configured_agents WHERE id=?").get(next.defaultAgent) as { payload: string } | undefined;
    if (!row) throw new Error("defaultAgent does not name a configured Agent.");
    validateStoredRecord("configured_agents", JSON.parse(row.payload));
  }
  if (Object.hasOwn(set, "defaultWorkspace")
    && (typeof next.defaultWorkspace !== "string" || !isAbsolute(next.defaultWorkspace))) {
    throw new Error("defaultWorkspace must be an absolute path.");
  }
  if (Object.hasOwn(set, "defaultWorkspace")) {
    const workspace = realpathSync(next.defaultWorkspace as string);
    if (!statSync(workspace).isDirectory()) throw new Error("defaultWorkspace must be an existing directory.");
    const fromHome = relative(realpathSync(home), workspace);
    if (fromHome === "" || (fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome))) {
      throw new Error("defaultWorkspace must be outside YUI_HOME.");
    }
    next.defaultWorkspace = workspace;
  }
  if (Object.hasOwn(set, "review")) {
    const roleName = object(next.review).roleName;
    const row = db.prepare("SELECT payload FROM global_roles WHERE name=?").get(roleName) as { payload: string } | undefined;
    if (!row) throw new Error("review must name a configured global Role.");
    validateStoredRecord("global_roles", JSON.parse(row.payload));
  }
  return JSON.stringify(next);
}

function identityCandidate(raw: string, backup: string): string {
  const current = parse(raw);
  validateHomeId(current.homeId as string);
  if (check(() => validateHomeIdentity(current as HomeIdentity)).status === "ok") {
    throw new Error("Home identity is already valid; replacing it is not a repair.");
  }
  const source = new Database(backup, { readonly: true, fileMustExist: true });
  try {
    const schema = inspectSqliteSchema(source);
    if (storageMinorUpgradePlan(schema.currentVersion) === null) throw new Error("Unsupported identity backup.");
    const row = source.prepare("SELECT home_identity FROM home_meta WHERE id=1").get() as { home_identity: string } | undefined;
    if (!row) throw new Error("Backup has no Home identity.");
    const identity = validateHomeIdentity(parse(row.home_identity) as HomeIdentity);
    if (identity.homeId !== current.homeId) throw new Error("Backup Home identity does not match the surviving homeId.");
    // A valid surviving field is evidence, not something to overwrite from a stale copy.
    for (const key of ["createdAt", "entropy"] as const) {
      const value = current[key];
      const valid = typeof value === "string" && (key === "entropy"
        ? /^[a-f0-9]{32}$/.test(value) : Number.isFinite(Date.parse(value)));
      if (valid && value !== identity[key]) throw new Error(`Backup conflicts with surviving identity ${key}.`);
    }
    return JSON.stringify(identity);
  } finally { source.close(); }
}

/** Caller owns maintenance/startup fences for apply. One SQL transaction protects
 * the preview guard, field update and revision; no task/history rows are touched. */
export function repairHomeRecord(
  db: Database.Database, home: string, request: HomeRepairRequest, expectedDigest?: string
) {
  validateSqliteSchema(db);
  const state = readState(db);
  if (!state.meta || !state.config || !Number.isSafeInteger(state.meta.revision)
    || !Number.isSafeInteger(state.meta.revision + 1) || state.meta.revision < 0) {
    throw new Error("Required Home singleton/revision is missing or invalid; scoped repair cannot reconstruct it.");
  }
  if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("SQLite integrity check failed; repair refused.");
  const raw = request.kind === "config" ? state.config.payload : state.meta.home_identity;
  const candidate = request.kind === "config"
    ? configCandidate(db, home, raw, request.patch) : identityCandidate(raw, request.backup);
  const digest = createHash("sha256").update(JSON.stringify({
    home: resolve(home), filesystem: readHomeFilesystemId(home), state,
    kind: request.kind, candidate
  })).digest("hex");
  const before = object(JSON.parse(raw));
  const after = object(JSON.parse(candidate));
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort();
  if (expectedDigest !== undefined) {
    if (expectedDigest !== digest) throw new Error("Repair preview digest changed; inspect and preview again.");
    const now = new Date().toISOString();
    if (request.kind === "config") db.prepare("UPDATE config SET payload=?,updated_at=? WHERE id=1").run(candidate, now);
    else db.prepare("UPDATE home_meta SET home_identity=? WHERE id=1").run(candidate);
    db.prepare("UPDATE home_meta SET revision=revision+1,updated_at=? WHERE id=1").run(now);
  }
  return {
    effect: expectedDigest === undefined ? "preview" : "applied",
    kind: request.kind, digest, fields,
    note: "Scoped control-field repair only. No automatic backup, history reconstruction, Controller start or identity generation."
  };
}
