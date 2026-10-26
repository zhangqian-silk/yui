import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { MODELS_VIEW_SCRIPT } from "../../dist/web/assets/client/views/models.js";
import { OPERATOR_HANDOFF_SCRIPT } from "../../dist/web/assets/client/views/operatorHandoff.js";
import { MODELS_HTML } from "../../dist/web/assets/shell/models.js";
import { appRail } from "../../dist/web/assets/shell/appRail.js";
import { SETTINGS_HTML } from "../../dist/web/assets/shell/settings.js";
import { WEB_ASSETS } from "../../dist/web/assets/assetManifest.js";
import { MANAGE_SHELL_SCRIPT } from "../../dist/web/assets/client/layout/manageShell.js";
import { EN } from "../../dist/web/assets/client/i18n/en.js";
import { ZH_CN } from "../../dist/web/assets/client/i18n/zh-CN.js";

// Minimal DOM: enough for h(), forms and buttons; no browser required.
function element(spec, attrs, ...children) {
  const node = {
    tagName: spec.split(".")[0].toUpperCase(), className: spec.split(".").slice(1).join(" "),
    value: "", checked: false, disabled: false, textContent: "", type: "",
    dataset: {}, handlers: {}, children: [],
    // Like the DOM, append() stringifies null; only h() skips empty children.
    append(...items) { this.children.push(...items.map(x => typeof x === "object" && x !== null ? x : String(x))); },
    replaceChildren(...items) { this.children = []; this.append(...items); },
    addEventListener(name, fn) {
      const previous = this.handlers[name];
      this.handlers[name] = previous ? event => { previous(event); return fn(event); } : fn;
    },
    setAttribute(name, value) { this[name] = value; }
  };
  if (attrs && typeof attrs === "object" && !Array.isArray(attrs) && !attrs.tagName) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else node[key] = value;
    }
  } else if (attrs != null) children.unshift(attrs);
  node.append(...children.flat(Infinity).filter(x => x != null && x !== false));
  return node;
}
const walk = node => node && typeof node === "object" ? [node, ...node.children.flatMap(walk)] : [];
const text = node => typeof node === "string" ? node
  : node && typeof node === "object" ? [node.textContent, ...node.children.map(text)].join(" ") : "";
const find = (root, predicate) => walk(root).find(predicate);
const all = (root, predicate) => walk(root).filter(predicate);
const button = (root, label) => find(root, n => n.tagName === "BUTTON" && n.children.includes(label));
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const submit = form => form.handlers.submit({ preventDefault() {} });
const resourceForm = (root, kind) => find(root, n => n.tagName === "FORM" && n.dataset.resourceKind === kind);
const connectionForm = root => resourceForm(root, "endpoint");
const endpointCard = root => find(root, n => n.className.includes("models-card") && resourceForm(n, "endpoint"));

