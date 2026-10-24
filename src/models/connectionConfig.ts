import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import { editConnectionToml } from "./connectionToml.js";

export type CodexConnectionAuth = { type: "env"; envKey: string } | { type: "official" } | { type: "none" };
export type BridgeConnectionAuth = { type: "keyfile"; file: string } | { type: "none" };
export interface ConnectionConfigInput {
  codex?: {
    /** Only user-level config.toml is supported. Explicit path wins over CODEX_HOME. */
    configPath?: string;
    codexHome?: string;
    scope?: "user";
    provider?: { id: string; name: string; baseUrl: string; auth: CodexConnectionAuth };
    selectProvider?: string;
    /** Optional, separately explicit static catalog reference. No file is fetched. */
    catalogPath?: string;
  };
  bridge?: {
    configPath: string;
    host?: string;
    port?: number;
    /** Non-loopback exposes metabridge's inference listener; never implicit. */
    allowRemoteListen?: boolean;
    provider?: { path: string; name: string; via: "cpa" | "direct"; baseUrl: string; auth: BridgeConnectionAuth };
  };
}
export interface ConnectionFilePreview {
  path: string; beforeRevision: string; afterRevision: string; changed: boolean;
  /** Requested native fields only, never values or full configuration. */
  fields: string[];
}
export interface ConnectionConfigPlan {
  schemaVersion: 1;
  status: "preview";
  files: ConnectionFilePreview[];
  warnings: string[];
}
export interface ConnectionFileResult extends ConnectionFilePreview {
  status: "saved" | "unchanged" | "failed" | "unknown" | "skipped";
  code?: string;
  backupPath?: string;
  backupRevision?: string;
  cleanupPaths?: string[];
}
export interface ConnectionConfigResult {
  schemaVersion: 1;
  status: "saved" | "unchanged" | "partial" | "failed" | "unknown";
  files: ConnectionFileResult[];
  warnings: string[];
}
export interface ConnectionWriteOptions {
  /** Caller has excluded all other writers, including non-cooperating editors. */
  exclusive: true;
}
type Snapshot = { path: string; raw: string | null; mode: number; revision: string };
type Change = { before: Snapshot; after: string | null; mode: number; fields: string[] };
type JsonObject = Record<string, unknown>;
const plans = new WeakMap<ConnectionConfigPlan, Change[]>();
const limit = 2 * 1024 * 1024;
const builtins = new Set(["openai", "ollama", "lmstudio", "amazon-bedrock"]);

