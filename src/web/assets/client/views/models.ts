import { MODEL_OPERATOR_PROMPTS } from "../../../../models/modelOperatorGuide.js";

export const MODELS_VIEW_SCRIPT = String.raw`
// Four model sections: sources, Agent access, catalog/quota and maintenance.
// Every fact comes from /api/models*; the
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

const OPERATOR_PROMPTS = ${JSON.stringify(MODEL_OPERATOR_PROMPTS)};
export const QUOTA_SOURCES = ["factory", "command-code"];
export const SECTIONS = ["providers", "catalog", "quota", "connection", "maintenance"];
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
  const now = deps.now || Date.now;
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
    connectionDrafts: {}, providerDraft: null, advanced: {},
    endpointId: "", moduleId: "", bridgeId: "",
    providerFilter: { query: "", route: "all", state: "all" },
    catalog: { page: null, items: [], loading: false, error: null, note: null, generation: 0, query: "", source: "all" },
    quota: { source: initial.source, observation: null, loading: false, error: null, unavailable: false, generation: 0 }
  };
  function panel(name) {
    return h("section.manage-section.models-section", { dataset: { section: name }, "aria-labelledby": "models-" + name + "-title" });
  }
  const status = h("div.models-status", { "aria-live": "polite" });
  const sections = { providers: panel("providers"), catalog: panel("catalog"), quota: panel("quota"), connection: panel("connection"), maintenance: panel("maintenance") };
  const sourceResources = h("div.models-source-resources");
  const bindingModelOptions = h("datalist", { id: "binding-model-options" });
  root.replaceChildren(status, sections.providers, sections.catalog, sections.quota, sections.connection, sections.maintenance);

  function tone(name, text) { return h("span.badge.tone-" + name, null, h("span.badge-dot"), text); }
  function when(iso) { return iso ? formatDateTime(iso, locale()) : t("models.unknown"); }
  function known(value, render) { return value === null || value === undefined ? t("models.unknown") : render ? render(value) : String(value); }
  function percent(fraction) { return Math.round(fraction * 1000) / 10 + "%"; }
  function number(value) { return new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(value); }
  // Re-reading facts also blocks writes so no save races the new revision.
  function writesBlocked() { return !state.view || state.view.readOnly || state.pending || state.unknown || state.loading; }
  function go(route) {
    const next = normalizeRoute(Object.assign({}, state.route, route));
    if (deps.navigate) deps.navigate(next);
    else show(next);
  }
  function sectionLink(section, text) {
    return h("a.btn-link", { href: "/models/" + section, onclick: function (event) {
      if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); go({ section: section });
    } }, text);
  }
  function head(name, hint, actions) {
    return h("header.manage-head", null,
      h("div.manage-heading", null,
        h("h1", { id: "models-" + name + "-title" }, t("models.section." + name)), hint ? h("p", null, hint) : null),
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
  function advanced(section, ...children) {
    const details = h("details.models-advanced", { open: !!state.advanced[section], dataset: { modelAdvanced: section } },
      h("summary", null, t("models.advancedManual")),
      h("p.faint", null, t("models.advancedManualHelp")), ...children);
    details.addEventListener("toggle", function () { state.advanced[section] = details.open; });
    return details;
  }
  function operatorHandoff(topic) {
    const prompt = OPERATOR_PROMPTS[locale().startsWith("zh") ? "zh" : "en"][topic];
    const input = h("textarea.models-operator-prompt", {
      readOnly: true, rows: 7, spellcheck: false, "aria-label": t("models.operatorPrompt"),
      dataset: { operatorPrompt: topic }
    });
    input.value = prompt;
    const result = h("p.faint", { role: "status", "aria-live": "polite" });
    const copy = h("button.btn.btn-primary", { type: "button", onclick: async function () {
      try {
        if (deps.copyText) await deps.copyText(prompt);
        else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) await navigator.clipboard.writeText(prompt);
        else {
          // LAN HTTP often has no secure-context clipboard API. Keep the text
          // available for manual copy even if the browser refuses this fallback.
          input.focus(); input.select();
          if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
        }
        result.textContent = t("models.operatorPromptCopied");
      } catch {
        input.focus?.(); input.select?.();
        result.textContent = t("models.copyPromptManually");
      }
    } }, t("models.copyOperatorPrompt"));
    return h("div.card.models-card.models-operator", null, h("div.card-body", null,
      h("h2", null, t("models.operatorTitle." + topic)),
      h("p", null, t("models.operatorHandoffHelp")), input,
      h("div.settings-actions", null, copy,
        h("button.btn", { type: "button", disabled: state.loading || state.pending, onclick: function () {
          state.bridgeId = ""; void reconcile();
        } }, t("models.operatorReadback"))),
      result, h("p.faint", null, t("models.operatorNoEffect")),
      h("a.btn-link", { href: "/models/docs" }, t("models.componentDocs"))));
  }
  function resourcePicker(rows, selected, change) {
    const select = h("select", { disabled: state.pending || state.loading },
      rows.map(row => h("option", { value: row.id }, row.id)));
    select.value = selected;
    select.addEventListener("change", function () { change(select.value); });
    return field(t("models.resource"), select);
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
    onChange({ connection: !!state.connectionDrafts.binding, provider: !!state.providerDraft || !!state.connectionDrafts.endpoint,
      maintenance: false,
      unknown: state.unknown, pending: state.pending });
  }
  function hasConnectionDrafts() { return Object.keys(state.connectionDrafts).length > 0; }

  // ---- Routing ----------------------------------------------------------
  function show(route) {
    const next = normalizeRoute(route);
    // Only the quota section reads its source from the route; elsewhere the
    // last shown source is kept for the way back.
    if (!["quota", "catalog"].includes(next.section)) next.source = state.quota.source;
    const sourceChanged = next.source !== state.quota.source;
    state.route = next;
    state.quota.source = next.source;
    updateSections();
    renderStatus();
    if (sourceChanged) void loadQuota();
    else renderQuota();
    notify();
    return next;
  }

  function renderAll() {
    renderStatus(); renderConnection(); renderProviders(); renderCatalog(); renderQuota();
    updateSections();
    notify();
  }
  function updateSections() {
    SECTIONS.forEach(function (name) {
      sections[name].hidden = name !== state.route.section &&
        !(["catalog", "quota"].includes(name) && ["catalog", "quota"].includes(state.route.section));
    });
  }

  // Page-wide facts and blocking conditions stay visible in every section.
  function renderStatus() {
    const view = state.view;
    const children = [];
    if (state.loading && !view) children.push(h("p", { role: "status" }, t("models.loading")));
    if (view && (state.route.section === "connection" || state.route.section === "providers")) {
      children.push(h("div.models-facts", null,
        tone(view.registry.modules.length || view.registry.endpoints.length ? "info" : "idle",
          view.registry.modules.length || view.registry.endpoints.length ? t("models.connected") : t("models.disconnected")),
        tone("warn", t("models.application." + view.application, view.application)),
        h("small.faint.models-notice", null, t(view.readOnly ? "models.readOnlyService" : "models.scope"))));
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

  function updateBindingSuggestions() {
    const endpointId = state.connectionDrafts.binding?.endpointId;
    const suggestions = endpointId && state.endpointId === endpointId ? state.catalog.items : [];
    bindingModelOptions.replaceChildren(...suggestions.map(item => h("option", { value: item.id }, item.id)));
  }

  // ---- Model sources, Agent access and component maintenance ------------
  function renderConnection() {
    const view = state.view;
    const blocked = writesBlocked();
    const r = view && view.registry || { modules: [], endpoints: [], bindings: [] };
    const cards = {};
    const agents = view && view.configuredAgents || [];
    const bindingDraft = state.connectionDrafts.binding || {};
    const selectedAgent = agents.find(a => a.id === bindingDraft.agentId);
    const compatible = r.endpoints.filter(e => e.protocol === (selectedAgent?.adapterId === "claude" ? "anthropic-messages" : "responses"));
    const schemas = {
      endpoint: { id: "", moduleId: ["", ...r.modules.map(m => m.id)], url: "", protocol: ["responses", "anthropic-messages"], clientKeyFile: "" },
      binding: { agentId: ["", ...agents.map(a => a.id)], endpointId: ["", ...(selectedAgent ? compatible : []).map(e => e.id)], model: "" }
    };
    Object.keys(schemas).forEach(function (kind) {
      const rows = r[kind === "endpoint" ? "endpoints" : "bindings"];
      const draft = state.connectionDrafts[kind] || {};
      const form = h("form.models-connection-form", { dataset: { resourceKind: kind } });
      const inputs = {};
      const selectionSummary = h("p.models-access-summary", { role: "status" });
      let previewed = null;
      const previewStatus = h("p.faint.models-receipt", { role: "status" });
      const actions = h("div.settings-actions");
      const submit = h("button.btn.btn-primary", { type: "submit", disabled: blocked || kind === "binding" }, t("models.saveResource"));
      Object.entries(schemas[kind]).forEach(function (entry) {
        const key = entry[0], spec = entry[1];
        // A resource removed from the registry can still be referenced by an
        // unsaved draft. Keep its exact selection visible for explicit repair.
        const options = Array.isArray(spec) && draft[key] && !spec.includes(draft[key]) ? [...spec, draft[key]] : spec;
        const optionLabel = function (value) {
          if (kind === "binding" && key === "agentId") return value ? value + " · " + (agents.find(a => a.id === value)?.adapterId || t("models.unavailable")) : t("models.chooseAgent");
          if (!value) return t(key === "endpointId" ? "models.option.native" : "models.option.noModule");
          if (kind === "binding" && key === "endpointId") {
            const endpoint = r.endpoints.find(e => e.id === value);
            return value + (endpoint ? " · " + endpoint.url : " · " + t("models.unavailable"));
          }
          return value;
        };
        const control = Array.isArray(spec)
          ? h("select", { disabled: blocked }, options.map(v => h("option", { value: v }, optionLabel(v))))
          : h("input", { type: "text", disabled: blocked, autocomplete: "off", spellcheck: "false" });
        control.value = draft[key] == null ? (Array.isArray(spec) ? spec[0] : spec) : draft[key];
        if (kind === "binding") {
          control.dataset.bindingField = key;
          if (key === "endpointId") control.disabled = blocked || !selectedAgent;
          if (key === "model") {
            control.disabled = blocked || !draft.endpointId;
            control.setAttribute("list", "binding-model-options");
          }
        }
        inputs[key] = control;
        control.addEventListener(kind === "binding" && Array.isArray(spec) ? "change" : "input", function () {
          state.connectionDrafts[kind] = values();
          previewed = null;
          previewStatus.textContent = "";
          if (kind === "binding") submit.disabled = true;
          if (kind === "binding" && key === "agentId") {
            const saved = r.bindings.find(b => b.agentId === control.value);
            state.connectionDrafts.binding.endpointId = saved?.endpointId || null;
            state.connectionDrafts.binding.model = saved?.model || "";
            renderConnection();
            if (saved?.endpointId) { state.endpointId = saved.endpointId; void loadCatalog(); }
          } else if (kind === "binding" && key === "endpointId") {
            state.connectionDrafts.binding.model = "";
            renderConnection();
            if (control.value) { state.endpointId = control.value; void loadCatalog(); }
          } else if (kind === "binding") updateSummary();
          notify();
        });
        form.append(field(t(kind === "binding" ? "models.access." + key : "models.field." + key), control,
          kind === "binding" && key === "model" ? t("models.modelChoiceHelp") : null));
      });
      function values() {
        const value = {};
        Object.keys(inputs).forEach(key => { value[key] = inputs[key].value.trim(); });
        if (kind === "endpoint" && !value.moduleId) value.moduleId = null;
        if (kind === "binding" && !value.endpointId) value.endpointId = null;
        if (kind === "binding") {
          value.adapterId = agents.find(a => a.id === value.agentId)?.adapterId || "";
          value.scope = "yui-new-session";
          if (!value.endpointId) value.model = "";
        }
        return value;
      }
      function updateSummary() {
        const value = values();
        selectionSummary.textContent = value.agentId
          ? value.agentId + " → " + (value.endpointId || t("models.option.native")) +
            (value.endpointId ? " → " + (value.model || t("models.chooseModel")) : "") + " · " + t("models.newSessionsOnly")
          : t("models.chooseAgent");
      }
      async function save(resource, removeId) {
        await write(async function () {
          await api.saveModelResource({ revision: view.registryRevision, requestId: crypto.randomUUID(), kind: kind,
            ...(removeId ? { removeId: removeId } : { resource: resource }) });
          return api.models(state.bridgeId);
        }, { scope: kind === "endpoint" ? "provider" : "connection", clearConnection: removeId ? null : kind });
      }
      if (kind === "binding") {
        updateSummary();
        updateBindingSuggestions();
        form.append(bindingModelOptions, selectionSummary);
        actions.append(h("button.btn", { type: "button", disabled: blocked || !selectedAgent, onclick: async function () {
        try {
          const binding = values();
          const requested = JSON.stringify(binding);
          await api.previewModelBinding({ revision: view.registryRevision, binding: binding });
          if (requested !== JSON.stringify(values())) return;
          previewed = requested; submit.disabled = writesBlocked(); previewStatus.textContent = t("models.bindingPreviewed");
        } catch (error) { previewStatus.textContent = error.message; submit.disabled = true; }
      } }, t("models.previewBinding")));
      }
      actions.append(submit, h("button.btn.btn-ghost", { type: "button",
        disabled: blocked,
        onclick: function () { delete state.connectionDrafts[kind]; renderConnection(); notify(); }
      }, t("models.discard")));
      form.append(actions, previewStatus);
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        if (writesBlocked() || kind === "binding" && previewed !== JSON.stringify(values())) return;
        void save(values());
      });
      const list = rows.map(function (row) {
        const resourceId = row.id || row.agentId;
        return h("li", null, h("code", null, resourceId), kind === "binding"
          ? " → " + (row.endpointId || t("models.option.native")) + (row.endpointId ? " → " + row.model : "") + " · " + t("models.newSessionsOnly")
          : " · " + (row.kind || row.protocol),
          h("button.btn.btn-ghost", { type: "button", disabled: blocked, onclick: function () {
            if (state.connectionDrafts[kind] && !confirm(t("models.replaceResourceDraft"))) return;
            state.connectionDrafts[kind] = { ...row }; renderConnection(); notify();
          } }, t("models.editResource")),
          h("button.btn.btn-ghost", { type: "button", disabled: blocked, onclick: function () {
            if (confirm(t("models.unregisterConfirm"))) void save(null, resourceId);
          } }, t("models.unregister")));
      });
      cards[kind] = h("div.card.models-card", null, h("div.card-body", null,
        h("h2", null, t("models.resourceKind." + kind)), rows.length ? h("ul", null, list) : h("p.faint", null, t("models.resourceEmpty." + kind)),
        kind === "binding" && !agents.length ? h("p.models-note", null, t("models.noAgents"),
          h("a.btn-link", { href: "/settings/server" }, t("models.configureAgents"))) : null,
        h("details", { open: kind === "binding" || !!state.connectionDrafts[kind] },
          h("summary", null, t("models.resourceEditor." + kind)), form)));
    });
    sourceResources.replaceChildren(cards.endpoint);
    const agentSummary = h("div.card.models-card", null, h("div.card-body", null,
      h("h2", null, t("models.currentAgentModels")),
      agents.length ? h("ul", null, agents.map(function (agent) {
        const binding = r.bindings.find(b => b.agentId === agent.id);
        return h("li", null, h("code", null, agent.id), " → ",
          binding?.endpointId ? binding.endpointId + " → " + binding.model : t("models.option.native"));
      })) : h("p.faint", null, t("models.noAgents")),
      h("p.faint", null, t("models.bindingScope"))));
    sections.connection.replaceChildren(
      head("connection", t("models.operatorAccessHelp")), agentSummary,
      operatorHandoff("binding"), receiptNode("connection") || h("span"),
      advanced("connection", cards.binding, sectionLink("providers", t("models.manageSources"))));
    sections.maintenance.replaceChildren(
      head("maintenance", t("models.operatorMaintenanceHelp")),
      operatorHandoff("maintenance"));
  }

  // ---- Access (providers) -----------------------------------------------
  function configurable() {
    const view = state.view;
    return !!(view && !view.readOnly && view.connection && view.connection.bridgeConfigFile
      && view.registry.modules.some(m => m.id === state.bridgeId && m.kind === "metabridge" && m.maintenance === "configuration"));
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
          if (writesBlocked() || !confirm(t("models.removeConfirm") + " " + provider.name + "\n" + t("models.exclusiveWriter"))) return;
          void write(function (revision) { return api.saveModelProvider({ revision: revision, moduleId: state.bridgeId, operation: "remove", id: provider.id }); },
            { scope: "provider", clearProvider: !!(state.providerDraft && state.providerDraft.id === provider.id) });
        } }, t("models.removeProvider")));
    } else {
      actions.append(h("span.chip", null, t("models.readOnly")));
      if (provider.reason) actions.append(h("small.faint.models-reason", null,
        t(provider.reason === "read-only-service" ? "models.readOnlyService" : "models.providerReadOnlyHelp")));
    }
    return h("tr", { dataset: { provider: provider.id }, "aria-current": editing ? "true" : null },
      h("td", { dataset: { label: t("models.column.provider") } },
        h("div.models-cell-main", null, h("strong", null, provider.name), h("code.id", { title: provider.id }, provider.id.slice(0, 12)))),
      h("td", { dataset: { label: t("models.column.baseUrl") } },
        h("span.mono-line.models-url", { title: provider.baseUrl || "" }, provider.baseUrl || t("models.unknown"))),
      h("td", { dataset: { label: t("models.column.prefix") } },
        provider.prefix ? h("code.id", null, provider.prefix) : h("span.chip", null, t("models.noPrefix"))),
      h("td", { dataset: { label: t("models.column.route") } }, h("span.chip", null, t("models.via." + provider.via, provider.via))),
      h("td", { dataset: { label: t("models.column.state") } }, h("div.models-facts", null,
        tone(provider.enabled ? "ok" : "idle", provider.enabled ? t("models.enabled") : t("models.disabled")),
        tone(provider.credentialPresent ? "info" : "idle", provider.credentialKind === "subscription" ? t("models.subscriptionAuth")
          : provider.credentialPresent ? t("models.credentialStored") : t("models.credentialMissing")))),
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
      if (!confirm(t("models.exclusiveWriter"))) return;
      if (key) provider.apiKey = key;
      void write(function (revision) { return api.saveModelProvider({ revision: revision, moduleId: state.bridgeId, operation: "save", provider: provider }); },
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
    const children = [
      h("header.models-subhead", null, h("h2", null, t("models.upstreamProviders")), view && !view.readOnly ? add : null)];
    if (view) children.push(resourcePicker(view.registry.modules.filter(m => m.kind === "metabridge"), state.bridgeId, function (id) {
      if (state.providerDraft && !confirm(t("models.discardProvider"))) return;
      state.providerDraft = null; state.bridgeId = id; void load();
    }));
    if (!view) children.push(h("p.models-empty", null, state.loading ? t("models.loading") : t("models.unavailable")));
    else {
      if (!configurable() && !view.readOnly) children.push(h("p.models-note", null, icon("info"), t("models.configFileRequired") + " ",
        sectionLink("maintenance", t("models.section.maintenance"))));
      children.push(receiptNode("provider"));
      if (state.providerDraft) children.push(h("div.card.models-card.models-editor", null, h("div.card-body", null, providerForm())));
      children.push(h("div.card.models-card", null, providerTools, providerResults));
      renderProviderTools();
    }
    const endpoints = view?.registry.endpoints || [];
    const summary = h("div.card.models-card", null, h("div.card-body", null,
      h("h2", null, t("models.currentServices")),
      endpoints.length ? h("ul", null, endpoints.map(e => h("li", null, h("code", null, e.id), " · " + e.protocol)))
        : h("p.faint", null, t("models.resourceEmpty.endpoint"))));
    sections.providers.replaceChildren(
      head("providers", t("models.operatorSourcesHelp")), summary, operatorHandoff("metabridge"),
      advanced("providers", sourceResources, ...children.filter(Boolean)));
  }

  // ---- Observations -----------------------------------------------------
  function expired(observedAt) {
    return !!observedAt && now() - Date.parse(observedAt) > 60000;
  }
  // Update only the badge: expiry must not rebuild forms, steal focus or
  // query an upstream service. The entry module supplies the local clock tick.
  function updateFreshness() {
    root.querySelectorAll("[data-observation-time]").forEach(function (badge) {
      badge.hidden = !(badge.dataset.serverStale === "true" || expired(badge.dataset.observationTime));
    });
  }
  function observationLine(observation) {
    const status = observation.status;
    const stale = tone("warn", t("models.stale"));
    stale.dataset.observationTime = observation.observedAt || "";
    stale.dataset.serverStale = String(observation.stale);
    stale.hidden = !(observation.stale || expired(observation.observedAt));
    return h("div.models-facts", { role: "status" },
      tone(OBSERVATION_TONES[status] || "idle", t("models.status." + status, status)),
      stale,
      h("small.faint", null, t("models.attempted") + " " + when(observation.attemptedAt) + " · " + t("models.observed") + " " + when(observation.observedAt)));
  }
  function observationError(observation) {
    return observation.error ? h("p.settings-error", null, observation.error) : null;
  }

  const catalogResults = h("div.models-results.models-catalog-results");
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
    updateBindingSuggestions();
    const catalog = state.catalog;
    const page = catalog.page;
    const refresh = h("button.btn", { type: "button", disabled: catalog.loading || !state.endpointId, onclick: function () { void refreshCatalog(); } },
      icon("refresh"), t("models.refreshCatalog"));
    const children = [head("catalog", t("models.catalogHelp"), [refresh])];
    if (state.view) children.push(resourcePicker(state.view.registry.endpoints, state.endpointId, function (id) {
      state.endpointId = id; void invalidateObservations();
    }));
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
    const name = t("models.window." + (parts.window || entry.label), parts.window || entry.label);
    // An unknown fraction draws an empty, unlabelled track, never 0%.
    const bar = fraction === null
      ? h("div.models-meter.is-unknown", { "aria-hidden": "true" })
      : h("div.models-meter.tone-" + level, { role: "progressbar", "aria-label": name, "aria-valuemin": "0", "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(fraction * 100)), "aria-valuetext": t("models.remaining") + " " + percent(fraction) },
        meterFill(fraction));
    const details = [entry.resetTime ? t("models.resets") + " " + when(entry.resetTime) : t("models.resetUnknown")];
    if (entry.used !== null || entry.cap !== null) details.push(t("models.used") + " " + known(entry.used, number) + " / " + known(entry.cap, number));
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
  function quotaItem(item, index) {
    const facts = (item.balanceDetails || []).map(function (entry) {
      return h("div", null, h("dt", null, t("models.balance." + entry.kind)), h("dd", { title: String(entry.value) }, known(entry.value, number)));
    });
    // Only Command Code reports a total and a period; Factory has neither, so
    // its absence there is not repeated as an unknown on every account.
    if (item.source === "command-code" || item.balance !== null) {
      facts.push(h("div", null, h("dt", null, t("models.balance")), h("dd", { title: String(item.balance ?? "") }, known(item.balance, number))));
    }
    if (item.source === "command-code" || item.periodEnd) {
      facts.push(h("div", null, h("dt", null, t("models.periodEnd")), h("dd", null, when(item.periodEnd))));
    }
    return h("li.card.models-account", null,
      h("div.card-head", null, h("div.card-heading", null,
        h("div.card-title", null, h("span", { title: item.id }, t("models.source." + item.source, item.source) +
          (item.source === "factory" ? " · " + t("models.account") + " " + (index + 1) : "")),
          tone(OBSERVATION_TONES[item.status] || "idle", t("models.status." + item.status, item.status))),
        item.source === "factory" ? h("span.card-hint", { title: t("models.accountIdHelp") }, item.id) : null)),
      h("div.card-body", null,
        item.error ? h("p.settings-error", null, item.error) : null,
        item.stale ? h("p.faint", null, t("models.stale") + " · " + t("models.observed") + " " + when(item.observedAt)) : null,
        item.windows.length ? h("div.models-groups", null, quotaGroups(item.windows).map(function (group) {
          return h("div.models-group", null, group.name ? h("h3", null, group.name) : null,
            h("ul.models-windows", null, group.windows.map(windowRow)));
        })) : h("p.faint", null, t("models.noWindows")),
        facts.length ? h("dl.models-balances", null, facts) : null));
  }
  function quotaReady() {
    return !!(state.view && state.view.registry.modules.some(m => m.id === state.moduleId
      && m.kind === "cliproxyapi" && m.quotaAdapter !== "none" && m.managementUrl && m.managementKeyFile));
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
    if (state.view) children.push(resourcePicker(state.view.registry.modules.filter(m => m.kind === "cliproxyapi"), state.moduleId, function (id) {
      state.moduleId = id; void invalidateObservations();
    }));
    if (!quotaReady()) children.push(h("p.models-note", null, icon("info"), t("models.quotaNeedsCpa") + " ", sectionLink("maintenance", t("models.section.maintenance"))));
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
    if (!view.registry.modules.some(m => m.id === state.bridgeId)) state.bridgeId = view.registry.modules.find(m => m.kind === "metabridge")?.id || "";
    if (!view.registry.endpoints.some(e => e.id === state.endpointId)) state.endpointId = view.registry.endpoints[0]?.id || "";
    if (!view.registry.modules.some(m => m.id === state.moduleId)) state.moduleId = view.registry.modules.find(m => m.kind === "cliproxyapi")?.id || "";
    if (previous && previous.revision === view.revision) return;
    return invalidateObservations();
  }
  function invalidateObservations() {
    const catalog = state.catalog;
    catalog.generation++;
    catalog.page = null; catalog.items = []; catalog.error = null; catalog.note = null; catalog.loading = false;
    const quota = state.quota;
    quota.generation++;
    quota.observation = null; quota.error = null; quota.unavailable = false; quota.loading = false;
    return Promise.all([loadCatalog(null), loadQuota()]);
  }

  async function load() {
    state.loading = true; state.loadError = null; renderAll();
    try { await adoptView(await api.models(state.bridgeId)); }
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
    // Reconcile against current registry facts even if an uncertain unregister
    // removed the selected resource. This read never replays the write.
    if (wasUnknown) state.bridgeId = "";
    if (!(await load())) return;
    const unchanged = !!view && state.view.revision === view.revision;
    if (wasUnknown) {
      setReceipt(t(unchanged ? "models.reconciledUnchanged" : "models.reconciledChanged"), "warn", "summary");
      state.unknown = false;
      api.releaseModelWrites();
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
      if (options.clearConnection) delete state.connectionDrafts[options.clearConnection];
      if (options.clearProvider) state.providerDraft = null;
      setReceipt(t("models.saved"), "ok", options.scope);
      await adoptView(view);
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
    if (!state.view) return;
    const catalog = state.catalog;
    const generation = ++catalog.generation;
    catalog.loading = true; catalog.error = null; catalog.note = null;
    // A first-page read replaces the observation; the old one is never kept on
    // screen while loading or after a failure.
    if (!cursor) { catalog.page = null; catalog.items = []; }
    renderCatalog();
    try {
      const page = await api.modelCatalog(cursor || "0", state.endpointId);
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
      const page = await api.refreshModels({ revision: state.view.registryRevision, kind: "catalog", resourceId: state.endpointId });
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
    if (!state.view) return;
    const quota = state.quota;
    const generation = ++quota.generation;
    const source = quota.source;
    quota.loading = true; quota.error = null; quota.unavailable = false; quota.observation = null; renderQuota();
    try {
      const observation = await api.modelQuota(source, state.moduleId);
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
      const observation = await api.refreshModels({ revision: state.view.registryRevision, kind: "quota", source: source, resourceId: state.moduleId });
      if (generation === quota.generation) quota.observation = observation;
    } catch (error) {
      if (generation === quota.generation) quotaFailure(quota, error);
    } finally {
      if (generation === quota.generation) { quota.loading = false; renderQuota(); }
    }
  }

  renderAll();
  // Establish the connection/revision before requesting its cached facts.
  const ready = load();
  return {
    ready: ready,
    state: state,
    show: show,
    translate: function () {
      // Keep data and drafts in this mount; never reload on language change.
      const password = root.querySelector?.('input[type="password"]');
      const value = password?.value;
      renderAll();
      const replacement = root.querySelector?.('input[type="password"]');
      if (replacement && value !== undefined) replacement.value = value;
    },
    updateFreshness: updateFreshness,
    dirty: function () { return hasConnectionDrafts() || !!state.providerDraft || state.pending; }
  };
}
`;