test("management navigation shares history across areas and normalizes direct URLs", () => {
  const elements = new Map();
  const document = { querySelector(key) {
    if (!elements.has(key)) elements.set(key, { hidden: true, querySelectorAll: () => [] });
    return elements.get(key);
  }, addEventListener() {} };
  const location = new URL("http://localhost/models?section=quota&source=command-code");
  const history = { state: null, pushes: 0,
    replaceState(state, _, url) { this.state = state; if (url) location.href = new URL(url, location).href; },
    pushState(state, _, url) { this.pushes++; this.replaceState(state, _, url); } };
  const handlers = {};
  const shown = [];
  const places = {};
  const window = { addEventListener(name, fn) { handlers[name] = fn; } };
  document.querySelector("#manage-scroll").scrollTop = 120;
  const ctx = vm.createContext({ URL, URLSearchParams, document, location, history, window,
    createI18n: () => ({ t: key => key, subscribe() {} }),
    rememberPlace: (area, href) => { places[area] = href; }, linkPlaces() {} });
  vm.runInContext(MANAGE_SHELL_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), ctx);
  for (const page of ["models", "settings", "jobs"]) ctx.registerManagePage(page, { show: route => shown.push({ ...route }) });
  ctx.startManagement();
  assert.equal(location.pathname + location.search, "/models/providers?detail=quota&source=command-code");
  assert.equal(history.pushes, 0, "normalizing a direct URL must not add a Back step");
  ctx.navigateManage({ page: "settings", section: "preferences" });
  ctx.navigateManage({ page: "models", section: "connection" });
  assert.equal(location.pathname, "/models/agents");
  assert.equal(ctx.manageHref(ctx.readManageRoute(new URL("http://localhost/settings/connection"))), "/models/agents");
  assert.equal(elements.get("#settings-root").hidden, false);
  ctx.navigateManage({ page: "models", section: "connection" });
  assert.equal(history.pushes, 2, "clicking the selected destination is a no-op");
  location.href = "http://localhost/settings/server";
  history.state = { scroll: 70 };
  handlers.popstate();
  assert.equal(shown.at(-1).section, "server");
  assert.equal(elements.get("#settings-root").hidden, false);
  assert.equal(elements.get("#manage-scroll").scrollTop, 70, "the center column restores its own scroll");
  assert.deepEqual({ ...places }, { models: "/models/agents", settings: "/settings/server", manage: "/settings/server" },
    "each area remembers its last section for the return trip from the workbench");
  const ref = JSON.stringify({ version: "a".repeat(40), relativePath: "report.md" });
  const fixed = new URL("http://localhost/settings/jobs?job=reports&jobRun=run-1&artifact=" + encodeURIComponent(ref));
  const legacy = ctx.readManageRoute(fixed);
  assert.equal(legacy.page, "jobs");
  assert.equal(legacy.moved, true, "a retired Settings link says it moved");
  assert.equal(ctx.manageHref(legacy), "/jobs" + fixed.search,
    "the retired Settings address opens the Jobs entry and preserves fixed Job evidence");
  for (const old of ["http://localhost/settings?section=jobs&task=task-7", "http://localhost/settings/jobs?task=task-7"])
    assert.equal(ctx.manageHref(ctx.readManageRoute(new URL(old))), "/jobs?task=task-7");
  const scoped = ctx.readManageRoute(new URL("http://localhost/jobs?task=task-12&job=sync&jobRun=run-2"));
  assert.deepEqual([scoped.page, scoped.task, scoped.job, scoped.jobRun, scoped.moved], ["jobs", "task-12", "sync", "run-2", undefined]);
  assert.equal(ctx.readManageRoute(new URL("http://localhost/jobs?task=../x")).task, null, "only an exact Task id scopes Jobs");
  // A Job choice is a history step; Back returns to the previous Job.
  const pushes = history.pushes;
  ctx.navigateManage({ page: "jobs", section: "jobs", task: null, job: "project-sync-project-1" });
  assert.equal(location.pathname + location.search, "/jobs?job=project-sync-project-1");
  assert.equal(history.pushes, pushes + 1);
  assert.equal(elements.get("#jobs-root").hidden, false);
  assert.equal(elements.get("#settings-root").hidden, true);
  assert.equal(places.jobs, "/jobs?job=project-sync-project-1");
  location.href = "http://localhost/settings/server";
  handlers.popstate();
  assert.equal(elements.get("#jobs-root").hidden, true);
});


function connection(extra = {}) {
  return { bridgeUrl: "http://127.0.0.1:9", bridgeConfigFile: "/fixture/bridge.yaml", cpaUrl: "", managementKeyFile: "", catalogKeyFile: "", ...extra };
}
function view(revision, extra = {}) {
  const c = extra.connection === undefined ? connection() : extra.connection;
  const registry = { modules: c ? [{ id: "bridge", kind: "metabridge", version: "fixture", managementUrl: c.bridgeUrl,
    managementKeyFile: "", configFile: c.bridgeConfigFile, maintenance: "configuration", quotaAdapter: "none" },
    ...(c.cpaUrl ? [{ id: "cpa", kind: "cliproxyapi", version: "8.0.12", managementUrl: c.cpaUrl,
      managementKeyFile: c.managementKeyFile, configFile: "", maintenance: "external", quotaAdapter: "factory-quota-v1" }] : [])] : [],
    endpoints: c ? [{ id: "bridge-api", moduleId: "bridge", url: c.bridgeUrl + "/v1", protocol: "responses", clientKeyFile: "" }] : [],
    bindings: [], receipts: [] };
  return { revision, registryRevision: revision, registry, quotaSources: ["factory", "command-code"].map(source => ({ moduleId: c?.cpaUrl ? "cpa" : "", source })), configuredAgents: [{ id: "codex", adapterId: "codex" }], connection: connection(), configurationError: null, application: "unverified", notice: "notice-" + revision,
    providers: [
      { id: "official", name: "Official", via: "unknown", baseUrl: "https://upstream.invalid", prefix: "", enabled: true,
        editable: false, reason: "official subscription route", credentialPresent: true, owner: "metabridge" },
      { id: "mine", name: "Mine", via: "direct", baseUrl: "https://mine.invalid", prefix: "mine/", enabled: true,
        editable: true, reason: null, credentialPresent: true, owner: "metabridge" }
    ], ...extra };
}
const observation = (status, extra = {}) => ({ status, attemptedAt: null, observedAt: null, stale: false, error: null, items: [], ...extra });

