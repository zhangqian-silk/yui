import { isAbsolute } from "node:path";
import { webLocalMutation, WebRequestRejected } from "../web/webMutation.js";
import type { TaskStore } from "../storage/taskStore.js";
import { modelFields, modelObject, modelUrl } from "./modelManagementConfig.js";
import { modelDigest, modelKey } from "./modelManagementFiles.js";
import type { AgentBinding, ModelEndpoint, ModelRegistry, ModuleInstance } from "./modelManagementTypes.js";

export const emptyModelRegistry = (): ModelRegistry => ({ modules: [], endpoints: [], bindings: [], receipts: [] });
const text = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length <= max && !/[\0\r\n]/.test(v);
const id = (v: unknown): v is string => text(v, 64) && /^[a-zA-Z0-9_-]+$/.test(v);
const file = (v: unknown): v is string => text(v) && (!v || isAbsolute(v));
function requireValue(ok: boolean, message: string): asserts ok {
  if (!ok) throw new WebRequestRejected(message);
}

export function validateModelRegistry(input: unknown): ModelRegistry {
  const r = modelObject(input);
  modelFields(r, ["modules", "endpoints", "bindings", "receipts"]);
  for (const name of ["modules", "endpoints", "bindings", "receipts"] as const) {
    requireValue(Array.isArray(r[name]) && (r[name] as unknown[]).length <= 100, "Invalid model registry collection.");
    for (const row of r[name] as unknown[]) modelObject(row);
  }
  const registry = r as ModelRegistry;
  const unique = (values: string[]) => new Set(values).size === values.length;
  requireValue(unique(registry.modules.map(m => m.id)) && unique(registry.endpoints.map(e => e.id))
    && unique(registry.bindings.map(b => b.agentId)) && unique(registry.receipts.map(r => r.requestId)), "Duplicate model resource identity.");
  for (const m of registry.modules) {
    modelFields(modelObject(m), ["id", "kind", "version", "managementUrl", "managementKeyFile", "configFile", "maintenance", "quotaAdapter"]);
    requireValue(id(m.id) && ["metabridge", "cliproxyapi"].includes(m.kind) && text(m.version, 128) && !!m.version
      && text(m.managementUrl) && file(m.managementKeyFile) && file(m.configFile)
      && ["external", "configuration"].includes(m.maintenance)
      && ["none", "factory-quota-v1"].includes(m.quotaAdapter), "Invalid module.");
    if (m.managementUrl) modelUrl(m.managementUrl);
    requireValue(m.kind === "cliproxyapi" || m.quotaAdapter === "none", "Quota belongs to CPA, not bridge.");
  }
  for (const e of registry.endpoints) {
    modelFields(modelObject(e), ["id", "moduleId", "url", "protocol", "clientKeyFile"]);
    requireValue(id(e.id) && (e.moduleId === null || registry.modules.some(m => m.id === e.moduleId))
      && ["responses", "anthropic-messages"].includes(e.protocol) && text(e.url) && file(e.clientKeyFile), "Invalid endpoint or missing module.");
    modelUrl(e.url);
  }
  for (const b of registry.bindings) validateBinding(registry, b);
  for (const receipt of registry.receipts) {
    modelFields(modelObject(receipt), ["requestId", "digest"]);
    requireValue(id(receipt.requestId) && /^[a-f0-9]{64}$/.test(receipt.digest), "Invalid model receipt.");
  }
  return structuredClone(registry);
}

export function validateBinding(registry: ModelRegistry, input: unknown): AgentBinding {
  const b = modelObject(input);
  modelFields(b, ["agentId", "adapterId", "endpointId", "model", "scope"]);
  requireValue(id(b.agentId) && ["codex", "claude"].includes(String(b.adapterId)) && text(b.model, 256)
    && b.scope === "yui-new-session", "Expected an exact Agent, adapter and new-session scope.");
  const endpoint = registry.endpoints.find(e => e.id === b.endpointId);
  requireValue(b.endpointId === null || !!endpoint, "Endpoint not found.");
  if (endpoint) {
    requireValue(endpoint.protocol === (b.adapterId === "codex" ? "responses" : "anthropic-messages"), "Endpoint protocol does not match the Agent adapter.");
    requireValue(!!b.model, "Select an explicit model.");
    requireValue(b.adapterId !== "claude" || !!endpoint.clientKeyFile, "Claude gateway binding requires an explicit client credential; never forward a saved subscription.");
  } else requireValue(b.model === "", "Native binding preserves native model selection; leave model empty.");
  return structuredClone(b) as AgentBinding;
}

