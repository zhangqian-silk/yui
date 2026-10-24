import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelManagement } from "../../dist/models/modelManagement.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { createRoleSessionSet, recordRoleAgentSession, updateRoleAgentSessionStatus, bindGlobalRoleProviderRuntime } from "../../dist/executor/agentExecutor.js";
import { createProviderRuntimeBinding } from "../../dist/runtime/providerRuntimeIdentity.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import Database from "../../dist/sqlite/driver.js";

function fixture(request) {
  let config = { schemaVersion: 1 };
  const store = { getConfig: () => structuredClone(config), saveConfig: c => { config = structuredClone(c); },
    transaction: fn => fn(store), getConfiguredAgent: id => ({ id, adapterId: id === "claude" ? "claude" : "codex" }) };
  const service = createModelManagement(store, { request });
  let n = 0;
  const save = (kind, resource, extra = {}) => service.saveResource({
    revision: service.readRegistry().revision, requestId: `r${++n}`, kind, resource, ...extra
  });
  return { service, save, store };
}
const cpa = { id: "shared", kind: "cliproxyapi", version: "8.0.12", managementUrl: "http://127.0.0.1:8317",
  managementKeyFile: "", configFile: "", maintenance: "external", quotaAdapter: "none" };
const endpoint = { id: "api", moduleId: null, url: "http://127.0.0.1:8317/v1", protocol: "responses", clientKeyFile: "" };

test("independent endpoints/native and shared CPA bindings are revisioned and protocol-specific without network", () => {
  const f = fixture(() => { throw new Error("registration must not contact a service"); });
  f.save("endpoint", endpoint);
  f.save("binding", { agentId: "codex", adapterId: "codex", endpointId: "api", model: "test", scope: "yui-new-session" });
  assert.equal(f.service.read().registry.modules.length, 0);
  f.save("module", cpa);
  f.save("endpoint", { ...endpoint, moduleId: "shared" });
  f.save("endpoint", { ...endpoint, id: "messages", moduleId: "shared", protocol: "anthropic-messages", clientKeyFile: "/private/client-key" });
  const binding = { agentId: "claude", adapterId: "claude", endpointId: "api", model: "test", scope: "yui-new-session" };
  assert.throws(() => f.save("binding", binding), /protocol/);
  f.save("binding", { ...binding, endpointId: "messages" });
  assert.equal(f.service.read().registry.modules.length, 1);
  assert.throws(() => f.save("binding", { ...binding, endpointId: null }), /Native/);
  f.save("binding", { ...binding, endpointId: null, model: "" });
  assert.equal(f.service.read().registry.bindings[1].endpointId, null);
  const stale = f.service.readRegistry().revision;
  const input = { revision: stale, requestId: "exact", kind: "module", resource: { ...cpa, version: "fixture" } };
  f.service.saveResource(input);
  assert.equal(f.service.saveResource(input).replayed, true);
  assert.throws(() => f.service.saveResource({ ...input, resource: cpa }), /requestId/);
  assert.throws(() => f.service.saveResource({ ...input, requestId: "other" }), /changed/);
  assert.throws(() => f.save("module", undefined, { removeId: "shared" }), /missing module/);
});

