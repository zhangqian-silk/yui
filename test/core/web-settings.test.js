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
import { SETTINGS_STYLES } from "../../dist/web/assets/styles/views/settings.js";

const nodeText = node => typeof node === "object" && node
  ? [node.textContent || "", ...Array.from(node.children || [], nodeText)].join(" ")
  : String(node);

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
    environment: { HOME: home, FIXTURE_SECRET: "must-never-be-exposed" },
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
  assert.deepEqual(f.service.index().supportedAgents.find(a => a.id === "codex-cli").configuredIds, ["fixture"]);
  assert.deepEqual(f.service.index().supportedAgents.find(a => a.id === "claude-code-cli").configuredIds, []);
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
  const role = f.service.read("role/worker");
  const request = { id: "role/worker", revision: role.revision, changes: [{ key: "enabled", value: false }] };
  assert.equal((await fetch(base + "/api/settings/group", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(request) })).status, 403);
  assert.notEqual(f.store.getGlobalRole("worker").enabled, false);
  const disabled = await fetch(base + "/api/settings/group", { method: "POST", headers, body: JSON.stringify(request) });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).group.fields.find(f => f.key === "enabled").value, false);
  assert.equal(f.store.getGlobalRoleSessionSet("worker"), null);
  await f.save("role/worker", [{ key: "enabled", value: true }]);
  await f.save("profile/reader", [{ key: "enabled", value: false }]);
  assert.match(f.service.read("profile/reader").observation.reason, /disabled/);
  await f.save("profile/reader", [{ key: "enabled", value: true }]);
  assert.equal(f.service.read("profile/reader").observation.status, "resolved");
  await assert.rejects(f.save("profile/reader", [{ key: "enabled", value: "false" }]), /boolean/);
});

