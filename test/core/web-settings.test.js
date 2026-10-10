import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createAgentProfile } from "../../dist/profile/agentProfile.js";
import { runConfigCommand } from "../../dist/commands/configCommands.js";
import { staticAgentConfigurationFields } from "../../dist/executor/agentConfigurationFields.js";
import { createWebSettings } from "../../dist/web/webSettings.js";
import { WebRequestRejected } from "../../dist/web/webMutation.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";
import { PREFS_SCRIPT } from "../../dist/web/assets/client/lib/prefs.js";
import { SETTINGS_SCRIPT } from "../../dist/web/assets/client/app/settings.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-settings-"));
  let store;
  t.after(() => { store?.close(); rmSync(home, { recursive: true, force: true }); });
  store = new SqliteTaskStore(home);
  const agent = createConfiguredAgent("fixture", "codex", "unused", [], [
    { target: "API_TOKEN", source: "process", sourceName: "FIXTURE_SECRET", required: true }
  ], new Date());
  store.saveConfiguredAgent(agent);
  store.saveGlobalRole(createGlobalRole("worker", [createRoleAgentBinding(agent)], agent.id, home, new Date()));
  store.saveAgentProfile(createAgentProfile({ id: "reader", runtime: { source: "global-worker" } }, new Date()));
  let refreshed = 0;
  const queries = [];
  const service = createWebSettings(store, {
    environment: { FIXTURE_SECRET: "must-never-be-exposed" },
    catalogs: { resolve: async input => {
      queries.push(input);
      return { source: "fallback", attemptedAt: new Date().toISOString(),
        failure: { code: "missing-command", message: "Fixture has no native provider." },
        catalog: { schemaVersion: 1, agentId: input.agent.id, adapterId: "codex", models: [],
          fields: staticAgentConfigurationFields("codex"), warnings: ["Native enumeration unavailable."] } };
    } },
    refreshConfiguration: () => { refreshed++; }
  });
  const save = (id, changes, extra = {}) => service.save({ id, revision: service.read(id).revision, changes, ...extra });
  return { home, store, service, save, queries, refreshed: () => refreshed };
}

test("settings use CLI defaults and validation, atomic group writes, stale-read protection and supported reset", async t => {
  const f = fixture(t);
  assert.deepEqual(f.service.read("system").fields.find(f => f.key === "time-zone").value,
    runConfigCommand("system", ["show"], f.store).data.timeZone);
  const original = f.service.read("runtime");
  await assert.rejects(f.save("runtime", [
    { key: "delivery-timeout-seconds", value: 240 },
    { key: "controller-task-concurrency", value: 0 }
  ]), WebRequestRejected);
  assert.equal(f.service.read("runtime").revision, original.revision, "failed group rolls back earlier valid fields");
  const saved = await f.save("runtime", [
    { key: "delivery-timeout-seconds", value: 240 },
    { key: "reconciliation-interval-seconds", value: 40 }
  ]);
  assert.equal(saved.status, "saved");
  assert.equal(f.refreshed(), 1);
  assert.equal(f.store.getConfig().deliveryTimeoutSeconds, 240);
  await assert.rejects(f.service.save({ id: "runtime", revision: original.revision,
    changes: [{ key: "delivery-timeout-seconds", value: 300 }] }), /changed since/);
  await f.save("runtime", [{ key: "delivery-timeout-seconds", reset: true }]);
  const reset = f.service.read("runtime").fields.find(f => f.key === "delivery-timeout-seconds");
  assert.equal(reset.source, "default");
  assert.equal(reset.value, reset.defaultValue);
  await f.save("workflow", [{ key: "review", value: { roleName: "worker", trigger: "final" } }]);
  assert.equal(runConfigCommand("workflow", ["show"], f.store).data.review.trigger, "final");
  await f.save("resources", [{ key: "resources-gc-mode", value: "quarantine" }]);
  await f.save("tools", [{ key: "tmux-history-limit", value: 2000 }]);
  assert.equal(f.store.getConfig().tmuxHistoryLimit, 2000);
  assert.match(f.service.read("tools").fields.find(f => f.key === "tmux-history-limit").takesEffect, /New tmux sessions/);
  for (const group of f.service.index().groups) {
    for (const field of f.service.read(group.id).fields) {
      assert.ok(f.service.index(field.key).groups.some(g => g.id === group.id),
        `${group.id} is searchable by its actual field ${field.key}`);
    }
  }
});

