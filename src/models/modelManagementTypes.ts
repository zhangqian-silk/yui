/** Management-only connection. No inference, OAuth or upstream keys live in Yui's DB. */
export type ModelConnection = {
  bridgeUrl: string;
  bridgeConfigFile: string;
  cpaUrl: string;
  managementKeyFile: string;
  catalogKeyFile: string;
};

export type ModuleInstance = {
  id: string;
  kind: "metabridge" | "cliproxyapi";
  version: string;
  managementUrl: string;
  managementKeyFile: string;
  configFile: string;
  maintenance: "external" | "configuration";
  /** A separately installed extension, never inferred from the CPA version. */
  quotaAdapter: "none" | "factory-quota-v1";
};
export type ModelEndpoint = {
  id: string;
  moduleId: string | null;
  url: string;
  protocol: "responses" | "anthropic-messages";
  clientKeyFile: string;
};
export type AgentBinding = {
  agentId: string;
  adapterId: "codex" | "claude";
  endpointId: string | null;
  model: string;
  scope: "yui-new-session";
};
export type ModelRegistry = {
  modules: ModuleInstance[];
  endpoints: ModelEndpoint[];
  bindings: AgentBinding[];
  receipts: { requestId: string; digest: string }[];
};

export type ModelProviderView = {
  id: string;
  name: string;
  via: "direct" | "cpa" | "unknown";
  baseUrl: string;
  prefix: string;
  enabled: boolean;
  editable: boolean;
  reason: string | null;
  credentialPresent: boolean;
  credentialKind?: "subscription" | "key";
  owner: "metabridge" | "cliproxyapi";
  /** Configuration observations, not inferred runtime paths or model availability. */
  protocol?: string;
  sourceFile?: string;
  priority?: number | null;
  models?: { name: string; alias?: string }[];
  excludedModels?: string[];
  routeModels?: string[];
  requestMode?: string | null;
  compaction?: { mode: "local" | "passthrough" | "unknown"; models: string[]; stripImages: boolean } | null;
};

export type ModelObservation<T> = {
  status: "not-queried" | "success" | "partial" | "failed" | "unsupported";
  attemptedAt: string | null;
  observedAt: string | null;
  stale: boolean;
  error: string | null;
  items: T[];
  source?: string;
  accountScope?: string;
  unit?: string;
};
export type ModelStatusItem = { id: string; configurationRevision: string; runtime: "unknown" };

export type ModelCatalogItem = { id: string; source: string };
export type ModelQuotaItem = {
  id: string;
  source: "factory" | "command-code";
  status: "success" | "partial" | "failed";
  windows: { label: string; remainingFraction: number | null; used: number | null; cap: number | null; resetTime: string | null }[];
  balance: number | null;
  balanceDetails: { kind: "extra-usage-usd" | "monthly-credits" | "purchased-credits" | "free-credits"; value: number }[];
  periodEnd: string | null;
  error: string | null;
  observedAt?: string | null;
  stale?: boolean;
};

export type ModelManagementView = {
  nativeProviders?: import("./nativeModelConfiguration.js").NativeProvider[];
  /** Per-Agent native read outcome; Providers are known only when status is "read" or "absent". */
  nativeConfigurations?: { agentId: string; status: import("./nativeModelConfiguration.js").NativeModelConfiguration["status"]; sourceFile: string }[];
  quotaSources?: { moduleId: string; source: string }[];
  readOnly?: boolean;
  revision: string;
  connection: ModelConnection | null;
  providers: ModelProviderView[];
  configurationError: string | null;
  application: "unverified";
  notice: string;
  registry: ModelRegistry;
  registryRevision: string;
  configuredAgents: { id: string; adapterId: string }[];
};