export class ConnectionConfigError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new ConnectionConfigError(code); }
function digest(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }
function revision(raw: string | null, mode: number): string {
  return raw === null ? "absent" : digest(`${mode}\0${raw}`);
}
function absolute(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/.test(path)) fail("ABSOLUTE_PATH_REQUIRED");
  return resolve(path);
}
function text(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && !/[\0\r\n]/.test(value);
}
function id(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail("INVALID_PROVIDER_ID");
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_CONFIG_OBJECT");
  return value as JsonObject;
}
function json(raw: string | null): JsonObject {
  if (raw === null) return {};
  try { return object(JSON.parse(raw)); } catch { return fail("INVALID_JSON_CONFIG"); }
}
function toml(raw: string): JsonObject {
  try { return parse(raw); } catch { return fail("INVALID_TOML_CONFIG"); }
}
function secureParent(path: string): void {
  const parent = dirname(path);
  const stat = lstatSync(parent);
  if (realpathSync(parent) !== parent || !stat.isDirectory()
    || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)) fail("UNSAFE_CONFIG_DIRECTORY");
}
function snapshot(path: string, privateOnly = false): Snapshot {
  path = absolute(path);
  secureParent(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, raw: null, mode: 0o600, revision: "absent" };
    return fail("UNSAFE_OR_UNREADABLE_FILE");
  }
  try {
    const stat = fstatSync(fd);
    // JSON escaping can expand a native snapshot by up to six times.
    const fileLimit = privateOnly ? limit * 8 : limit;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > fileLimit || !(stat.mode & 0o200)
      || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)
      || (privateOnly && (stat.mode & 0o077))) fail("UNSAFE_OR_UNREADABLE_FILE");
    const bytes = readFileSync(fd);
    const raw = bytes.toString("utf8");
    if (bytes.length > fileLimit) fail("FILE_TOO_LARGE");
    if (!Buffer.from(raw).equals(bytes)) fail("INVALID_UTF8_CONFIG");
    const mode = stat.mode & 0o777;
    return { path, raw, mode, revision: revision(raw, mode) };
  } finally { closeSync(fd); }
}
function safeSnapshot(path: string, privateOnly = false): Snapshot {
  try { return snapshot(path, privateOnly); }
  catch (error) {
    if (error instanceof ConnectionConfigError) throw error;
    return fail("UNSAFE_OR_UNREADABLE_FILE");
  }
}
function url(value: string): string {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash || !text(value)) fail("INVALID_ENDPOINT_URL");
    return value;
  } catch { return fail("INVALID_ENDPOINT_URL"); }
}
function editToml(raw: string, table: string[], changes: Record<string, string | boolean | undefined>): string {
  try { return editConnectionToml(raw, table, changes); }
  catch { return fail("UNSUPPORTED_TOML_EDIT"); }
}
function codexPath(input: NonNullable<ConnectionConfigInput["codex"]>, environment: NodeJS.ProcessEnv): string {
  if (input.scope !== undefined && input.scope !== "user") fail("USER_SCOPE_REQUIRED");
  const defaultHome = join(homedir(), ".codex");
  const home = input.configPath !== undefined && input.codexHome === undefined
    ? (environment.CODEX_HOME && isAbsolute(environment.CODEX_HOME) ? resolve(environment.CODEX_HOME) : defaultHome)
    : absolute(input.codexHome ?? environment.CODEX_HOME ?? defaultHome);
  const path = absolute(input.configPath ?? join(home, "config.toml"));
  if (basename(path) !== "config.toml") fail("USER_CONFIG_TOML_REQUIRED");
  // A noncanonical explicit path is permitted only outside an identifiable repo
  // project .codex layer. Never write a provider that Codex will ignore.
  if (basename(dirname(path)) === ".codex" && dirname(path) !== home) {
    let cursor = dirname(dirname(path));
    while (true) {
      try { lstatSync(join(cursor, ".git")); fail("PROJECT_CONFIG_UNSUPPORTED"); }
      catch (error) { if (error instanceof ConnectionConfigError) throw error; }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return path;
}
function preview(change: Change): ConnectionFilePreview {
  return { path: change.before.path, beforeRevision: change.before.revision,
    afterRevision: revision(change.after, change.mode),
    fields: [...change.fields],
    changed: change.before.raw !== change.after || change.before.mode !== change.mode };
}
function makePlan(changes: Change[], warnings: string[]): ConnectionConfigPlan {
  const plan: ConnectionConfigPlan = { schemaVersion: 1, status: "preview", files: changes.map(preview), warnings };
  // Freeze the public handle so callers cannot accidentally change target metadata.
  plan.files.forEach(file => { Object.freeze(file.fields); Object.freeze(file); });
  Object.freeze(plan.files);
  Object.freeze(plan.warnings);
  Object.freeze(plan);
  plans.set(plan, changes);
  return plan;
}

/** Read-only. No directory creation, locks, backup, credential read or network I/O. */
export function planConnectionConfig(input: ConnectionConfigInput, environment: NodeJS.ProcessEnv = process.env): ConnectionConfigPlan {
  const changes: Change[] = [];
  const warnings = [
    "Files only: no service, catalog refresh, authentication check or running-session change.",
    "Writes require exclusive ownership; cooperative locks cannot exclude external editors.",
  ];
  if (!input || (!input.codex && !input.bridge)) fail("EMPTY_CONNECTION_REQUEST");
  // Provider first, bridge reference next, Codex last; this is not a transaction.
  if (input.bridge) {
    const b = input.bridge;
    if (b.host === undefined && b.port === undefined && b.provider === undefined) fail("EMPTY_BRIDGE_REQUEST");
    const before = safeSnapshot(b.configPath);
    const value = json(before.raw);
    if (b.host !== undefined) {
      if (!text(b.host) || /[\s/\\]/.test(b.host)) fail("INVALID_LISTEN_HOST");
      if (!["localhost", "127.0.0.1", "::1"].includes(b.host) && b.allowRemoteListen !== true) fail("REMOTE_LISTEN_REQUIRES_OPT_IN");
      value.host = b.host;
    }
    if (b.port !== undefined) {
      if (!Number.isInteger(b.port) || b.port < 1 || b.port > 65535) fail("INVALID_LISTEN_PORT");
      value.port = b.port;
    }
    if (b.provider) {
      const p = b.provider;
      id(p.name);
      if (!["cpa", "direct"].includes(p.via)) fail("UNSUPPORTED_BRIDGE_ROUTE");
      if (value.backends !== undefined) fail("INLINE_BRIDGE_BACKENDS_UNSUPPORTED");
      if (value.providerFiles !== undefined && (!Array.isArray(value.providerFiles) || value.providerFiles.some(ref => !text(ref)))) fail("INVALID_PROVIDER_FILES");
      const providerBefore = safeSnapshot(p.path);
      if (providerBefore.path === before.path) fail("DUPLICATE_TARGET");
      const provider = json(providerBefore.raw);
      if (provider.name !== undefined && provider.name !== p.name) fail("BRIDGE_PROVIDER_NAME_CONFLICT");
      if (provider.protocol !== undefined && provider.protocol !== "responses") fail("UNSUPPORTED_BRIDGE_PROTOCOL");
      if (provider.sanitize || provider.webSearch) fail("BRIDGE_PROCESSING_POLICY_CONFLICT");
      if (provider.env_key !== undefined || provider.env_http_headers !== undefined
        || provider.http_headers !== undefined) fail("UNSUPPORTED_BRIDGE_AUTH");
      delete provider.base;
      Object.assign(provider, { name: p.name, via: p.via, base_url: url(p.baseUrl), wire_api: "responses", protocol: "responses" });
      provider.requestMode ??= "passthrough";
      provider.compaction ??= { mode: "passthrough" };
      if (p.auth?.type === "keyfile") {
        if (!text(p.auth.file)) fail("INVALID_KEYFILE_REFERENCE");
        provider.auth = { type: "keyfile", file: p.auth.file };
      } else if (p.auth?.type === "none") provider.auth = { type: "none" };
      else fail("UNSUPPORTED_BRIDGE_AUTH");
      // Credential material may already exist in native files; never expose it.
      const refs = (value.providerFiles ?? []) as string[];
      const resolveRef = (ref: string) => ref.startsWith("~/") ? join(homedir(), ref.slice(2)) : resolve(dirname(before.path), ref);
      if (new Set(refs.map(resolveRef)).size !== refs.length) fail("DUPLICATE_PROVIDER_REFERENCE");
      if (!refs.some(ref => resolveRef(ref) === providerBefore.path)) refs.push(relative(dirname(before.path), providerBefore.path).split(sep).join("/"));
      value.providerFiles = refs;
      const after = JSON.stringify(provider) === JSON.stringify(json(providerBefore.raw)) ? providerBefore.raw : `${JSON.stringify(provider, null, 2)}\n`;
      changes.push({ before: providerBefore, after, mode: providerBefore.raw === null ? 0o600 : providerBefore.mode,
        fields: ["name", "via", "base_url", "wire_api", "protocol", "requestMode", "compaction", "auth"] });
    }
    const after = JSON.stringify(value) === JSON.stringify(json(before.raw)) ? before.raw : `${JSON.stringify(value, null, 2)}\n`;
    changes.push({ before, after, mode: before.mode,
      fields: [...(b.host !== undefined ? ["host"] : []), ...(b.port !== undefined ? ["port"] : []),
        ...(b.provider ? ["providerFiles"] : [])] });
    warnings.push("metabridge saved files are not applied by this tool; MB_HOST/MB_PORT can override file settings.");
  }
  if (input.codex) {
    const c = input.codex;
    if (!c.provider && c.selectProvider === undefined && c.catalogPath === undefined) fail("EMPTY_CODEX_REQUEST");
    const before = safeSnapshot(codexPath(c, environment));
    let raw = before.raw ?? "";
    if (c.provider) {
      const p = c.provider;
      id(p.id);
      if (builtins.has(p.id)) fail("RESERVED_CODEX_PROVIDER");
      if (!text(p.name)) fail("INVALID_PROVIDER_NAME");
      const providers = toml(raw).model_providers;
      const old = providers === undefined ? {} : object(providers);
      const provider = old[p.id] === undefined ? {} : object(old[p.id]);
      if (provider.auth !== undefined || provider.experimental_bearer_token !== undefined
        || provider.http_headers !== undefined || provider.env_http_headers !== undefined) fail("CODEX_AUTH_REQUIRES_NATIVE_EDIT");
      const fields: Record<string, string | boolean | undefined> = { name: p.name, base_url: url(p.baseUrl), wire_api: "responses" };
      if (p.auth?.type === "env") {
        if (typeof p.auth.envKey !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.auth.envKey)) fail("INVALID_ENV_KEY_REFERENCE");
        fields.env_key = p.auth.envKey;
        fields.requires_openai_auth = false;
      } else if (p.auth?.type === "official" || p.auth?.type === "none") {
        fields.env_key = undefined;
        fields.requires_openai_auth = p.auth.type === "official";
      } else fail("UNSUPPORTED_CODEX_AUTH");
      raw = editToml(raw, ["model_providers", p.id], fields);
    }
    if (c.selectProvider !== undefined) {
      id(c.selectProvider);
      const providers = toml(raw).model_providers;
      if (!builtins.has(c.selectProvider) && (!providers || !Object.hasOwn(providers, c.selectProvider))) fail("UNKNOWN_CODEX_PROVIDER");
      raw = editToml(raw, [], { model_provider: c.selectProvider });
    }
    if (c.catalogPath !== undefined) raw = editToml(raw, [], { model_catalog_json: absolute(c.catalogPath) });
    changes.push({ before, after: raw, mode: before.mode, fields: [
      ...(c.provider ? [`model_providers.${c.provider.id}.{name,base_url,wire_api,env_key,requires_openai_auth}`] : []),
      ...(c.selectProvider !== undefined ? ["model_provider (explicit default selection)"] : []),
      ...(c.catalogPath !== undefined ? ["model_catalog_json (explicit local reference)"] : []),
    ] });
    warnings.push("Codex user config only. CLI, profile and managed policy may override it; no effective-session claim.");
  }
  if (new Set(changes.map(change => change.before.path)).size !== changes.length) fail("DUPLICATE_TARGET");
  return makePlan(changes, warnings);
}

function errorCode(error: unknown): string {
  return error instanceof ConnectionConfigError ? error.code : "FILESYSTEM_OPERATION_FAILED";
}
function result(files: ConnectionFileResult[], warnings: string[]): ConnectionConfigResult {
  const status = files.some(file => file.status === "unknown") ? "unknown"
    : files.some(file => file.status === "failed" || file.status === "skipped")
      ? files.some(file => file.status === "saved") ? "partial" : "failed"
      : files.some(file => file.status === "saved") ? "saved" : "unchanged";
  return { schemaVersion: 1, status, files, warnings: [...warnings] };
}
function assertCurrent(before: Snapshot): void {
  if (safeSnapshot(before.path).revision !== before.revision) fail("REVISION_CONFLICT");
}
function writePrivate(path: string, raw: string, mode = 0o600): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { fchmodSync(fd, mode); writeFileSync(fd, raw, "utf8"); fsyncSync(fd); }
  catch (error) {
    try { unlinkSync(path); } catch { /* retain the owned path for inspection */ }
    throw error;
  } finally { closeSync(fd); }
}