test("Agent/Role/Profile settings retain existing ownership, environment references and honest capability failures", async t => {
  const f = fixture(t);
  const agent = f.service.read("agent/fixture");
  assert.doesNotMatch(JSON.stringify(agent), /must-never-be-exposed/);
  assert.equal(agent.observation.environment[0].present, true);
  await f.save("agent/fixture", [{ key: "baseArgs", value: ["--fixture", "a b"] }]);
  assert.deepEqual(f.store.getConfiguredAgent("fixture").baseArgs, ["--fixture", "a b"]);
  await assert.rejects(f.save("agent/fixture", [{ key: "environment", value: [
    { target: "API_TOKEN", source: "literal", value: "secret" }
  ] }]), /references/);
  const role = f.store.getGlobalRole("worker");
  await f.save("role/worker", [{ key: "model", value: "explicit-model" }, { key: "systemPrompt", value: "Keep answers concise" }]);
  assert.equal(f.store.getGlobalRole("worker").agentBindings.fixture.config.model, "explicit-model");
  assert.equal(f.store.getGlobalRole("worker").launchRevision, role.launchRevision + 1);
  assert.equal(f.store.getGlobalRoleSessionSet("worker"), null, "save never launches a Session");
  assert.equal(f.service.read("profile/reader").observation.source, "global-worker");
  await f.save("profile/reader", [{ key: "agent", value: "fixture" }, { key: "model", value: "explicit-model" }]);
  assert.equal(f.store.getAgentProfile("reader").runtime.source, "explicit");
  await f.save("profile/reader", [{ key: "agent", value: "" }]);
  assert.equal(f.store.getAgentProfile("reader").runtime.source, "global-worker");
  const result = await f.service.capabilities("role/worker", true);
  assert.equal(result.source, "fallback");
  assert.equal(result.failure.code, "missing-command");
  assert.deepEqual(result.catalog.models, []);
  assert.equal(f.queries.at(-1).refresh, true);
  assert.equal(f.queries.at(-1).config.model, "explicit-model");
  const now = new Date();
  const desired = f.store.getGlobalRole("worker");
  const sessions = recordRoleAgentSession(createRoleSessionSet({ scope: "global", roleName: "worker" }, "fixture", now), {
    agentId: "fixture", adapterId: "codex", nativeSessionId: "fixture-session", status: "active",
    policy: "fixed", effective: resolveEffectiveLaunch({ role: desired, purpose: "execution" })
  }, now);
  f.store.saveGlobalRoleSessionSet(sessions);
  await assert.rejects(f.save("role/worker", [{ key: "model", value: "next-model" }]), /live native Session/);
  await f.save("role/worker", [{ key: "model", value: "next-model" }], { acknowledgeLive: true });
  assert.deepEqual(f.store.getGlobalRoleSessionSet("worker"), sessions, "acknowledgement stores desired settings without adopting them");
  await assert.rejects(f.save("agent/fixture", [{ key: "command", value: "next-command" }]), /live native session/);
  await f.save("agent/fixture", [{ key: "command", value: "next-command" }], { acknowledgeLive: true });
  assert.deepEqual(f.store.getGlobalRoleSessionSet("worker"), sessions);
});

test("settings HTTP ingress requires page token and reports rejected writes without exposing environment values", async t => {
  const f = fixture(t);
  const server = createYuiWebServer(f.store, { settings: f.service, token: "fixture-token" });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "x-yui-web-token": "fixture-token", "content-type": "application/json" };
  assert.equal((await fetch(base + "/api/settings")).status, 403);
  assert.equal((await fetch(base + "/settings")).status, 200);
  const list = await (await fetch(base + "/api/settings", { headers })).json();
  assert.ok(list.groups.some(g => g.id === "profile/reader"));
  const read = await (await fetch(base + "/api/settings/group?id=system", { headers })).json();
  const response = await fetch(base + "/api/settings/group", { method: "POST", headers,
    body: JSON.stringify({ id: "system", revision: read.revision, changes: [{ key: "default-agent", value: "missing" }] }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).disposition, "not-submitted");
});

test("Role default model/effort saves validate the selected model without changing a live Session", async t => {
  const f = fixture(t);
  const service = createWebSettings(f.store, {
    environment: {},
    catalogs: { resolve: async () => ({
      source: "live", attemptedAt: "2026-10-10T00:00:00Z",
      catalog: { schemaVersion: 1, agentId: "fixture", adapterId: "codex",
        fields: [{ key: "model", choices: [], allowCustom: false }],
        models: [
          { value: "fast", label: "Fast", isDefault: true, efforts: [{ value: "low", label: "Low" }] },
          { value: "deep", label: "Deep", isDefault: false, efforts: [{ value: "high", label: "High" }] }
        ], warnings: [] }
    }) }
  });
  const save = changes => service.save({ id: "role/worker", revision: service.read("role/worker").revision, changes });
  await save([{ key: "model", value: "fast" }, { key: "effort", value: "low" }]);
  const before = service.read("role/worker");
  await assert.rejects(save([{ key: "model", value: "deep" }]), /field=effort/);
  assert.equal(service.read("role/worker").revision, before.revision);
  await assert.rejects(save([{ key: "model", value: "missing" }]), /field=model/);
  await save([{ key: "model", value: "deep" }, { key: "effort", value: "high" }]);
  await save([{ key: "model", reset: true }, { key: "effort", reset: true }]);
  assert.equal(f.store.getGlobalRoleSessionSet("worker"), null);
  assert.equal(service.read("role/worker").fields.find(f => f.key === "model").source, "native/default");
});

