import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { MODELS_VIEW_SCRIPT } from "../../dist/web/assets/client/views/models.js";
import { MODELS_HTML } from "../../dist/web/assets/shell/models.js";
import { SIDEBAR_HTML } from "../../dist/web/assets/shell/sidebar.js";
import { WEB_ASSETS } from "../../dist/web/assets/assetManifest.js";

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

function mount(api) {
  const context = vm.createContext({ h: element, formatDateTime: iso => "at:" + iso, window: {} });
  vm.runInContext(MODELS_VIEW_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const root = element("div");
  const confirmations = [];
  const page = context.mountModels(root, { t: (key, fallback) => key, api,
    confirm: message => { confirmations.push(message); return true; } });
  return { root, page, confirmations };
}

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
  assert.match(MODELS_HTML, /src="\/assets\/js\/app\/models\.js"/);
  assert.match(SIDEBAR_HTML, /href="\/models"/);
});

test("connection and provider writes carry the read revision, never echo keys and never resend unknown outcomes", async () => {
  const api = fakeApi();
  const { root, page } = mount(api);
  await page.ready;
  assert.match(text(root), /models\.application\.unverified/);
  assert.doesNotMatch(text(root), /\b(null|undefined)\b/, "empty slots never render as text");
  assert.match(text(root), /notice-r1/);
  // Read-only providers expose their reason, never edit controls.
  const official = find(root, n => n.dataset.provider === "official");
  assert.match(text(official), /official subscription route/);
  assert.equal(all(official, n => n.tagName === "BUTTON").length, 0);
  // The server returns the prefix with its trailing slash; it is shown as-is.
  const mine = text(find(root, n => n.dataset.provider === "mine"));
  assert.match(mine, /mine\//);
  assert.doesNotMatch(mine, /mine\/\//);

  // Connection save sends all five fields with the read revision.
  const connectionForm = find(root, n => n.tagName === "FORM");
  const urlInput = find(connectionForm, n => n.tagName === "INPUT");
  assert.ok(button(connectionForm, "models.discard").disabled);
  urlInput.value = " http://127.0.0.1:10 "; urlInput.handlers.input();
  assert.equal(button(connectionForm, "models.discard").disabled, false, "the first edit enables discard");
  await submit(connectionForm); await tick();
  const [, sent] = api.calls.find(c => c[0] === "connection");
  assert.deepEqual(sent, { revision: "r1", connection: connection({ bridgeUrl: "http://127.0.0.1:10" }) });
  assert.match(text(root), /models\.saved notice-r2/);

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
  await submit(form); await submit(find(root, n => n.tagName === "FORM"));
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
    windows: [{ label: "weekly", remainingFraction: null, used: 5, cap: null, resetTime: null }], balance: null, periodEnd: null, error: "window missing" }] });
  const select = find(root, n => n.tagName === "SELECT");
  select.value = "command-code"; select.handlers.change(); await tick();
  assert.deepEqual(api.calls.filter(c => c[0] === "quota").map(c => c[1]), ["factory", "command-code"]);
  const quota = text(root);
  assert.match(quota, /models\.stale/);
  assert.match(quota, /models\.remaining models\.unknown/);
  assert.match(quota, /models\.used 5 \/ models\.unknown/);
  assert.match(quota, /models\.balance models\.unknown/);

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
  const connectionForm = find(root, n => n.tagName === "FORM");
  find(connectionForm, n => n.tagName === "INPUT").value = "http://127.0.0.1:11";
  await submit(connectionForm); await tick();

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
  let form = find(root, n => n.tagName === "FORM");
  const urlInput = find(form, n => n.tagName === "INPUT");
  urlInput.value = "http://127.0.0.1:12"; urlInput.handlers.input();
  await submit(form); await tick();
  assert.match(text(root), /models\.rejected revision is stale/);
  assert.equal(page.state.connectionDraft.bridgeUrl, "http://127.0.0.1:12");

  // Writes are blocked while the facts are being read again.
  const reread = deferred();
  api.models = async () => { api.calls.push(["models"]); return reread.promise; };
  button(root, "models.readFacts").handlers.click(); await tick();
  form = find(root, n => n.tagName === "FORM");
  assert.ok(find(form, n => n.type === "submit").disabled);
  await submit(form);
  assert.equal(api.calls.filter(c => c[0] === "connection").length, 1, "no save races the re-read");
  reread.resolve(view("r5")); await tick();

  assert.match(text(root), /models\.rereadChanged/);
  assert.ok(!api.calls.some(c => c[0] === "release"), "a rejection holds no unresolved write key");
  assert.equal(api.calls.filter(c => c[0] === "connection").length, 1, "nothing is replayed automatically");
  form = find(root, n => n.tagName === "FORM");
  assert.equal(find(form, n => n.tagName === "INPUT").value, "http://127.0.0.1:12", "the draft is kept");
  api.saveModelConnection = async input => { api.calls.push(["connection", copy(input)]); return view("r6"); };
  await submit(form); await tick();
  assert.equal(api.calls.filter(c => c[0] === "connection").at(-1)[1].revision, "r5", "the next save carries the re-read revision");
});