function mount(api, extra = {}) {
  let handoff;
  const context = vm.createContext({ crypto: webcrypto, h: element, icon: name => element("svg.icon." + name), formatDateTime: iso => "at:" + iso, window: {},
    openOperatorHandoff: options => { handoff = options; } });
  vm.runInContext(MODELS_VIEW_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const root = element("div");
  root.querySelectorAll = selector => all(root, node => selector === "[data-model-detail]"
    ? node.dataset.modelDetail !== undefined : node.dataset.observationTime !== undefined);
  const confirmations = [];
  const page = context.mountModels(root, { t: (key, fallback) => key, api,
    confirm: message => { confirmations.push(message); return true; }, ...extra });
  return { root, page, confirmations, handoff: () => handoff };
}

test("initial observations wait for the configuration baseline", async () => {
  let resolveView;
  const baseline = view("new", { connection: connection({ bridgeUrl: "http://127.0.0.1:10" }) });
  const api = fakeApi({ models: id => id ? Promise.resolve(baseline) : new Promise(resolve => { resolveView = resolve; }) });
  const { page } = mount(api);
  await tick();
  assert.equal(api.calls.length, 0, "no observation may precede the first configuration read");
  resolveView(baseline);
  await page.ready;
  assert.deepEqual(api.calls.map(call => call[0]), ["catalog", "quota"]);
});

test("language changes retain current observations without loading again", async () => {
  let reads = 0;
  const api = fakeApi({ models: async () => { reads++; return view("r1"); } });
  const { page } = mount(api);
  await page.ready;
  const observation = page.state.catalog.page;
  const calls = api.calls.length;
  page.translate();
  assert.equal(reads, 2, "one baseline plus one explicit component-source read");
  assert.equal(api.calls.length, calls);
  assert.equal(page.state.catalog.page, observation);
  assert.equal(page.dirty(), false);
});

test("Provider overview includes every configured source, keeps instance identity and isolates component failures", async () => {
  const baseline = view("r1", { quotaSources: [],
    connection: connection({ cpaUrl: "https://cpa.invalid", managementKeyFile: "/fixture/key" }),
    nativeProviders: [{ id: "native-bridge", name: "Same name", agentId: "codex", sourceFile: "/fixture/config",
      baseUrl: "https://native.invalid", protocol: "responses", credentialPresent: true }] });
  const direct = { ...baseline.providers[1], id: "shared-name", name: "Same name", protocol: "responses",
    models: [{ name: "upstream-model", alias: "public-model" }], sourceFile: "/fixture/bridge",
    compaction: { mode: "local", models: ["matching/*"], stripImages: true }, apiKey: "must-not-render" };
  const forwarding = { ...direct, id: "cpa-upstream", name: "CPA connection", via: "cpa" };
  const cpa = Array.from({ length: 9 }, (_, index) => ({ ...direct, id: index ? "cpa-" + index : "shared-name",
    owner: "cliproxyapi", via: "direct", sourceFile: "/fixture/cpa" }));
  let fail = false;
  const calls = [];
  const api = fakeApi({ models: async id => {
    calls.push(id || "baseline");
    if (!id) return baseline;
    if (id === "cpa" && fail) throw Error("CPA config unreadable");
    return { ...baseline, providers: id === "cpa" ? cpa : [direct, forwarding] };
  } });
  const { root, page, handoff } = mount(api);
  await page.ready;
  const records = all(root, node => node.dataset.providerIdentity);
  assert.equal(records.length, 11, "one bridge Provider, nine CPA Providers and one native record are all visible by default");
  assert.equal(new Set(records.map(node => node.dataset.providerIdentity)).size, 11, "same names and IDs from distinct sources are not merged");
  assert.equal(records.some(node => node.dataset.provider === "cpa-upstream"), false, "the CPA connection is not counted as a supplier");
  assert.match(text(root), /CPA connection/);
  assert.match(text(root), /matching\/\*/);
  assert.match(text(root), /models.compactionMatched/);
  assert.match(text(root), /public-model/);
  assert.doesNotMatch(text(root), /must-not-render/);
  assert.equal(api.calls.some(call => call[0] === "refresh"), false);
  assert.deepEqual(calls, ["baseline", "bridge", "cpa"]);
  assert.equal(!!find(root, node => node.dataset.modelDetail === "maintenance").open, false);
  page.show({ section: "catalog" });
  assert.equal(find(root, node => node.dataset.modelDetail === "catalog").open, true, "retired catalog URL opens the in-page detail");
  assert.equal(all(root, node => node.tagName === "H1").length, 1);
  fail = true;
  button(root, "models.configure.provider").handlers.click();
  await handoff().onReadback();
  assert.equal(all(root, node => node.dataset.providerIdentity).length, 2, "a failed source does not erase other configuration records");
  assert.match(text(root), /CPA config unreadable/);
  const providerSection = find(root, node => node.dataset.section === "providers");
  const visibleAlert = providerSection.children.flatMap(node => node.children || [])
    .find(node => node.role === "alert");
  assert.ok(visibleAlert, "source failures are visible beside the main list without opening component details");
  assert.match(text(visibleAlert), /CPA config unreadable/);
});

test("native-only Provider records have no invented components, catalog, quota placeholder or upstream reads", async () => {
  const api = fakeApi({ current: view("r1", { connection: null, providers: [], quotaSources: [],
    nativeProviders: [{ id: "native", agentId: "codex", name: "Native", sourceFile: "/fixture/config",
      baseUrl: "https://native.invalid", credentialPresent: false }] }) });
  const { root, page } = mount(api);
  await page.ready;
  assert.match(text(root), /Native/);
  assert.doesNotMatch(text(root), /models.disconnected/, "native Agent use does not require component registration");
  for (const key of ["maintenance", "catalog", "quota"]) {
    assert.equal(find(root, node => node.dataset.modelDetail === key), undefined);
  }
  assert.deepEqual(api.calls.map(call => call[0]), ["models"]);
  page.show({ section: "maintenance" });
  assert.equal(find(root, node => node.dataset.modelDetail === "maintenance"), undefined);
});

test("a standalone registered endpoint remains visible without any optional component", async () => {
  const current = view("r1", { connection: null, providers: [], quotaSources: [] });
  current.registry.endpoints.push({ id: "standalone", moduleId: null, url: "https://standalone.invalid",
    protocol: "responses", clientKeyFile: "/fixture/private-reference" });
  const api = fakeApi({ current });
  const { root, page } = mount(api);
  await page.ready;
  const record = find(root, node => node.dataset.providerIdentity === "endpoint:standalone");
  assert.ok(record);
  assert.match(text(record), /https:\/\/standalone.invalid/);
  assert.match(text(record), /models.origin.endpoint/);
  assert.match(text(record), /\/fixture\/private-reference/);
  assert.equal(find(root, node => node.dataset.modelDetail === "maintenance"), undefined);
  assert.deepEqual(api.calls.map(call => call[0]), ["models", "catalog"], "only the explicitly registered endpoint cache is read");
});

// Manual Provider/binding forms have been retired. Their mutation authority,
// preview, credential and replay contracts remain covered by model-management
// and model-registry tests; the Web now protects a read-only handoff boundary.
test("Provider facts distinguish native connections and snapshots, with one non-mutating configuration handoff", async () => {
  const api = fakeApi({ current: view("r1", { readOnly: true, quotaSources: [],
    provenance: { label: "Production snapshot", capturedAt: "2026-10-26T00:00:00Z" },
    nativeProviders: [{ id: "native", agentId: "codex", name: "Native service", baseUrl: "https://native.invalid",
      credentialPresent: true }] }) });
  const { root, page, handoff } = mount(api);
  await page.ready;
  assert.match(text(root), /Production snapshot/);
  assert.match(text(root), /Native service.*codex/);
  assert.match(text(root), /https:\/\/native.invalid/);
  assert.equal(all(root, n => n.tagName === "FORM" || n.tagName === "TEXTAREA" || n.type === "password").length, 0);
  assert.equal(api.calls.some(call => call[0] === "quota"), false, "no invented default quota source");
  assert.equal(all(root, n => n.tagName === "BUTTON" && /models.source.(factory|command-code)/.test(text(n))).length, 0);
  button(root, "models.configure.provider").handlers.click();
  assert.equal(handoff().topic, "provider");
  assert.equal(button(root, "models.refreshCatalog").disabled, true);
  await button(root, "models.refreshCatalog").handlers.click();
  assert.equal(button(root, "models.readQuota"), undefined, "no quota component means no empty quota control");
  assert.equal(api.calls.some(call => ["resource", "provider", "refresh"].includes(call[0])), false,
    "snapshot refresh is blocked in handlers as well as controls");
});

test("first quota read is explicit and exposes only real accounts while retaining a partial success", async () => {
  const account = { id: "actual-account", source: "factory", status: "success", windows: [],
    balance: null, balanceDetails: [], periodEnd: null, error: null };
  const actual = observation("success", { items: [account], observedAt: "2026-10-26T00:00:00Z" });
  const api = fakeApi({ current: view("r1", { quotaSources: [],
    connection: connection({ cpaUrl: "https://fixture.invalid", managementKeyFile: "/fixture/private-key" }) }),
    modelQuota: async source => { api.calls.push(["quota", source]); return actual; },
    refreshModels: async input => {
      api.calls.push(["refresh", copy(input)]);
      if (input.source === "command-code") throw new Error("quota request failed");
      api.current.quotaSources = [{ moduleId: "cpa", source: "factory" }];
      return actual;
    }
  });
  const { root, page } = mount(api);
  await page.ready;
  page.show({ section: "quota" });
  assert.equal(api.calls.some(call => ["quota", "refresh"].includes(call[0])), false);
  assert.equal(button(root, "models.source.factory"), undefined);
  assert.equal(button(root, "models.source.command-code"), undefined);
  const read = button(root, "models.readQuota");
  assert.equal(read.disabled, false);
  await read.handlers.click();
  assert.equal(api.calls.filter(call => call[0] === "refresh").length, 2);
  assert.match(text(root), /actual-account/);
  assert.match(text(root), /quota request failed/);
  assert.equal(page.state.quota.source, "factory");
  assert.equal(button(root, "models.source.command-code"), undefined, "failed source never becomes an invented account tab");
  page.show({ section: "providers" }); page.show({ section: "quota" });
  assert.equal(api.calls.filter(call => call[0] === "refresh").length, 2, "navigation does not repeat upstream calls");
});

test("Agent and Provider handoffs are distinct, copy-only and restore focus when closed", async () => {
  const body = element("body");
  let focused = 0;
  const document = { body, activeElement: { focus() { focused++; } } };
  const h = (...args) => {
    const node = element(...args);
    node.focus = () => {};
    node.select = () => {};
    node.showModal = () => { node.open = true; };
    node.close = () => { node.open = false; node.handlers.close?.(); };
    node.remove = () => { body.children = body.children.filter(child => child !== node); };
    return node;
  };
  const context = vm.createContext({ h, document });
  vm.runInContext(OPERATOR_HANDOFF_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const copied = [];
  let reads = 0;
  for (const topic of ["agent", "provider"]) {
    const dialog = context.openOperatorHandoff({ topic, t: key => key, locale: () => "zh-CN",
      copyText: async prompt => { copied.push(prompt); }, onReadback: async () => { reads++; } });
    assert.equal(dialog.open, true);
    assert.equal(find(dialog, node => node.tagName === "TEXTAREA").readOnly, true);
    await button(dialog, "models.copyOperatorPrompt").handlers.click();
    assert.equal(reads, 0, "copy does not execute or reread");
    button(dialog, "models.closePanel").handlers.click();
    assert.equal(body.children.length, 0);
  }
  assert.match(copied[0], /接入 Agent/);
  assert.match(copied[1], /模型 Provider/);
  assert.notEqual(copied[0], copied[1]);
  assert.equal(focused, 2);
});

test("cached observations become stale locally without requests or replacing controls", async () => {
  let now = Date.parse("2026-10-15T00:00:00Z");
  const api = fakeApi({
    modelCatalog: async () => ({ ...observation("success", { observedAt: new Date(now).toISOString() }), total: 0, nextCursor: null }),
    modelQuota: async () => observation("success", { observedAt: new Date(now).toISOString() })
  });
  const { root, page } = mount(api, { now: () => now });
  root.querySelectorAll = () => all(root, node => node.dataset.observationTime !== undefined);
  await page.ready;
  const badges = root.querySelectorAll();
  assert.equal(badges.length, 2);
  assert.ok(badges.every(node => node.hidden));
  const form = connectionForm(root);
  const calls = api.calls.length;
  now += 61_000;
  page.updateFreshness();
  assert.ok(badges.every(node => !node.hidden));
  assert.equal(connectionForm(root), form);
  assert.equal(api.calls.length, calls, "expiry makes no network request");
});

function fakeApi(overrides = {}) {
  const calls = [];
  const api = {
    calls,
    models: async () => { calls.push(["models"]); return api.current; },
    modelCatalog: async cursor => { calls.push(["catalog", cursor]); return { ...observation("not-queried"), total: 0, nextCursor: null }; },
    modelQuota: async source => { calls.push(["quota", source]); return observation("not-queried"); },
    saveModelResource: async input => { calls.push(["resource", copy(input)]); api.current = api.next(input); return { application: "saved" }; },
    previewModelBinding: async input => ({ ...input, notice: "New Session only" }),
    saveModelProvider: async input => { calls.push(["provider", copy(input)]); return api.next(input); },
    releaseModelWrites: () => calls.push(["release"]),
    refreshModels: async input => { calls.push(["refresh", copy(input)]); return observation("success"); },
    current: view("r1"),
    next: () => view("r2"),
    ...overrides
  };
  return api;
}

test("models shell is served and linked from the dashboard navigation", () => {
  assert.ok(WEB_ASSETS["/assets/js/app/models.js"] && WEB_ASSETS["/assets/js/views/models.js"]);
  assert.ok(WEB_ASSETS["/assets/css/views/models.css"]);
  assert.match(MODELS_HTML, /__YUI_WEB_TOKEN__/);
  assert.match(MODELS_HTML, /src="\/assets\/js\/app\/manage\.js"/);
  // One global rail on every page: each area returns to where the user last was.
  assert.equal(appRail("models").replace(/ aria-current="page"/g, ""), appRail("settings").replace(/ aria-current="page"/g, ""));
  for (const area of ["workbench", "jobs", "models", "settings"]) assert.match(appRail("models"), new RegExp(`data-area="${area}" (aria-current="page" )?data-nav-area="${area}"`));
  assert.match(appRail("workbench"), /href="\/models" data-area="models" data-nav-area="models"/);
  // The shared rail links back to Yui and Settings and gives every section a real URL.
  assert.match(MODELS_HTML, /href="\/"/);
  assert.match(MODELS_HTML, /href="\/settings"/);
  for (const section of ["providers"]) {
    assert.match(MODELS_HTML, new RegExp(`href="/models/${section}" data-page="models" data-section="${section}"`));
  }
});

test("models and settings share one management rail with the same navigation", () => {
  const rail = html => html.match(/<aside class="manage-rail sidebar"[\s\S]*?<\/aside>/)[0];
  assert.equal(rail(MODELS_HTML), rail(SETTINGS_HTML), "both pages render the identical shared section list");
  const nav = rail(MODELS_HTML);
  // The workbench frame: global rail, collapsible list, top bar with the list switch.
  for (const area of ["workbench", "jobs", "models", "settings"]) assert.match(MODELS_HTML, new RegExp(`class="rail-item"[^>]*data-area="${area}"`));
  assert.match(MODELS_HTML, /class="app manage-app"/);
  assert.match(MODELS_HTML, /<header class="top-bar">[\s\S]*data-sidebar-toggle="true"/);
  // All model operations belong to Models, not Settings.
  const models = nav.match(/data-area-group="models">[\s\S]*?<\/div>\s*<\/div>/)[0];
  const settings = nav.match(/data-area-group="settings">[\s\S]*?<\/div>\s*<\/div>/)[0];
  for (const section of ["providers", "agents"]) assert.match(models, new RegExp(`data-section="${section}"`));
  assert.doesNotMatch(models, /data-section="(catalog|quota|maintenance)"/, "only Agent and Provider are navigation entries");
  for (const section of ["preferences", "skills", "server"]) {
    assert.match(settings, new RegExp(`href="/settings/${section}" data-page="settings" data-section="${section}"`));
  }
  assert.doesNotMatch(settings, /data-page="models"/);
  // Jobs are their own entry, not a Settings section; its list mounts in the same rail.
  assert.doesNotMatch(settings, /data-section="jobs"/);
  assert.match(nav, /data-area-group="jobs">\s*<div id="jobs-index"/);
  assert.match(MODELS_HTML, /<div id="jobs-root" class="jobs-root" hidden><\/div>/);
  assert.match(appRail("jobs"), /href="\/jobs" data-area="jobs" aria-current="page" data-nav-area="jobs"/);
  assert.doesNotMatch(settings, /data-section="agents"/, "Agent editing has one entry in the Agent/Provider area");
  for (const section of ["preferences", "skills", "server"]) assert.match(SETTINGS_HTML, new RegExp(`data-section="${section}"`));
  assert.match(SETTINGS_HTML, /id="settings-search"/);
  assert.match(SETTINGS_HTML, /id="skill-browser"/);
  assert.match(SETTINGS_HTML, /src="\/assets\/js\/app\/manage\.js"/);
  assert.ok(WEB_ASSETS["/assets/js/layout/manageShell.js"] && WEB_ASSETS["/assets/css/views/manage.css"]);
});

test("Operator readback handles a removed bridge without targeting the removed resource or replaying a write", async () => {
  const api = fakeApi();
  api.models = async id => {
    if (id && !api.current.registry.modules.some(m => m.id === id)) throw new Error("Module not found");
    return api.current;
  };
  const { root, page, handoff } = mount(api);
  await page.ready;
  api.current = view("r2", { connection: null, providers: [] });
  button(root, "models.configure.provider").handlers.click();
  await handoff().onReadback();
  await tick(); await tick();
  assert.equal(page.state.unknown, false);
  assert.equal(page.state.bridgeId, "");
  assert.equal(page.state.view.registry.modules.length, 0);
  assert.equal(api.calls.some(c => c[0] === "resource"), false);
});

test("catalog and quota stay separate and never present unknown, failed or stale data as current success", async () => {
  const pages = {
    "0": { ...observation("success", { observedAt: "t1", items: [{ id: "factory/a", source: "factory" }] }), total: 3, nextCursor: "1" },
    "1": { ...observation("success", { observedAt: "t1", items: [{ id: "b", source: "metabridge" }] }), total: 3, nextCursor: "2" },
    "2": { ...observation("success", { observedAt: "t2", items: [{ id: "c", source: "metabridge" }] }), total: 3, nextCursor: null }
  };
  let quotaRead = async () => { throw Object.assign(new Error("HTTP 404"), { status: 404 }); };
  const api = fakeApi({
    current: view("r1", { connection: connection({ cpaUrl: "http://127.0.0.1:8", managementKeyFile: "/fixture/key" }) }),
    modelCatalog: async cursor => { api.calls.push(["catalog", cursor]); return pages[cursor]; },
    modelQuota: async source => { api.calls.push(["quota", source]); return quotaRead(source); }
  });
  const { root, page, handoff } = mount(api);
  await page.ready; await tick();
  assert.match(text(root), /models\.quotaUnavailable/);
  assert.doesNotMatch(text(root), /models\.quotaFailed/);
  assert.match(text(root), /models\.status\.success/, "quota failure does not block the catalog");

  button(root, "models.moreCatalog").handlers.click(); await tick();
  assert.equal(page.state.catalog.items.length, 2);
  button(root, "models.moreCatalog").handlers.click(); await tick(); await tick();
  assert.deepEqual(page.state.catalog.items.map(i => i.id), ["factory/a"], "pages from another observation are not mixed");
  assert.match(text(root), /models\.catalogChanged/);

  quotaRead = async source => observation("partial", { stale: true, observedAt: "t0", items: [{ id: "acct", source, status: "partial",
    windows: [{ label: "weekly", remainingFraction: null, used: 5, cap: null, resetTime: null }], balance: null,
    balanceDetails: [{ kind: "purchased-credits", value: 12.5 }, { kind: "extra-usage-usd", value: 0 }],
    periodEnd: null, error: "window missing" }] });
  button(root, "models.source.command-code").handlers.click(); await tick();
  assert.deepEqual(api.calls.filter(c => c[0] === "quota").map(c => c[1]), ["factory", "command-code"]);
  const quota = text(root);
  assert.match(quota, /models\.stale/);
  assert.match(quota, /models\.remaining models\.unknown/);
  assert.match(quota, /models\.used 5 \/ models\.unknown/);
  assert.match(quota, /models\.balance\s+models\.unknown/);
  assert.match(quota, /models\.balance\.purchased-credits\s+12\.5/);
  assert.match(quota, /models\.balance\.extra-usage-usd\s+0/);

  api.refreshModels = async input => { api.calls.push(["refresh", copy(input)]); throw new Error("billing unreachable"); };
  button(root, "models.refreshQuota").handlers.click(); await tick();
  assert.deepEqual(api.calls.at(-1), ["refresh", { revision: "r1", kind: "quota", source: "command-code", resourceId: "cpa" }]);
  assert.equal(page.state.quota.observation, null, "a failed refresh does not keep the previous value");
  assert.match(text(root), /models\.quotaFailed billing unreachable/);
});

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("observations are invalidated with the configuration revision and late responses are fenced", async () => {
  const success = (items, extra = {}) => ({ ...observation("success", { observedAt: "t1", items }), total: items.length, nextCursor: null, ...extra });
  const reads = [];
  const quotaReads = [];
  const api = fakeApi({
    current: view("r1", { connection: connection({ cpaUrl: "http://127.0.0.1:8", managementKeyFile: "/fixture/key" }) }),
    modelCatalog: async cursor => { api.calls.push(["catalog", cursor]); const d = deferred(); reads.push(d); return d.promise; },
    modelQuota: async source => { api.calls.push(["quota", source]); const d = deferred(); quotaReads.push(d); return d.promise; }
  });
  const { root, page, handoff } = mount(api);
  await tick();
  reads.shift().resolve(success([{ id: "old/a", source: "metabridge" }]));
  quotaReads.shift().resolve(observation("success", { items: [{ id: "old-acct", source: "factory", status: "success", windows: [], balance: 1, periodEnd: null, error: null }] }));
  await page.ready; await tick();
  assert.match(text(root), /old\/a/);
  assert.match(text(root), /old-acct/);

  // An explicit refresh for r1 is still in flight when the connection changes.
  const lateRefresh = deferred();
  api.refreshModels = async input => { api.calls.push(["refresh", copy(input)]); return lateRefresh.promise; };
  button(root, "models.refreshCatalog").handlers.click(); await tick();
  api.current = view("r2", { connection: connection({ cpaUrl: "http://127.0.0.1:8", managementKeyFile: "/fixture/key" }) });
  button(root, "models.configure.provider").handlers.click();
  void handoff().onReadback(); await tick();

  const refreshes = api.calls.filter(c => c[0] === "refresh").length;
  assert.equal(page.state.view.revision, "r2");
  assert.doesNotMatch(text(root), /old\/a|old-acct/, "r1 observations are not shown under r2");
  assert.equal(api.calls.filter(c => c[0] === "catalog").length, 2, "the new cache is read");
  assert.equal(api.calls.filter(c => c[0] === "quota").length, 2);

  lateRefresh.resolve(success([{ id: "old/late", source: "metabridge" }])); await tick();
  assert.doesNotMatch(text(root), /old\/late/, "a late r1 response is fenced");
  reads.shift().resolve(success([{ id: "new/a", source: "metabridge" }]));
  quotaReads.shift().reject(new Error("cache read failed")); await tick();
  assert.match(text(root), /new\/a/);
  assert.equal(page.state.quota.observation, null);
  assert.equal(api.calls.filter(c => c[0] === "refresh").length, refreshes, "no external refresh is sent automatically");

  // A second Operator change invalidates the same way, with no Web mutation.
  api.current = view("r3");
  void handoff().onReadback(); await tick();
  assert.equal(page.state.catalog.page, null);
  assert.equal(api.calls.filter(c => c[0] === "catalog").length, 3);

  // A failed observation with no items is unknown, not empty.
  reads.shift().resolve({ ...observation("failed", { error: "bridge down" }), total: 0, nextCursor: null });
  quotaReads.shift().resolve(observation("failed", { error: "billing down" })); await tick();
  assert.match(text(root), /models\.catalogItemsUnknown/);
  assert.match(text(root), /models\.quotaItemsUnknown/);
  assert.doesNotMatch(text(root), /models\.catalogEmpty|models\.quotaEmpty/);
});

test("quota groups windows by the server's own labels and never draws unknown as zero", async () => {
  const api = fakeApi({
    current: view("r1", { connection: connection({ cpaUrl: "http://127.0.0.1:8", managementKeyFile: "/fixture/key" }) }),
    modelQuota: async source => observation("success", { observedAt: "t1", items: [{ id: "factory-0123456789ab", source, status: "success",
      windows: [
        { label: "Standard / 5h", remainingFraction: 0.92, used: null, cap: null, resetTime: "2026-10-15T08:34:51Z" },
        { label: "Standard / weekly", remainingFraction: 0.1, used: null, cap: null, resetTime: null },
        { label: "Droid Core / 5h", remainingFraction: null, used: null, cap: null, resetTime: null }
      ], balance: null, balanceDetails: [{ kind: "extra-usage-usd", value: 0 }], periodEnd: null, error: null }] })
  });
  const { root, page } = mount(api);
  await page.ready; await tick();
  const groups = all(root, n => n.className.includes("models-group") && !n.className.includes("models-groups"));
  assert.deepEqual(groups.map(g => find(g, n => n.tagName === "H3").children[0]), ["Standard", "Droid Core"]);
  const bars = all(root, n => n.role === "progressbar");
  assert.deepEqual(bars.map(b => b["aria-valuenow"]), ["92", "10"], "only known fractions get a progress bar");
  assert.match(bars[1].className, /tone-bad/);
  const core = text(groups[1]);
  assert.match(core, /models\.remaining models\.unknown/);
  assert.match(core, /models\.resetUnknown/);
  assert.doesNotMatch(core, /0%|models\.used/, "unknown is not rendered as zero or as empty used/cap pairs");
  const account = text(find(root, n => n.className.includes("models-account")));
  assert.match(account, /factory-0123456789ab/);
  assert.ok(find(root, n => n.title === "models.accountIdHelp"), "opaque identity explanation remains accessible");
  assert.doesNotMatch(account, /models\.periodEnd|models\.balance\s+models\.unknown/, "Factory does not repeat fields it never reports");
  assert.match(account, /models\.balance\.extra-usage-usd\s+0/);
});

test("catalog search covers loaded pages only and says so", async () => {
  const api = fakeApi({
    modelCatalog: async cursor => ({ ...observation("success", { observedAt: "t1", items: [
      { id: "factory/claude-opus", source: "factory" }, { id: "cpa/gpt", source: "cpa" }, { id: "plain", source: "metabridge" }] }),
    total: 250, nextCursor: "3" })
  });
  const { root, page } = mount(api);
  await page.ready; await tick();
  const catalog = find(root, n => n.dataset.section === "catalog");
  const search = find(catalog, n => n.type === "search");
  search.value = "OPUS"; search.handlers.input();
  assert.deepEqual(all(catalog, n => n.className === "models-catalog-item").map(n => text(n).trim().split(/\s+/)[0]), ["factory/claude-opus"]);
  assert.match(text(catalog), /models\.catalogCount · models\.catalogMatches/);
  assert.ok(button(catalog, "models.moreCatalog"), "paging stays available while searching");
  button(catalog, "cpa").handlers.click();
  assert.match(text(catalog), /models\.noCatalogMatches/);
});
