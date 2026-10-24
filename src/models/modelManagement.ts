import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { TaskStore } from "../storage/taskStore.js";
import { WebRequestRejected } from "../web/webMutation.js";
import { modelFields, modelObject, modelUrl } from "./modelManagementConfig.js";
import { createModelRegistry } from "./modelRegistry.js";
import { modelDigest, modelJsonFile, modelKey, newModelFile, privateModelFile, replaceModelFile, type ModelFile } from "./modelManagementFiles.js";
import { readModelJson } from "./modelManagementHttp.js";
import type { ModelCatalogItem, ModelConnection, ModelManagementView, ModelObservation, ModelProviderView, ModelQuotaItem, ModelStatusItem } from "./modelManagementTypes.js";
import { createModelMaintenanceService } from "./modelMaintenanceService.js";
import type { DurableJobCaller } from "../controller/jobControl.js";

type Store = Pick<TaskStore, "getConfig" | "saveConfig" | "transaction"> & Partial<Pick<TaskStore, "getConfiguredAgent">>;
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
  const registry = createModelRegistry(store);
  const observations = new Map<string, ModelObservation<ModelCatalogItem | ModelQuotaItem | ModelStatusItem>>();
  const pending = new Map<string, Promise<unknown>>();
  // Lazy: file-only model callers need not supply a Job/Store implementation.
  const maintenance = () => createModelMaintenanceService(store as TaskStore);

  function snapshot(moduleId?: string) {
    const module = moduleId ? registry.read().modules.find(m => m.id === moduleId)
      : registry.read().modules.find(m => m.kind === "metabridge");
    if (moduleId && !module) throw new WebRequestRejected("Module not found.");
    const endpoint = registry.read().endpoints.find(e => e.moduleId === module?.id && e.protocol === "responses");
    // A read-only projection for the existing Provider editor. Never persisted.
    const connection: ModelConnection | null = module?.kind === "metabridge" ? {
      bridgeUrl: endpoint?.url ?? module.managementUrl, bridgeConfigFile: module.configFile,
      cpaUrl: "", managementKeyFile: "", catalogKeyFile: endpoint?.clientKeyFile ?? ""
    } : null;
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
    const revision = modelDigest([registry.read(), module?.id, root?.raw ?? null, providers.map(p => [p.id, p.file.raw]), configurationError]);
    return { connection, root, providers, configurationError, revision, module };
  }

  function read(moduleId?: string): ModelManagementView {
    const state = snapshot(moduleId);
    return {
      revision: state.revision, connection: state.connection, providers: state.providers.map(provider => {
        const view = providerView(provider);
        return state.module?.maintenance === "configuration" ? view : { ...view, editable: false, reason: "read-only-service" };
      }),
      configurationError: state.configurationError, application: "unverified", notice: NOTICE,
      registry: registry.read(), registryRevision: registry.revision()
    };
  }

  function checkRevision(body: Record<string, unknown>) {
    const state = snapshot(typeof body.moduleId === "string" ? body.moduleId : undefined);
    if (typeof body.revision !== "string" || body.revision !== state.revision) {
      throw new WebRequestRejected("Model configuration changed; read it again before submitting.");
    }
    return state;
  }

  function saveProvider(input: unknown): ModelManagementView {
    const body = modelObject(input);
    modelFields(body, ["revision", "operation", "provider", "id", "moduleId", "requestId", "exclusiveWriter"]);
    const requestDigest = modelDigest(body);
    const receipt = registry.read().receipts.find(r => r.requestId === body.requestId);
    if (receipt) {
      if (receipt.digest !== requestDigest) throw new WebRequestRejected("requestId already names different parameters.");
      return read(typeof body.moduleId === "string" ? body.moduleId : undefined);
    }
    const registryRevision = registry.revision();
    const state = checkRevision(body);
    if (typeof body.moduleId !== "string" || typeof body.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.requestId)
      || body.exclusiveWriter !== true || state.module?.maintenance !== "configuration") {
      throw new WebRequestRejected("Provider writes require requestId, configuration maintenance and an explicit exclusiveWriter agreement.");
    }
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
      const previousBase = target?.value.base_url ?? target?.value.base;
      const sameDestination = target && safeUrl(draft.baseUrl) === safeUrl(previousBase);
      if (target && !sameDestination && !key) {
        throw new WebRequestRejected("Changing the credential destination requires a newly supplied key.");
      }
      value = { ...(target?.value ?? {
        wire_api: "responses", protocol: "responses", requestMode: "passthrough",
        compaction: { mode: "passthrough" }, catalog: { source: "remote" }, priority: 50
      }), name: draft.name, via: draft.via, prefix: draft.prefix, enabled: draft.enabled };
      // metabridge's base prepends /v1; base_url is already a complete API root.
      // Keep the existing spelling even when the address is intentionally edited.
      value[target?.value.base !== undefined ? "base" : "base_url"] = sameDestination ? previousBase : draft.baseUrl;
      if (key) {
        const auth = target?.value.auth as Record<string, unknown> | undefined;
        value.auth = auth && ["static", "gateway"].includes(String(auth.type))
          ? { ...auth, key } : { type: "static", key };
      }
      const auth = value.auth as Record<string, unknown>;
      if (draft.enabled && ["static", "gateway"].includes(String(auth.type))
        && (typeof auth.key !== "string" || !auth.key.trim())) {
        throw new WebRequestRejected("Enabling this provider requires an API key; supply one or keep the provider disabled.");
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
    let retainedFile: string | undefined;
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
        if (removing) {
          // Inline auth may be the only copy. Preserve the complete provider in
          // an owned 0600 file before unlinking, just as providerFiles removal
          // leaves its existing file. Never delete this copy on uncertain save.
          retainedFile = newModelFile(dirname(root.path), "retained", target.value);
          backends.splice(state.providers.indexOf(target), 1);
        }
        else backends[state.providers.indexOf(target)] = value!;
      } else backends.push(value!);
      try { replaceModelFile(root, { ...root.value, backends }); }
      catch (error) {
        if (retainedFile) throw new Error(`Provider copy retained in ${retainedFile}; removal was not confirmed. Read current facts before retrying.`, { cause: error });
        throw error;
      }
    }
    try { registry.recordProviderWrite(body.requestId, requestDigest, registryRevision); }
    catch (error) { throw new Error("Provider file saved but request receipt is unconfirmed; inspect the file and registry before retrying.", { cause: error }); }
    const view = read(state.module?.id);
    if (removing) view.notice = `Provider unlinked. Referenced files and credentials were retained; no service was stopped.${retainedFile ? ` Inline provider retained beside the bridge configuration in ${retainedFile}.` : ""} ${NOTICE}`;
    return view;
  }

  function current<T>(value: ModelObservation<T>): ModelObservation<T> {
    return { ...value, stale: value.stale || value.observedAt !== null && now().getTime() - Date.parse(value.observedAt) > 60_000 };
  }
  function observationKey(kind: string, resourceId: string, source = "") {
    const resource = kind === "catalog" ? registry.read().endpoints.find(e => e.id === resourceId)
      : registry.read().modules.find(m => m.id === resourceId);
    if (!resource) throw new WebRequestRejected("Observation resource not found.");
    return modelDigest([kind, resource, source]);
  }
  function readCatalog(cursor = "0", endpointId = registry.read().endpoints[0]?.id ?? "") {
    if (!endpointId) return { ...empty<ModelCatalogItem>(), total: 0, nextCursor: null };
    const catalog = observations.get(observationKey("catalog", endpointId)) as ModelObservation<ModelCatalogItem> ?? empty<ModelCatalogItem>();
    if (!/^\d{1,5}$/.test(cursor) || Number(cursor) > 2000) throw new WebRequestRejected("Invalid catalog cursor.");
    const offset = Number(cursor);
    return { ...current(catalog), items: catalog.items.slice(offset, offset + 100), total: catalog.items.length,
      nextCursor: offset + 100 < catalog.items.length ? String(offset + 100) : null };
  }
  function readQuota(source: string, moduleId = registry.read().modules.find(m => m.kind === "cliproxyapi")?.id ?? "") {
    if (source !== "factory" && source !== "command-code") throw new WebRequestRejected("Unsupported quota source.");
    if (!moduleId) return empty<ModelQuotaItem>();
    return current(observations.get(observationKey("quota", moduleId, source)) ?? empty<ModelQuotaItem>());
  }
  function readStatus(moduleId: string) {
    return current(observations.get(observationKey("status", moduleId)) ?? empty<ModelStatusItem>());
  }
  async function refresh(input: unknown): Promise<unknown> {
    const body = modelObject(input);
    modelFields(body, ["revision", "kind", "source", "resourceId"]);
    if (body.revision !== registry.revision()) throw new WebRequestRejected("Model registry changed; read it again.");
    const kind = body.kind;
    const source = body.source;
    if (kind !== "catalog" && kind !== "quota" && kind !== "status" || (kind === "catalog" || kind === "status") && source !== undefined
      || kind === "quota" && source !== "factory" && source !== "command-code") {
      throw new WebRequestRejected("Unsupported observation.");
    }
    if (typeof body.resourceId !== "string") throw new WebRequestRejected("Select an exact observation resourceId.");
    const resourceId = body.resourceId;
    const identity = observationKey(kind as string, resourceId, source as string | undefined);
    const active = pending.get(identity);
    if (active) return active;
    if (pending.size >= 4) throw new WebRequestRejected("Observation capacity reached; wait for the current request.");
    const operation = (async () => {
      const attemptedAt = now().toISOString();
      let observation: ModelObservation<ModelCatalogItem | ModelQuotaItem | ModelStatusItem>;
      try {
        if (kind === "status") {
          const module = registry.read().modules.find(m => m.id === resourceId)!;
          if (!module.configFile) throw new Error("configuration-unavailable");
          const raw = privateModelFile(module.configFile);
          observation = { status: "success", items: [{ id: module.id, configurationRevision: modelDigest(raw), runtime: "unknown" }],
            attemptedAt, observedAt: now().toISOString(), stale: false, error: null };
        } else if (kind === "catalog") {
          const endpoint = registry.read().endpoints.find(e => e.id === resourceId)!;
          if (endpoint.protocol !== "responses") throw new Error("catalog-unsupported");
          const key = modelKey(endpoint.clientKeyFile);
          const raw = modelObject(await request(endpoint.url, "/models", key, 8_000));
          if (!Array.isArray(raw.data) || raw.data.length > 2000) throw new Error("invalid-or-oversize-catalog");
          const items = raw.data.map(item => {
            const row = modelObject(item);
            if (typeof row.id !== "string" || !row.id || row.id.length > 2048) throw new Error("invalid-catalog");
            return { id: row.id, source: endpoint.id };
          });
          // No hidden /healthz read: it may refresh upstreams. A catalog is
          // the endpoint's reported list, not proof of complete upstream health.
          observation = { status: "success", items, attemptedAt,
            observedAt: now().toISOString(), stale: false, error: null };
        } else {
          const module = registry.read().modules.find(m => m.id === resourceId)!;
          if (module.kind !== "cliproxyapi" || module.quotaAdapter !== "factory-quota-v1"
            || !module.managementUrl || !module.managementKeyFile) throw new Error("quota-unsupported");
          const suffix = source === "factory" ? "accounts" : "command-code";
          const raw = await request(module.managementUrl, `/v0/management/plugins/factory-quota/${suffix}`, modelKey(module.managementKeyFile), 30_000);
          const reported = normalizeQuota(source as "factory" | "command-code", raw);
          if (reported.length && reported.every(item => item.status === "failed")) throw new Error("account-query-failed");
          const observedAt = now().toISOString();
          const previous = observations.get(identity) as ModelObservation<ModelQuotaItem> | undefined;
          const items = reported.map(item => {
            if (item.status !== "failed") return { ...item, observedAt, stale: false };
            const old = previous?.items.find(old => old.id === item.id);
            return { ...(old ?? item), status: item.status, error: item.error,
              observedAt: old?.observedAt ?? null, stale: !!old?.observedAt };
          });
          observation = { status: items.some(item => item.status !== "success") ? "partial" : "success",
            items, attemptedAt, observedAt, stale: items.some(item => item.stale),
            error: items.some(item => item.status === "failed") ? "account-query-failed" : null };
        }
      } catch (error) {
        const code = error instanceof Error && /^[a-z-]{1,64}$/.test(error.message) ? error.message : "observation-unavailable";
        const previous = observations.get(identity);
        observation = { status: code.endsWith("unsupported") ? "unsupported" : "failed", items: previous?.items ?? [],
          attemptedAt, observedAt: previous?.observedAt ?? null, stale: previous?.observedAt !== null && !!previous, error: code } as typeof observation;
      }
      if (observationKey(kind as string, resourceId, source as string | undefined) !== identity) {
        throw new WebRequestRejected("Resource changed during observation; result discarded.");
      }
      observations.set(identity, observation);
      // At most 100 endpoints, 100 module statuses and 200 quota sources.
      // Old resource revisions cannot grow this Controller-local cache forever.
      while (observations.size > 400) observations.delete(observations.keys().next().value!);
      observation.source = resourceId;
      observation.accountScope = kind === "quota" ? `${resourceId}/${source}/accounts` : resourceId;
      observation.unit = kind === "quota" ? "per-window fraction; balanceDetails carry distinct units" : kind === "catalog" ? "model-id" : "configuration-digest";
      return kind === "catalog" ? readCatalog("0", resourceId) : kind === "status" ? readStatus(resourceId) : readQuota(source as string, resourceId);
    })();
    pending.set(identity, operation);
    try { return await operation; } finally { pending.delete(identity); }
  }
  return { read, saveProvider, readCatalog, readQuota, readStatus, refresh,
    readMaintenance: (moduleId: string) => maintenance().read(moduleId),
    maintain: (input: unknown, caller: DurableJobCaller) => maintenance().maintain(input, caller),
    connectionPreview: (input: unknown) => maintenance().connectionPreview(input),
    connectionApply: (input: unknown, caller: DurableJobCaller) => maintenance().connectionApply(input, caller),
    readRegistry: () => ({ revision: registry.revision(), registry: registry.read() }),
    saveResource: registry.save, previewBinding: registry.previewBinding };
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
    credentialKind: p.protocol === "codex-subscription" ? "subscription" : "key",
    owner: "metabridge"
  };
}
function safeUrl(value: unknown): string {
  try { return modelUrl(typeof value === "string" ? value : "").toString().replace(/\/+$/, ""); }
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
    const credits = raw.credits === undefined ? {} : modelObject(raw.credits);
    const balanceDetails: ModelQuotaItem["balanceDetails"] = [];
    for (const [field, kind] of [
      ["monthlyCredits", "monthly-credits"], ["purchasedCredits", "purchased-credits"], ["freeCredits", "free-credits"]
    ] as const) {
      const value = finite(credits[field]);
      if (value !== null) balanceDetails.push({ kind, value });
    }
    // The extension supplies a total only when all three pools are known.
    // Keep partial pools visible without inventing that total.
    const balance = balanceDetails.length === 3 ? finite(raw.balance) : null;
    return [{ id: "command-code", source, status: balance === null ? "partial" : "success",
      windows: raw.windows.map((w, i) => windowView(w, safeText(modelObject(w).window) ?? `window-${i + 1}`)),
      balance, balanceDetails, periodEnd: time(raw.periodEnd), error: balance === null ? "quota-total-unknown" : null }];
  }
  if (!Array.isArray(raw.accounts) || raw.accounts.length > 16) throw new Error("invalid-quota-response");
  return raw.accounts.map((account, i) => {
    const row = modelObject(account);
    const result: ModelQuotaItem = { id: `factory-${modelDigest(typeof row.id === "string" ? row.id : i).slice(0, 12)}`,
      source, status: "failed", windows: [], balance: null, balanceDetails: [], periodEnd: null, error: "account-query-failed" };
    if (row.error || !row.quota) return result;
    const quota = modelObject(row.quota);
    if (Array.isArray(quota.summary)) {
      if (quota.summary.length > 32) return result;
      const extra = quota.summary.find(metric => metric && typeof metric === "object"
        && metric.key === "extra_usage_balance" && metric.currency === "USD");
      const value = finite(extra?.value);
      if (value !== null) result.balanceDetails.push({ kind: "extra-usage-usd", value });
    }
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
