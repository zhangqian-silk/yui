import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { TaskStore } from "../storage/taskStore.js";
import { webLocalMutation, WebRequestRejected } from "../web/webMutation.js";
import { modelFields, modelObject, modelUrl, validateModelConnection } from "./modelManagementConfig.js";
import { modelDigest, modelJsonFile, modelKey, newModelFile, replaceModelFile, type ModelFile } from "./modelManagementFiles.js";
import { readModelJson } from "./modelManagementHttp.js";
import type { ModelCatalogItem, ModelManagementView, ModelObservation, ModelProviderView, ModelQuotaItem } from "./modelManagementTypes.js";

type Store = Pick<TaskStore, "getConfig" | "saveConfig" | "transaction">;
type Provider = { file: ModelFile; value: Record<string, unknown>; id: string };
const NOTICE = "Configuration is owned by metabridge. Saved does not mean applied: reload through your existing deployment flow if needed, then refresh the catalog. No Session, account or model is switched; inference is not validated.";
const empty = <T>(): ModelObservation<T> => ({
  status: "not-queried", attemptedAt: null, observedAt: null, stale: false, error: null, items: []
});

export function createModelManagement(store: Store, options: {
  request?: typeof readModelJson; now?: () => Date;
} = {}) {
  const request = options.request ?? readModelJson;
  const now = options.now ?? (() => new Date());
  let catalog = empty<ModelCatalogItem>();
  const quotas = { factory: empty<ModelQuotaItem>(), "command-code": empty<ModelQuotaItem>() };
  let cacheRevision = "";
  const pending = new Map<string, Promise<unknown>>();

  function snapshot() {
    const connection = store.getConfig().modelManagement ?? null;
    let root: ModelFile | undefined;
    let providers: Provider[] = [];
    let configurationError: string | null = null;
    try {
      if (connection?.bridgeConfigFile) {
        root = modelJsonFile(connection.bridgeConfigFile);
        if (root.value.providerFiles !== undefined && root.value.backends !== undefined) throw new Error();
        if (root.value.providerFiles !== undefined) {
          if (!Array.isArray(root.value.providerFiles) || !root.value.providerFiles.length || root.value.providerFiles.length > 100) throw new Error();
          const seen = new Set<string>();
          let bytes = Buffer.byteLength(root.raw);
          providers = root.value.providerFiles.map((path: unknown) => {
            if (typeof path !== "string") throw new Error();
            const filename = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(dirname(root!.path), path);
            if (seen.has(filename)) throw new Error();
            seen.add(filename);
            const file = modelJsonFile(filename);
            bytes += Buffer.byteLength(file.raw);
            if (bytes > 2 * 1024 * 1024) throw new Error();
            return { file, value: file.value, id: modelDigest(filename) };
          });
          if (new Set(providers.map(p => p.value.name)).size !== providers.length) throw new Error();
        } else {
          const backends = root.value.backends ?? [];
          if (!Array.isArray(backends) || backends.length > 100) throw new Error();
          const names = new Set<string>();
          providers = backends.map((value: unknown, index: number) => {
            const row = modelObject(value);
            const name = typeof row.name === "string" ? row.name : String(index);
            if (names.has(name)) throw new Error();
            names.add(name);
            return { file: root!, value: row, id: modelDigest([root!.path, name]) };
          });
        }
      }
    } catch {
      configurationError = "Bridge configuration is unavailable, ambiguous or unsupported. No configuration was changed.";
      providers = [];
    }
    const revision = modelDigest([connection, root?.raw ?? null, providers.map(p => [p.id, p.file.raw]), configurationError]);
    if (revision !== cacheRevision) {
      catalog = empty();
      quotas.factory = empty();
      quotas["command-code"] = empty();
      cacheRevision = revision;
    }
    return { connection, root, providers, configurationError, revision };
  }

  function read(): ModelManagementView {
    const state = snapshot();
    return {
      revision: state.revision, connection: state.connection, providers: state.providers.map(providerView),
      configurationError: state.configurationError, application: "unverified", notice: NOTICE
    };
  }

  function checkRevision(body: Record<string, unknown>) {
    const state = snapshot();
    if (typeof body.revision !== "string" || body.revision !== state.revision) {
      throw new WebRequestRejected("Model configuration changed; read it again before submitting.");
    }
    return state;
  }

  function saveConnection(input: unknown): ModelManagementView {
    const body = modelObject(input);
    modelFields(body, ["revision", "connection"]);
    const state = checkRevision(body);
    const connection = body.connection === null ? null : validateModelConnection(body.connection);
    // No external I/O inside the store transaction.
    webLocalMutation(store as TaskStore, tx => {
      if (modelDigest(tx.getConfig().modelManagement ?? null) !== modelDigest(state.connection)) {
        throw new WebRequestRejected("Connection changed; read it again.");
      }
      const config = { ...tx.getConfig() };
      if (connection) config.modelManagement = connection;
      else delete config.modelManagement;
      tx.saveConfig(config);
    });
    return read();
  }

  function saveProvider(input: unknown): ModelManagementView {
    const body = modelObject(input);
    modelFields(body, ["revision", "operation", "provider", "id"]);
    const state = checkRevision(body);
    if (!state.root || state.configurationError) throw new WebRequestRejected("Select a readable local bridge configuration first.");
    const removing = body.operation === "remove";
    if (!removing && body.operation !== "save") throw new WebRequestRejected("Unknown provider operation.");
    const draft = removing ? null : modelObject(body.provider);
    if (draft) modelFields(draft, ["id", "name", "via", "baseUrl", "prefix", "enabled", "apiKey"]);
    const id = removing ? body.id : draft!.id;
    const target = id === undefined ? undefined : state.providers.find(p => p.id === id);
    if (id !== undefined && !target) throw new WebRequestRejected("Provider identity changed; read it again.");
    if (target && !providerView(target).editable) throw new WebRequestRejected("This provider is read-only.");
    if (removing && !target) throw new WebRequestRejected("Select the exact provider to remove.");
    if (!removing && !target && state.providers.length >= 100) throw new WebRequestRejected("Provider limit reached.");
    let value: Record<string, unknown> | undefined;
    if (draft) {
      if (typeof draft.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(draft.name)
        || typeof draft.prefix !== "string" || !/^[a-zA-Z0-9_-]{1,64}\/$/.test(draft.prefix)
        || !["direct", "cpa"].includes(String(draft.via)) || typeof draft.baseUrl !== "string"
        || typeof draft.enabled !== "boolean"
        || (draft.apiKey !== undefined && (typeof draft.apiKey !== "string" || draft.apiKey.length > 8192 || /[\0\r\n]/.test(draft.apiKey)))) {
        throw new WebRequestRejected("Expected a name, unique namespace ending in /, direct/cpa route, URL, enabled flag and optional API key.");
      }
      modelUrl(draft.baseUrl);
      if (state.providers.some(p => p !== target && (p.value.name === draft.name || p.value.prefix === draft.prefix))) {
        throw new WebRequestRejected("Provider name or model namespace already exists.");
      }
      const key = typeof draft.apiKey === "string" ? draft.apiKey.trim() : "";
      if (!target && !key) throw new WebRequestRejected("A new API-key connection requires a key.");
      if (target && draft.baseUrl !== (target.value.base_url ?? target.value.base) && !key) {
        throw new WebRequestRejected("Changing the credential destination requires a newly supplied key.");
      }
      value = { ...(target?.value ?? {
        wire_api: "responses", protocol: "responses", requestMode: "passthrough",
        compaction: { mode: "passthrough" }, catalog: { source: "remote" }, priority: 50
      }), name: draft.name, via: draft.via, prefix: draft.prefix, enabled: draft.enabled };
      // metabridge's base prepends /v1; base_url is already a complete API root.
      // Keep the existing spelling even when the address is intentionally edited.
      value[target?.value.base !== undefined ? "base" : "base_url"] = draft.baseUrl;
      if (key) {
        const auth = target?.value.auth as Record<string, unknown> | undefined;
        value.auth = auth && ["static", "gateway"].includes(String(auth.type))
          ? { ...auth, key } : { type: "static", key };
      }
    }
    const backends = state.providers.filter(p => p !== target).map(p => p.value);
    if (!removing) backends.push(value!);
    if (!backends.some(p => p.enabled !== false)) {
      throw new WebRequestRejected("Keep at least one enabled backend before saving.");
    }
    // Existing cross-provider web search references must still resolve. Do not
    // rewrite references or silently select another provider on the user's behalf.
    for (const provider of backends) {
      const search = provider.webSearch;
      if (!search || typeof search !== "object" || Array.isArray(search)) continue;
      const destination = backends.find(p => p.name === (search as Record<string, unknown>).backend);
      if (!destination || (provider.enabled !== false && destination.enabled === false)) {
        throw new WebRequestRejected("This change would break a webSearch backend reference; manage the reference with its owner first.");
      }
    }
    // External files never participate in Yui's DB transaction. Synchronous CAS
    // detects observed edits; metabridge has no cross-writer locking protocol.
    checkRevision(body);
    const root = state.root;
    if (root.value.providerFiles !== undefined) {
      if (target && !removing) replaceModelFile(target.file, value);
      else {
        const files = [...root.value.providerFiles as string[]];
        if (target) files.splice(state.providers.indexOf(target), 1);
        else files.push(newModelFile(dirname(root.path), draft!.name as string, value));
        // A failed root replacement can leave a private unreferenced file;
        // never delete a file whose adoption by another writer is unknown.
        try { replaceModelFile(root, { ...root.value, providerFiles: files }); }
        catch (error) {
          if (!target) throw new Error("Provider file created but bridge reference update was not confirmed; inspect retained private files before retrying.", { cause: error });
          throw error;
        }
      }
    } else {
      const backends = state.providers.map(p => p.value);
      if (target) {
        if (removing) backends.splice(state.providers.indexOf(target), 1);
        else backends[state.providers.indexOf(target)] = value!;
      } else backends.push(value!);
      replaceModelFile(root, { ...root.value, backends });
    }
    const view = read();
    if (removing) view.notice = `Provider unlinked. Referenced files and credentials were retained; no service was stopped. ${NOTICE}`;
    return view;
  }

  function current<T>(value: ModelObservation<T>): ModelObservation<T> {
    return { ...value, stale: value.observedAt !== null && now().getTime() - Date.parse(value.observedAt) > 60_000 };
  }
  function readCatalog(cursor = "0") {
    snapshot();
    if (!/^\d{1,5}$/.test(cursor) || Number(cursor) > 2000) throw new WebRequestRejected("Invalid catalog cursor.");
    const offset = Number(cursor);
    return { ...current(catalog), items: catalog.items.slice(offset, offset + 100), total: catalog.items.length,
      nextCursor: offset + 100 < catalog.items.length ? String(offset + 100) : null };
  }
  function readQuota(source: string) {
    snapshot();
    if (source !== "factory" && source !== "command-code") throw new WebRequestRejected("Unsupported quota source.");
    return current(quotas[source]);
  }
  async function refresh(input: unknown): Promise<unknown> {
    const body = modelObject(input);
    modelFields(body, ["revision", "kind", "source"]);
    const state = checkRevision(body);
    if (!state.connection) throw new WebRequestRejected("Configure a metabridge connection first.");
    const kind = body.kind;
    const source = body.source;
    if (kind !== "catalog" && kind !== "quota" || kind === "catalog" && source !== undefined
      || kind === "quota" && source !== "factory" && source !== "command-code") {
      throw new WebRequestRejected("Unsupported observation.");
    }
    const identity = `${state.revision}/${kind}/${source ?? ""}`;
    const active = pending.get(identity);
    if (active) return active;
    if (pending.size >= 4) throw new WebRequestRejected("Observation capacity reached; wait for the current request.");
    const operation = (async () => {
      const attemptedAt = now().toISOString();
      let observation: ModelObservation<ModelCatalogItem> | ModelObservation<ModelQuotaItem>;
      try {
        const c = state.connection!;
        if (kind === "catalog") {
          const raw = modelObject(await request(c.bridgeUrl, "/v1/models", modelKey(c.catalogKeyFile), 8_000));
          if (!Array.isArray(raw.data) || raw.data.length > 2000) throw new Error("invalid-or-oversize-catalog");
          const items = raw.data.map(item => {
            const row = modelObject(item);
            if (typeof row.id !== "string" || !row.id || row.id.length > 2048) throw new Error("invalid-catalog");
            return { id: row.id, source: row.id.includes("/") ? row.id.split("/")[0]! : "metabridge" };
          });
          observation = { status: "success", items, attemptedAt, observedAt: now().toISOString(), stale: false, error: null };
        } else {
          if (!c.cpaUrl || !c.managementKeyFile) throw new Error("quota-not-configured");
          const suffix = source === "factory" ? "accounts" : "command-code";
          const raw = await request(c.cpaUrl, `/v0/management/plugins/factory-quota/${suffix}`, modelKey(c.managementKeyFile), 30_000);
          const items = normalizeQuota(source as "factory" | "command-code", raw);
          observation = { status: items.some(item => item.status !== "success") ? "partial" : "success",
            items, attemptedAt, observedAt: now().toISOString(), stale: false, error: null };
        }
      } catch (error) {
        const code = error instanceof Error && /^[a-z-]{1,64}$/.test(error.message) ? error.message : "observation-unavailable";
        observation = { status: "failed", items: [], attemptedAt, observedAt: null, stale: false, error: code };
      }
      if (snapshot().revision !== state.revision) throw new WebRequestRejected("Connection changed during observation; result discarded.");
      if (kind === "catalog") {
        catalog = observation as ModelObservation<ModelCatalogItem>;
        return readCatalog();
      }
      quotas[source as "factory" | "command-code"] = observation as ModelObservation<ModelQuotaItem>;
      return readQuota(source as string);
    })();
    pending.set(identity, operation);
    try { return await operation; } finally { pending.delete(identity); }
  }
  return { read, saveConnection, saveProvider, readCatalog, readQuota, refresh };
}