/** No retries or cross-file rollback. Public result contains no native contents. */
export function applyConnectionConfig(plan: ConnectionConfigPlan, options: ConnectionWriteOptions): ConnectionConfigResult {
  const changes = plans.get(plan);
  if (!changes) fail("PLAN_HANDLE_REQUIRED");
  if (options?.exclusive !== true) fail("EXCLUSIVE_WRITER_REQUIRED");
  const files: ConnectionFileResult[] = changes.map(change => ({ ...preview(change), status: "skipped" }));
  const locks: string[] = [];
  let failedIndex = 0;
  try {
    // Hold all cooperative locks before preflight. No waiting, stealing, or retries.
    for (const change of [...changes].sort((a, b) => a.before.path.localeCompare(b.before.path))) {
      failedIndex = changes.indexOf(change);
      secureParent(change.before.path);
      const lock = `${change.before.path}.connection.lock`;
      try { writePrivate(lock, `${process.pid}\n`); } catch { fail("CONFIG_LOCK_UNAVAILABLE"); }
      locks.push(lock);
    }
    for (const [index, change] of changes.entries()) {
      failedIndex = index;
      assertCurrent(change.before);
    }
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i], file = files[i];
      if (!file.changed) { file.status = "unchanged"; continue; }
      let temporary: string | undefined;
      let mutationStarted = false;
      try {
        assertCurrent(change.before);
        const backupPath = join(dirname(change.before.path), `.connection-backup-${randomUUID()}.json`);
        const backup = `${JSON.stringify({ schemaVersion: 1, target: change.before.path,
          before: change.before.raw, beforeMode: change.before.mode, beforeRevision: change.before.revision,
          afterRevision: file.afterRevision })}\n`;
        file.backupPath = backupPath;
        file.backupRevision = digest(backup);
        writePrivate(backupPath, backup);
        if (change.after !== null) {
          temporary = join(dirname(change.before.path), `.connection-${randomUUID()}.tmp`);
          writePrivate(temporary, change.after, change.mode);
        }
        assertCurrent(change.before);
        mutationStarted = true;
        if (temporary) { renameSync(temporary, change.before.path); temporary = undefined; }
        else unlinkSync(change.before.path);
        const directoryFd = openSync(dirname(change.before.path), constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
        if (safeSnapshot(change.before.path).revision !== file.afterRevision) fail("WRITE_READBACK_MISMATCH");
        file.status = "saved";
      } catch (error) {
        // A filesystem error after entering the mutation boundary is uncertain,
        // not proof that the old bytes survived. Caller must inspect, never replay.
        file.status = mutationStarted ? "unknown" : "failed";
        file.code = errorCode(error);
        break;
      } finally {
        if (temporary) {
          try { unlinkSync(temporary); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") file.cleanupPaths = [temporary];
          }
        }
      }
    }
  } catch (error) {
    const target = files[failedIndex];
    if (target) { target.status = "failed"; target.code = errorCode(error); }
  } finally {
    for (const lock of locks.reverse()) {
      try { unlinkSync(lock); }
      catch { /* reported below without mutating the plan */ }
    }
  }
  const warnings = [...plan.warnings];
  for (const file of files) {
    for (const path of file.cleanupPaths ?? []) warnings.push(`Owned temporary remains unverified: ${path}`);
  }
  for (const lock of locks) {
    try { lstatSync(lock); warnings.push(`Owned lock remains: ${lock}`); } catch { /* absent */ }
  }
  return result(files, warnings);
}