test("browser session access preference is isolated, validated and truthful when storage fails", () => {
  const values = new Map();
  const context = vm.createContext({ localStorage: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)
  } });
  vm.runInContext(PREFS_SCRIPT.replace(/^export /gm, ""), context);
  assert.equal(context.readSessionAccessMode(), "native");
  assert.equal(context.writeSessionAccessMode("structured"), true);
  assert.equal(context.readSessionAccessMode(), "structured");
  assert.throws(() => context.writeSessionAccessMode("invented"));
  context.localStorage.setItem = () => { throw Error("denied"); };
  assert.equal(context.writeSessionAccessMode("native"), false);
  context.localStorage.getItem = context.localStorage.removeItem = () => { throw Error("denied"); };
  assert.equal(context.writeSessionAccessMode("native"), false, "read fallback is not a successful write");
  assert.equal(context.clearPreference("yui.dock.width"), false);
  assert.equal(values.get("yui.session.accessMode"), "structured");
});

test("settings editor preserves drafts and unknown receipts, with model-dependent capability choices", async () => {
  function element(spec, attrs, ...children) {
    const result = {
      tagName: spec.split(".")[0].toUpperCase(), value: "", checked: false, disabled: false,
      dataset: {}, handlers: {}, children: [], classList: { add() {} },
      append(...items) {
        const children = items.flat().filter(x => x != null);
        for (const child of children) if (typeof child === "object") child.parent = this;
        this.children.push(...children);
      },
      replaceChildren(...items) { this.children = []; this.append(...items); },
      addEventListener(name, fn) {
        const previous = this.handlers[name];
        this.handlers[name] = previous ? event => { previous(event); return fn(event); } : fn;
      },
      setAttribute(name, value) { this[name] = value; },
      remove() {},
      after() {},
      before(...items) {
        if (!this.parent) return;
        for (const item of items) item.parent = this.parent;
        this.parent.children.splice(this.parent.children.indexOf(this), 0, ...items);
      },
      focus() {},
      querySelectorAll(selector) {
        const tags = selector.toUpperCase().split(",");
        const visit = node => typeof node === "object" ? [
          ...(tags.includes(node.tagName) ? [node] : []), ...node.children.flatMap(visit)
        ] : [];
        return this.children.flatMap(visit);
      }
    };
    if (attrs) for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith("on")) result.addEventListener(key.slice(2), value);
      else result[key] = value;
    }
    result.append(...children);
    return result;
  }
  const shell = new Map();
  let failure = Object.assign(Error("Invalid value"), { disposition: "not-submitted" });
  let saved;
  let submissions = 0;
  const context = vm.createContext({
    h: element, URLSearchParams,
    document: { querySelector: key => {
      if (!shell.has(key)) shell.set(key, element("div"));
      return shell.get(key);
    } },
    window: { addEventListener() {} },
    createI18n: () => ({ t: k => k, subscribe() {} }), createThemeController: () => ({}),
    readSessionAccessMode: () => "native", writeSessionAccessMode: () => true,
    readPreference: () => null, clearPreference: () => false,
    requestJson: async () => ({}),
    submitMutation: async () => { submissions++; if (failure) throw failure; return saved; }
  });
  vm.runInContext(SETTINGS_SCRIPT.replace(/^import .*;\n/gm, "").replace("void start();", ""), context);
  shell.get("#reset-layout").handlers.click();
  assert.equal(shell.get("#browser-receipt").textContent, "settings.storageFailed");
  const cleared = [];
  context.clearPreference = key => { cleared.push(key); return true; };
  shell.get("#reset-layout").handlers.click();
  assert.equal(cleared.length, 4);
  assert.equal(shell.get("#browser-receipt").textContent, "settings.layoutReset");
  const group = { id: "runtime", revision: "first", notice: "next launch",
    fields: [{ key: "delivery-timeout-seconds", label: "Timeout", kind: "number", value: 120, reset: true }] };
  const state = { content: element("div"), pending: false };
  context.renderGroup(state, group);
  const draft = state.editors[0].control;
  draft.value = "bad"; draft.handlers.input();
  await state.content.children[0].handlers.submit({ preventDefault() {} });
  assert.equal(submissions, 0, "basic validation happens before submission");
  draft.value = "240"; draft.handlers.input();
  await state.content.children[0].handlers.submit({ preventDefault() {} });
  assert.equal(draft.value, "240");
  assert.equal(state.dirty, true);
  assert.equal(state.save.disabled, false, "proven rejection is editable");
  failure = Object.assign(Error("Connection lost"), { disposition: "unknown" });
  await state.content.children[0].handlers.submit({ preventDefault() {} });
  assert.equal(draft.value, "240");
  assert.equal(state.unknown, true);
  assert.equal(state.save.disabled, true);
  const unknownReceipt = state.receipt.textContent;
  draft.value = "300"; draft.handlers.input();
  assert.equal(state.receipt.textContent, unknownReceipt, "editing never erases the unknown-write warning");
  const count = submissions;
  await state.content.children[0].handlers.submit({ preventDefault() {} });
  assert.equal(submissions, count, "unknown outcome is not replayed");
  // A fresh, explicitly reconciled page receives a fresh read revision.
  context.renderGroup(state, { ...group, revision: "reconciled" });
  state.editors[0].control.value = "240"; state.editors[0].control.handlers.input();
  failure = null;
  saved = { group: { ...group, revision: "saved", fields: [{ ...group.fields[0], value: 240 }] },
    output: "saved 240", adoption: "next launch", refresh: "not-required" };
  await state.content.children[0].handlers.submit({ preventDefault() {} });
  assert.equal(state.dirty, false);
  assert.equal(state.group.revision, "saved");
  assert.equal(state.editors[0].control.value, "240");

  const roleGroup = { id: "role/worker", agentId: "fixture", revision: "role-first", notice: "next launch",
    fields: [
      { key: "model", label: "Model", kind: "text", value: "fast", reset: true },
      { key: "effort", label: "Effort", kind: "text", value: "low", reset: true },
      { key: "systemPrompt", label: "Instructions", kind: "multiline", value: "" }
    ] };
  context.renderGroup(state, roleGroup);
  const catalog = { agentId: "fixture", models: [
    { value: "fast", label: "Fast", isDefault: true, efforts: [{ value: "low", label: "Low" }] },
    { value: "deep", label: "Deep", efforts: [{ value: "high", label: "High" }] }
  ], fields: [{ key: "model", allowCustom: true }, { key: "effort", allowCustom: true }], warnings: [] };
  let resolveCapabilities;
  context.requestJson = () => new Promise(resolve => { resolveCapabilities = resolve; });
  const query = state.content.querySelectorAll("button").find(button => button.children.includes("settings.queryCapabilities"));
  const capabilityRead = query.handlers.click();
  const beforeQuerySubmit = submissions;
  await state.content.children[0].handlers.submit({ preventDefault() {} });
  assert.equal(submissions, beforeQuerySubmit, "submission waits for the in-flight capability read");
  resolveCapabilities({ source: "cache", fetchedAt: "2026-10-10T00:00:00Z", catalog });
  await capabilityRead;
  assert.equal(state.capabilityPending, false);
  assert.equal(query.disabled, false);
  const [model, effort] = state.editors;
  assert.equal(model.control.tagName, "SELECT");
  assert.equal(effort.control.tagName, "SELECT");
  assert.equal(state.dirty, false, "a capability read does not change defaults");
  model.control.value = "deep"; model.control.handlers.change();
  assert.equal(effort.control.value, "low", "model changes never silently replace an effort draft");
  assert.ok(effort.control.children.some(option => option.value === "high"));
  effort.control.value = ""; effort.control.handlers.change();
  assert.equal(effort.change().reset, true, "native default uses the existing clear operation");
  const custom = model.row.querySelectorAll("button").find(button => button.children.includes("settings.custom"));
  custom.handlers.click();
  assert.equal(model.control.tagName, "INPUT");
  model.control.value = "private-model"; model.control.handlers.change();
  context.applyCapabilities(state, { catalog });
  assert.equal(model.control.value, "private-model", "refresh retains custom or unlisted drafts");
  context.applyCapabilities(state, { catalog: { ...catalog, models: [],
    fields: [{ key: "model", available: false, allowCustom: false, reason: "Not supported" }] } });
  assert.equal(model.control.disabled, true);
  assert.equal(model.control.value, "private-model");
  assert.equal(model.blocked, true, "unavailable capability cannot submit a changed draft");
});