test("resource observations keep last success and are shared by module, never by Agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-registry-"));
  let fail = false;
  let accountFailure = false;
  const calls = [];
  try {
    const key = join(root, "management.key");
    writeFileSync(key, "private-management", { mode: 0o600 });
    const f = fixture(async (base, path, credential) => {
      calls.push({ base, path, credential });
      if (fail) throw new Error("upstream-private-message");
      if (path === "/models") return { data: [{ id: "test" }] };
      return { accounts: [{ id: "private-account", ...(accountFailure ? { error: "private-detail" } : { quota: {
        groups: [{ displayName: "Standard", buckets: [{ window: "week", remainingFraction: 0 }] }]
      } }) }, { id: "second-account", quota: { groups: [] } }] };
    });
    f.save("module", { ...cpa, managementKeyFile: key, quotaAdapter: "factory-quota-v1" });
    f.save("endpoint", endpoint);
    assert.equal(calls.length, 0);
    const refresh = (kind, resourceId, source) => f.service.refresh({
      revision: f.service.readRegistry().revision, kind, resourceId, ...(source ? { source } : {})
    });
    assert.equal((await refresh("catalog", "api")).status, "success");
    assert.equal(calls[0].credential, "", "management key must not reach inference catalog");
    const quota = await refresh("quota", "shared", "factory");
    assert.equal(quota.items[0].windows[0].remainingFraction, 0);
    assert.equal(quota.items[0].balance, null);
    assert.equal(calls[1].credential, "private-management");
    accountFailure = true;
    const partial = await refresh("quota", "shared", "factory");
    assert.equal(partial.status, "partial");
    assert.equal(partial.stale, true);
    assert.equal(partial.items[0].stale, true);
    assert.equal(partial.items[0].observedAt, quota.items[0].observedAt);
    assert.deepEqual(partial.items[0].windows, quota.items[0].windows);
    assert.equal(partial.items[0].error, "account-query-failed");
    fail = true;
    const failed = await refresh("quota", "shared", "factory");
    assert.equal(failed.status, "failed");
    assert.equal(failed.stale, true);
    assert.equal(failed.observedAt, partial.observedAt);
    assert.deepEqual(failed.items, partial.items);
    assert.equal(JSON.stringify(failed).includes("private-account"), false);
    assert.equal(JSON.stringify(failed).includes("private-management"), false);
    const before = calls.length;
    f.service.read(); f.service.readQuota("factory", "shared"); f.service.readCatalog("0", "api");
    assert.equal(calls.length, before, "cached reads must not refresh");
    assert.deepEqual(calls.map(c => c.path), ["/models", ...Array(3).fill("/v0/management/plugins/factory-quota/accounts")]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exact credential origins and native-field status reread preserve authority and last success", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-model-native-config-"));
  try {
    const file = join(root, "config.yaml");
    const before = "config-version: 8\nrouting:\n  strategy: round-robin\n";
    writeFileSync(file, before, { mode: 0o600 });
    const f = fixture(() => { throw new Error("no network allowed"); });
    f.save("module", { ...cpa, configFile: file, managementKeyFile: "/private/management" });
    assert.throws(() => f.save("module", { ...cpa, configFile: file, managementKeyFile: "/private/management",
      managementUrl: "https://other.example" }), /origin/);
    const refresh = () => f.service.refresh({ revision: f.service.readRegistry().revision, kind: "status", resourceId: "shared" });
    const original = await refresh();
    assert.equal(original.items[0].runtime, "unknown");
    // A fixture's native authority edit, not a second Yui config writer.
    const after = "config-version: 8\nrouting:\n  strategy: fill-first\n";
    writeFileSync(file, after, { mode: 0o600 });
    assert.equal(f.service.readStatus("shared").items[0].configurationRevision, original.items[0].configurationRevision);
    const reread = await refresh();
    assert.notEqual(reread.items[0].configurationRevision, original.items[0].configurationRevision);
    assert.equal(JSON.stringify(reread).includes("fill-first"), false);
    rmSync(file);
    const failed = await refresh();
    assert.equal(failed.stale, true);
    assert.deepEqual(failed.items, reread.items);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("quota wire responses distinguish unknown pools, distinct units and all-account failures", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-model-quota-wire-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = join(root, "key");
  writeFileSync(key, "fixture", { mode: 0o600 });
  let raw = { accounts: [{ id: "one", quota: { groups: [{ buckets: [{ remainingFraction: 0.5 }] }],
    summary: [{ key: "extra_usage_balance", currency: "USD", value: 4 }] } }] };
  const f = fixture(async () => raw);
  f.save("module", { ...cpa, managementKeyFile: key, quotaAdapter: "factory-quota-v1" });
  const refresh = source => f.service.refresh({ revision: f.service.readRegistry().revision,
    kind: "quota", resourceId: "shared", source });
  const success = await refresh("factory");
  assert.equal(success.items[0].balance, null, "USD extra usage is not an account total");
  assert.deepEqual(success.items[0].balanceDetails, [{ kind: "extra-usage-usd", value: 4 }]);
  raw = { accounts: [{ id: "one", error: "private failure" }] };
  const failed = await refresh("factory");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "account-query-failed");
  assert.equal(failed.observedAt, success.observedAt);
  assert.deepEqual(failed.items, success.items);
  raw = { windows: [], balance: 100, credits: { monthlyCredits: 0, purchasedCredits: 2 } };
  const partial = await refresh("command-code");
  assert.equal(partial.items[0].balance, null);
  assert.equal(partial.status, "partial");
  raw = { ...raw, balance: 5, credits: { ...raw.credits, freeCredits: 3 } };
  const full = await refresh("command-code");
  assert.equal(full.items[0].balance, 5);
  assert.equal(full.items[0].balanceDetails[0].value, 0);
  assert.equal(full.status, "success");
});

