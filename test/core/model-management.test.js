import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createModelManagement as createService } from "../../dist/models/modelManagement.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";
import { readModelJson } from "../../dist/models/modelManagementHttp.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";

// Compact fixture builder for the Provider file tests. The runtime never reads
// this old convenience shape; the actual storage migration is tested separately.
function registryConnection(c) {
  return { modules: [
    { id: "bridge", kind: "metabridge", version: "fixture", managementUrl: c.bridgeUrl,
      configFile: c.bridgeConfigFile, managementKeyFile: "", maintenance: "configuration", quotaAdapter: "none" },
    ...(c.cpaUrl ? [{ id: "cpa", kind: "cliproxyapi", version: "8.0.12", managementUrl: c.cpaUrl,
      configFile: "", managementKeyFile: c.managementKeyFile, maintenance: "external", quotaAdapter: "factory-quota-v1" }] : [])
  ], endpoints: [{ id: "bridge-api", moduleId: "bridge", url: c.bridgeUrl.replace(/\/+$/, "") + "/v1",
    protocol: "responses", clientKeyFile: c.catalogKeyFile }], bindings: [], receipts: [] };
}
function createModelManagement(store, options) {
  let receipts;
  const fixtureStore = { ...store, getConfig: () => {
    const c = store.getConfig();
    const current = c.modelManagement?.bridgeUrl ? { ...c, modelManagement: registryConnection(c.modelManagement) } : c;
    if (receipts && current.modelManagement) current.modelManagement = { ...current.modelManagement, receipts };
    return current;
  }, saveConfig: store.saveConfig ?? (c => { receipts = c.modelManagement.receipts; }),
    transaction: fn => store.transaction ? store.transaction(() => fn(fixtureStore)) : fn(fixtureStore) };
  const service = createService(fixtureStore, options);
  let counter = 0;
  return { ...service, saveProvider: body => service.saveProvider({
    moduleId: "bridge", requestId: `provider-${++counter}`, exclusiveWriter: true, ...body
  }) };
}

