import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { MODELS_VIEW_SCRIPT } from "../../dist/web/assets/client/views/models.js";
import { MODELS_HTML } from "../../dist/web/assets/shell/models.js";
import { appRail } from "../../dist/web/assets/shell/appRail.js";
import { SETTINGS_HTML } from "../../dist/web/assets/shell/settings.js";
import { WEB_ASSETS } from "../../dist/web/assets/assetManifest.js";
import { MANAGE_SHELL_SCRIPT } from "../../dist/web/assets/client/layout/manageShell.js";

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
const connectionForm = root => find(root, n => n.tagName === "FORM" && n.className.includes("models-connection-form"));

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
  for (const page of ["models", "settings"]) ctx.registerManagePage(page, { show: route => shown.push({ ...route }) });
  ctx.startManagement();
  assert.equal(location.pathname + location.search, "/models/quota?source=command-code");
  assert.equal(history.pushes, 0, "normalizing a direct URL must not add a Back step");
  ctx.navigateManage({ page: "settings", section: "preferences" });
  ctx.navigateManage({ page: "models", section: "connection" });
  assert.equal(location.pathname, "/settings/connection");
  assert.equal(elements.get("#models-root").hidden, false);
  ctx.navigateManage({ page: "models", section: "connection" });
  assert.equal(history.pushes, 2, "clicking the selected destination is a no-op");
  location.href = "http://localhost/settings/server";
  history.state = { scroll: 70 };
  handlers.popstate();
  assert.equal(shown.at(-1).section, "server");
  assert.equal(elements.get("#settings-root").hidden, false);
  assert.equal(elements.get("#manage-scroll").scrollTop, 70, "the center column restores its own scroll");
  assert.deepEqual({ ...places }, { models: "/models/quota?source=command-code", settings: "/settings/server", manage: "/settings/server" },
    "each area remembers its last section for the return trip from the workbench");
  const ref = JSON.stringify({ version: "a".repeat(40), relativePath: "report.md" });
  const fixed = new URL("http://localhost/settings/jobs?job=reports&jobRun=run-1&artifact=" + encodeURIComponent(ref));
  const href = ctx.manageHref(ctx.readManageRoute(fixed));
  assert.equal(href, fixed.pathname + fixed.search, "management canonicalization must preserve fixed Job evidence");
});


function connection(extra = {}) {
  return { bridgeUrl: "http://127.0.0.1:9", bridgeConfigFile: "/fixture/bridge.yaml", cpaUrl: "", managementKeyFile: "", catalogKeyFile: "", ...extra };
}
function view(revision, extra = {}) {
  return { revision, connection: connection(), configurationError: null, application: "unverified", notice: "notice-" + revision,
    providers: [
      { id: "official", name: "Official", via: "unknown", baseUrl: "https://upstream.invalid", prefix: "", enabled: true,
        editable: false, reason: "official subscription route", credentialPresent: true, owner: "metabridge" },
      { id: "mine", name: "Mine", via: "direct", baseUrl: "https://mine.invalid", prefix: "mine/", enabled: true,
        editable: true, reason: null, credentialPresent: true, owner: "metabridge" }
    ], ...extra };
}
const observation = (status, extra = {}) => ({ status, attemptedAt: null, observedAt: null, stale: false, error: null, items: [], ...extra });

