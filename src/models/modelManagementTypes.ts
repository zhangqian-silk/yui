/** Management-only connection. No inference, OAuth or upstream keys live in Yui's DB. */
export type ModelConnection = {
  bridgeUrl: string;
  bridgeConfigFile: string;
  cpaUrl: string;
  managementKeyFile: string;
  catalogKeyFile: string;
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
  owner: "metabridge";
};

export type ModelObservation<T> = {
  status: "not-queried" | "success" | "partial" | "failed" | "unsupported";
  attemptedAt: string | null;
  observedAt: string | null;
  stale: boolean;
  error: string | null;
  items: T[];
};

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
};

export type ModelManagementView = {
  readOnly?: boolean;
  revision: string;
  connection: ModelConnection | null;
  providers: ModelProviderView[];
  configurationError: string | null;
  application: "unverified";
  notice: string;
};
