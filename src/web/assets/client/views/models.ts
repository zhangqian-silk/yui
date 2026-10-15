export const MODELS_VIEW_SCRIPT = String.raw`
// Model management page body, split into four routed sections: access
// (metabridge providers), the cached model catalog, per-source quota and the
// management connection settings. Every fact comes from /api/models*; the
// page keeps only drafts and view state. Saving configuration is not applying
// it (metabridge needs its own reload), a quota or catalog observation is
// never upgraded to success, and an API key typed here lives only in its
// password input until submission.
//
// All four sections stay mounted and are only hidden, so moving between them
// (including browser back/forward) never discards a draft. The entry module
// owns the URL; this view renders whichever route it is given.
//
// deps: t, locale, api (models* functions from lib/api), confirm(text),
// route {section, source}, navigate(route) and onChange(flags), all optional
// except t and api.
import { h, icon } from "/assets/js/lib/dom.js";
import { formatDateTime } from "/assets/js/lib/format.js";

export const QUOTA_SOURCES = ["factory", "command-code"];
export const SECTIONS = ["providers", "catalog", "quota", "connection"];
const CONNECTION_GROUPS = [
  { key: "bridge", fields: ["bridgeUrl", "bridgeConfigFile", "catalogKeyFile"] },
  { key: "cpa", fields: ["cpaUrl", "managementKeyFile"] }
];
const CONNECTION_FIELDS = ["bridgeUrl", "bridgeConfigFile", "cpaUrl", "managementKeyFile", "catalogKeyFile"];
const OBSERVATION_TONES = { success: "ok", partial: "warn", failed: "bad", unsupported: "idle", "not-queried": "idle" };
const ROUTE_FILTERS = ["all", "direct", "cpa", "unknown"];
const STATE_FILTERS = ["all", "enabled", "disabled", "readonly"];
// Server contract: the prefix is sent and returned with its trailing slash.
export const PREFIX_PATTERN = /^[a-zA-Z0-9_-]{1,64}\/$/;

// Normalizes any requested route; unknown values fall back to the defaults.
export function normalizeRoute(route) {
  const value = route || {};
  return {
    section: SECTIONS.includes(value.section) ? value.section : SECTIONS[0],
    source: QUOTA_SOURCES.includes(value.source) ? value.source : QUOTA_SOURCES[0]
  };
}

// A window label is the server's own text. Factory labels read
// "<group> / <window>"; anything without that separator stays ungrouped.
export function splitWindowLabel(label) {
  const text = String(label || "");
  const at = text.indexOf(" / ");
  return at > 0 ? { group: text.slice(0, at), window: text.slice(at + 3) } : { group: "", window: text };
}

export function mountModels(root, deps) {
  const t = deps.t;
  const api = deps.api;
  const locale = deps.locale || function () { return "en"; };
  const confirm = deps.confirm || function (text) { return window.confirm(text); };
  const onChange = deps.onChange || function () {};
  const initial = normalizeRoute(deps.route);
  const state = {
    route: initial,
    view: null, loading: false, loadError: null,
    // One write at a time; an unknown outcome blocks every write until the
    // reader explicitly reads current facts again.
    // A rejected write (for example a stale revision) keeps its draft and
    // offers an explicit re-read; nothing is replayed automatically.
    pending: false, unknown: false, rejected: false, receipt: null,
    connectionDraft: null, providerDraft: null,
    providerFilter: { query: "", route: "all", state: "all" },
    catalog: { page: null, items: [], loading: false, error: null, note: null, generation: 0, query: "", source: "all" },
    quota: { source: initial.source, observation: null, loading: false, error: null, unavailable: false, generation: 0 }
  };
  function panel(name) {
    return h("section.models-section", { dataset: { section: name }, "aria-labelledby": "models-" + name + "-title" });
  }
  const status = h("div.models-status", { "aria-live": "polite" });
  const sections = { providers: panel("providers"), catalog: panel("catalog"), quota: panel("quota"), connection: panel("connection") };
  root.replaceChildren(status, sections.providers, sections.catalog, sections.quota, sections.connection);

  function tone(name, text) { return h("span.badge.tone-" + name, null, h("span.badge-dot"), text); }
  function when(iso) { return iso ? formatDateTime(iso, locale()) : t("models.unknown"); }
  function known(value, render) { return value === null || value === undefined ? t("models.unknown") : render ? render(value) : String(value); }
  function percent(fraction) { return Math.round(fraction * 1000) / 10 + "%"; }
  // Re-reading facts also blocks writes so no save races the new revision.
  function writesBlocked() { return !state.view || state.pending || state.unknown || state.loading; }
  function go(route) {
    const next = normalizeRoute(Object.assign({}, state.route, route));
    if (deps.navigate) deps.navigate(next);
    else show(next);
  }
  function sectionLink(section, text) {
    return h("a.btn-link", { href: "/models?section=" + section, onclick: function (event) {
      if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); go({ section: section });
    } }, text);
  }
  function head(name, hint, actions) {
    return h("header.models-head", null,
      h("div.models-heading", null, h("h1", { id: "models-" + name + "-title" }, t("models.section." + name)), hint ? h("p", null, hint) : null),
      actions && actions.length ? h("div.card-actions", null, actions) : null);
  }
  function receiptNode(scope) {
    if (!state.receipt || state.receipt.scope !== scope) return null;
    const line = h("p.receipt.models-receipt", { role: "status", "aria-live": "polite" }, state.receipt.text);
    line.dataset.state = state.receipt.state;
    if (!(state.rejected && state.receipt.rejected && !state.unknown)) return line;
    return h("div.models-receipt-group", null, line, h("div.settings-actions", null,
      h("button.btn", { type: "button", disabled: state.loading || state.pending, onclick: function () { void reconcile(); } }, t("models.readFacts"))));
  }
  function field(labelText, control, hint) {
    return h("label.field", null, h("span", null, labelText), control, hint ? h("small.faint", null, hint) : null);
  }
  function searchBox(labelKey, value, onInput) {
    const input = h("input", { type: "search", autocomplete: "off", spellcheck: "false", placeholder: t(labelKey) });
    input.value = value;
    input.addEventListener("input", function () { onInput(input.value); });
    return h("label.models-search", null, icon("search"), h("span.sr-only", null, t(labelKey)), input);
  }
  function filterGroup(labelKey, values, current, labelOf, onPick) {
    return h("div.seg.seg-sm", { role: "group", "aria-label": t(labelKey) }, values.map(function (value) {
      return h("button.seg-btn", { type: "button", "aria-pressed": String(value === current), onclick: function () { onPick(value); } }, labelOf(value));
    }));
  }
  function notify() {
    onChange({ connection: !!state.connectionDraft, provider: !!state.providerDraft, unknown: state.unknown, pending: state.pending });
  }

  // ---- Routing ----------------------------------------------------------
  function show(route) {
    const next = normalizeRoute(route);
    // Only the quota section reads its source from the route; elsewhere the
    // last shown source is kept for the way back.
    if (next.section !== "quota") next.source = state.quota.source;
    const sourceChanged = next.source !== state.quota.source;
    state.route = next;
    state.quota.source = next.source;
    SECTIONS.forEach(function (name) { sections[name].hidden = name !== next.section; });
    if (sourceChanged) void loadQuota();
    else renderQuota();
    notify();
    return next;
  }

  function renderAll() {
    renderStatus(); renderConnection(); renderProviders(); renderCatalog(); renderQuota();
    SECTIONS.forEach(function (name) { sections[name].hidden = name !== state.route.section; });
    notify();
  }

  // Page-wide facts and blocking conditions stay visible in every section.
  function renderStatus() {
    const view = state.view;
    const children = [];
    if (state.loading && !view) children.push(h("p", { role: "status" }, t("models.loading")));
    if (view) {
      children.push(h("div.models-facts", null,
        tone(view.connection ? "info" : "idle", view.connection ? t("models.connected") : t("models.disconnected")),
        tone("warn", t("models.application." + view.application, view.application)),
        view.notice ? h("small.faint.models-notice", null, view.notice) : null));
    }
    if (state.loadError) {
      children.push(h("div.models-alert", { role: "alert" }, icon("alert"), h("p.settings-error", null, t("models.loadFailed") + " " + state.loadError),
        h("button.btn", { type: "button", onclick: function () { void load(); } }, t("models.retry"))));
    }
    if (view && view.configurationError) {
      children.push(h("div.models-alert", { role: "alert" }, icon("alert"), h("p.settings-error", null, t("models.configurationError") + " " + view.configurationError)));
    }
    if (state.unknown) {
      children.push(h("div.models-alert", { role: "alert" }, icon("alert"), h("p.settings-error", null, t("models.unknownBlocked")),
        h("button.btn", { type: "button", disabled: state.loading, onclick: function () { void reconcile(); } }, t("models.readFacts"))));
    }
    children.push(receiptNode("summary"));
    status.replaceChildren.apply(status, children.filter(Boolean));
  }

  // ---- Connection settings ----------------------------------------------
  function connectionValues() {
    if (state.connectionDraft) return state.connectionDraft;
    const current = state.view && state.view.connection;
    const values = {};
    CONNECTION_FIELDS.forEach(function (key) { values[key] = current ? current[key] || "" : ""; });
    return values;
  }
  function renderConnection() {
    const view = state.view;
    const values = connectionValues();
    const blocked = writesBlocked();
    const form = h("form.models-connection-form", { novalidate: true });
    const inputs = {};
    const discard = h("button.btn.btn-ghost", { type: "button", disabled: !state.connectionDraft || state.pending }, t("models.discard"));
    CONNECTION_GROUPS.forEach(function (group) {
      const set = h("fieldset.models-fieldset", null, h("legend", null, t("models.connectionGroup." + group.key)));
      group.fields.forEach(function (key) {
        const input = h("input", { type: key.endsWith("Url") ? "url" : "text", autocomplete: "off", spellcheck: "false",
          value: values[key], disabled: blocked, required: key === "bridgeUrl" });
        input.value = values[key];
        input.addEventListener("input", function () {
          const draft = Object.assign({}, connectionValues());
          draft[key] = input.value;
          const first = !state.connectionDraft;
          state.connectionDraft = draft;
          discard.disabled = state.pending;
          if (first) notify();
        });
        inputs[key] = input;
        set.append(field(t("models.connection." + key), input, t("models.connection." + key + "Help")));
      });
      form.append(set);
    });
    const save = h("button.btn.btn-primary", { type: "submit", disabled: blocked }, t("models.saveConnection"));
    const disconnect = h("button.btn", { type: "button", disabled: blocked || !(view && view.connection) }, t("models.disconnect"));
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (writesBlocked()) return;
      const connection = {};
      CONNECTION_FIELDS.forEach(function (key) { connection[key] = inputs[key].value.trim(); });
      if (!connection.bridgeUrl) { setReceipt(t("models.bridgeUrlRequired"), "bad", "connection"); renderConnection(); return; }
      void write(function (revision) { return api.saveModelConnection({ revision: revision, connection: connection }); },
        { scope: "connection", clearConnection: true });
    });
    disconnect.addEventListener("click", function () {
      if (writesBlocked() || !confirm(t("models.disconnectConfirm"))) return;
      void write(function (revision) { return api.saveModelConnection({ revision: revision, connection: null }); },
        { scope: "connection", clearConnection: true });
    });
    discard.addEventListener("click", function () { state.connectionDraft = null; renderConnection(); notify(); });
    form.append(h("div.settings-actions", null, save, disconnect, discard,
      state.connectionDraft ? h("small.faint", null, t("models.unsavedDraft")) : null));
    const receipt = receiptNode("connection");
    if (receipt) form.append(receipt);
    sections.connection.replaceChildren.apply(sections.connection, [
      head("connection", t("models.connectionHelp")),
      view && !view.connection ? h("p.models-note", null, icon("info"), t("models.notConnected")) : null,
      h("div.card.models-card", null, h("div.card-body", null, form)),
      h("div.card.models-card", null, h("div.card-body.models-explain", null,
        h("h2", null, t("models.applicationTitle")),
        h("p", null, t("models.applicationHelp")),
        h("p", null, t("models.agentSettings") + " ", h("a.btn-link", { href: "/settings" }, t("models.openSettings")))))].filter(Boolean));
  }

  // ---- Access (providers) -----------------------------------------------
  function configurable() {
    const view = state.view;
    return !!(view && view.connection && view.connection.bridgeConfigFile);
  }
  function startProvider(provider) {
    if (state.providerDraft && !confirm(t("models.discardProvider"))) return;
    state.providerDraft = provider
      ? { id: provider.id, name: provider.name, via: provider.via, baseUrl: provider.baseUrl, prefix: provider.prefix,
        enabled: provider.enabled, credentialPresent: provider.credentialPresent }
      : { id: null, name: "", via: "direct", baseUrl: "", prefix: "", enabled: true, credentialPresent: false };
    renderProviders();
    notify();
  }
  function providerMatches(provider) {
    const filter = state.providerFilter;
    if (filter.route !== "all" && provider.via !== filter.route) return false;
    if (filter.state === "enabled" && !provider.enabled) return false;
    if (filter.state === "disabled" && provider.enabled) return false;
    if (filter.state === "readonly" && provider.editable) return false;
    const query = filter.query.trim().toLowerCase();
    if (!query) return true;
    return [provider.name, provider.id, provider.baseUrl, provider.prefix].some(function (value) {
      return String(value || "").toLowerCase().includes(query);
    });
  }
  function providerRow(provider) {
    const blocked = writesBlocked();
    const editing = !!(state.providerDraft && state.providerDraft.id === provider.id);
    const actions = h("div.models-row-actions");
    if (provider.editable) {
      actions.append(
        h("button.btn", { type: "button", disabled: blocked, "aria-label": t("models.editProvider") + " " + provider.name,
          onclick: function () { startProvider(provider); } }, t("models.editProvider")),
        h("button.btn.btn-ghost.models-danger", { type: "button", disabled: blocked, "aria-label": t("models.removeProvider") + " " + provider.name, onclick: function () {
          if (writesBlocked() || !confirm(t("models.removeConfirm") + " " + provider.name)) return;
          void write(function (revision) { return api.saveModelProvider({ revision: revision, operation: "remove", id: provider.id }); },
            { scope: "provider", clearProvider: !!(state.providerDraft && state.providerDraft.id === provider.id) });
        } }, t("models.removeProvider")));
    } else {
      actions.append(h("span.chip", null, t("models.readOnly")));
      if (provider.reason) actions.append(h("small.faint.models-reason", null, provider.reason));
    }
    return h("tr", { dataset: { provider: provider.id }, "aria-current": editing ? "true" : null },
      h("td", { dataset: { label: t("models.column.provider") } },
        h("div.models-cell-main", null, h("strong", null, provider.name), h("code.id", null, provider.id))),
      h("td", { dataset: { label: t("models.column.baseUrl") } },
        h("span.mono-line.models-url", { title: provider.baseUrl || "" }, provider.baseUrl || t("models.unknown"))),
      h("td", { dataset: { label: t("models.column.prefix") } },
        provider.prefix ? h("code.id", null, provider.prefix) : h("span.chip", null, t("models.noPrefix"))),
      h("td", { dataset: { label: t("models.column.route") } }, h("span.chip", null, t("models.via." + provider.via, provider.via))),
      h("td", { dataset: { label: t("models.column.state") } }, h("div.models-facts", null,
        tone(provider.enabled ? "ok" : "idle", provider.enabled ? t("models.enabled") : t("models.disabled")),
        tone(provider.credentialPresent ? "info" : "idle", provider.credentialPresent ? t("models.credentialStored") : t("models.credentialMissing")))),
      h("td", { dataset: { label: t("models.column.actions") } }, actions));
  }
  function providerForm() {
    const draft = state.providerDraft;
    const isNew = !draft.id;
    const blocked = writesBlocked();
    const form = h("form.settings-stack.models-provider-form", { novalidate: true });
    function bind(control, key, read) {
      control.addEventListener(control.type === "checkbox" ? "change" : "input", function () { draft[key] = read(control); });
      return control;
    }
    const name = bind(h("input", { autocomplete: "off", disabled: blocked, value: draft.name }), "name", function (c) { return c.value; });
    name.value = draft.name;
    const via = h("select", { disabled: blocked },
      h("option", { value: "direct" }, t("models.via.direct")), h("option", { value: "cpa" }, t("models.via.cpa")),
      draft.via === "unknown" ? h("option", { value: "unknown", disabled: true }, t("models.via.unknown")) : null);
    via.value = draft.via;
    // Changing the route only retitles its hints; re-rendering would discard a typed key.
    const viaHint = h("small.faint");
    const keyLabel = h("span");
    function describeVia() {
      viaHint.textContent = via.value === "cpa" ? t("models.provider.viaCpaHelp") : t("models.provider.viaDirectHelp");
      keyLabel.textContent = via.value === "cpa" ? t("models.provider.apiKeyCpa") : t("models.provider.apiKey");
    }
    via.addEventListener("change", function () { draft.via = via.value; describeVia(); });
    const baseUrl = bind(h("input", { type: "url", autocomplete: "off", spellcheck: "false", disabled: blocked, value: draft.baseUrl }), "baseUrl", function (c) { return c.value; });
    baseUrl.value = draft.baseUrl;
    const prefix = bind(h("input", { autocomplete: "off", spellcheck: "false", disabled: blocked, value: draft.prefix,
      placeholder: "mine/", maxlength: "65" }), "prefix", function (c) { return c.value; });
    prefix.value = draft.prefix;
    const enabled = bind(h("input", { type: "checkbox", disabled: blocked }), "enabled", function (c) { return c.checked; });
    enabled.checked = !!draft.enabled;
    // The key is never part of the draft or any re-render; it is read once at
    // submission and the input is discarded afterwards.
    const apiKey = h("input", { type: "password", autocomplete: "new-password", spellcheck: "false", disabled: blocked,
      placeholder: isNew ? "" : t("models.apiKeyKeep") });
    const save = h("button.btn.btn-primary", { type: "submit", disabled: blocked }, isNew ? t("models.createProvider") : t("models.saveProvider"));
    const cancel = h("button.btn.btn-ghost", { type: "button", disabled: state.pending }, t("models.cancel"));
    cancel.addEventListener("click", function () { state.providerDraft = null; renderProviders(); notify(); });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (writesBlocked()) return;
      const key = apiKey.value;
      apiKey.value = "";
      const provider = { name: name.value.trim(), via: via.value, baseUrl: baseUrl.value.trim(), prefix: prefix.value.trim(), enabled: enabled.checked };
      if (!isNew) provider.id = draft.id;
      const missing = !provider.name || !provider.baseUrl || (isNew && !provider.prefix) || (isNew && !key)
        || (provider.via !== "direct" && provider.via !== "cpa");
      if (missing) { setReceipt(t(isNew ? "models.providerNewRequired" : "models.providerRequired"), "bad", "provider"); renderProviders(); return; }
      if (!PREFIX_PATTERN.test(provider.prefix)) { setReceipt(t("models.prefixInvalid"), "bad", "provider"); renderProviders(); return; }
      if (key) provider.apiKey = key;
      void write(function (revision) { return api.saveModelProvider({ revision: revision, operation: "save", provider: provider }); },
        { scope: "provider", clearProvider: true });
    });
    describeVia();
    form.append(
      h("div.models-form-head", null, h("h2", null, isNew ? t("models.newProvider") : t("models.editProvider") + " · " + draft.name),
        isNew ? null : h("code.id", null, draft.id)),
      h("div.settings-grid", null,
        field(t("models.provider.name"), name),
        h("label.field", null, h("span", null, t("models.provider.via")), via, viaHint),
        field(t("models.provider.baseUrl"), baseUrl),
        field(t("models.provider.prefix"), prefix, t("models.provider.prefixHelp"))),
      h("label.settings-reset", null, enabled, t("models.provider.enabled")),
      h("label.field", null, keyLabel, apiKey, h("small.faint", null,
        isNew ? t("models.provider.apiKeyNewHelp") : (draft.credentialPresent ? t("models.provider.apiKeyKeepHelp") : t("models.provider.apiKeyMissingHelp")))),
      h("div.settings-actions", null, save, cancel));
    return form;
  }
  // The list re-renders on every keystroke in the search box; the toolbar
  // (and the editor above it) are left alone so neither loses focus or input.
  const providerResults = h("div.models-results");
  function renderProviderResults() {
    const view = state.view;
    if (!view) { providerResults.replaceChildren(); return; }
    const rows = view.providers.filter(providerMatches);
    const count = h("p.faint.models-count", { role: "status" }, t("models.providerCount")
      .replace("{shown}", String(rows.length)).replace("{total}", String(view.providers.length)));
    if (!view.providers.length) { providerResults.replaceChildren(h("p.models-empty", null, t("models.noProviders"))); return; }
    if (!rows.length) { providerResults.replaceChildren(count, h("p.models-empty", null, t("models.noProviderMatches"))); return; }
    providerResults.replaceChildren(count, h("div.models-table-wrap", null, h("table.models-table", null,
      h("thead", null, h("tr", null, ["provider", "baseUrl", "prefix", "route", "state", "actions"].map(function (key) {
        return h("th", { scope: "col" }, t("models.column." + key));
      }))),
      h("tbody", null, rows.map(providerRow)))));
  }
  // Filters re-render only the toolbar and list, never an open editor.
  const providerTools = h("div.models-toolbar");
  function renderProviderTools() {
    const filter = state.providerFilter;
    providerTools.replaceChildren(
      searchBox("models.searchProviders", filter.query, function (value) { filter.query = value; renderProviderResults(); }),
      filterGroup("models.filter.route", ROUTE_FILTERS, filter.route, function (value) {
        return value === "all" ? t("models.filter.all") : t("models.via." + value, value);
      }, function (value) { filter.route = value; renderProviderTools(); }),
      filterGroup("models.filter.state", STATE_FILTERS, filter.state, function (value) {
        return t("models.filter." + value);
      }, function (value) { filter.state = value; renderProviderTools(); }));
    renderProviderResults();
  }
  function renderProviders() {
    const view = state.view;
    const add = h("button.btn.btn-primary", { type: "button", disabled: writesBlocked() || !configurable() || !!state.providerDraft,
      onclick: function () { startProvider(null); } }, icon("plus"), t("models.addProvider"));
    const children = [head("providers", t("models.providersHelp"), view ? [add] : null)];
    if (!view) children.push(h("p.models-empty", null, state.loading ? t("models.loading") : t("models.unavailable")));
    else {
      if (!configurable()) children.push(h("p.models-note", null, icon("info"), t("models.configFileRequired") + " ",
        sectionLink("connection", t("models.openConnection"))));
      children.push(receiptNode("provider"));
      if (state.providerDraft) children.push(h("div.card.models-card.models-editor", null, h("div.card-body", null, providerForm())));
      children.push(h("div.card.models-card", null, providerTools, providerResults));
      renderProviderTools();
    }
    sections.providers.replaceChildren.apply(sections.providers, children.filter(Boolean));
  }

  // ---- Observations -----------------------------------------------------
  function observationLine(observation) {
    const status = observation.status;
    return h("div.models-facts", { role: "status" },
      tone(OBSERVATION_TONES[status] || "idle", t("models.status." + status, status)),
      observation.stale ? tone("warn", t("models.stale")) : null,
      h("small.faint", null, t("models.attempted") + " " + when(observation.attemptedAt) + " · " + t("models.observed") + " " + when(observation.observedAt)));
  }
  function observationError(observation) {
    return observation.error ? h("p.settings-error", null, observation.error) : null;
  }

  const catalogResults = h("div.models-results");
  function catalogMatches(item) {
    const catalog = state.catalog;
    if (catalog.source !== "all" && item.source !== catalog.source) return false;
    const query = catalog.query.trim().toLowerCase();
    return !query || item.id.toLowerCase().includes(query);
  }
  function renderCatalogResults() {
    const catalog = state.catalog;
    const page = catalog.page;
    if (!page || !catalog.items.length) { catalogResults.replaceChildren(); return; }
    const rows = catalog.items.filter(catalogMatches);
    // Search covers only the pages already read; the count says so.
    const count = t("models.catalogCount").replace("{shown}", String(catalog.items.length)).replace("{total}", String(page.total))
      + (rows.length === catalog.items.length ? "" : " · " + t("models.catalogMatches").replace("{count}", String(rows.length)));
    catalogResults.replaceChildren(h("p.faint.models-count", { role: "status" }, count),
      rows.length ? h("ul.models-catalog", null, rows.map(function (item) {
        return h("li.models-catalog-item", null, h("code", null, item.id), h("span.chip", null, item.source));
      })) : h("p.models-empty", null, t("models.noCatalogMatches")));
  }
  function renderCatalog() {
    const catalog = state.catalog;
    const page = catalog.page;
    const refresh = h("button.btn", { type: "button", disabled: catalog.loading || !state.view || !(state.view.connection), onclick: function () { void refreshCatalog(); } },
      icon("refresh"), t("models.refreshCatalog"));
    const children = [head("catalog", t("models.catalogHelp"), [refresh])];
    const body = h("div.card-body");
    if (catalog.loading) body.append(h("p", { role: "status" }, t("models.loading")));
    if (catalog.error) body.append(h("p.settings-error", { role: "alert" }, t("models.catalogFailed") + " " + catalog.error));
    if (catalog.note) body.append(h("p", { role: "status" }, catalog.note));
    if (page) {
      body.append(observationLine(page));
      const error = observationError(page);
      if (error) body.append(error);
      // Only a successful observation can say the catalog is really empty.
      if (!catalog.items.length) body.append(h("p.models-empty", null, t(page.status === "not-queried" ? "models.catalogNotQueried"
        : page.status === "success" ? "models.catalogEmpty" : "models.catalogItemsUnknown")));
      else {
        const sources = [];
        catalog.items.forEach(function (item) { if (!sources.includes(item.source)) sources.push(item.source); });
        if (catalog.source !== "all" && !sources.includes(catalog.source)) catalog.source = "all";
        body.append(h("div.models-toolbar.models-toolbar-flat", null,
          searchBox("models.searchCatalog", catalog.query, function (value) { catalog.query = value; renderCatalogResults(); }),
          sources.length > 1 ? filterGroup("models.filter.source", ["all"].concat(sources), catalog.source, function (value) {
            return value === "all" ? t("models.filter.all") : value;
          }, function (value) { catalog.source = value; renderCatalog(); }) : null), catalogResults);
        renderCatalogResults();
      }
    }
    const more = page && page.nextCursor
      ? h("button.btn", { type: "button", disabled: catalog.loading, onclick: function () { void loadCatalog(page.nextCursor); } }, t("models.moreCatalog"))
      : null;
    if (more) body.append(h("div.settings-actions", null, more));
    children.push(h("div.card.models-card", null, body));
    sections.catalog.replaceChildren.apply(sections.catalog, children.filter(Boolean));
  }

  // The page CSP forbids style attributes; the width is set through CSSOM.
  function meterFill(fraction) {
    const fill = h("span");
    if (fill.style) fill.style.width = Math.max(0, Math.min(100, fraction * 100)) + "%";
    return fill;
  }
  function windowRow(entry) {
    const parts = splitWindowLabel(entry.label);
    const fraction = entry.remainingFraction;
    const level = fraction === null ? "idle" : fraction >= 0.5 ? "ok" : fraction >= 0.2 ? "warn" : "bad";
    const name = parts.window || entry.label;
    // An unknown fraction draws an empty, unlabelled track, never 0%.
    const bar = fraction === null
      ? h("div.models-meter.is-unknown", { "aria-hidden": "true" })
      : h("div.models-meter.tone-" + level, { role: "progressbar", "aria-label": name, "aria-valuemin": "0", "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(fraction * 100)), "aria-valuetext": t("models.remaining") + " " + percent(fraction) },
        meterFill(fraction));
    const details = [entry.resetTime ? t("models.resets") + " " + when(entry.resetTime) : t("models.resetUnknown")];
    if (entry.used !== null || entry.cap !== null) details.push(t("models.used") + " " + known(entry.used) + " / " + known(entry.cap));
    return h("li.models-window", null,
      h("div.models-window-line", null, h("span.models-window-name", null, name),
        h("span.models-window-value", null, t("models.remaining") + " " + known(fraction, percent))),
      bar, h("small.faint", null, details.join(" · ")));
  }
  function quotaGroups(windows) {
    const groups = [];
    windows.forEach(function (entry) {
      const name = splitWindowLabel(entry.label).group;
      let group = groups.find(function (g) { return g.name === name; });
      if (!group) { group = { name: name, windows: [] }; groups.push(group); }
      group.windows.push(entry);
    });
    return groups;
  }
  function quotaItem(item) {
    const facts = (item.balanceDetails || []).map(function (entry) {
      return h("div", null, h("dt", null, t("models.balance." + entry.kind)), h("dd", null, known(entry.value)));
    });
    // Only Command Code reports a total and a period; Factory has neither, so
    // its absence there is not repeated as an unknown on every account.
    if (item.source === "command-code" || item.balance !== null) {
      facts.push(h("div", null, h("dt", null, t("models.balance")), h("dd", null, known(item.balance))));
    }
    if (item.source === "command-code" || item.periodEnd) {
      facts.push(h("div", null, h("dt", null, t("models.periodEnd")), h("dd", null, when(item.periodEnd))));
    }
    return h("li.card.models-account", null,
      h("div.card-head", null, h("div.card-heading", null,
        h("div.card-title", null, h("span", null, item.id),
          tone(OBSERVATION_TONES[item.status] || "idle", t("models.status." + item.status, item.status))),
        item.source === "factory" ? h("span.card-hint", null, t("models.accountIdHelp")) : null)),
      h("div.card-body", null,
        item.error ? h("p.settings-error", null, item.error) : null,
        item.windows.length ? h("div.models-groups", null, quotaGroups(item.windows).map(function (group) {
          return h("div.models-group", null, group.name ? h("h3", null, group.name) : null,
            h("ul.models-windows", null, group.windows.map(windowRow)));
        })) : h("p.faint", null, t("models.noWindows")),
        facts.length ? h("dl.models-balances", null, facts) : null));
  }
  function quotaReady() {
    const connection = state.view && state.view.connection;
    return !!(connection && connection.cpaUrl && connection.managementKeyFile);
  }
  function renderQuota() {
    const quota = state.quota;
    const tabs = h("div.seg", { role: "group", "aria-label": t("models.source") }, QUOTA_SOURCES.map(function (source) {
      return h("button.seg-btn", { type: "button", "aria-pressed": String(source === quota.source), disabled: quota.loading && source !== quota.source,
        onclick: function () { if (source !== quota.source) go({ section: "quota", source: source }); } }, t("models.source." + source, source));
    }));
    const refresh = h("button.btn", { type: "button", disabled: quota.loading || !quotaReady(), onclick: function () { void refreshQuota(); } },
      icon("refresh"), t("models.refreshQuota"));
    const children = [head("quota", t("models.quotaHelp"), [refresh]), h("div.models-toolbar.models-toolbar-flat", null, tabs)];
    if (!quotaReady()) children.push(h("p.models-note", null, icon("info"), t("models.quotaNeedsCpa") + " ", sectionLink("connection", t("models.openConnection"))));
    const body = [];
    if (quota.loading) body.push(h("p", { role: "status" }, t("models.loading")));
    if (quota.unavailable) body.push(h("p", { role: "status" }, t("models.quotaUnavailable")));
    else if (quota.error) body.push(h("p.settings-error", { role: "alert" }, t("models.quotaFailed") + " " + quota.error));
    const observation = quota.observation;
    if (observation) {
      body.push(observationLine(observation), observationError(observation));
      if (observation.status === "not-queried") body.push(h("p.models-empty", null, t("models.quotaNotQueried")));
      else if (observation.status === "unsupported") body.push(h("p.models-empty", null, t("models.quotaUnsupported")));
      else if (!observation.items.length) body.push(h("p.models-empty", null, t(observation.status === "success" ? "models.quotaEmpty" : "models.quotaItemsUnknown")));
    }
    children.push(h("div.card.models-card", null, h("div.card-body", null, body.filter(Boolean))));
    if (observation && observation.items.length && observation.status !== "not-queried" && observation.status !== "unsupported") {
      children.push(h("ul.models-accounts", null, observation.items.map(quotaItem)));
    }
    sections.quota.replaceChildren.apply(sections.quota, children.filter(Boolean));
  }

  // ---- Reads and writes -------------------------------------------------
  function setReceipt(text, receiptState, scope) { state.receipt = { text: text, state: receiptState, scope: scope }; }

  // Observations belong to one configuration revision: the server drops its
  // caches when the revision changes, so the page does too. Bumping each
  // generation fences responses still in flight for the old revision, and only
  // the new caches are read (GET); no external refresh is sent automatically.
  function adoptView(view) {
    const previous = state.view;
    state.view = view;
    if (!previous || previous.revision === view.revision) return false;
    invalidateObservations();
    return true;
  }
  function invalidateObservations() {
    const catalog = state.catalog;
    catalog.generation++;
    catalog.page = null; catalog.items = []; catalog.error = null; catalog.note = null; catalog.loading = false;
    const quota = state.quota;
    quota.generation++;
    quota.observation = null; quota.error = null; quota.unavailable = false; quota.loading = false;
    void loadCatalog(null); void loadQuota();
  }

  async function load() {
    state.loading = true; state.loadError = null; renderAll();
    try { adoptView(await api.models()); }
    catch (error) { state.loadError = error.message; }
    finally { state.loading = false; renderAll(); }
    return !state.loadError;
  }

  // An unknown write is never resent. Reading current facts again lets the
  // reader see whether it landed; later writes carry that fresh revision, so
  // the server's revision check rejects anything based on the old view.
  // After a rejection the same explicit read refreshes the revision while the
  // non-secret drafts stay for the reader to review and save again.
  async function reconcile() {
    if (state.pending || state.loading) return;
    const view = state.view;
    const wasUnknown = state.unknown;
    if (!(await load())) return;
    const unchanged = !!view && state.view.revision === view.revision;
    if (wasUnknown) {
      setReceipt(t(unchanged ? "models.reconciledUnchanged" : "models.reconciledChanged"), "warn", "summary");
      state.unknown = false;
      api.releaseModelWrites();
      state.connectionDraft = null;
    } else {
      setReceipt(t(unchanged ? "models.rereadUnchanged" : "models.rereadChanged"), unchanged ? "ok" : "warn", "summary");
    }
    state.rejected = false;
    renderAll();
  }

  async function write(send, options) {
    if (writesBlocked()) return;
    state.pending = true;
    state.rejected = false;
    setReceipt(t("models.saving"), "pending", options.scope);
    renderAll();
    try {
      const view = await send(state.view.revision);
      if (options.clearConnection) state.connectionDraft = null;
      if (options.clearProvider) state.providerDraft = null;
      setReceipt(t("models.saved") + (view.notice ? " " + view.notice : ""), "ok", options.scope);
      adoptView(view);
    } catch (error) {
      if (error.disposition === "not-submitted") {
        state.rejected = true;
        setReceipt(t("models.rejected") + " " + error.message, "bad", options.scope);
        state.receipt.rejected = true;
      } else {
        state.unknown = true;
        // The blocking alert is page-wide; the receipt stays where it was made.
        setReceipt(t("models.unknownWrite") + " " + error.message, "warn", options.scope);
      }
    } finally {
      state.pending = false;
      renderAll();
    }
  }

  async function loadCatalog(cursor) {
    const catalog = state.catalog;
    const generation = ++catalog.generation;
    catalog.loading = true; catalog.error = null; catalog.note = null;
    // A first-page read replaces the observation; the old one is never kept on
    // screen while loading or after a failure.
    if (!cursor) { catalog.page = null; catalog.items = []; }
    renderCatalog();
    try {
      const page = await api.modelCatalog(cursor || "0");
      if (generation !== catalog.generation) return;
      // Pages from different observations are never mixed.
      if (cursor && catalog.page && page.observedAt !== catalog.page.observedAt) {
        catalog.loading = false;
        await loadCatalog(null);
        catalog.note = t("models.catalogChanged");
        renderCatalog();
        return;
      }
      catalog.items = cursor ? catalog.items.concat(page.items) : page.items.slice();
      catalog.page = page;
    } catch (error) {
      if (generation === catalog.generation) catalog.error = error.message;
    } finally {
      if (generation === catalog.generation) { catalog.loading = false; renderCatalog(); }
    }
  }

  async function refreshCatalog() {
    const catalog = state.catalog;
    if (catalog.loading || !state.view) return;
    const generation = ++catalog.generation;
    catalog.loading = true; catalog.error = null; catalog.note = null; renderCatalog();
    try {
      const page = await api.refreshModels({ revision: state.view.revision, kind: "catalog" });
      if (generation !== catalog.generation) return;
      catalog.page = page; catalog.items = page.items.slice();
    } catch (error) {
      // Like quota: an unanswered refresh leaves the catalog unknown.
      if (generation === catalog.generation) { catalog.error = error.message; catalog.page = null; catalog.items = []; }
    } finally {
      if (generation === catalog.generation) { catalog.loading = false; renderCatalog(); }
    }
  }

  function quotaFailure(quota, error) {
    // A 404 says only that this route is unavailable, not that the plugin is
    // uninstalled; any other failure leaves the quota unknown.
    if (error.status === 404) quota.unavailable = true;
    else quota.error = error.message;
    quota.observation = null;
  }

  async function loadQuota() {
    const quota = state.quota;
    const generation = ++quota.generation;
    const source = quota.source;
    quota.loading = true; quota.error = null; quota.unavailable = false; quota.observation = null; renderQuota();
    try {
      const observation = await api.modelQuota(source);
      if (generation === quota.generation) quota.observation = observation;
    } catch (error) {
      if (generation === quota.generation) quotaFailure(quota, error);
    } finally {
      if (generation === quota.generation) { quota.loading = false; renderQuota(); }
    }
  }

  async function refreshQuota() {
    const quota = state.quota;
    if (quota.loading || !state.view) return;
    const generation = ++quota.generation;
    const source = quota.source;
    quota.loading = true; quota.error = null; quota.unavailable = false; renderQuota();
    try {
      const observation = await api.refreshModels({ revision: state.view.revision, kind: "quota", source: source });
      if (generation === quota.generation) quota.observation = observation;
    } catch (error) {
      if (generation === quota.generation) quotaFailure(quota, error);
    } finally {
      if (generation === quota.generation) { quota.loading = false; renderQuota(); }
    }
  }

  renderAll();
  const ready = Promise.all([load(), loadCatalog(null), loadQuota()]);
  return {
    ready: ready,
    state: state,
    show: show,
    dirty: function () { return !!state.connectionDraft || !!state.providerDraft || state.pending; }
  };
}
`;
