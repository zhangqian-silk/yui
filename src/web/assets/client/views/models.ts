export const MODELS_VIEW_SCRIPT = String.raw`
// Model management page body: the metabridge/CPA management connection, the
// metabridge provider list, the cached model catalog and per-source quota.
// Every fact comes from /api/models*; the page keeps only drafts and view
// state. Saving configuration is not applying it (metabridge needs its own
// reload), a quota or catalog observation is never upgraded to success, and
// an API key typed here lives only in its password input until submission.
//
// deps: t, locale, api (models* functions from lib/api), confirm(text).
import { h } from "/assets/js/lib/dom.js";
import { formatDateTime } from "/assets/js/lib/format.js";

export const QUOTA_SOURCES = ["factory", "command-code"];
const CONNECTION_FIELDS = ["bridgeUrl", "bridgeConfigFile", "cpaUrl", "managementKeyFile", "catalogKeyFile"];
const OBSERVATION_TONES = { success: "ok", partial: "warn", failed: "bad", unsupported: "idle", "not-queried": "idle" };
// Server contract: the prefix is sent and returned with its trailing slash.
export const PREFIX_PATTERN = /^[a-zA-Z0-9_-]{1,64}\/$/;

export function mountModels(root, deps) {
  const t = deps.t;
  const api = deps.api;
  const locale = deps.locale || function () { return "en"; };
  const confirm = deps.confirm || function (text) { return window.confirm(text); };
  const state = {
    view: null, loading: false, loadError: null,
    // One write at a time; an unknown outcome blocks every write until the
    // reader explicitly reads current facts again.
    // A rejected write (for example a stale revision) keeps its draft and
    // offers an explicit re-read; nothing is replayed automatically.
    pending: false, unknown: false, rejected: false, receipt: null,
    connectionDraft: null, providerDraft: null,
    catalog: { page: null, items: [], loading: false, error: null, note: null, generation: 0 },
    quota: { source: QUOTA_SOURCES[0], observation: null, loading: false, error: null, unavailable: false, generation: 0 }
  };
  const sections = {
    summary: h("section.settings-card.models-summary", { "aria-labelledby": "models-summary-title" }),
    connection: h("section.settings-card", { "aria-labelledby": "models-connection-title" }),
    providers: h("section.settings-card", { "aria-labelledby": "models-providers-title" }),
    catalog: h("section.settings-card", { "aria-labelledby": "models-catalog-title" }),
    quota: h("section.settings-card", { "aria-labelledby": "models-quota-title" })
  };
  root.replaceChildren(sections.summary, sections.connection, sections.providers, sections.catalog, sections.quota);

  function tone(name, text) { return h("span.badge.tone-" + name, null, text); }
  function when(iso) { return iso ? formatDateTime(iso, locale()) : t("models.unknown"); }
  function known(value, render) { return value === null || value === undefined ? t("models.unknown") : render ? render(value) : String(value); }
  // Re-reading facts also blocks writes so no save races the new revision.
  function writesBlocked() { return !state.view || state.pending || state.unknown || state.loading; }
  function heading(id, key) { return h("h2", { id: id }, t(key)); }
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

  function renderAll() {
    renderSummary(); renderConnection(); renderProviders(); renderCatalog(); renderQuota();
  }

  function renderSummary() {
    const view = state.view;
    const children = [heading("models-summary-title", "models.summary")];
    if (state.loading && !view) children.push(h("p", { role: "status" }, t("models.loading")));
    if (state.loadError) {
      children.push(h("p.settings-error", { role: "alert" }, t("models.loadFailed") + " " + state.loadError),
        h("div.settings-actions", null, h("button.btn", { type: "button", onclick: function () { void load(); } }, t("models.retry"))));
    }
    if (view) {
      children.push(
        h("div.models-facts", null,
          tone(view.connection ? "info" : "idle", view.connection ? t("models.connected") : t("models.disconnected")),
          tone("warn", t("models.application." + view.application, view.application))),
        h("p", null, t("models.applicationHelp")),
        view.notice ? h("p", null, view.notice) : null,
        view.configurationError ? h("p.settings-error", { role: "alert" }, t("models.configurationError") + " " + view.configurationError) : null);
    }
    if (state.unknown) {
      children.push(h("p.settings-error", { role: "alert" }, t("models.unknownBlocked")),
        h("div.settings-actions", null, h("button.btn", { type: "button", disabled: state.loading, onclick: function () { void reconcile(); } }, t("models.readFacts"))));
    }
    children.push(receiptNode("summary"));
    children.push(h("p", null, t("models.agentSettings") + " ", h("a", { href: "/settings" }, t("models.openSettings"))));
    sections.summary.replaceChildren.apply(sections.summary, children.filter(Boolean));
  }

  // ---- Connection -------------------------------------------------------
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
    const form = h("form.settings-stack", { novalidate: true });
    const inputs = {};
    const discard = h("button.btn.btn-ghost", { type: "button", disabled: !state.connectionDraft || state.pending }, t("models.discard"));
    CONNECTION_FIELDS.forEach(function (key) {
      const input = h("input", { type: key.endsWith("Url") ? "url" : "text", autocomplete: "off", spellcheck: "false",
        value: values[key], disabled: blocked, required: key === "bridgeUrl" });
      input.value = values[key];
      input.addEventListener("input", function () {
        const draft = Object.assign({}, connectionValues());
        draft[key] = input.value;
        state.connectionDraft = draft;
        discard.disabled = state.pending;
      });
      inputs[key] = input;
      form.append(field(t("models.connection." + key), input, t("models.connection." + key + "Help")));
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
    discard.addEventListener("click", function () { state.connectionDraft = null; renderConnection(); });
    form.append(h("p", null, t("models.connectionHelp")),
      h("div.settings-actions", null, save, disconnect, discard), h("div", null, receiptNode("connection")));
    sections.connection.replaceChildren(heading("models-connection-title", "models.connection"),
      h("div", null, view && !view.connection ? h("p", null, t("models.notConnected")) : null), form);
  }

  // ---- Providers --------------------------------------------------------
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
  }
  function providerRow(provider) {
    const blocked = writesBlocked();
    const facts = h("div.models-facts", null,
      h("span.chip", null, t("models.via." + provider.via, provider.via)),
      provider.prefix ? h("code.id", null, provider.prefix) : h("span.chip", null, t("models.noPrefix")),
      tone(provider.enabled ? "ok" : "idle", provider.enabled ? t("models.enabled") : t("models.disabled")),
      tone(provider.credentialPresent ? "info" : "idle", provider.credentialPresent ? t("models.credentialStored") : t("models.credentialMissing")));
    const actions = h("div.settings-actions");
    if (provider.editable) {
      actions.append(
        h("button.btn", { type: "button", disabled: blocked, onclick: function () { startProvider(provider); } }, t("models.editProvider")),
        h("button.btn", { type: "button", disabled: blocked, onclick: function () {
          if (writesBlocked() || !confirm(t("models.removeConfirm") + " " + provider.name)) return;
          void write(function (revision) { return api.saveModelProvider({ revision: revision, operation: "remove", id: provider.id }); },
            { scope: "provider", clearProvider: !!(state.providerDraft && state.providerDraft.id === provider.id) });
        } }, t("models.removeProvider")));
    } else {
      actions.append(h("small.faint", null, t("models.readOnly") + (provider.reason ? " · " + provider.reason : "")));
    }
    return h("li.models-provider", { dataset: { provider: provider.id } },
      h("div.models-provider-head", null, h("strong", null, provider.name), h("code.id", null, provider.id)),
      h("p.mono-line", null, provider.baseUrl || t("models.unknown")), facts, actions);
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
    cancel.addEventListener("click", function () { state.providerDraft = null; renderProviders(); });
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
      h("h3", null, isNew ? t("models.newProvider") : t("models.editProvider") + " · " + draft.id),
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
  function renderProviders() {
    const view = state.view;
    const children = [heading("models-providers-title", "models.providers")];
    if (!view) children.push(h("p", null, state.loading ? t("models.loading") : t("models.unavailable")));
    else {
      children.push(h("p", null, t("models.providersHelp")));
      if (!view.providers.length) children.push(h("p", null, t("models.noProviders")));
      else children.push(h("ul.models-list", null, view.providers.map(providerRow)));
      if (state.providerDraft) children.push(providerForm());
      else {
        const add = h("button.btn", { type: "button", disabled: writesBlocked() || !configurable(), onclick: function () { startProvider(null); } }, t("models.addProvider"));
        children.push(h("div.settings-actions", null, add, configurable() ? null : h("small.faint", null, t("models.configFileRequired"))));
      }
      children.push(receiptNode("provider"));
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

  function renderCatalog() {
    const catalog = state.catalog;
    const page = catalog.page;
    const refresh = h("button.btn", { type: "button", disabled: catalog.loading || !state.view || !(state.view.connection), onclick: function () { void refreshCatalog(); } }, t("models.refreshCatalog"));
    const children = [heading("models-catalog-title", "models.catalog"), h("p", null, t("models.catalogHelp"))];
    if (catalog.loading) children.push(h("p", { role: "status" }, t("models.loading")));
    if (catalog.error) children.push(h("p.settings-error", { role: "alert" }, t("models.catalogFailed") + " " + catalog.error));
    if (catalog.note) children.push(h("p", { role: "status" }, catalog.note));
    if (page) {
      children.push(observationLine(page), observationError(page));
      // Only a successful observation can say the catalog is really empty.
      if (!catalog.items.length) children.push(h("p", null, t(page.status === "not-queried" ? "models.catalogNotQueried"
        : page.status === "success" ? "models.catalogEmpty" : "models.catalogItemsUnknown")));
      else {
        children.push(h("p.faint", null, t("models.catalogCount").replace("{shown}", String(catalog.items.length)).replace("{total}", String(page.total))),
          h("ul.models-list.models-catalog", null, catalog.items.map(function (item) {
            return h("li.models-catalog-item", null, h("code.id", null, item.id), h("span.chip", null, item.source));
          })));
      }
    }
    const more = page && page.nextCursor
      ? h("button.btn", { type: "button", disabled: catalog.loading, onclick: function () { void loadCatalog(page.nextCursor); } }, t("models.moreCatalog"))
      : null;
    children.push(h("div.settings-actions", null, refresh, more));
    sections.catalog.replaceChildren.apply(sections.catalog, children.filter(Boolean));
  }

  function quotaItem(item) {
    return h("li.models-quota-item", null,
      h("div.models-provider-head", null, h("strong", null, item.id),
        tone(OBSERVATION_TONES[item.status] || "idle", t("models.status." + item.status, item.status))),
      item.error ? h("p.settings-error", null, item.error) : null,
      item.windows.length ? h("ul.models-windows", null, item.windows.map(function (entry) {
        return h("li", null, h("strong", null, entry.label),
          h("span", null, t("models.remaining") + " " + known(entry.remainingFraction, function (value) { return Math.round(value * 1000) / 10 + "%"; })),
          h("span", null, t("models.used") + " " + known(entry.used) + " / " + known(entry.cap)),
          h("span", null, t("models.resets") + " " + when(entry.resetTime)));
      })) : h("p.faint", null, t("models.noWindows")),
      h("p.faint", null, t("models.balance") + " " + known(item.balance) + " · " + t("models.periodEnd") + " " + when(item.periodEnd)));
  }
  function quotaReady() {
    const connection = state.view && state.view.connection;
    return !!(connection && connection.cpaUrl && connection.managementKeyFile);
  }
  function renderQuota() {
    const quota = state.quota;
    const select = h("select", { disabled: quota.loading },
      QUOTA_SOURCES.map(function (source) { return h("option", { value: source }, t("models.source." + source, source)); }));
    select.value = quota.source;
    select.addEventListener("change", function () { quota.source = select.value; void loadQuota(); });
    const refresh = h("button.btn", { type: "button", disabled: quota.loading || !quotaReady(), onclick: function () { void refreshQuota(); } }, t("models.refreshQuota"));
    const children = [heading("models-quota-title", "models.quota"), h("p", null, t("models.quotaHelp")),
      h("div.settings-actions.models-quota-controls", null, field(t("models.source"), select), refresh,
        quotaReady() ? null : h("small.faint", null, t("models.quotaNeedsCpa")))];
    if (quota.loading) children.push(h("p", { role: "status" }, t("models.loading")));
    if (quota.unavailable) children.push(h("p", { role: "status" }, t("models.quotaUnavailable")));
    else if (quota.error) children.push(h("p.settings-error", { role: "alert" }, t("models.quotaFailed") + " " + quota.error));
    const observation = quota.observation;
    if (observation) {
      children.push(observationLine(observation), observationError(observation));
      if (observation.status === "not-queried") children.push(h("p", null, t("models.quotaNotQueried")));
      else if (observation.status === "unsupported") children.push(h("p", null, t("models.quotaUnsupported")));
      else if (!observation.items.length) children.push(h("p", null, t(observation.status === "success" ? "models.quotaEmpty" : "models.quotaItemsUnknown")));
      else children.push(h("ul.models-list", null, observation.items.map(quotaItem)));
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
    dirty: function () { return !!state.connectionDraft || !!state.providerDraft || state.pending; }
  };
}
`;