function mount(api, extra = {}) {
  const context = vm.createContext({ h: element, icon: name => element("svg.icon." + name), formatDateTime: iso => "at:" + iso, window: {} });
  vm.runInContext(MODELS_VIEW_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const root = element("div");
  const confirmations = [];
  const page = context.mountModels(root, { t: (key, fallback) => key, api,
    confirm: message => { confirmations.push(message); return true; }, ...extra });
  return { root, page, confirmations };
}

test("initial observations wait for the configuration baseline", async () => {
  let resolveView;
  const api = fakeApi({ models: () => new Promise(resolve => { resolveView = resolve; }) });
  const { page } = mount(api);
  await tick();
  assert.equal(api.calls.length, 0, "no observation may precede the first configuration read");
  resolveView(view("new", { connection: connection({ bridgeUrl: "http://127.0.0.1:10" }) }));
  await page.ready;
  assert.deepEqual(api.calls.map(call => call[0]), ["catalog", "quota"]);
});

test("language changes retain current observations and drafts without loading again", async () => {
  let reads = 0;
  const api = fakeApi({ models: async () => { reads++; return view("r1"); } });
  const { page } = mount(api);
  await page.ready;
  const observation = page.state.catalog.page;
  page.state.connectionDraft = { ...connection(), bridgeUrl: "http://127.0.0.1:91" };
  const calls = api.calls.length;
  page.translate();
  assert.equal(reads, 1);
  assert.equal(api.calls.length, calls);
  assert.equal(page.state.catalog.page, observation);
  assert.equal(page.state.connectionDraft.bridgeUrl, "http://127.0.0.1:91");
  assert.equal(page.dirty(), true);
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
    saveModelConnection: async input => { calls.push(["connection", copy(input)]); return api.next(input); },
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
  for (const area of ["workbench", "models", "settings"]) assert.match(appRail("models"), new RegExp(`data-area="${area}" (aria-current="page" )?data-nav-area="${area}"`));
  assert.match(appRail("workbench"), /href="\/models" data-area="models" data-nav-area="models"/);
  // The shared rail links back to Yui and Settings and gives every section a real URL.
  assert.match(MODELS_HTML, /href="\/"/);
  assert.match(MODELS_HTML, /href="\/settings"/);
  for (const section of ["providers", "catalog", "quota", "connection"]) {
    assert.match(MODELS_HTML, new RegExp(`href="/${section === "connection" ? "settings" : "models"}/${section}" data-page="models" data-section="${section}"`));
  }
});

test("models and settings share one management rail with the same navigation", () => {
  const rail = html => html.match(/<aside class="manage-rail sidebar"[\s\S]*?<\/aside>/)[0];
  assert.equal(rail(MODELS_HTML), rail(SETTINGS_HTML), "both pages render the identical shared section list");
  const nav = rail(MODELS_HTML);
  // The workbench frame: global rail, collapsible list, top bar with the list switch.
  for (const area of ["workbench", "models", "settings"]) assert.match(MODELS_HTML, new RegExp(`class="rail-item"[^>]*data-area="${area}"`));
  assert.match(MODELS_HTML, /class="app manage-app"/);
  assert.match(MODELS_HTML, /<header class="top-bar">[\s\S]*data-sidebar-toggle="true"/);
  // Daily model work stays under Models; the connection is a Settings section still served by /models.
  const models = nav.match(/data-area-group="models">[\s\S]*?<\/div>\s*<\/div>/)[0];
  const settings = nav.match(/data-area-group="settings">[\s\S]*?<\/div>\s*<\/div>/)[0];
  for (const section of ["providers", "catalog", "quota"]) assert.match(models, new RegExp(`data-section="${section}"`));
  assert.doesNotMatch(models, /data-section="connection"/);
  for (const section of ["preferences", "skills", "server"]) {
    assert.match(settings, new RegExp(`href="/settings/${section}" data-page="settings" data-section="${section}"`));
  }
  assert.match(settings, /href="\/settings\/connection" data-page="models" data-section="connection"/);
  assert.match(nav, /Agents &amp; server/, "labels are HTML-escaped");
  for (const section of ["preferences", "skills", "server"]) assert.match(SETTINGS_HTML, new RegExp(`data-section="${section}"`));
  assert.match(SETTINGS_HTML, /id="settings-search"/);
  assert.match(SETTINGS_HTML, /id="skill-browser"/);
  assert.match(SETTINGS_HTML, /src="\/assets\/js\/app\/manage\.js"/);
  assert.ok(WEB_ASSETS["/assets/js/layout/manageShell.js"] && WEB_ASSETS["/assets/css/views/manage.css"]);
});

test("connection and provider writes carry the read revision, never echo keys and never resend unknown outcomes", async () => {
  const api = fakeApi();
  const { root, page } = mount(api);
  await page.ready;
  assert.match(text(root), /models\.application\.unverified/);
  assert.doesNotMatch(text(root), /\b(null|undefined)\b/, "empty slots never render as text");
  assert.match(text(root), /models\.scope/, "the ownership notice uses the current UI language");
  // Read-only providers expose their reason, never edit controls.
  const official = find(root, n => n.dataset.provider === "official");
  assert.match(text(official), /models\.providerReadOnlyHelp/);
  assert.equal(all(official, n => n.tagName === "BUTTON").length, 0);
  // The server returns the prefix with its trailing slash; it is shown as-is.
  const mine = text(find(root, n => n.dataset.provider === "mine"));
  assert.match(mine, /mine\//);
  assert.doesNotMatch(mine, /mine\/\//);

  // Connection save sends all five fields with the read revision.
  const form0 = connectionForm(root);
  const urlInput = find(form0, n => n.tagName === "INPUT");
  assert.ok(button(form0, "models.discard").disabled);
  urlInput.value = " http://127.0.0.1:10 "; urlInput.handlers.input();
  assert.equal(button(form0, "models.discard").disabled, false, "the first edit enables discard");
  await submit(form0); await tick();
  const [, sent] = api.calls.find(c => c[0] === "connection");
  assert.deepEqual(sent, { revision: "r1", connection: connection({ bridgeUrl: "http://127.0.0.1:10" }) });
  assert.match(text(root), /models\.saved/);

  // New provider: key is required, sent once and cleared; it never enters page state.
  button(root, "models.addProvider").handlers.click();
  let form = find(root, n => n.className.includes("models-provider-form"));
  const inputs = all(form, n => n.tagName === "INPUT");
  const [name, baseUrl, prefix] = inputs.filter(n => n.type !== "password" && n.type !== "checkbox");
  const key = inputs.find(n => n.type === "password");
  assert.equal(key.autocomplete, "new-password");
  name.value = "New"; name.handlers.input();
  baseUrl.value = "https://new.invalid"; baseUrl.handlers.input();
  assert.equal(prefix.placeholder, "mine/");
  prefix.value = "new/"; prefix.handlers.input();
  await submit(form);
  assert.equal(api.calls.filter(c => c[0] === "provider").length, 0, "new provider without key is not submitted");
  assert.match(text(root), /models\.providerNewRequired/);
  for (const invalid of ["new", "a/b/", "bad prefix/", "x".repeat(65) + "/"]) {
    form = find(root, n => n.className.includes("models-provider-form"));
    all(form, n => n.tagName === "INPUT")[2].value = invalid;
    find(form, n => n.type === "password").value = "sk-fixture-secret";
    await submit(form);
    assert.match(text(root), /models\.prefixInvalid/, invalid);
  }
  assert.equal(api.calls.filter(c => c[0] === "provider").length, 0, "prefixes outside the server contract are not submitted");
  form = find(root, n => n.className.includes("models-provider-form"));
  all(form, n => n.tagName === "INPUT")[2].value = "new/";

  api.saveModelProvider = async input => {
    api.calls.push(["provider", copy(input)]);
    throw Object.assign(new Error("prefix taken"), { disposition: "not-submitted" });
  };
  form = find(root, n => n.className.includes("models-provider-form"));
  const keyInput = find(form, n => n.type === "password");
  keyInput.value = "sk-fixture-secret";
  await submit(form); await tick();
  const [, rejected] = api.calls.filter(c => c[0] === "provider").at(-1);
  assert.deepEqual(rejected, { revision: "r2", operation: "save",
    provider: { name: "New", via: "direct", baseUrl: "https://new.invalid", prefix: "new/", enabled: true, apiKey: "sk-fixture-secret" } });
  assert.equal(keyInput.value, "", "key input is cleared after submission");
  assert.doesNotMatch(JSON.stringify(page.state), /sk-fixture-secret/);
  assert.doesNotMatch(text(root), /sk-fixture-secret/);
  form = find(root, n => n.className.includes("models-provider-form"));
  assert.equal(find(form, n => n.type === "password").value, "", "rendered key is never rehydrated");
  assert.equal(all(form, n => n.tagName === "INPUT")[0].value, "New", "rejected draft is kept");
  assert.match(text(root), /models\.rejected prefix taken/);

  // Unknown outcome: every model write is blocked until current facts are read.
  api.saveModelProvider = async input => {
    api.calls.push(["provider", copy(input)]);
    throw Object.assign(new Error("connection reset"), { disposition: "unknown" });
  };
  find(form, n => n.type === "password").value = "sk-second";
  await submit(form); await tick();
  const count = api.calls.filter(c => c[0] === "provider").length;
  assert.match(text(root), /models\.unknownBlocked/);
  form = find(root, n => n.className.includes("models-provider-form"));
  assert.ok(find(form, n => n.tagName === "BUTTON" && n.type === "submit").disabled);
  await submit(form); await submit(connectionForm(root));
  assert.equal(api.calls.filter(c => c[0] === "provider" || c[0] === "connection").length, count + 1, "nothing is resent");
  assert.ok(!api.calls.some(c => c[0] === "release"));

  api.current = view("r3");
  button(root, "models.readFacts").handlers.click(); await tick(); await tick();
  assert.ok(api.calls.some(c => c[0] === "release"), "explicit reconciliation releases the write key");
  assert.match(text(root), /models\.reconciledChanged/);
  assert.equal(button(find(root, n => n.dataset.provider === "mine"), "models.editProvider").disabled, false);
});

test("editing keeps the stored credential unless a new key is typed; removal is confirmed", async () => {
  const api = fakeApi();
  const { root, page, confirmations } = mount(api);
  await page.ready;
  button(find(root, n => n.dataset.provider === "mine"), "models.editProvider").handlers.click();
  const form = find(root, n => n.className.includes("models-provider-form"));
  assert.match(text(form), /models\.provider\.apiKeyKeepHelp/);
  await submit(form); await tick();
  const [, saved] = api.calls.find(c => c[0] === "provider");
  assert.equal(Object.hasOwn(saved.provider, "apiKey"), false);
  assert.equal(saved.provider.id, "mine");
  button(find(root, n => n.dataset.provider === "mine"), "models.removeProvider").handlers.click(); await tick();
  assert.equal(confirmations.length, 1);
  assert.deepEqual(api.calls.filter(c => c[0] === "provider").at(-1)[1], { revision: "r2", operation: "remove", id: "mine" });
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
  const { root, page } = mount(api);
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
  assert.deepEqual(api.calls.at(-1), ["refresh", { revision: "r1", kind: "quota", source: "command-code" }]);
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
  const { root, page } = mount(api);
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
  const form0 = connectionForm(root);
  find(form0, n => n.tagName === "INPUT").value = "http://127.0.0.1:11";
  await submit(form0); await tick();

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

  // Reconciling an unknown write that landed invalidates the same way.
  api.saveModelProvider = async input => { api.calls.push(["provider", copy(input)]); throw Object.assign(new Error("reset"), { disposition: "unknown" }); };
  button(find(root, n => n.dataset.provider === "mine"), "models.removeProvider").handlers.click(); await tick();
  api.current = view("r3");
  button(root, "models.readFacts").handlers.click(); await tick();
  assert.equal(page.state.catalog.page, null);
  assert.equal(api.calls.filter(c => c[0] === "catalog").length, 3);

  // A failed observation with no items is unknown, not empty.
  reads.shift().resolve({ ...observation("failed", { error: "bridge down" }), total: 0, nextCursor: null });
  quotaReads.shift().resolve(observation("failed", { error: "billing down" })); await tick();
  assert.match(text(root), /models\.catalogItemsUnknown/);
  assert.match(text(root), /models\.quotaItemsUnknown/);
  assert.doesNotMatch(text(root), /models\.catalogEmpty|models\.quotaEmpty/);
});

test("a stale-revision rejection keeps the draft and offers an explicit re-read without replay", async () => {
  const api = fakeApi();
  const { root, page } = mount(api);
  await page.ready;
  api.saveModelConnection = async input => {
    api.calls.push(["connection", copy(input)]);
    throw Object.assign(new Error("revision is stale"), { disposition: "not-submitted" });
  };
  let form = connectionForm(root);
  const urlInput = find(form, n => n.tagName === "INPUT");
  urlInput.value = "http://127.0.0.1:12"; urlInput.handlers.input();
  await submit(form); await tick();
  assert.match(text(root), /models\.rejected revision is stale/);
  assert.equal(page.state.connectionDraft.bridgeUrl, "http://127.0.0.1:12");

  // Writes are blocked while the facts are being read again.
  const reread = deferred();
  api.models = async () => { api.calls.push(["models"]); return reread.promise; };
  button(root, "models.readFacts").handlers.click(); await tick();
  form = connectionForm(root);
  assert.ok(find(form, n => n.type === "submit").disabled);
  await submit(form);
  assert.equal(api.calls.filter(c => c[0] === "connection").length, 1, "no save races the re-read");
  reread.resolve(view("r5")); await tick();

  assert.match(text(root), /models\.rereadChanged/);
  assert.ok(!api.calls.some(c => c[0] === "release"), "a rejection holds no unresolved write key");
  assert.equal(api.calls.filter(c => c[0] === "connection").length, 1, "nothing is replayed automatically");
  form = connectionForm(root);
  assert.equal(find(form, n => n.tagName === "INPUT").value, "http://127.0.0.1:12", "the draft is kept");
  api.saveModelConnection = async input => { api.calls.push(["connection", copy(input)]); return view("r6"); };
  await submit(form); await tick();
  assert.equal(api.calls.filter(c => c[0] === "connection").at(-1)[1].revision, "r5", "the next save carries the re-read revision");
});


test("sections are routed without remounting, so drafts and typed keys survive navigation and filtering", async () => {
  const api = fakeApi();
  const routes = [];
  const flags = [];
  const context = vm.createContext({ h: element, icon: name => element("svg.icon." + name), formatDateTime: iso => "at:" + iso, window: {} });
  vm.runInContext(MODELS_VIEW_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  assert.deepEqual({ ...context.normalizeRoute({ section: "bogus", source: "nope" }) }, { section: "providers", source: "factory" });
  const root = element("div");
  const page = context.mountModels(root, { t: key => key, api, confirm: () => true,
    route: { section: "quota", source: "command-code" },
    navigate: route => { routes.push({ ...route }); page.show(route); },
    onChange: next => flags.push({ ...next }) });
  await page.ready;
  const section = name => find(root, n => n.dataset.section === name);
  assert.equal(section("quota").hidden, false);
  assert.equal(section("providers").hidden, true);
  assert.deepEqual(api.calls.filter(c => c[0] === "quota").map(c => c[1]), ["command-code"], "a direct open reads the routed source");

  // In-page links go through navigate(); the quota source is part of the route.
  button(root, "models.source.factory").handlers.click(); await tick();
  assert.deepEqual(routes.at(-1), { section: "quota", source: "factory" });
  assert.deepEqual(api.calls.filter(c => c[0] === "quota").map(c => c[1]), ["command-code", "factory"]);

  // A connection draft and a provider editor with a typed key survive section
  // changes, back/forward (show) and provider filtering.
  const urlInput = find(connectionForm(root), n => n.tagName === "INPUT");
  urlInput.value = "http://127.0.0.1:99"; urlInput.handlers.input();
  page.show({ section: "providers" });
  assert.equal(flags.at(-1).connection, true, "the rail can mark the section with a draft");
  button(find(root, n => n.dataset.provider === "mine"), "models.editProvider").handlers.click();
  const key = find(root, n => n.type === "password");
  key.value = "sk-typed";
  const search = find(section("providers"), n => n.type === "search");
  search.value = "official"; search.handlers.input();
  assert.equal(find(root, n => n.dataset.provider === "mine"), undefined, "search filters rows");
  assert.match(text(section("providers")), /models\.providerCount/);
  button(section("providers"), "models.filter.readonly").handlers.click();
  assert.ok(find(root, n => n.dataset.provider === "official"));
  assert.equal(find(root, n => n.type === "password"), key, "filtering never rebuilds the editor");
  assert.equal(key.value, "sk-typed");
  page.show({ section: "catalog" }); page.show({ section: "providers" });
  assert.equal(find(root, n => n.type === "password").value, "sk-typed");
  assert.equal(connectionForm(root).children.length > 0 && find(connectionForm(root), n => n.tagName === "INPUT").value, "http://127.0.0.1:99");
  assert.equal(page.state.quota.source, "factory", "leaving quota keeps its source for the way back");
  assert.ok(page.dirty());
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