type Store = Pick<TaskStore, "getConfig" | "saveConfig" | "transaction"> & Partial<Pick<TaskStore, "getConfiguredAgent">>;
/** One authority for references. No registration operation reads files or calls upstreams. */
export function createModelRegistry(store: Store) {
  const read = () => store.getConfig().modelManagement ?? emptyModelRegistry();
  const revision = () => modelDigest(read());
  function previewBinding(input: unknown) {
    const body = modelObject(input);
    modelFields(body, ["revision", "binding"]);
    requireValue(body.revision === revision(), "Model registry changed; read it again.");
    const binding = validateBinding(read(), body.binding);
    const agent = store.getConfiguredAgent?.(binding.agentId);
    requireValue(!!agent && agent.adapterId === binding.adapterId, "Configured Agent identity/adapter does not match.");
    return { binding, revision: revision(), application: "new-session-only",
      notice: "Existing Sessions and the shared daemon are unchanged. Native means no Yui endpoint override. No inference or authentication was tested." };
  }
  function save(input: unknown) {
    const body = modelObject(input);
    modelFields(body, ["revision", "requestId", "kind", "resource", "removeId"]);
    requireValue(id(body.requestId), "Expected a stable requestId.");
    requireValue(["module", "endpoint", "binding"].includes(String(body.kind)), "Unknown model resource kind.");
    const digest = modelDigest({ kind: body.kind, resource: body.resource, removeId: body.removeId });
    const old = read();
    const receipt = old.receipts.find(r => r.requestId === body.requestId);
    if (receipt) {
      requireValue(receipt.digest === digest, "requestId already names different parameters.");
      return { revision: revision(), application: "saved", replayed: true };
    }
    requireValue(body.revision === revision(), "Model registry changed; read it again.");
    const next = structuredClone(old);
    const key = body.kind === "module" ? "modules" : body.kind === "endpoint" ? "endpoints" : "bindings";
    const resourceId = body.removeId ?? modelObject(body.resource)[key === "bindings" ? "agentId" : "id"];
    requireValue(id(resourceId), "Expected exact resource identity.");
    const rows = next[key] as (ModuleInstance | ModelEndpoint | AgentBinding)[];
    const index = rows.findIndex(r => ("agentId" in r ? r.agentId : r.id) === resourceId);
    if (body.removeId !== undefined) {
      requireValue(body.resource === undefined && index >= 0, "Resource not found or ambiguous mutation.");
      rows.splice(index, 1);
    } else {
      if (key === "bindings") previewBinding({ revision: body.revision, binding: body.resource });
      if (index >= 0) {
        // Reusing a key reference at a different origin would silently redirect a secret.
        const previous = rows[index] as ModuleInstance & ModelEndpoint;
        const updated = modelObject(body.resource);
        const address = key === "modules" ? "managementUrl" : "url";
        const credential = key === "modules" ? "managementKeyFile" : "clientKeyFile";
        if (key !== "bindings" && previous[credential] && previous[credential] === updated[credential]) {
          const origin = (v: unknown) => v ? modelUrl(String(v)).origin : "";
          requireValue(origin(previous[address]) === origin(updated[address]), "Changing credential origin requires a new key reference or clearing it first.");
        }
        rows[index] = body.resource as typeof rows[number];
      } else rows.push(body.resource as typeof rows[number]);
    }
    next.receipts = [...next.receipts.slice(-99), { requestId: body.requestId, digest }];
    validateModelRegistry(next);
    webLocalMutation(store as TaskStore, tx => {
      requireValue(modelDigest(tx.getConfig().modelManagement ?? emptyModelRegistry()) === modelDigest(old), "Model registry changed; read it again.");
      tx.saveConfig({ ...tx.getConfig(), modelManagement: next });
    });
    return { revision: revision(), application: key === "bindings" ? "new-session-only" : "saved", replayed: false };
  }
  function recordProviderWrite(requestId: string, digest: string, expectedRevision: string) {
    webLocalMutation(store as TaskStore, tx => {
      const current = tx.getConfig().modelManagement ?? emptyModelRegistry();
      requireValue(modelDigest(current) === expectedRevision, "Registry changed while recording Provider write.");
      const next = { ...current, receipts: [...current.receipts.slice(-99), { requestId, digest }] };
      tx.saveConfig({ ...tx.getConfig(), modelManagement: validateModelRegistry(next) });
    });
  }
  return { read, revision, save, previewBinding, recordProviderWrite };
}

/** Per-thread/process overrides, never user config or a shared daemon restart.
 * The planner supplies pinned Session references on restore, current refs on new.
 */
export function modelBindingLaunch(registry: ModelRegistry | undefined, agentId: string, adapterId: string) {
  const binding = registry?.bindings.find(b => b.agentId === agentId);
  if (!binding || binding.endpointId === null) return null;
  requireValue(binding.adapterId === adapterId, "Model binding adapter changed.");
  validateBinding(registry!, binding);
  const endpoint = registry!.endpoints.find(e => e.id === binding.endpointId)!;
  const key = modelKey(endpoint.clientKeyFile);
  if (adapterId === "codex") return {
    model: binding.model,
    config: { model_provider: "yui_endpoint", model_providers: { yui_endpoint: {
      name: endpoint.id, base_url: endpoint.url, wire_api: "responses", requires_openai_auth: false,
      ...(key ? { http_headers: { Authorization: `Bearer ${key}` } } : {})
    } } }
  };
  return { model: binding.model, environment: {
    ANTHROPIC_BASE_URL: endpoint.url, ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: "", CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1"
  } };
}