test("Role default model/effort saves validate the selected model without changing a live Session", async t => {
  const f = fixture(t);
  const service = createWebSettings(f.store, {
    environment: { HOME: f.home },
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
  assert.equal(context.readSessionAccessMode(), "structured", "conversation is the default");
  assert.equal(context.writeSessionAccessMode("native"), true);
  assert.equal(context.readSessionAccessMode(), "native");
  assert.throws(() => context.writeSessionAccessMode("invented"));
  context.localStorage.setItem = () => { throw Error("denied"); };
  assert.equal(context.writeSessionAccessMode("structured"), false);
  context.localStorage.getItem = context.localStorage.removeItem = () => { throw Error("denied"); };
  assert.equal(context.writeSessionAccessMode("structured"), false, "read fallback is not a successful write");
  assert.equal(context.clearPreference("yui.dock.width"), false);
  assert.equal(values.get("yui.session.accessMode"), "native");
});

test("settings editor preserves drafts and unknown receipts, with model-dependent capability choices", async () => {
  let activeElement = null;
  const childCollection = (items = []) => new Proxy(items, {
    get(target, key, receiver) {
      // HTMLCollection supports indexed iteration but not Array#forEach.
      if (key === "forEach") return undefined;
      return Reflect.get(target, key, receiver);
    }
  });
  function element(spec, attrs, ...children) {
    const result = {
      tagName: spec.split(".")[0].toUpperCase(), value: "", checked: false, disabled: false,
      dataset: {}, handlers: {}, children: childCollection(), classList: { add() {} },
      get parentElement() { return this.parent && this.parent.tagName ? this.parent : null; },
      get parentNode() { return this.parent || null; },
      append(...items) {
        const children = items.flat().filter(x => x != null);
        for (const child of children) if (typeof child === "object") {
          if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
          child.parent = this;
        }
        this.children.push(...children);
      },
      replaceChildren(...items) { this.children = childCollection(); this.append(...items); },
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
      focus() { this.focused = true; activeElement = this; },
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
  const shown = [];
  const panels = ["preferences", "skills", "server", "agents"].map(section => ({ hidden: false, dataset: { section } }));
  let skillOptions;
  let failure = Object.assign(Error("Invalid value"), { disposition: "not-submitted" });
  let saved;
  let submissions = 0;
  let language = "";
  const translations = [];
  const context = vm.createContext({
    h: element, URLSearchParams,
    document: { get activeElement() { return activeElement; }, querySelector: key => {
      if (!shell.has(key)) shell.set(key, element("div"));
      return shell.get(key);
    }, querySelectorAll: () => panels },
    window: { addEventListener() {}, location: { search: "?section=server" }, history: { pushState() {} }, scrollTo() {} },
    i18n: { t: k => language + k, subscribe(fn) { translations.push(fn); } }, createThemeController: () => ({ render() {} }),
    registerManagePage() {}, navigateManage() {},
    pageSections: () => ["preferences", "skills", "server"],
    createManageShell: () => ({ set: section => shown.push(section), setDirty() {}, render() {} }),
    mountSkills: (root, t, options) => { skillOptions = options; },
    readSessionAccessMode: () => "native", writeSessionAccessMode: () => true,
    readPreference: () => null, clearPreference: () => false,
    requestJson: async () => ({}),
    submitMutation: async () => { submissions++; if (failure) throw failure; return saved; }
  });
  vm.runInContext(SETTINGS_SCRIPT.replace(/^import .*;\n/gm, "").replace("void start();", ""), context);
  // A direct open of ?section=server shows only that section in the shared rail.
  assert.deepEqual(shown, ["server"]);
  assert.deepEqual(panels.map(panel => panel.hidden), [true, true, false, true]);
  assert.equal(skillOptions.heading, false, "the section heading replaces the Skills card title");
  assert.equal(typeof skillOptions.onDirty, "function");
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
  await state.form.handlers.submit({ preventDefault() {} });
  assert.equal(submissions, 0, "basic validation happens before submission");
  draft.value = "240"; draft.handlers.input();
  await state.form.handlers.submit({ preventDefault() {} });
  assert.equal(draft.value, "240");
  assert.equal(state.dirty, true);
  assert.equal(state.save.disabled, false, "proven rejection is editable");
  failure = Object.assign(Error("Connection lost"), { disposition: "unknown" });
  await state.form.handlers.submit({ preventDefault() {} });
  assert.equal(draft.value, "240");
  assert.equal(state.unknown, true);
  assert.equal(state.save.disabled, true);
  const unknownReceipt = state.receipt.textContent;
  draft.value = "300"; draft.handlers.input();
  assert.equal(state.receipt.textContent, unknownReceipt, "editing never erases the unknown-write warning");
  const count = submissions;
  await state.form.handlers.submit({ preventDefault() {} });
  assert.equal(submissions, count, "unknown outcome is not replayed");
  // A fresh, explicitly reconciled page receives a fresh read revision.
  context.renderGroup(state, { ...group, revision: "reconciled" });
  state.editors[0].control.value = "240"; state.editors[0].control.handlers.input();
  failure = null;
  saved = { group: { ...group, revision: "saved", fields: [{ ...group.fields[0], value: 240 }] },
    output: "saved 240", adoption: "next launch", refresh: "not-required" };
  await state.form.handlers.submit({ preventDefault() {} });
  assert.equal(state.dirty, false);
  assert.equal(state.group.revision, "saved");
  assert.equal(state.editors[0].control.value, "240");

  const roleGroup = { id: "role/worker", agentId: "fixture", revision: "role-first", notice: "next launch",
    provenance: { label: "Fixture snapshot", capturedAt: "2026-10-27T00:00:00Z" },
    fields: [
      { key: "model", label: "Model", kind: "text", value: "fast", reset: true },
      { key: "effort", label: "Effort", kind: "text", value: "low", reset: true },
      { key: "systemPrompt", label: "Instructions", kind: "multiline", value: "" },
      { key: "workspace", label: "Workspace", kind: "text", value: "/fixture/workspace" },
      { key: "enabled", label: "Enabled", kind: "boolean", value: true }
    ] };
  context.renderGroup(state, roleGroup);
  const editorFor = key => state.editors.find(editor => editor.field.key === key);
  const roleView = nodeText(state.content);
  for (const heading of ["settings.group.identity", "settings.group.models", "settings.group.workspace",
    "settings.group.instructions", "settings.source.title"]) {
    assert.match(roleView, new RegExp(heading), `the rebuilt inspector exposes ${heading}`);
  }
  assert.match(roleView, /settings.editCount/, "the sticky action footer reports unsaved state");
  assert.match(SETTINGS_STYLES, /\.agent-inspector\{[^}]*overflow:clip/,
    "the inspector must not become the sticky containing block for its action footer");
  const catalog = { agentId: "fixture", models: [
    { value: "fast", label: "Fast", isDefault: true, efforts: [{ value: "low", label: "Low" }] },
    { value: "deep", label: "Deep", efforts: [{ value: "high", label: "High" }] }
  ], fields: [{ key: "model", allowCustom: true }, { key: "effort", allowCustom: true }], warnings: [] };
  let resolveCapabilities;
  context.requestJson = () => new Promise(resolve => { resolveCapabilities = resolve; });
  const query = state.content.querySelectorAll("button").find(button => button.children.includes("settings.queryCapabilities"));
  const capabilityRead = query.handlers.click();
  const beforeQuerySubmit = submissions;
  await state.form.handlers.submit({ preventDefault() {} });
  assert.equal(submissions, beforeQuerySubmit, "submission waits for the in-flight capability read");
  resolveCapabilities({ source: "cache", fetchedAt: "2026-10-10T00:00:00Z", catalog });
  await capabilityRead;
  assert.equal(state.capabilityPending, false);
  assert.equal(query.disabled, false);
  const model = editorFor("model");
  const effort = editorFor("effort");
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
  const availability = { id: "profile/reader", revision: "enabled", notice: "Template only",
    fields: [{ key: "enabled", label: "Enabled", kind: "boolean", value: true }] };
  context.renderGroup(state, availability);
  const toggle = state.editors[0].control;
  assert.equal(toggle.tagName, "SELECT");
  assert.equal(toggle.value, "true");
  assert.deepEqual(toggle.children.map(nodeText).map(value => value.trim()), ["settings.booleanOn", "settings.booleanOff"],
    "boolean values use localized labels instead of true/false");
  toggle.value = "false"; toggle.handlers.change();
  let submitted;
  context.submitMutation = async (_key, _url, body) => {
    submitted = body;
    return { group: { ...availability, revision: "disabled",
      fields: [{ ...availability.fields[0], value: false }] }, output: "disabled", adoption: "No Session stopped" };
  };
  await state.form.handlers.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(submitted.changes)), [{ key: "enabled", value: false }]);
  assert.equal(state.editors[0].control.value, "false");
  assert.equal(state.dirty, false);
  context.renderGroup(state, { ...roleGroup, readOnly: true,
    provenance: { label: "Production snapshot", capturedAt: "2026-10-26T00:00:00Z" } });
  context.applyCapabilities(state, { catalog });
  assert.ok(state.editors.every(editor => editor.control.disabled), "capability choices cannot unlock snapshot inputs");
  const snapshotModel = editorFor("model");
  const snapshotCustom = snapshotModel.row.querySelectorAll("button").find(button => button.children.includes("settings.custom"));
  assert.equal(snapshotCustom.disabled, true);
  snapshotCustom.handlers.click();
  assert.equal(snapshotModel.control.disabled, true);
  const previous = submitted;
  snapshotModel.control.value = "deep"; snapshotModel.control.handlers.change();
  await state.form.handlers.submit({ preventDefault() {} });
  assert.equal(submitted, previous, "snapshot mutation is blocked even if the submit handler is invoked");
  assert.equal(state.save.disabled, true);

  const metadata = [
    { id: "system", section: "server", title: "System" },
    { id: "profile/reader", section: "profiles", title: "Reader" },
    { id: "profile/empty", section: "profiles", title: "Empty reader" },
    { id: "role/worker", section: "roles", title: "Worker" },
    { id: "role/empty", section: "roles", title: "Empty worker" },
    { id: "agent/fixture", section: "agents", title: "Fixture" }
  ];
  const currentGroups = {
    system: { id: "system", revision: "system-first", notice: "server settings",
      fields: [
        { key: "default-agent", label: "Default Agent", kind: "text", value: "fixture", source: "stored", reset: true },
        { key: "default-workspace", label: "Default workspace", kind: "text", value: "/fixture/workspace", source: "default", reset: true },
        { key: "time-zone", label: "Time zone", kind: "text", value: "Asia/Shanghai", source: "stored", reset: true },
        { key: "delivery-timeout-seconds", label: "Timeout", kind: "number", value: 120, reset: true }
      ] },
    "role/worker": { ...roleGroup, fields: roleGroup.fields.map(field => ({ ...field, source: "stored" })) },
    "role/empty": { id: "role/empty", agentId: "fixture",
      fields: [{ key: "model", label: "Model", kind: "text", value: "" },
        { key: "effort", label: "Effort", kind: "text", value: "" }] },
    "agent/fixture": { id: "agent/fixture", agentId: "fixture", fields: [],
      observation: { native: { model: "native-model", effort: "medium", catalogFetchedAt: "2026-10-27T08:00:00Z", models: [{ value: "native-model" }] } } },
    "profile/reader": { id: "profile/reader", agentId: "fixture",
      fields: [{ key: "model", label: "Model", kind: "text", value: "" }],
      observation: { source: "global-worker", status: "resolved", binding: { config: { model: "worker-inherited", effort: "high" } } } },
    "profile/empty": { id: "profile/empty", agentId: "fixture",
      fields: [{ key: "model", label: "Model", kind: "text", value: "" },
        { key: "effort", label: "Effort", kind: "text", value: "" }],
      observation: { source: "explicit", status: "resolved", binding: { config: { model: "", effort: "" } } } }
  };
  const requests = [];
  context.requestJson = async url => {
    requests.push(url);
    if (url.startsWith("/api/settings/group?")) return currentGroups[new URL(url, "http://fixture").searchParams.get("id")];
    return { groups: metadata, total: 4, supportedAgents: [] };
  };
  context.showSection("agents");
  await context.start();
  await new Promise(resolve => setTimeout(resolve, 0));
  const uiGroups = vm.runInContext("groups", context);
  const agent = uiGroups.find(group => group.meta.id === "agent/fixture");
  const role = uiGroups.find(group => group.meta.id === "role/worker");
  const profile = uiGroups.find(group => group.meta.id === "profile/reader");
  const emptyRole = uiGroups.find(group => group.meta.id === "role/empty");
  const emptyProfile = uiGroups.find(group => group.meta.id === "profile/empty");
  const text = nodeText;
  assert.equal(agent.root.parent, shell.get("#agent-settings-groups"));
  assert.equal(role.root.parent, shell.get("#agent-settings-groups"));
  assert.equal(profile.root.parent, shell.get("#agent-settings-groups"));
  assert.equal(agent.root.hidden, true, "loaded detail cards stay out of the master/detail view");
  assert.equal(role.root.hidden, true);
  assert.match(text(profile.summary), /worker-inherited/, "template summaries show resolved inherited model, not an empty override");
  assert.match(text(role.summary), /fast/);
  assert.doesNotMatch(text(role.summary), /native-model/, "role overrides are not replaced by the Agent native default");
  for (const emptySummary of [text(emptyRole.summary), text(emptyProfile.summary)]) {
    assert.doesNotMatch(emptySummary, /settings.summaryUnavailable/,
      "a resolved group with empty overrides is not misreported as unreadable");
    assert.match(emptySummary, /settings.summaryNativeDefault/);
  }
  assert.match(text(emptyRole.summary), /settings.roleDefaults/);
  assert.equal(requests.some(url => url.includes("capabilities")), false, "group summaries do not trigger capability discovery");
  const accessText = text(vm.runInContext("agentIndex", context));
  assert.match(accessText, /fast/, "index rows expose the Role's model evidence");
  assert.match(accessText, /worker-inherited/, "index rows expose a resolved Profile's inherited model");
  const findAccess = id => {
    const visit = node => typeof node === "object" ? [node, ...(node.children || []).flatMap(visit)] : [];
    return visit(vm.runInContext("agentIndex", context)).find(node => node.dataset?.agentId === id);
  };
  const timestampState = { content: element("div"), pending: false };
  context.renderGroup(timestampState, currentGroups["agent/fixture"]);
  assert.match(text(timestampState.content), /settings.source.observed · 2026-10-27T08:00:00Z/,
    "a Native overview reports the actual observation timestamp");
  context.renderGroup(timestampState, { ...currentGroups["agent/fixture"],
    observation: { native: { model: "native-model", effort: "medium", models: [] } } });
  assert.match(text(timestampState.content), /settings.source.observationUnknown/,
    "an absent Native observation time is labelled unknown rather than presented as a blank timestamp");
  const roleDraft = role.editors[0].control;
  roleDraft.value = "unlisted-draft"; roleDraft.handlers.input();
  findAccess("role/worker").handlers.click();
  findAccess("agent/fixture").handlers.click();
  findAccess("role/worker").handlers.click();
  assert.equal(role.editors[0].control, roleDraft, "switching index members preserves a mounted draft");
  assert.equal(roleDraft.value, "unlisted-draft");
  const indexText = text(vm.runInContext("agentIndex", context));
  assert.match(indexText, /settings.unsavedShort/, "an input event updates the index's unsaved badge immediately");
  const focusBefore = findAccess("role/worker");
  activeElement = focusBefore;
  context.renderAgentIndex();
  const restoredAccess = findAccess("role/worker");
  assert.equal(activeElement, restoredAccess, "index rerender restores focus to the same member control");
  assert.equal(restoredAccess.focused, true, "index rerender restores keyboard focus to the selected member");
  const close = role.inspectorContent.querySelectorAll("button").find(button => button["aria-label"] === "settings.closeInspector");
  activeElement = close;
  close.handlers.click();
  assert.equal(text(vm.runInContext("agentInspector", context)).includes("settings.inspectorEmpty"), true,
    "closing the inspector shows an explicit empty state instead of reopening the first member");
  assert.equal(vm.runInContext("selectedAccess()", context), null);
  assert.equal(activeElement, findAccess("role/worker"), "closing moves focus to the row for the member that was closed");
  const externalButton = element("button");
  activeElement = externalButton;
  context.renderAgentIndex();
  assert.equal(activeElement, externalButton, "an index redraw never steals focus from an unrelated button");
  findAccess("role/worker").handlers.click();
  assert.equal(role.editors[0].control, roleDraft, "selecting after close retains the mounted draft");
  assert.equal(roleDraft.value, "unlisted-draft");
  context.showSection("server");
  assert.equal(panels.find(panel => panel.dataset.section === "server").hidden, false);
  assert.equal(panels.find(panel => panel.dataset.section === "agents").hidden, true);
  const serverGroup = uiGroups.find(group => group.meta.id === "system");
  assert.equal(serverGroup?.root.parent, shell.get("#server-settings-groups"), "server group cards are attached to the visible server section");
  assert.equal(serverGroup?.loaded, true);
  const serverControl = serverGroup?.editors[0]?.control;
  assert.equal(serverControl?.disabled, false, "system fields remain editable through the actual server entry");
  assert.equal(typeof serverControl?.handlers.input, "function", "system fields keep their editable input listener");
  const serverText = text(serverGroup.content);
  assert.match(serverText, /translated:settings.notice.server|settings.notice.server/,
    "Server cards use the shared CLI source/reset notice, not the Role launch notice");
  assert.doesNotMatch(serverText, /settings.notice.role/);
  const serverSections = serverGroup.content.querySelectorAll("section").filter(section => section.children[0]?.tagName === "H3");
  const sectionFor = key => serverSections.find(section => text(section.children[0]).includes(key));
  assert.match(text(sectionFor("settings.group.defaults")), /settings.field.default-agent/);
  assert.match(text(sectionFor("settings.group.defaults")), /settings.field.default-workspace/);
  assert.match(text(sectionFor("settings.group.defaults")), /settings.field.time-zone/);
  assert.doesNotMatch(text(sectionFor("settings.group.defaults")), /settings.group.permissions/);
  assert.match(text(sectionFor("settings.group.runtime")), /settings.field.delivery-timeout-seconds/);
  assert.match(text(sectionFor("settings.group.defaults")), /settings.takesEffect.time-zone/,
    "the time-zone field keeps its distinct next-render effect text");
  const compare = serverGroup.content.querySelectorAll("button").find(button => button.children.includes("settings.compare"));
  await compare.handlers.click();
  const compareText = text(serverGroup.content);
  assert.match(compareText, /settings.compare.server/);
  assert.doesNotMatch(compareText, /server settings/, "the raw backend notice is not shown in the localized comparison");
  assert.match(compareText, /settings.field.time-zone/);
  const roleWithProfiles = { content: element("div"), pending: false };
  context.renderGroup(roleWithProfiles, { ...roleGroup, profiles: [{ id: "reader", available: true }] });
  const roleText = text(roleWithProfiles.content);
  assert.equal((roleText.match(/settings\.notice\.role/g) || []).length, 1,
    "Role guidance has one notice rather than repeating the same later-launch warning");
  assert.match(roleText, /settings\.profileAcknowledge/,
    "Profile application has a one-time-copy acknowledgement distinct from ordinary Save");
  assert.match(roleText, /settings\.acknowledge\.role/,
    "ordinary Role Save retains its live-session safeguard");
  const assertLocalizedCompare = async (state, group, key, backendNotice) => {
    context.renderGroup(state, group);
    const button = state.content.querySelectorAll("button").find(item => item.children.includes("settings.compare"));
    await button.handlers.click();
    const compared = text(state.content);
    assert.match(compared, new RegExp(key), `${group.id} compare uses its localized explanation`);
    assert.doesNotMatch(compared, new RegExp(backendNotice), `${group.id} compare does not leak the backend notice`);
  };
  await assertLocalizedCompare({ content: element("div"), pending: false }, roleGroup,
    "settings.compare.roles", "next launch");
  await assertLocalizedCompare({ content: element("div"), pending: false }, currentGroups["agent/fixture"],
    "settings.compare.agents", "native configuration");
  await assertLocalizedCompare({ content: element("div"), pending: false }, currentGroups["profile/reader"],
    "settings.compare.profiles", "Template only");
  context.showSection("agents");
  assert.equal(panels.find(panel => panel.dataset.section === "agents").hidden, false);
  assert.equal(role.editors[0].control, roleDraft, "navigation retains the existing editor");
  assert.equal(roleDraft.value, "unlisted-draft");
  assert.equal(role.dirty, true);
  language = "translated:";
  translations.forEach(update => update());
  assert.match(text(role.summary), /translated:settings.roleDefaults/);
  assert.match(text(vm.runInContext("agentIndex", context)), /translated:settings.area.roles/);
  assert.equal(role.editors[0].control, roleDraft, "translation updates summaries without rebuilding draft controls");
  assert.equal(roleDraft.value, "unlisted-draft");
  context.renderGroup(profile, { ...currentGroups["profile/reader"],
    fields: [{ key: "enabled", kind: "boolean", value: false }],
    observation: { source: "global-worker", status: "unavailable", reason: "Worker is unavailable" } });
  assert.match(text(profile.summary), /Worker is unavailable/);
  assert.match(text(profile.summary), /settings.summaryDisabled/);
  assert.doesNotMatch(text(profile.summary), /settings.summaryNativeDefault/, "an unresolved template is not presented as a native-default choice");
});