test("Model management preserves official routes, guards revisions and never returns keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-models-"));
  let config = { schemaVersion: 1 };
  const store = {
    getConfig: () => structuredClone(config),
    saveConfig: value => { config = structuredClone(value); },
    transaction: fn => fn(store)
  };
  try {
    mkdirSync(join(root, "providers"));
    const bridge = join(root, "config.json");
    writeFileSync(bridge, JSON.stringify({ backends: [{
      name: "official", protocol: "codex-subscription", prefix: "", auth: { type: "passthrough" }
    }] }), { mode: 0o600 });
    const service = createModelManagement(store);
    config.modelManagement = registryConnection({
      bridgeUrl: "http://127.0.0.1:8318", bridgeConfigFile: bridge,
      cpaUrl: "", managementKeyFile: "", catalogKeyFile: ""
    });
    let view = service.read();
    assert.equal(view.providers[0].editable, false);
    const initial = view.revision;
    view = service.saveProvider({ revision: initial, operation: "save", provider: {
      name: "demo", via: "direct", baseUrl: "https://example.com/v1",
      prefix: "demo/", enabled: true, apiKey: "secret-test-value"
    } });
    assert.equal(view.providers.length, 2);
    assert.equal(JSON.stringify(view).includes("secret-test-value"), false);
    assert.equal(view.application, "unverified");
    assert.throws(() => service.saveProvider({ revision: initial, operation: "remove", id: view.providers[1].id }), /changed/i);
    assert.throws(() => service.saveProvider({ revision: view.revision, operation: "remove", id: view.providers[0].id }), /read.only/i);
    const saved = JSON.parse(readFileSync(bridge, "utf8"));
    assert.equal(saved.backends[0].protocol, "codex-subscription");
    assert.equal(saved.backends[1].auth.key, "secret-test-value");
    view = service.saveProvider({ revision: view.revision, operation: "remove", id: view.providers[1].id });
    assert.equal(view.providers.length, 1);
    const retained = readdirSync(root).find(name => name.startsWith("yui-provider-retained-"));
    assert.ok(retained, "inline removal retains the only credential in a private unreferenced file");
    assert.equal(JSON.parse(readFileSync(join(root, retained))).auth.key, "secret-test-value");
    assert.equal(statSync(join(root, retained)).mode & 0o077, 0);
    assert.ok(view.notice.includes(retained));
    assert.equal(JSON.stringify(view).includes("secret-test-value"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Model HTTP boundary persists only references and requires token, origin and JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-models-web-"));
  let store, server;
  try {
    store = new SqliteTaskStore(root);
    store.saveConfiguredAgent(createConfiguredAgent("coding", "codex", "/fixture/codex", [], [], new Date()));
    const service = createService(store, { environment: { HOME: root } });
    server = createYuiWebServer(store, { token: "fixture-token", models: service });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const api = `${url}/api/models`;
    const shell = await fetch(`${url}/models`);
    assert.equal(shell.status, 200);
    const html = await shell.text();
    for (const path of ["/models/connection", "/models/maintenance", "/settings/connection", "/models/catalog"]) {
      assert.equal((await fetch(url + path)).status, 200, path);
    }
    assert.deepEqual(service.read().configuredAgents, [{ id: "coding", adapterId: "codex" }], "selection exposes no launch command or credentials");
    assert.match(html, /name="yui-web-token" content="fixture-token"/);
    assert.doesNotMatch(html, /__YUI_WEB_TOKEN__/);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)];
    assert.ok(assets.some(match => match[1].startsWith("/assets/js/app/manage.js?v=")));
    for (const path of ["/models/agents", "/settings/agents", "/models/providers", "/models/catalog", "/models/quota",
      "/settings/preferences", "/settings/skills", "/settings/server", "/settings/connection"]) {
      assert.equal(await (await fetch(url + path)).text(), html, "every direct management URL serves the same document");
    }
    for (const [, asset] of assets) {
      const response = await fetch(url + asset);
      assert.equal(response.status, 200, asset);
      assert.match(response.headers.get("cache-control"), /private, max-age=31536000, immutable/);
    }
    const entryUrl = assets.find(match => match[1].startsWith("/assets/js/app/manage.js?v="))[1];
    const entry = await (await fetch(url + entryUrl)).text();
    assert.match(entry, /app\/settings\.js\?v=[a-f0-9]+/);
    assert.match(html, /rel="modulepreload"/);
    assert.equal((await fetch(url + "/models")).headers.get("cache-control"), "no-store");
    assert.equal((await fetch(url + "/assets/app.js")).headers.get("cache-control"), "no-store");
    assert.equal((await fetch(url + "/assets/app.js?v=stale")).status, 404);
    const head = await fetch(`${url}/models`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const docs = await fetch(`${url}/models/docs`);
    assert.equal(docs.status, 200);
    assert.match(await docs.text(), /CLIProxyAPI v8\.0\.12/);
    for (const component of ["maintenance", "connection", "metabridge", "cliproxyapi"]) {
      const manual = await fetch(`${url}/models/docs/${component}`);
      assert.equal(manual.status, 200, component);
      assert.ok((await manual.text()).length > 1000);
    }
    assert.equal((await fetch(api)).status, 403);
    const headers = { "x-yui-web-token": "fixture-token", "content-type": "application/json" };
    const view = await (await fetch(`${api}/registry`, { headers })).json();
    const endpoint = { id: "direct", moduleId: null, url: url + "/v1", protocol: "responses", clientKeyFile: "" };
    const body = JSON.stringify({ revision: view.revision, requestId: "registration", kind: "endpoint", resource: endpoint });
    const denied = await fetch(`${api}/resource`, { method: "POST", headers, body });
    assert.equal(denied.status, 409);
    assert.equal(store.getConfig().modelManagement, undefined);
    assert.equal((await fetch(`${api}/connection/preview`, { method: "POST", headers,
      body: JSON.stringify({ input: {} }) })).status, 409, "native preview also requires origin");
    const invalidPreview = await fetch(`${api}/connection/preview`, { method: "POST",
      headers: { ...headers, origin: url }, body: JSON.stringify({ input: {} }) });
    assert.equal((await invalidPreview.json()).disposition, "not-submitted");
    const saved = await fetch(`${api}/resource`, { method: "POST", headers: { ...headers, origin: url }, body });
    assert.equal(saved.status, 200);
    assert.deepEqual(store.getConfig().modelManagement.endpoints, [endpoint]);
    assert.equal((await fetch(`${api}/resource`, { method: "POST", headers: { ...headers, origin: url }, body })).status, 200);
    assert.throws(() => store.saveConfig({ schemaVersion: 1, modelManagement: { ...store.getConfig().modelManagement, apiKey: "forbidden" } }), /Unknown|invalid/i);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("file-backed providers retain external files on removal and refuse symlink configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-models-files-"));
  try {
    const original = join(root, "official.json");
    writeFileSync(original, JSON.stringify({ name: "official", protocol: "codex-subscription", auth: { type: "passthrough" } }), { mode: 0o600 });
    const file = join(root, "config.json");
    writeFileSync(file, JSON.stringify({ providerFiles: ["official.json"] }), { mode: 0o600 });
    let config = { schemaVersion: 1, modelManagement: { bridgeUrl: "http://127.0.0.1:8318", bridgeConfigFile: file, cpaUrl: "", managementKeyFile: "", catalogKeyFile: "" } };
    const store = { getConfig: () => config, saveConfig: c => { config = c; }, transaction: fn => fn(store) };
    const service = createModelManagement(store);
    const saved = service.saveProvider({ revision: service.read().revision, operation: "save", provider: {
      name: "extra", via: "cpa", baseUrl: "http://127.0.0.1:8317/v1", prefix: "extra/", enabled: false, apiKey: "client-key"
    } });
    const created = JSON.parse(readFileSync(file, "utf8")).providerFiles[1];
    assert.equal(statSync(join(root, created)).mode & 0o077, 0);
    const removed = service.saveProvider({ revision: saved.revision, operation: "remove", id: saved.providers[1].id });
    assert.match(removed.notice, /retained/);
    assert.equal(JSON.parse(readFileSync(join(root, created), "utf8")).auth.key, "client-key");
    const link = join(root, "link.json");
    symlinkSync(file, link);
    config.modelManagement.modules[0].configFile = link;
    assert.ok(service.read().configurationError);
    assert.equal(service.read().providers.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider edits preserve address semantics and reject broken backend dependencies before writing", () => {
  for (const layout of ["backends", "providerFiles"]) {
    const root = mkdtempSync(join(tmpdir(), "yui-models-policy-"));
    try {
      const file = join(root, "config.json");
      const tools = { name: "tools", via: "direct", protocol: "responses", base: "https://example.com/v1/",
        prefix: "tools/", auth: { type: "static", key: "fixture-key" } };
      const implicit = { ...tools, name: "implicit", prefix: "implicit/", sanitize: "gateway" };
      delete implicit.via;
      const command = { name: "command", protocol: "command-code", enabled: true,
        webSearch: { backend: "tools", model: "demo" } };
      const config = { schemaVersion: 1, modelManagement: {
        bridgeUrl: "http://localhost:8318", bridgeConfigFile: file, cpaUrl: "", managementKeyFile: "", catalogKeyFile: ""
      } };
      const store = { getConfig: () => config };
      const write = providers => {
        if (layout === "backends") writeFileSync(file, JSON.stringify({ officialModels: { enabled: false }, backends: providers }), { mode: 0o600 });
        else {
          providers.forEach(p => writeFileSync(join(root, p.name + ".json"), JSON.stringify(p), { mode: 0o600 }));
          writeFileSync(file, JSON.stringify({ providerFiles: providers.map(p => p.name + ".json") }), { mode: 0o600 });
        }
      };
      write([tools, implicit, command]);
      const service = createModelManagement(store);
      let view = service.read();
      const target = view.providers.find(p => p.name === "tools");
      const draft = { id: target.id, name: "tools", via: "direct", baseUrl: target.baseUrl, prefix: "tools/", enabled: true };
      const implicitView = view.providers.find(p => p.name === "implicit");
      assert.equal(implicitView.editable, false, "implicit request/compaction policies stay with their owner");
      assert.throws(() => service.saveProvider({ revision: view.revision, operation: "save",
        provider: { ...draft, id: implicitView.id, name: "implicit", prefix: "implicit/" } }), /read.only/i);
      assert.equal(service.read().revision, view.revision);
      view = service.saveProvider({ revision: view.revision, operation: "save", provider: draft });
      const saved = layout === "backends" ? JSON.parse(readFileSync(file)).backends[0] : JSON.parse(readFileSync(join(root, "tools.json")));
      assert.equal(saved.base, tools.base);
      assert.equal(saved.base_url, undefined, "base must not become a complete API root");
      assert.throws(() => service.saveProvider({ revision: view.revision, operation: "save",
        provider: { ...draft, baseUrl: "https://other.example/v1" } }), /newly supplied key/i);
      assert.equal(service.read().revision, view.revision, "a truly changed credential destination remains protected");
      for (const change of [{ name: "renamed" }, { enabled: false }]) {
        assert.throws(() => service.saveProvider({ revision: view.revision, operation: "save", provider: { ...draft, ...change } }), /referenc/i);
        assert.equal(service.read().revision, view.revision);
      }
      assert.throws(() => service.saveProvider({ revision: view.revision, operation: "remove", id: target.id }), /referenc/i);
      assert.equal(service.read().revision, view.revision);
      write([tools]);
      view = service.read();
      assert.throws(() => service.saveProvider({ revision: view.revision, operation: "save",
        provider: { ...draft, id: view.providers[0].id, enabled: false } }), /enabled backend/i);
      assert.throws(() => service.saveProvider({ revision: view.revision, operation: "remove", id: view.providers[0].id }), /enabled backend/i);
      assert.equal(service.read().revision, view.revision);
      write([{ name: "official", protocol: "codex-subscription", auth: { type: "passthrough" } },
        { ...tools, enabled: false, auth: { type: "static" } }]);
      view = service.read();
      const unconfigured = { ...draft, id: view.providers.find(p => p.name === "tools").id };
      view = service.saveProvider({ revision: view.revision, operation: "save", provider: { ...unconfigured, enabled: false } });
      assert.throws(() => service.saveProvider({ revision: view.revision, operation: "save",
        provider: unconfigured }), /key|credential/i);
      assert.equal(service.read().revision, view.revision, "missing credential must be rejected before either layout is written");
      view = service.saveProvider({ revision: view.revision, operation: "save",
        provider: { ...unconfigured, apiKey: "new-fixture-key" } });
      assert.equal(view.providers.find(p => p.name === "tools").enabled, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});


test("real model management projects optional metabridge, CPA and native Provider facts without secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-models-integrated-"));
  let store, server;
  try {
    store = new SqliteTaskStore(root);
    store.saveConfiguredAgent(createConfiguredAgent(
      "codex-long-fixture", "codex", "/fixture/codex", [], [], new Date()
    ));
    const longName = "Metabridge provider with a deliberately long operator-facing name for wrapping checks";
    const longUrl = "https://metabridge-provider-with-a-very-long-hostname-and-path.invalid/v1/responses/upstream";
    const bridge = join(root, "bridge.json");
    const cpa = join(root, "cpa.json");
    writeFileSync(bridge, JSON.stringify({ backends: [
      { name: longName, via: "direct", protocol: "responses", base_url: longUrl,
        prefix: "long-provider-prefix/", auth: { type: "static", key: "must-not-leak-bridge" },
        models: [{ name: "upstream-long-model", alias: "public-long-model" }] },
      { name: "official-subscription", protocol: "codex-subscription", auth: { type: "passthrough" } }
    ] }), { mode: 0o600 });
    writeFileSync(cpa, JSON.stringify({ "api-keys": { codex: [{
      name: "CPA provider with a deliberately long name for narrow layout checks",
      "base-url": "https://cpa-provider-with-a-very-long-hostname-and-path.invalid/v1",
      prefix: "cpa-long/", keys: ["must-not-leak-cpa"], models: [{ name: "cpa-upstream", alias: "cpa-public" }]
    }] } }), { mode: 0o600 });
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex", "config.toml"), [
      'model = "native-long-model"',
      'model_reasoning_effort = "medium"',
      'model_provider = "native-long"',
      '[model_providers.native-long]',
      'name = "Native provider with a deliberately long name for wrapping checks"',
      'base_url = "https://native-provider-with-a-very-long-hostname-and-path.invalid/v1"',
      'wire_api = "responses"',
      'http_headers = { Authorization = "Bearer must-not-leak-native" }'
    ].join("\n"), { mode: 0o600 });
    store.saveConfig({ ...store.getConfig(), modelManagement: {
      modules: [
        { id: "bridge", kind: "metabridge", version: "fixture", managementUrl: "http://127.0.0.1:9",
          managementKeyFile: "", configFile: bridge, maintenance: "configuration", quotaAdapter: "none" },
        { id: "cpa", kind: "cliproxyapi", version: "8.0.12", managementUrl: "http://127.0.0.1:8",
          managementKeyFile: "", configFile: cpa, maintenance: "external", quotaAdapter: "factory-quota-v1" }
      ],
      endpoints: [{ id: "bridge-api", moduleId: "bridge", url: "http://127.0.0.1:9/v1",
        protocol: "responses", clientKeyFile: "" }],
      bindings: [], receipts: []
    } });
    const service = createService(store, { environment: { HOME: root } });
    server = createYuiWebServer(store, { token: "provider-fixture-token", models: service });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const headers = { "x-yui-web-token": "provider-fixture-token" };
    const bridgeView = await (await fetch(url + "/api/models?moduleId=bridge", { headers })).json();
    const cpaView = await (await fetch(url + "/api/models?moduleId=cpa", { headers })).json();
    const baseline = await (await fetch(url + "/api/models", { headers })).json();
    assert.equal(bridgeView.configurationError, null);
    assert.equal(bridgeView.providers.find(provider => provider.name === longName)?.baseUrl, longUrl);
    assert.equal(cpaView.providers.find(provider => provider.prefix === "cpa-long/")?.via, "cpa");
    assert.equal(baseline.nativeProviders.find(provider => provider.name.includes("Native provider"))?.baseUrl,
      "https://native-provider-with-a-very-long-hostname-and-path.invalid/v1");
    assert.deepEqual(bridgeView.registry.modules.map(module => module.kind).sort(), ["cliproxyapi", "metabridge"]);
    const serialized = JSON.stringify({ baseline, bridgeView, cpaView });
    for (const secret of ["must-not-leak-bridge", "must-not-leak-cpa", "must-not-leak-native"]) {
      assert.doesNotMatch(serialized, new RegExp(secret));
    }
    assert.equal(service.read().application, "unverified", "configuration facts do not claim inference or account availability");
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("each Agent's native read outcome reaches the model view: unreadable is unknown, not absent", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-models-native-status-"));
  const store = new SqliteTaskStore(root);
  try {
    store.saveConfiguredAgent(createConfiguredAgent("codex", "codex", "/fixture/codex", [], [], new Date()));
    store.saveConfiguredAgent(createConfiguredAgent("claude", "claude", "/fixture/claude", [], [], new Date()));
    const codexHome = join(root, "codex"), claudeHome = join(root, "claude");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), 'model = "unterminated\n[model_providers.x\nhttp_headers = { Authorization = "Bearer must-not-leak" }');
    const environment = { HOME: root, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome };
    const statuses = () => Object.fromEntries(createService(store, { environment }).read().nativeConfigurations.map(n => [n.agentId, n.status]));
    const broken = createService(store, { environment }).read();
    assert.deepEqual(statuses(), { codex: "unavailable", claude: "absent" });
    assert.deepEqual(broken.nativeProviders, []);
    assert.doesNotMatch(JSON.stringify(broken), /must-not-leak/);
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "own"\n[model_providers.own]\nbase_url = "https://own.invalid/v1"\nwire_api = "responses"\n');
    const read = createService(store, { environment }).read();
    assert.deepEqual(statuses(), { codex: "read", claude: "absent" });
    assert.deepEqual(read.nativeProviders.map(p => [p.agentId, p.id, p.selected]), [["codex", "own", true]]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("domain observations honor Node all-address lookup without losing pinned target checks", async () => {
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer private-fixture-key");
    res.end('{"data":[],"diagnostic":"private-fixture-key"}');
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    assert.deepEqual(await readModelJson(`http://localhost:${server.address().port}`, "/v1/models", "private-fixture-key", 1000),
      { data: [], diagnostic: "[redacted]" });
    await assert.rejects(readModelJson("https://169.254.169.254", "/models", "never-send", 100), /target-rejected/);
    await assert.rejects(readModelJson("http://example.com", "/models", "never-send", 100), /loopback HTTP or HTTPS/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
