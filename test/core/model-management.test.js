import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync, statSync } from "node:fs";
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Model observations use bounded reads; failed quota is not zero or stale success", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-models-http-"));
  let fail = false;
  const requested = [];
  const server = createServer((req, res) => {
    requested.push(req.url);
    res.setHeader("content-type", "application/json");
    if (fail) { res.statusCode = 500; res.end("secret-test-value"); return; }
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "factory/claude", api_key: "do-not-project" }] })); return;
    }
    assert.equal(req.headers.authorization, "Bearer secret-test-value");
    res.end(JSON.stringify({ accounts: [{ id: "private-account", quota: {
      groups: [{ displayName: "Standard", buckets: [{ window: "weekly", remainingFraction: 0 }] }]
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
    const quota = await service.refresh({ revision, kind: "quota", source: "factory" });
    assert.equal(quota.status, "success");
    assert.equal(quota.items[0].windows[0].remainingFraction, 0);
    assert.equal(quota.items[0].balance, null);
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