/** Restore exact saved files only, guarded by their write-after revisions.
 * Backups are retained and may contain credentials. Partial/unknown results
 * require inspection; only confirmed saved members may be restored.
 */
export function restoreConnectionConfig(receipt: ConnectionConfigResult, options: ConnectionWriteOptions): ConnectionConfigResult {
  if (receipt?.schemaVersion !== 1 || !Array.isArray(receipt.files)) fail("INVALID_RESTORE_RECEIPT");
  const changes: Change[] = [];
  for (const file of [...receipt.files].reverse()) {
    if (file.status !== "saved") continue;
    if (!file.backupPath || !file.backupRevision) fail("MISSING_BACKUP_RECEIPT");
    const backup = safeSnapshot(file.backupPath, true);
    if (backup.raw === null || digest(backup.raw) !== file.backupRevision) fail("BACKUP_REVISION_CONFLICT");
    const value = json(backup.raw);
    if (value.schemaVersion !== 1 || value.target !== file.path || value.afterRevision !== file.afterRevision
      || value.beforeRevision !== file.beforeRevision
      || !(value.before === null || typeof value.before === "string")
      || !Number.isInteger(value.beforeMode) || (value.beforeMode as number) < 0 || (value.beforeMode as number) > 0o777
      || revision(value.before as string | null, value.beforeMode as number) !== value.beforeRevision) fail("INVALID_BACKUP");
    const current = safeSnapshot(file.path);
    // Preserve the expected after revision, so apply performs normal all-file
    // conflict preflight rather than silently restoring over a later edit.
    changes.push({ before: { ...current, revision: file.afterRevision }, after: value.before as string | null,
      mode: value.beforeMode as number, fields: ["restore exact file snapshot"] });
  }
  if (!changes.length) fail("NO_CONFIRMED_FILES_TO_RESTORE");
  if (new Set(changes.map(change => change.before.path)).size !== changes.length) fail("DUPLICATE_TARGET");
  return applyConnectionConfig(makePlan(changes, ["Restore is file-only, revision-guarded; native backups are retained."]), options);
}
