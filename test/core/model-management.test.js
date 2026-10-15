import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createModelManagement } from "../../dist/models/modelManagement.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";
import { readModelJson } from "../../dist/models/modelManagementHttp.js";

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
    let view = service.read();
    view = service.saveConnection({ revision: view.revision, connection: {
      bridgeUrl: "http://127.0.0.1:8318", bridgeConfigFile: bridge,
      cpaUrl: "", managementKeyFile: "", catalogKeyFile: ""
    } });
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

test("Model observations use bounded reads; failed quota is not zero or stale success", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-models-http-"));
  let fail = false;
  let catalogItems = [{ id: "factory/claude", api_key: "do-not-project" }];
  let catalogError = null;
  let healthUnavailable = false;
  let commandQuota = { windows: [], credits: { purchasedCredits: 12.5 } };
  const requested = [];
  const server = createServer((req, res) => {
    requested.push(req.url);
    res.setHeader("content-type", "application/json");
    if (fail) { res.statusCode = 500; res.end("secret-test-value"); return; }
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: catalogItems })); return;
    }
    if (req.url === "/healthz") {
      if (healthUnavailable) { res.statusCode = 404; res.end("{}"); return; }
      res.end(JSON.stringify({ ok: true, service: "metabridge", models: catalogItems.length,
        backends: { factory: { ok: !catalogError, error: catalogError },
          unused: { ok: false, error: "disabled" } },
        officialModels: { ok: false, count: 0, error: null }, degraded: catalogError }));
      return;
    }
    assert.equal(req.headers.authorization, "Bearer secret-test-value");
    if (req.url.endsWith("/command-code")) {
      res.end(JSON.stringify(commandQuota)); return;
    }
    res.end(JSON.stringify({ accounts: [{ id: "private-account", quota: {
      groups: [{ displayName: "Standard", buckets: [{ window: "weekly", remainingFraction: 0 }] }],
      summary: [{ key: "extra_usage_balance", value: 12.5, currency: "USD" }]
    } }] }));
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const key = join(root, "key");
    writeFileSync(key, "secret-test-value", { mode: 0o600 });
    let config = { schemaVersion: 1, modelManagement: {
      bridgeUrl: url, bridgeConfigFile: "", cpaUrl: url, managementKeyFile: key, catalogKeyFile: ""
    } };
    const store = { getConfig: () => config, saveConfig: c => { config = c; }, transaction: fn => fn(store) };
    const service = createModelManagement(store);
    const revision = service.read().revision;
    const catalog = await service.refresh({ revision, kind: "catalog" });
    assert.equal(catalog.status, "success");
    assert.deepEqual(catalog.items, [{ id: "factory/claude", source: "factory" }]);
    catalogError = "upstream failed with secret-test-value";
    const partial = await service.refresh({ revision, kind: "catalog" });
    assert.equal(partial.status, "partial");
    assert.equal(partial.items.length, 1);
    assert.equal(JSON.stringify(partial).includes("secret-test-value"), false);
    catalogItems = [];
    const emptyFailed = await service.refresh({ revision, kind: "catalog" });
    assert.equal(emptyFailed.status, "failed", "HTTP 200 with no models is not successful when upstream failed");
    assert.equal(emptyFailed.observedAt, null);
    catalogError = null;
    assert.equal((await service.refresh({ revision, kind: "catalog" })).status, "success", "healthy empty catalog stays distinguishable");
    healthUnavailable = true;
    assert.equal((await service.refresh({ revision, kind: "catalog" })).status, "failed");
    catalogItems = [{ id: "factory/claude" }];
    assert.equal((await service.refresh({ revision, kind: "catalog" })).status, "partial");
    const quota = await service.refresh({ revision, kind: "quota", source: "factory" });
    assert.equal(quota.status, "success");
    assert.equal(quota.items[0].windows[0].remainingFraction, 0);
    assert.equal(quota.items[0].balance, null);
    assert.deepEqual(quota.items[0].balanceDetails, [{ kind: "extra-usage-usd", value: 12.5 }]);
    const command = await service.refresh({ revision, kind: "quota", source: "command-code" });
    assert.equal(command.status, "partial");
    assert.equal(command.items[0].balance, null, "one known pool is not a complete total");
    assert.deepEqual(command.items[0].balanceDetails, [{ kind: "purchased-credits", value: 12.5 }]);
    commandQuota = { windows: [], credits: { monthlyCredits: 0, purchasedCredits: 12.5, freeCredits: 0 }, balance: 12.5 };
    const completeCommand = await service.refresh({ revision, kind: "quota", source: "command-code" });
    assert.equal(completeCommand.status, "success");
    assert.equal(completeCommand.items[0].balance, 12.5);
    assert.deepEqual(completeCommand.items[0].balanceDetails.map(row => row.value), [0, 12.5, 0]);
    assert.equal(JSON.stringify(quota).includes("private-account"), false);
    fail = true;
    const failed = await service.refresh({ revision, kind: "quota", source: "factory" });
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.items, []);
    assert.equal(JSON.stringify(failed).includes("secret-test-value"), false);
    assert.equal(requested.some(path => path.includes("usage/queue")), false);
    await assert.rejects(readModelJson("https://169.254.169.254", "/v1/models", "never-send", 100), /target-rejected/);
    await assert.rejects(readModelJson("http://example.com", "/v1/models", "never-send", 100), /loopback HTTP or HTTPS/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("connection origin changes cannot silently reuse existing credential references", () => {
  const connection = { bridgeUrl: "https://bridge.example", bridgeConfigFile: "",
    cpaUrl: "https://cpa.example", managementKeyFile: "/private/management", catalogKeyFile: "/private/catalog" };
  let config = { schemaVersion: 1, modelManagement: connection };
  const store = { getConfig: () => config, saveConfig: c => { config = c; }, transaction: fn => fn(store) };
  const service = createModelManagement(store);
  let view = service.read();
  for (const field of ["bridgeUrl", "cpaUrl"]) {
    assert.throws(() => service.saveConnection({ revision: view.revision,
      connection: { ...connection, [field]: "https://other.example" } }), /credential|key/i);
    assert.equal(service.read().revision, view.revision);
  }
  view = service.saveConnection({ revision: view.revision,
    connection: { ...connection, bridgeUrl: "https://BRIDGE.example:443/" } });
  assert.equal(view.connection.catalogKeyFile, connection.catalogKeyFile);
  view = service.saveConnection({ revision: view.revision,
    connection: { ...connection, bridgeUrl: "https://other.example", catalogKeyFile: "/private/new-catalog",
      cpaUrl: "", managementKeyFile: "" } });
  assert.equal(view.connection.catalogKeyFile, "/private/new-catalog");
  assert.equal(view.connection.managementKeyFile, "");
});

test("Model HTTP boundary persists only references and requires token, origin and JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-models-web-"));
  let store, server;
  try {
    store = new SqliteTaskStore(root);
    const service = createModelManagement(store);
    server = createYuiWebServer(store, { token: "fixture-token", models: service });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const api = `${url}/api/models`;
    const shell = await fetch(`${url}/models`);
    assert.equal(shell.status, 200);
    const html = await shell.text();
    assert.match(html, /name="yui-web-token" content="fixture-token"/);
    assert.doesNotMatch(html, /__YUI_WEB_TOKEN__/);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)];
    assert.ok(assets.some(match => match[1] === "/assets/js/app/models.js"));
    for (const [, asset] of assets) assert.equal((await fetch(url + asset)).status, 200, asset);
    const head = await fetch(`${url}/models`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(api)).status, 403);
    const headers = { "x-yui-web-token": "fixture-token", "content-type": "application/json" };
    const view = await (await fetch(api, { headers })).json();
    const connection = { bridgeUrl: url, bridgeConfigFile: "", cpaUrl: "", managementKeyFile: "", catalogKeyFile: "" };
    const body = JSON.stringify({ revision: view.revision, connection });
    const denied = await fetch(`${api}/connection`, { method: "POST", headers, body });
    assert.equal(denied.status, 409);
    assert.equal(store.getConfig().modelManagement, undefined);
    const saved = await fetch(`${api}/connection`, { method: "POST", headers: { ...headers, origin: url }, body });
    assert.equal(saved.status, 200);
    assert.deepEqual(store.getConfig().modelManagement, connection);
    assert.equal((await fetch(`${api}/connection`, { method: "POST", headers: { ...headers, origin: url }, body })).status, 409);
    assert.throws(() => store.saveConfig({ schemaVersion: 1, modelManagement: { ...connection, apiKey: "forbidden" } }), /Unknown|invalid/i);
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
    config = { ...config, modelManagement: { ...config.modelManagement, bridgeConfigFile: link } };
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

test("domain observations honor Node all-address lookup without losing pinned target checks", async () => {
  const server = createServer((_req, res) => res.end('{"data":[]}'));
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    assert.deepEqual(await readModelJson(`http://localhost:${server.address().port}`, "/v1/models", "", 1000), { data: [] });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