test("central storage 1.23 migration converts only references and archives original configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-model-migration-"));
  try {
    const store = new SqliteTaskStore(root);
    store.close();
    const old = { schemaVersion: 1, modelManagement: { bridgeUrl: "http://127.0.0.1:8318",
      bridgeConfigFile: "/not-read/bridge.json", cpaUrl: "http://127.0.0.1:8317",
      managementKeyFile: "/not-read/management", catalogKeyFile: "/not-read/client" } };
    const db = new Database(join(root, "yui.db"));
    db.prepare("INSERT OR REPLACE INTO config(id,payload,updated_at) VALUES(1,?,?)").run(JSON.stringify(old), new Date().toISOString());
    db.prepare("UPDATE storage_schema SET minor=23").run();
    db.close();
    assert.equal((await runStorageUpgrade({ home: root, mode: "execute" })).outcome, "upgraded");
    const current = new SqliteTaskStore(root);
    try {
      const registry = current.getConfig().modelManagement;
      assert.equal(registry.modules.length, 2);
      assert.equal(registry.endpoints.length, 1);
      assert.deepEqual(registry.bindings, []);
      assert.ok(registry.modules.every(m => m.maintenance === "external" && m.quotaAdapter === "none"));
      const archived = current.databaseHandle().prepare("SELECT payload FROM storage_migration_archive WHERE migration_version=24 AND family='config'").get();
      assert.deepEqual(JSON.parse(archived.payload), old);
    } finally { current.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real planner start/restore pins each Agent endpoint without daemon restart, user config mutation or secret snapshots", t => {
  for (const adapterId of ["codex", "claude"]) {
    const root = mkdtempSync(join(tmpdir(), "yui-model-launch-"));
    const store = new SqliteTaskStore(root);
    t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
    const at = new Date("2026-10-24T00:00:00Z");
    const agent = createConfiguredAgent(adapterId, adapterId, "/fixture/never-execute", [], [], at);
    store.saveConfiguredAgent(agent);
    const role = createGlobalRole("assistant", [createRoleAgentBinding(agent)], agent.id, root, at);
    store.saveGlobalRole(role);
    const keyFile = join(root, "client.key");
    writeFileSync(keyFile, "fixture-client-secret", { mode: 0o600 });
    const service = createModelManagement(store);
    const save = (kind, resource, requestId) => service.saveResource({
      revision: service.readRegistry().revision, requestId, kind, resource
    });
    save("endpoint", { ...endpoint, url: adapterId === "codex" ? endpoint.url : "http://127.0.0.1:8317",
      protocol: adapterId === "codex" ? "responses" : "anthropic-messages", clientKeyFile: keyFile }, "endpoint");
    save("binding", { agentId: agent.id, adapterId, endpointId: "api", model: "fixture-model", scope: "yui-new-session" }, "binding");
    const planner = new FileRoleLaunchPlanner(root, store, { environment: { HOME: root, PATH: process.env.PATH,
      ANTHROPIC_CUSTOM_HEADERS: "private-native-header", CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "private-native-oauth" } });
    const input = { roleName: role.name, agentId: agent.id, adapterId };
    const started = planner.planGlobalRole({ ...input, mode: "new" });
    const effective = resolveEffectiveLaunch({ store, role, purpose: "execution" });
    assert.equal(effective.model, "fixture-model", "effective model must match the actual endpoint launch");
    const nativeSessionId = adapterId === "codex" ? "fixture-thread" : started.session.nativeSessionId;
    const sessionSet = recordRoleAgentSession(
      createRoleSessionSet({ scope: "global", roleName: role.name }, agent.id, at),
      { agentId: agent.id, adapterId, nativeSessionId, status: "active", policy: "fixed", effective }, at);
    store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(sessionSet, createProviderRuntimeBinding({
      providerNamespace: adapterId === "codex" ? "openai/codex" : "anthropic/claude-code",
      accountScope: adapterId, conversationId: nativeSessionId, startedAt: at.toISOString()
    }), at));
    save("endpoint", { ...endpoint, url: "https://replacement.example" + (adapterId === "codex" ? "/v1" : ""),
      protocol: adapterId === "codex" ? "responses" : "anthropic-messages", clientKeyFile: keyFile + ".new" }, "changed-endpoint");
    const restored = planner.planGlobalRole({ ...input, mode: "resume", nativeSessionId });
    if (adapterId === "codex") {
      const provider = restored.launch.providerControl.codexThread.config.model_providers.yui_endpoint;
      assert.equal(provider.base_url, endpoint.url);
      assert.equal(provider.http_headers.Authorization, "Bearer fixture-client-secret");
      assert.equal(restored.launch.providerControl.codexThread.model, "fixture-model");
      assert.ok(!restored.launch.args.includes("--restart"));
    } else {
      assert.equal(restored.launch.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8317");
      assert.equal(restored.launch.env.ANTHROPIC_AUTH_TOKEN, "fixture-client-secret");
      assert.equal(restored.launch.env.ANTHROPIC_API_KEY, "");
      assert.equal(restored.launch.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
      assert.equal(restored.launch.env.CLAUDE_CODE_USE_BEDROCK, undefined);
      assert.equal(restored.launch.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    }
    assert.equal(JSON.stringify(effective).includes("fixture-client-secret"), false);
    assert.equal(JSON.stringify(service.read()).includes("fixture-client-secret"), false);
    const ended = updateRoleAgentSessionStatus(store.getGlobalRoleSessionSet(role.name), agent.id, "ended", at, "stopped");
    store.saveGlobalRoleSessionSet(ended);
    const fresh = resolveEffectiveLaunch({ store, role, purpose: "execution" });
    assert.match(fresh.modelEndpoint.endpoint.url, /replacement/);
  }
});
