export const MODELS_VIEW_SCRIPT = String.raw`
// Provider facts and cached observations. Configuration is handed to Operator,
// while Agent/Role editing remains in the shared settings controller.
// Navigation never probes upstream; only explicit refresh may do that.
import { h, icon } from "/assets/js/lib/dom.js";
import { formatDateTime } from "/assets/js/lib/format.js";
import { openOperatorHandoff } from "/assets/js/views/operatorHandoff.js";

export const SECTIONS = ["providers"];
const OBSERVATION_TONES = { success: "ok", partial: "warn", failed: "bad", unsupported: "idle", "not-queried": "idle" };

// Normalizes any requested route; unknown values fall back to the defaults.
export function normalizeRoute(route) {
  const value = route || {};
  return {
    section: "providers",
    detail: ["catalog", "quota", "maintenance"].includes(value.section) ? value.section
      : ["catalog", "quota", "maintenance"].includes(value.detail) ? value.detail : "",
    source: typeof value.source === "string" ? value.source : ""
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
  const onChange = deps.onChange || function () {};
  const initial = normalizeRoute(deps.route);
  const state = {
    route: initial,
    view: null, loading: false, loadError: null,
    pending: false, unknown: false, receipt: null,
    components: [], expanded: initial.detail ? { [initial.detail]: true } : {},
    endpointId: "", moduleId: "", bridgeId: "",
    catalog: { page: null, items: [], loading: false, error: null, note: null, generation: 0, query: "", source: "all" },
    quota: { source: initial.source, observation: null, loading: false, error: null, unavailable: false, generation: 0 }
  };
  function panel(name) {
    return h("section.manage-section.models-section", { dataset: { section: name }, "aria-labelledby": "models-" + name + "-title" });
  }
  const status = h("div.models-status", { "aria-live": "polite" });
  const sections = { providers: panel("providers"), catalog: panel("catalog"), quota: panel("quota") };
  root.replaceChildren(sections.providers);

  function tone(name, text) { return h("span.badge.tone-" + name, null, h("span.badge-dot"), text); }
  function when(iso) { return iso ? formatDateTime(iso, locale()) : t("models.unknown"); }
  function known(value, render) { return value === null || value === undefined ? t("models.unknown") : render ? render(value) : String(value); }
  function percent(fraction) { return Math.round(fraction * 1000) / 10 + "%"; }
  function number(value) { return new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(value); }
  function go(route) {
    const next = normalizeRoute(Object.assign({}, state.route, route));
    if (deps.navigate) deps.navigate(next);
    else show(next);
  }
  function head(name, hint, actions) {
    return h("header.manage-head", null,
      h("div.manage-heading", null,
        h(name === "providers" ? "h1" : "h2", { id: "models-" + name + "-title" }, t("models.section." + name)), hint ? h("p", null, hint) : null),
      actions && actions.length ? h("div.card-actions", null, actions) : null);
  }
  function receiptNode(scope) {
    if (!state.receipt || state.receipt.scope !== scope) return null;
    const line = h("p.receipt.models-receipt", { role: "status", "aria-live": "polite" }, state.receipt.text);
    line.dataset.state = state.receipt.state;
    return line;
  }
  function disclosure(key, label, ...children) {
    const node = h("details.models-disclosure", { open: !!state.expanded[key], dataset: { modelDetail: key } },
      h("summary", key === "catalog" || key === "quota" ? { id: "models-" + key + "-title" } : null, label), ...children);
    node.addEventListener("toggle", function () { state.expanded[key] = node.open; });
    return node;
  }
  function field(labelText, control, hint) {
    return h("label.field", null, h("span", null, labelText), control, hint ? h("small.faint", null, hint) : null);
  }
  function resourcePicker(rows, selected, change, label = "models.queryInstance") {
    const select = h("select", { disabled: state.pending || state.loading || state.quota.loading },
      rows.map(row => h("option", { value: row.id }, row.id)));
    select.value = selected;
    select.addEventListener("change", function () { change(select.value); });
    return field(t(label), select);
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
    onChange({ connection: false, provider: false, maintenance: false, unknown: false, pending: false });
  }

  // ---- Routing ----------------------------------------------------------
  function show(route) {
    const next = normalizeRoute(route);
    // Only the quota section reads its source from the route; elsewhere the
    // last shown source is kept for the way back.
    if (next.detail !== "quota" || !next.source) next.source = state.quota.source;
    const available = (state.view?.quotaSources || []).filter(item => item.moduleId === state.moduleId).map(item => item.source);
    if (state.view && !available.includes(next.source)) next.source = available[0] || "";
    const sourceChanged = next.source !== state.quota.source;
    state.route = next;
    if (next.detail) state.expanded[next.detail] = true;
    state.quota.source = next.source;
    updateSections();
    renderStatus();
    if (sourceChanged) void loadQuota();
    else renderQuota();
    notify();
    return next;
  }

  function renderAll() {
    renderStatus(); renderProviders(); renderCatalog(); renderQuota();
    updateSections();
    notify();
  }
  function updateSections() {
    root.querySelectorAll?.("[data-model-detail]").forEach(node => {
      if (state.expanded[node.dataset.modelDetail]) node.open = true;
    });
  }

  // Page-wide facts and blocking conditions stay visible in every section.
  function renderStatus() {
    const view = state.view;
    const children = [];
    if (state.loading && !view) children.push(h("p", { role: "status" }, t("models.loading")));
    if (state.loadError) {
      children.push(h("div.models-alert", { role: "alert" }, icon("alert"), h("p.settings-error", null, t("models.loadFailed") + " " + state.loadError),
        h("button.btn", { type: "button", onclick: function () { void load(); } }, t("models.retry"))));
    }
    if (view && view.configurationError) {
      children.push(h("div.models-alert", { role: "alert" }, icon("alert"), h("p.settings-error", null, t("models.configurationError") + " " + view.configurationError)));
    }
    children.push(receiptNode("summary"));
    status.replaceChildren.apply(status, children.filter(Boolean));
  }

  // ---- Model services, by how each Agent connects ----------------------
  // The usage dimension is the Agent adapter's wire protocol (Codex:
  // Responses, Claude: Anthropic Messages), never a model name or vendor.
  // Each record keeps its owner: the Agent's native file, Yui's registry,
  // or an optional component's own configuration.
  function componentName(module) { return module.kind === "cliproxyapi" ? "CPA" : module.kind; }
  const DIMENSIONS = [
    { adapter: "codex", protocol: "responses" },
    { adapter: "claude", protocol: "anthropic-messages" }
  ];
  function facts(entries) {
    return h("dl.models-record-facts", null, entries.filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([label, value]) => h("div", null, h("dt", null, label), h("dd", null, String(value)))));
  }
  function providerDetails(provider, identity) {
    const models = provider.models || [];
    const children = [facts([
      [t("models.recordId"), provider.id], [t("models.configurationSource"), provider.sourceFile],
      [t("models.credentialReference"), provider.credentialReference],
      [t("models.provider.prefix"), provider.prefix === "" ? t("models.noPrefix") : provider.prefix], [t("models.priority"), provider.priority],
      [t("models.requestMode"), provider.requestMode]
    ])];
    if (models.length) children.push(h("h4", null, t("models.configuredModels")),
      h("p.faint", null, t("models.configuredModelsHelp")),
      h("ul.models-configured-models", null, models.map(model => h("li", null,
        h("code", null, model.name || model.value), model.alias ? " → " + model.alias : ""))));
    if (provider.excludedModels?.length) children.push(facts([[t("models.excludedModels"), provider.excludedModels.join(", ")]]));
    if (provider.routeModels?.length) children.push(facts([[t("models.routeRules"), provider.routeModels.join(", ")]]));
    if (provider.compaction) {
      const policy = provider.compaction;
      children.push(h("h4", null, t("models.compaction")),
        h("p", null, t(policy.mode === "local" && policy.models?.length ? "models.compactionMatched" : "models.compaction." + policy.mode)),
        facts([[t("models.routeRules"), policy.models?.join(", ")],
          [t("models.stripImages"), policy.stripImages === true ? t("models.yes") : policy.stripImages === false ? t("models.no") : null]]));
    }
    return disclosure("record:" + identity, t("models.recordDetails") + (models.length ? " · " + models.length + " " + t("models.modelsUnit") : ""), ...children);
  }
  function credentialLabel(provider, native) {
    if (provider.credentialKind === "reference") return t(provider.credentialReference ? "models.credentialReference" : "models.credentialReferenceMissing");
    if (provider.credentialKind === "subscription") return t("models.subscriptionAuth");
    if (provider.credentialPresent) return t("models.credentialStored");
    return native ? t("models.nativeCredentialUnknown") : t("models.credentialMissing");
  }
  function enabledBadge(provider) {
    return provider.enabled === true ? tone("ok", t("models.enabled"))
      : provider.enabled === false ? tone("idle", t("models.disabled")) : tone("idle", t("models.enablementUnknown"));
  }
  function guide(labelKey, scenario, className = "btn btn-sm") {
    return h("button." + className.split(" ").join("."), { type: "button", dataset: { guide: scenario.kind },
      onclick: () => openOperatorHandoff({ scenario, t, locale, copyText: deps.copyText, onReadback: reconcile }) }, t(labelKey));
  }
  function table(columns, rows, key) {
    return h("div.services-table", { dataset: { servicesTable: key }, role: "table" },
      h("div.services-row.services-row-head", { role: "row" }, columns.map(label => h("span", { role: "columnheader" }, label))),
      ...rows.map(row => {
        // A row is its cells, optionally with the exact record identity.
        const cells = Array.isArray(row) ? row : row.cells;
        return h("div.services-row", { role: "row", dataset: Array.isArray(row) ? {} : row.data }, cells.map((value, index) =>
          h("span", { role: "cell", dataset: { label: columns[index] } }, value)));
      }));
  }
  function moduleOf(endpoint) {
    return endpoint?.moduleId ? state.view.registry.modules.find(module => module.id === endpoint.moduleId) || null : null;
  }
  function viaLabel(endpoint) {
    const module = moduleOf(endpoint);
    return module ? componentName(module) + " · " + module.id : t("services.direct");
  }
  function agentRoute(agent) {
    const registry = state.view.registry;
    const binding = registry.bindings.find(item => item.agentId === agent.id && item.endpointId);
    const endpoint = binding ? registry.endpoints.find(item => item.id === binding.endpointId) : null;
    const natives = (state.view.nativeProviders || []).filter(provider => provider.agentId === agent.id);
    const selected = natives.find(provider => provider.selected);
    const nativeText = selected ? t("services.nativeSelected").replace("{name}", selected.name || selected.id)
      : t("services.nativeDefault");
    const target = binding
      ? [h("strong", null, t("services.viaEndpoint").replace("{id}", binding.endpointId)),
        h("small", null, viaLabel(endpoint) + " · " + t("services.model") + " " + (binding.model || "—") + " · " + t("services.newSessionsOnly")),
        h("small.faint", null, t("services.outsideYui").replace("{native}", nativeText))]
      : [h("strong", null, nativeText), h("small", null, selected ? t("services.ownedNative") : t("services.noCustomProvider"))];
    return h("li.services-route", { dataset: { routeAgent: agent.id } },
      h("span.services-route-agent", null, h("code", null, agent.id)),
      h("span.services-route-arrow", { "aria-hidden": "true" }, "→"),
      h("span.services-route-target", null, ...target),
      tone(binding ? "info" : "idle", t(binding ? "services.routeYui" : "services.routeNative")));
  }
  function dimension(spec) {
    const view = state.view;
    const agents = (view.configuredAgents || []).filter(agent => agent.adapterId === spec.adapter);
    const endpoints = view.registry.endpoints.filter(endpoint => endpoint.protocol === spec.protocol);
    const natives = (view.nativeProviders || []).filter(provider => agents.some(agent => agent.id === provider.agentId));
    const bound = endpoint => view.registry.bindings.filter(binding => binding.endpointId === endpoint.id).map(binding => binding.agentId);
    const children = [
      h("header.services-dim-head", null,
        h("div", null, h("h2", null, t("services.dim." + spec.adapter)),
          h("p", null, t("services.dimHelp." + spec.adapter))),
        guide("services.guide." + spec.adapter, { kind: "service", adapter: spec.adapter,
          agents: agents.map(agent => agent.id), endpoints: endpoints.map(endpoint => endpoint.id) }))
    ];
    children.push(h("h3.services-sub", null, t("services.routes")),
      agents.length ? h("ul.services-routes", null, agents.map(agentRoute))
        : h("p.models-empty", null, t("services.noAgents." + spec.adapter)));
    children.push(h("h3.services-sub", null, t("services.endpoints"), h("span.count", null, String(endpoints.length))),
      endpoints.length ? table([t("services.col.endpoint"), t("services.col.via"), t("models.column.baseUrl"), t("services.col.key"), t("services.col.bound")],
        endpoints.map(endpoint => ({ data: { providerIdentity: "endpoint:" + endpoint.id }, cells: [h("code", null, endpoint.id), viaLabel(endpoint),
          h("span.mono-line", { title: endpoint.url }, endpoint.url),
          h("span.services-key", null, t(endpoint.clientKeyFile ? "services.keyReferenced" : "services.keyNone"),
            endpoint.clientKeyFile ? h("small.mono-line", null, endpoint.clientKeyFile) : null),
          bound(endpoint).join(", ") || h("span.faint", null, t("services.unbound"))] })), "endpoints-" + spec.adapter)
        : h("p.models-empty", null, t("services.noEndpoints")));
    children.push(h("h3.services-sub", null, t("services.native"), h("span.count", null, String(natives.length))),
      natives.length ? table([t("services.col.provider"), t("services.col.agent"), t("models.column.baseUrl"), t("models.credential"), ""],
        natives.map(provider => ({ data: { providerIdentity: "native:" + provider.agentId + ":" + provider.sourceFile + ":" + provider.id }, cells: [h("strong", null, provider.name || provider.id), h("code", null, provider.agentId),
          h("span.mono-line", { title: provider.baseUrl || "" }, provider.baseUrl || t("models.notReported")),
          credentialLabel(provider, true),
          provider.selected ? tone("info", t("models.nativeSelected")) : h("span.faint", null, t("models.nativeNotSelected"))] })), "native-" + spec.adapter)
        : h("p.models-empty", null, t("services.noNative")));
    return h("section.services-dim", { dataset: { dimension: spec.adapter } }, ...children);
  }
  function componentCard(component) {
    const module = component.module;
    const view = state.view;
    const providers = component.view?.providers || [];
    const exposed = view.registry.endpoints.filter(endpoint => endpoint.moduleId === module.id);
    const error = component.error || component.view?.configurationError;
    const children = [
      h("header.services-component-head", null,
        h("div", null, h("h3", null, componentName(module), h("code.id", null, module.id)),
          h("p", null, t("services.componentRole." + module.kind))),
        h("div.services-component-tags", null, tone("idle", t("services.version").replace("{version}", module.version)),
          tone(module.maintenance === "configuration" ? "info" : "idle", t("services.maintenance." + module.maintenance)),
          guide("services.guide.component", { kind: "component", componentKind: module.kind, id: module.id }))),
      facts([[t("services.ownerFile"), module.configFile || t("models.notReported")],
        [t("models.managementAddress"), module.managementUrl],
        [t("services.exposes"), exposed.map(endpoint => endpoint.id + " (" + endpoint.protocol + ")").join(", ") || t("services.exposesNone")]])
    ];
    if (error) children.push(h("p.settings-error", { role: "alert" }, error));
    else if (component.view) children.push(providers.length
      ? table([t("services.col.provider"), t("services.col.route"), t("models.column.baseUrl"), t("services.col.state"), ""],
        providers.map(provider => ({ data: { providerIdentity: module.id + ":" + provider.id, provider: provider.id }, cells: [
          h("span.services-provider-name", null, h("strong", null, provider.name || provider.id),
            provider.prefix ? h("small", null, provider.prefix) : null),
          t("services.upstream." + (provider.via || "unknown"), provider.via || ""),
          h("span.mono-line", { title: provider.baseUrl || "" }, provider.baseUrl || t("models.notReported")),
          h("span.services-provider-state", null, enabledBadge(provider), h("small", null, credentialLabel(provider, false))),
          providerDetails(provider, module.id + ":" + provider.id)] })), "component-" + module.id)
      : h("p.models-empty", null, t("services.noUpstreams")));
    else children.push(h("p", { role: "status" }, t("models.loading")));
    return h("article.services-component", { dataset: { component: module.kind, componentId: module.id } }, ...children);
  }
  function renderProviders() {
    const view = state.view;
    const snapshot = view?.provenance ? h("span.access-snapshot", { title: view.provenance.label },
      h("strong", null, t("access.snapshot")), h("time", null, view.provenance.capturedAt)) : null;
    const reread = h("button.btn.btn-sm", { type: "button", disabled: state.loading || state.pending, onclick: function () { void reconcile(); } },
      icon("refresh"), t("services.reread"));
    const children = [h("header.manage-head.access-head", null,
      h("div.manage-heading", null, h("h1", { id: "models-providers-title" }, t("models.section.providers")),
        h("p", null, t("services.hint"))), snapshot ? h("div.access-snapshot-slot", null, snapshot) : null,
      h("div.access-head-actions", null, reread))];
    if (!view) {
      sections.providers.replaceChildren(...children, status);
      return;
    }
    children.push(status, h("div.services-dims", null, DIMENSIONS.map(dimension)));
    const modules = state.components;
    children.push(h("section.services-components", null,
      h("header.services-dim-head", null, h("div", null, h("h2", null, t("services.components")),
        h("p", null, t("services.componentsHelp")))),
      modules.length ? h("div.services-component-list", null, modules.map(componentCard))
        : h("div.services-none", null, h("p", null, t("services.noComponents")),
          h("div.settings-actions", null,
            guide("services.guide.metabridge", { kind: "component", componentKind: "metabridge" }),
            guide("services.guide.cpa", { kind: "component", componentKind: "cliproxyapi" })))));
    const endpoints = view.registry.endpoints || [];
    const quotaModules = view.registry.modules.filter(module => module.kind === "cliproxyapi" && module.quotaAdapter !== "none");
    const observed = [];
    if (endpoints.length) observed.push(disclosure("catalog", t("models.endpointCatalog"),
      h("p.faint", null, t("models.endpointCatalogHelp")), sections.catalog));
    if (quotaModules.length || view.quotaSources?.length) observed.push(disclosure("quota", t("models.section.quota"), sections.quota));
    if (observed.length) children.push(h("section.services-observed", null, h("h2", null, t("services.observed")),
      h("p.faint", null, t("services.observedHelp")), ...observed));
    children.push(h("p.services-footnote", null, t("services.footnote")));
    sections.providers.replaceChildren(...children.filter(Boolean));
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
    const catalog = state.catalog;
    const page = catalog.page;
    const refresh = h("button.btn", { type: "button", disabled: catalog.loading || !state.endpointId || state.view?.readOnly, onclick: function () { void refreshCatalog(); } },
      icon("refresh"), t("models.refreshCatalog"));
    const children = [h("div.models-subhead", null, h("p.faint", null, t("models.catalogHelp")), refresh)];
    if (state.view) children.push(resourcePicker(state.view.registry.endpoints, state.endpointId, function (id) {
      state.endpointId = id; void invalidateObservations();
    }, "models.queryEndpoint"));
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
      && m.kind === "cliproxyapi" && m.quotaAdapter === "factory-quota-v1" && m.managementUrl && m.managementKeyFile));
  }
  function renderQuota() {
    const quota = state.quota;
    const sources = (state.view?.quotaSources || []).filter(item => item.moduleId === state.moduleId).map(item => item.source);
    const tabs = sources.length > 1 ? h("div.seg", { role: "group", "aria-label": t("models.source") }, sources.map(function (source) {
      return h("button.seg-btn", { type: "button", "aria-pressed": String(source === quota.source), disabled: quota.loading && source !== quota.source,
        onclick: function () { if (source !== quota.source) go({ section: "quota", source: source }); } }, t("models.source." + source, source));
    })) : null;
    const refresh = h("button.btn", { type: "button", disabled: quota.loading || !quotaReady() || state.view?.readOnly, onclick: function () {
      return quota.source ? refreshQuota() : readInitialQuota();
    } }, icon("refresh"), t(quota.source ? "models.refreshQuota" : "models.readQuota"));
    const children = [h("div.models-subhead", null, h("p.faint", null, t("models.quotaHelp")), refresh),
      h("div.models-toolbar.models-toolbar-flat", null, tabs)];
    if (state.view) children.push(resourcePicker(state.view.registry.modules.filter(m => m.kind === "cliproxyapi"), state.moduleId, function (id) {
      state.moduleId = id;
      state.quota.source = (state.view.quotaSources || []).find(item => item.moduleId === id)?.source || "";
      void invalidateObservations();
    }));
    if (!quota.source) children.push(h("p.models-note", null, icon("info"),
      t(quotaReady() && !state.view?.readOnly ? "models.quotaReadHelp" : "models.quotaNeedsCpa")));
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
    if (!view.registry.modules.some(m => m.id === state.moduleId)) state.moduleId = view.registry.modules.find(m => m.kind === "cliproxyapi" && m.quotaAdapter !== "none")?.id
      || view.quotaSources?.[0]?.moduleId || "";
    const sources = (view.quotaSources || []).filter(item => item.moduleId === state.moduleId).map(item => item.source);
    if (!sources.includes(state.quota.source)) state.quota.source = sources[0] || "";
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
    try {
      const view = await api.models();
      // Each configured component is an independent read source. A failed
      // source remains visible as a scoped error, without hiding other records.
      const components = await Promise.all(view.registry.modules.map(async module => {
        try {
          const current = await api.models(module.id);
          if (current.registryRevision !== view.registryRevision) return { module, error: t("models.configurationChangedRead") };
          return { module, view: current };
        } catch (error) { return { module, error: error.message }; }
      }));
      state.components = components;
      await adoptView(view);
    }
    catch (error) { state.loadError = error.message; }
    finally { state.loading = false; renderAll(); }
    return !state.loadError;
  }

  // Operator owns configuration changes. Read every current source again;
  // this action never replays a write or contacts an upstream model service.
  async function reconcile() {
    if (state.pending || state.loading) return;
    const view = state.view;
    // Reconcile against current registry facts even if an uncertain unregister
    // removed the selected resource. This read never replays the write.
    state.bridgeId = "";
    if (!(await load())) return;
    const unchanged = !!view && state.view.revision === view.revision;
    setReceipt(t(unchanged ? "models.rereadUnchanged" : "models.rereadChanged"), unchanged ? "ok" : "warn", "summary");
    renderAll();
  }

  async function loadCatalog(cursor) {
    if (!state.view || !state.endpointId) return;
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
    if (catalog.loading || !state.view || state.view.readOnly) return;
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
    if (!state.view || !state.quota.source) return;
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
    if (quota.loading || !state.view || state.view.readOnly || !quotaReady()) return;
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

  async function readInitialQuota() {
    const quota = state.quota;
    if (quota.loading || !state.view || state.view.readOnly || !quotaReady()) return;
    const moduleId = state.moduleId;
    const revision = state.view.registryRevision;
    const generation = ++quota.generation;
    let completionGeneration = generation;
    quota.loading = true; quota.error = null; quota.unavailable = false; renderQuota();
    // These are the registered adapter's wire operations, not default account
    // categories. Only this explicit click calls them; actual returned accounts
    // determine which source choices appear after reading the cache metadata.
    try {
      const results = await Promise.all(["factory", "command-code"].map(async source => {
        try {
          const observation = await api.refreshModels({ revision, kind: "quota", source, resourceId: moduleId });
          return { source, observation, error: ["failed", "unsupported"].includes(observation.status) ? observation.error || t("models.quotaItemsUnknown") : null };
        } catch (error) { return { source, error: error.message }; }
      }));
      if (generation !== quota.generation || moduleId !== state.moduleId) return;
      const success = results.find(result => result.observation?.items.length);
      if (success) quota.observation = success.observation;
      const view = await api.models(state.bridgeId);
      if (generation !== quota.generation || moduleId !== state.moduleId) return;
      const adoption = adoptView(view);
      completionGeneration = quota.generation;
      await adoption;
      if (moduleId !== state.moduleId || quota.generation !== completionGeneration) return;
      if (quota.source) {
        const read = loadQuota();
        completionGeneration = quota.generation;
        await read;
      }
      if (moduleId !== state.moduleId || quota.generation !== completionGeneration) return;
      // A sibling failure must not erase a successfully observed account.
      const errors = results.filter(result => result.error).map(result => result.error);
      if (errors.length) quota.error = errors.join(" · ");
      else if (!quota.source) quota.observation = results.find(result => result.observation)?.observation || null;
    } catch (error) {
      if (moduleId === state.moduleId && quota.generation === completionGeneration) quota.error = error.message;
    } finally {
      if (moduleId === state.moduleId && quota.generation === completionGeneration) { quota.loading = false; renderQuota(); }
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
      // Keep observations and expanded details; locale changes make no reads.
      renderAll();
    },
    updateFreshness: updateFreshness,
    dirty: function () { return false; }
  };
}
`;
