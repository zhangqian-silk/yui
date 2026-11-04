// Disposable isolated fixture for task-150/work-item-6 browser checks.
// Real Yui web server, settings and model management over a temp Home.
// No Controller, no Provider/model/account call: catalogs and HTTP are fakes.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
const repo = process.env.YUI_REPO;
const imp = p => import(join(repo, "dist", p));
const { SqliteTaskStore } = await imp("storage/sqliteStore.js");
const { createConfiguredAgent } = await imp("agent/agent.js");
const { createGlobalRole, createRoleAgentBinding } = await imp("role/role.js");
const { createAgentProfile } = await imp("profile/agentProfile.js");
const { createWebSettings } = await imp("web/webSettings.js");
const { createModelManagement } = await imp("models/modelManagement.js");
const { createYuiWebServer } = await imp("web/webServer.js");
const { staticAgentConfigurationFields } = await imp("executor/agentConfigurationFields.js");
const { CURRENT_CONFIG_SCHEMA_VERSION } = await imp("storage/taskStore.js");

const mode = process.argv[2] || "full";
const port = Number(process.argv[3] || 4301);
const root = resolve(process.argv[4] || `/tmp/yui-t150-wi6/homes/${mode}-${port}-${Date.now()}`);
if (existsSync(root)) throw new Error("fixture root exists: " + root);
mkdirSync(root, { recursive: true });
const yuiHome = join(root, "yui"); mkdirSync(yuiHome);
const userHome = join(root, "user");
const codexHome = join(userHome, ".codex"); const claudeHome = join(userHome, ".claude");
const now = new Date("2026-11-02T08:00:00Z");
if (mode !== "empty") {
  mkdirSync(codexHome, { recursive: true }); mkdirSync(claudeHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), [
    'model = "gpt-6-astra"', 'model_reasoning_effort = "xhigh"', 'model_provider = "metabridge"', '',
    '[model_providers.metabridge]', 'name = "metabridge"', 'base_url = "http://127.0.0.1:9/v1"', 'wire_api = "responses"', 'env_key = "FIXTURE_BRIDGE_KEY"', '',
    '[model_providers.openai_direct]', 'name = "OpenAI direct"', 'base_url = "https://api.openai.invalid/v1"', 'wire_api = "responses"', ''
  ].join("\n"));
  writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({ fetched_at: "2026-11-01T22:10:00Z", models: [
    { slug: "gpt-6-astra", display_name: "GPT-6 Astra", supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map(effort => ({ effort })) },
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map(effort => ({ effort })) },
    { slug: "factory/claude-opus-5-5", display_name: "Opus 5.5 (via Factory)", supported_reasoning_levels: ["low", "medium", "high"].map(effort => ({ effort })) }
  ] }));
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ model: "sonnet", effortLevel: "xhigh" }));
  // badnative / badbound: Codex's native TOML cannot be parsed (unknown, not "no Provider").
  if (mode.startsWith("bad")) writeFileSync(join(codexHome, "config.toml"), 'model = "unterminated\n[model_providers.broken\n');
}
const bridgeConfig = join(root, "bridge.json");
writeFileSync(bridgeConfig, JSON.stringify({ backends: [
  { name: "factory", prefix: "factory/", via: "cpa", base_url: "http://127.0.0.1:9/cpa/v1", protocol: "responses", wire_api: "responses", enabled: true, auth: { type: "gateway", key: "fixture-never-shown" }, priority: 10, models: [{ name: "claude-opus-5-5" }, { name: "gpt-6-astra" }] },
  { name: "official", prefix: "openai/", via: "direct", base_url: "https://api.openai.invalid/v1", protocol: "responses", wire_api: "responses", enabled: true, auth: { type: "keyfile", file: "/fixture/key" }, priority: 50 }
] }));
const cpaConfig = join(root, "cpa.json");
writeFileSync(cpaConfig, JSON.stringify({ "api-keys": { "openai-compatibility": [
  { name: "factory-pool", "base-url": "https://factory.invalid/v1", keys: ["fixture-never-shown"], models: [{ name: "claude-opus-5-5", alias: "opus" }] }
] } }));
const environment = { HOME: userHome, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, PATH: process.env.PATH };
const store = new SqliteTaskStore(yuiHome);
store.transaction(w => {
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  const claude = createConfiguredAgent("claude", "claude", "claude", [], [], now);
  w.saveConfiguredAgent(codex); if (mode !== "empty") w.saveConfiguredAgent(claude);
  const ws = join(root, "workspace");
  const role = (name, agent, model, effort, extra = {}) => {
    const b = createRoleAgentBinding(agent);
    const binding = { ...b, config: { ...b.config, ...(model ? { model } : {}), ...(effort ? { effort } : {}) } };
    return { ...createGlobalRole(name, [binding], agent.id, ws, now), ...extra };
  };
  w.saveGlobalRole(role("leader", codex, "gpt-6-astra", "medium"));
  w.saveGlobalRole(role("worker", codex, "gpt-6.1-sol", "medium"));
  if (mode !== "empty") {
    w.saveGlobalRole(role("operator", codex, "gpt-6.1-sol", "medium", {
      responsibilities: ["处理用户的直接请求并路由到对应 Task", "维护全局 Role 与 Agent 配置"],
      constraints: ["处理任何由 Task Leader 发起、需要 Operator 或用户选择的消息或 InputRequest 时，如无更新且更具体的用户指令，应直接选择在既定 Task 目标与边界内最推荐的选项，并记录理由。",
        "不修改个人配置、线上服务或全局 CLI；需要真实资源验证时先取得用户明确授权。"],
      skills: ["yui-operator"] }));
    w.saveGlobalRole(role("reviewer", codex, "gpt-6.1-sol", "max"));
    w.saveGlobalRole(role("ui-developer", claude, "", "", { description: "Independent product and frontend design work." }));
    w.saveAgentProfile(createAgentProfile({ id: "reader", runtime: { source: "global-worker" }, description: "Read-only research template" }, now));
    w.saveAgentProfile(createAgentProfile({ id: "designer", runtime: { source: "explicit", agentId: "claude", model: "opus", effort: "high" }, description: "Design and frontend work",
      instructions: "You own product and frontend design.\nStart from the user's scenario, not from the existing layout.\nPrefer one clear primary action per view.\nKeep copy short and concrete; avoid explanations users must read before acting.\nVerify every change in a real browser at desktop, tablet and phone widths.\nNever change production configuration or personal settings." }, now));
    w.saveAgentProfile(createAgentProfile({ id: "reviewer", runtime: { source: "explicit", agentId: "codex", model: "gpt-6.1-sol", effort: "max" },
      description: "Review one candidate against the user's core outcome, supported behavior, and direct evidence.",
      instructions: "Start from user intent and acceptance criteria. Inspect the complete relevant change and report only reachable, material, actionable problems with direct evidence. Separate defects from verification gaps, and prefer the smallest sufficient correction. Follow the bound Project's Policy and Knowledge for build, test, migration, release, and review expectations; do not import rules from another Project or Task. Do not turn speculative or extreme edge cases into new state, retries, fallbacks, or protocol. Never push, integrate, mutate Task state, touch another workspace or stable checkout. Expose evidence and options to the Leader, who decides." }, now));
    w.saveAgentProfile(createAgentProfile({ id: "fast-fix", runtime: { source: "explicit", agentId: "codex", model: "gpt-6-astra", effort: "low" } }, now));
  }
  const config = { schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION, defaultAgent: "codex", defaultWorkspace: ws };
  if (["full", "readonly", "badnative", "badbound"].includes(mode)) config.modelManagement = {
    modules: [
      { id: "bridge", kind: "metabridge", version: "0.9.2", managementUrl: "http://127.0.0.1:9", managementKeyFile: "", configFile: bridgeConfig, maintenance: "external", quotaAdapter: "none" },
      { id: "cpa", kind: "cliproxyapi", version: "6.1.0", managementUrl: "http://127.0.0.1:9", managementKeyFile: join(root, "cpa.key"), configFile: cpaConfig, maintenance: "external", quotaAdapter: "factory-quota-v1" }
    ],
    endpoints: [
      { id: "bridge-codex", moduleId: "bridge", url: "http://127.0.0.1:9/v1", protocol: "responses", clientKeyFile: "" },
      { id: "claude-gateway", moduleId: null, url: "https://claude-gw.invalid", protocol: "anthropic-messages", clientKeyFile: join(root, "claude.key") }
    ],
    bindings: mode === "badnative" ? [] : [{ agentId: "codex", adapterId: "codex", endpointId: "bridge-codex", model: "factory/claude-opus-5-5", scope: "yui-new-session" }],
    receipts: []
  };
  w.saveConfig(config);
});
const catalogs = { resolve: async input => {
  const native = input.agent.adapterId === "codex"
    ? [["gpt-6-astra", ["low", "medium", "high", "xhigh"]], ["gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"]], ["factory/claude-opus-5-5", ["low", "medium", "high"]]]
    : [["sonnet", ["low", "medium", "high", "xhigh"]], ["opus", ["low", "medium", "high", "xhigh", "max"]]];
  return { source: "cache", fetchedAt: "2026-11-01T22:10:00Z", attemptedAt: new Date().toISOString(),
    catalog: { schemaVersion: 1, agentId: input.agent.id, adapterId: input.agent.adapterId,
      models: native.map(([value, efforts], i) => ({ value, label: value, isDefault: i === 0, resolvedModel: value,
        efforts: efforts.map(e => ({ value: e, label: e })), defaultEffort: efforts[1] })),
      fields: staticAgentConfigurationFields(input.agent.adapterId), warnings: [] } };
} };
const settings = createWebSettings(store, { environment, catalogs });
const models = createModelManagement(store, { environment, request: async () => { throw new Error("fixture: upstream disabled"); } });
const snapshot = { label: "线上配置只读快照（不修改线上配置）", capturedAt: "2026-11-02T07:30:00Z" };
const ro = mode === "readonly";
const wrapped = ro ? {
  ...settings,
  index: (...a) => ({ ...settings.index(...a), readOnly: true, provenance: snapshot }),
  read: id => ({ ...settings.read(id), readOnly: true, provenance: snapshot }),
  save: async () => { throw new Error("read-only snapshot"); },
  applyProfile: async () => { throw new Error("read-only snapshot"); }
} : settings;
const modelService = ro ? { ...models, read: id => ({ ...models.read(id), readOnly: true, provenance: snapshot }) } : models;
const server = createYuiWebServer(store, { settings: wrapped, models: mode === "nomodels" ? undefined : modelService, token: "fixture-token" });
await new Promise(r => server.listen(port, "127.0.0.1", r));
console.log(JSON.stringify({ ready: true, mode, port, root, pid: process.pid }));
const stop = () => { server.closeAllConnections?.(); server.close(() => { store.close(); process.exit(0); }); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