function providerView(provider: Provider): ModelProviderView {
  const p = provider.value;
  const auth = p.auth && typeof p.auth === "object" ? p.auth as Record<string, unknown> : {};
  const editable = (p.protocol ?? "responses") === "responses"
    // Declaring via on an implicit chain changes metabridge's request and
    // compaction defaults. This editor does not migrate those policies.
    && (p.via === "direct" || p.via === "cpa")
    && ["static", "keyfile", "gateway"].includes(String(auth.type))
    && typeof p.prefix === "string" && /^[a-zA-Z0-9_-]{1,64}\/$/.test(p.prefix)
    && p.routeModels === undefined && p.http_headers === undefined;
  return {
    id: provider.id, name: safeText(p.name, 128) ?? "unnamed",
    via: p.via === "direct" || p.via === "cpa" ? p.via : "unknown",
    baseUrl: safeUrl(p.base_url ?? p.base), prefix: safeText(p.prefix, 128) ?? "",
    enabled: p.enabled !== false, editable, reason: editable ? null : "Official, implicit-policy, shared-route or unsupported provider; manage with its existing owner.",
    credentialPresent: typeof auth.key === "string" && !!auth.key || typeof auth.file === "string" && !!auth.file,
    owner: "metabridge"
  };
}
function safeUrl(value: unknown): string {
  try { return modelUrl(typeof value === "string" ? value : "").toString().replace(/\/$/, ""); }
  catch { return ""; }
}
function safeText(value: unknown, limit = 128): string | null {
  return typeof value === "string" && value.length <= limit && !/[\0\r\n]/.test(value) ? value : null;
}
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function time(value: unknown): string | null {
  return typeof value === "string" && value.length < 64 && Number.isFinite(Date.parse(value)) ? value : null;
}
function windowView(value: unknown, label: string) {
  const row = modelObject(value);
  const remaining = finite(row.remainingFraction);
  return { label, remainingFraction: remaining !== null && remaining <= 1 ? remaining : null,
    used: finite(row.used), cap: finite(row.cap), resetTime: time(row.resetTime) };
}
function normalizeQuota(source: "factory" | "command-code", value: unknown): ModelQuotaItem[] {
  const raw = modelObject(value);
  if (source === "command-code") {
    if (!Array.isArray(raw.windows) || raw.windows.length > 32) throw new Error("invalid-quota-response");
    return [{ id: "command-code", source, status: "success",
      windows: raw.windows.map((w, i) => windowView(w, safeText(modelObject(w).window) ?? `window-${i + 1}`)),
      balance: finite(raw.balance), periodEnd: time(raw.periodEnd), error: null }];
  }
  if (!Array.isArray(raw.accounts) || raw.accounts.length > 16) throw new Error("invalid-quota-response");
  return raw.accounts.map((account, i) => {
    const row = modelObject(account);
    const result: ModelQuotaItem = { id: `factory-${modelDigest(typeof row.id === "string" ? row.id : i).slice(0, 12)}`,
      source, status: "failed", windows: [], balance: null, periodEnd: null, error: "account-query-failed" };
    if (row.error || !row.quota) return result;
    const quota = modelObject(row.quota);
    if (!Array.isArray(quota.groups) || quota.groups.length > 16) return result;
    for (const group of quota.groups) {
      const g = modelObject(group);
      if (!Array.isArray(g.buckets) || g.buckets.length > 16) return result;
      for (const bucket of g.buckets) {
        const b = modelObject(bucket);
        result.windows.push(windowView(b, `${safeText(g.displayName) ?? "group"} / ${safeText(b.window) ?? "window"}`));
      }
    }
    result.status = result.windows.length ? "success" : "partial";
    result.error = result.windows.length ? null : "quota-fields-unknown";
    return result;
  });
}
