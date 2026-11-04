export const SETTINGS_SCRIPT = String.raw`
// Settings controller in the shared management document. Sections stay
// mounted across model/settings navigation. Leaving the document protects
// unsaved server groups; Skills guard their own bindings.
import { h } from "/assets/js/lib/dom.js";
import { requestJson, submitMutation } from "/assets/js/lib/api.js";
import { createThemeController } from "/assets/js/lib/theme.js";
import { clearPreference, readSessionAccessMode, writeSessionAccessMode } from "/assets/js/lib/prefs.js";
import { i18n, createManageShell, pageSections, registerManagePage, navigateManage } from "/assets/js/layout/manageShell.js";
import { mountSkills } from "/assets/js/views/skills.js";
import { mountPermissions } from "/assets/js/views/permissions.js";
import { openOperatorHandoff } from "/assets/js/views/operatorHandoff.js";

const $ = selector => document.querySelector(selector);
const t = i18n.t;
const SECTIONS = pageSections("settings");
const dirtySections = { skills: false, server: false, agents: false, roles: false };
let settingsReady = false;
let settingsReadOnly = false;
let supportedAgents = [];
function readSection() {
  const section = new URLSearchParams(window.location.search).get("section");
  return SECTIONS.includes(section) ? section : SECTIONS[0];
}
let section = readSection();
let permissions;
const shell = createManageShell({ page: "settings", t, onNavigate: navigate });
function showSection(next) {
  section = next;
  document.querySelectorAll("#settings-root > .manage-section[data-section]").forEach(panel => { panel.hidden = panel.dataset.section !== next; });
  shell.set(next);
  if (settingsReady && (next === "agents" || next === "roles" || next === "server")) filterGroups();
  if (next === "permissions" && !permissions) permissions = mountPermissions($("#permission-browser"), t);
}
function navigate(next) {
  navigateManage({ page: "settings", section: next });
}
function markDirty(name, value) {
  if (dirtySections[name] === value) return;
  dirtySections[name] = value;
  shell.setDirty(dirtySections);
}
registerManagePage("settings", { show: next => showSection(next.section) });
i18n.subscribe(() => shell.render());
i18n.subscribe(() => {
  permissions?.translate();
});
const skills = mountSkills($("#skill-browser"), t, { heading: false, onDirty: value => markDirty("skills", value) });
i18n.subscribe(() => skills?.translate());
const theme = createThemeController($("#theme-options"), t);
i18n.subscribe(() => theme.render());
const access = $("#access-mode");
access.value = readSessionAccessMode();
access.addEventListener("change", () => {
  $("#browser-receipt").textContent = writeSessionAccessMode(access.value) ? t("settings.browserSaved") : t("settings.storageFailed");
});
$("#reset-layout").addEventListener("click", () => {
  const keys = ["yui.sidebar.width", "yui.dock.width", "yui.dock.side", "yui.dock.open"];
  const results = keys.map(clearPreference);
  $("#browser-receipt").textContent = results.every(Boolean) ? t("settings.layoutReset") : t("settings.storageFailed");
});

const serverGroups = $("#server-settings-groups");
const agentGroups = $("#agent-settings-groups");
const serverStatus = $("#server-settings-status");
const serverSearch = $("#server-settings-search");
const serverMore = $("#server-settings-more");
const groups = [];
// Execution configs (Roles + Profiles) and Agents share one list/detail frame.
// It moves to the visible section; every member keeps its own mounted form.
const ACCESS_SECTIONS = { roles: ["roles", "profiles"], agents: ["agents"] };
const ACCESS_AREAS = ["agents", "roles", "profiles"];
const agentSearch = h("input", { type: "search", autocomplete: "off", spellcheck: false, id: "access-search" });
const agentSearchLabel = h("label.access-search", { for: "access-search" }, h("span.sr-only", null, t("access.search")), agentSearch);
const agentStatus = h("p.access-status", { role: "status" });
const agentMore = h("button.btn", { type: "button", hidden: true }, t("settings.more"));
const agentIndex = h("div.access-list", { role: "region", "aria-label": t("access.list") });
const agentInspector = h("section.access-detail.agent-inspector", { "aria-label": t("access.detail") });
const accessLayout = h("div.access-layout", { dataset: { detail: "closed" } }, agentIndex, agentInspector);
const accessFrame = h("div.access-frame", null, h("div.access-toolbar", null, agentSearchLabel, agentStatus),
  accessLayout, h("div.access-more", null, agentMore));
let agentInspectorOpen = false;
let modelRoutes = { status: "loading", bindings: [], endpoints: [], modules: [] };
function accessSection() { return ACCESS_SECTIONS[section] ? section : null; }
function mountAccessFrame() {
  const host = section === "roles" ? $("#role-access-host") : section === "agents" ? $("#agent-access-host") : null;
  if (!host) return;
  if (accessFrame.parentNode !== host) host.append(accessFrame);
  agentSearch.placeholder = t(section === "roles" ? "access.searchRoles" : "access.searchAgents");
}
function currentStatus() { return accessSection() ? agentStatus : serverStatus; }
function currentSearch() { return accessSection() ? agentSearch : serverSearch; }
function currentMore() { return accessSection() ? agentMore : serverMore; }
function searchValue() { return currentSearch()?.value || ""; }
function groupArea(meta) {
  return meta.id.startsWith("agent/") ? "agents" : meta.id.startsWith("role/") ? "roles"
    : meta.id.startsWith("profile/") ? "profiles" : "server";
}
// A rendered member may not have index metadata (a directly rendered group).
function stateArea(state) { return groupArea(state.meta || { id: state.group?.id || "" }); }
function stateTitle(state) { return state.meta?.title || state.group?.title || state.group?.id || ""; }
function accessLabel(area) { return t("settings.area." + area); }
function selectedAccess() { return groups.find(state => state.selected) || null; }
function markAccessDirty() {
  markDirty("roles", groups.some(g => g.dirty && ["roles", "profiles"].includes(groupArea(g.meta))));
  markDirty("agents", groups.some(g => g.dirty && groupArea(g.meta) === "agents"));
}
function accessMatches(state) {
  return state.matched && !!ACCESS_SECTIONS[accessSection()]?.includes(groupArea(state.meta));
}

// ---- Facts derived from the loaded groups and the model registry --------
function loadedGroup(id) { return groups.find(state => state.meta.id === id)?.group || null; }
function nativeOf(agentId) { return agentId ? loadedGroup("agent/" + agentId)?.observation?.native || null : null; }
function agentAdapter(agentId) { return agentId ? loadedGroup("agent/" + agentId)?.observation?.adapterId || "" : ""; }
function agentKind(agentId) {
  const component = supportedAgents.find(item => (item.configuredIds || []).includes(agentId));
  return component?.label || agentAdapter(agentId) || "";
}
function routeFor(agentId) {
  if (modelRoutes.status !== "read" || !agentId) return null;
  const binding = modelRoutes.bindings.find(item => item.agentId === agentId && item.endpointId);
  if (!binding) return null;
  const endpoint = modelRoutes.endpoints.find(item => item.id === binding.endpointId) || null;
  const module = endpoint?.moduleId ? modelRoutes.modules.find(item => item.id === endpoint.moduleId) || null : null;
  return { binding, endpoint, module };
}
function rolesUsing(agentId) {
  return groups.filter(state => groupArea(state.meta) === "roles" && state.group?.agentId === agentId);
}
// What a new Session would launch with, using the same precedence as the
// launch planner: a Yui endpoint binding replaces the model; otherwise the
// Role/Profile value; otherwise the Agent's own native default.
function effective(state) {
  const group = state.group;
  if (!group) return null;
  const area = stateArea(state);
  const value = key => group.fields.find(item => item.key === key)?.value || "";
  if (area === "agents") {
    const native = group.observation?.native;
    return { agentId: group.agentId, model: native?.model || "", effort: native?.effort || "",
      modelSource: "native", effortSource: "native", route: routeFor(group.agentId), routeStatus: modelRoutes.status,
      nativeStatus: native?.status || "unsupported" };
  }
  let agentId = group.agentId || "", model, effort, own;
  if (area === "profiles") {
    const runtime = group.observation;
    if (!runtime || runtime.status !== "resolved") return { unavailable: runtime?.reason || t("settings.profileUnavailable"), agentId };
    agentId = runtime.binding?.agentId || agentId;
    model = runtime.binding?.config?.model || ""; effort = runtime.binding?.config?.effort || "";
    own = runtime.source === "global-worker" ? "worker" : "profile";
  } else { model = value("model"); effort = value("effort"); own = "role"; }
  const native = nativeOf(agentId);
  const route = routeFor(agentId);
  // Until the registry is read successfully an endpoint may still replace the
  // model: the saved value is shown, but not as the model a new Session uses.
  return { agentId, ownModel: model, route, routeStatus: modelRoutes.status,
    model: route ? route.binding.model : model || native?.model || "",
    effort: effort || native?.effort || "",
    modelSource: route ? "route" : model ? own : "native", effortSource: effort ? own : "native",
    nativeStatus: native?.status || (nativeOf(agentId) ? "read" : "unknown") };
}
function sourceText(kind, route) {
  return kind === "route" ? t("access.source.route").replace("{id}", route?.binding.endpointId || "")
    : t("access.source." + kind);
}
function adapterChip(agentId) {
  const adapter = agentAdapter(agentId);
  return adapter ? h("span.access-chip.adapter-" + adapter, null, adapter === "codex" ? "Codex" : adapter === "claude" ? "Claude" : adapter) : null;
}

// ---- List ---------------------------------------------------------------
function cell(name, ...children) { return h("span.access-cell.access-cell-" + name, null, ...children); }
function modelLine(e) {
  if (!e) return [h("span.access-muted", null, t("settings.summaryLoading"))];
  if (e.unavailable) return [h("span.access-warn", null, t("access.unresolved"))];
  return [h("span.access-model", null, e.model || t("access.nativeDefault"),
      h("span.access-effort", null, " · " + (e.effort || t("access.nativeDefault")))),
    h("small.access-source.source-" + (e.routeStatus === "read" ? e.modelSource : e.routeStatus === "loading" ? "pending" : "unknown"), null, sourceLine(e))];
}
// The source of a Role/Profile model, qualified while the endpoint binding is
// not known (still loading or the registry read failed).
function sourceLine(e) {
  const source = sourceText(e.modelSource, e.route);
  return e.routeStatus === "read" ? source
    : source + " · " + t(e.routeStatus === "loading" ? "access.routePending" : "access.routeUnknownShort");
}
function badges(state) {
  const group = state.group;
  const list = [];
  if (state.loadError) list.push(h("span.badge.tone-bad", null, t("settings.summaryUnavailable")));
  if (state.dirty) list.push(h("span.badge.tone-warn", null, t("settings.unsavedShort")));
  if (state.unknown) list.push(h("span.badge.tone-bad", null, t("access.unknownWrite")));
  if (group?.fields.find(item => item.key === "enabled")?.value === false) list.push(h("span.badge", null, t("settings.summaryDisabled")));
  if (groupArea(state.meta) === "roles" && group?.observation?.session && group.observation.session !== "absent")
    list.push(h("span.badge.tone-info", null, t("access.session." + group.observation.session, group.observation.session)));
  return list;
}
function accessRow(state) {
  const area = groupArea(state.meta);
  const e = effective(state);
  const group = state.group;
  const columns = [];
  const description = group?.fields.find(item => item.key === "description")?.value;
  columns.push(cell("name", h("strong", null, state.meta.title),
    description ? h("small", null, description) : null));
  if (area === "agents") {
    const route = e?.route;
    const users = rolesUsing(group?.agentId || state.meta.title);
    columns.push(cell("kind", h("span", null, agentKind(group?.agentId) || t("settings.summaryLoading")), adapterChip(group?.agentId)),
      cell("model", ...(group ? [h("span.access-model", null, e.model || t(e.nativeStatus === "read" ? "access.nativeDefault" : "access.nativeUnread"),
        e.effort ? h("span.access-effort", null, " · " + e.effort) : null),
        h("small.access-source", null, t("access.nativeFile." + (e.nativeStatus === "read" ? "read" : e.nativeStatus === "absent" ? "absent" : "other")))] : modelLine(null))),
      cell("route", modelRoutes.status === "read"
        ? route ? [h("span.access-route", null, route.binding.endpointId), h("small", null, route.module ? (route.module.kind === "metabridge" ? "metabridge" : "CPA") + " · " + route.module.id : t("access.directEndpoint"))]
          : [h("span", null, t("access.routeNative")), h("small", null, t("access.routeNativeHelp"))]
        : h("span.access-muted", null, t(modelRoutes.status === "loading" ? "settings.summaryLoading" : "access.unknown"))),
      cell("users", users.length ? users.map(user => user.meta.title).join(", ") : h("span.access-muted", null, t("access.noRoles"))));
  } else {
    const agentId = e?.agentId || group?.agentId || "";
    const runtime = area === "profiles" ? group?.observation : null;
    columns.push(cell("agent", area === "profiles" && runtime?.source === "global-worker"
      ? [h("span", null, t("access.inheritWorker")), agentId ? h("small", null, agentId) : null]
      : [h("span.access-agent", null, agentId || t(group ? "access.unknown" : "settings.summaryLoading"), adapterChip(agentId)),
        area === "profiles" ? h("small", null, t("access.explicitAgent")) : null]),
      cell("model", ...modelLine(group ? e : null)));
  }
  columns.push(cell("status", ...badges(state)));
  return h("button.access-row.access-row-" + area, { type: "button",
    "aria-current": state.selected ? "true" : null, dataset: { agentId: state.meta.id, agentArea: area },
    onclick: () => selectAccess(state) }, ...columns);
}
const COLUMNS = {
  roles: ["access.col.role", "access.col.agent", "access.col.model", ""],
  profiles: ["access.col.profile", "access.col.runtime", "access.col.model", ""],
  agents: ["access.col.agent", "access.col.kind", "access.col.native", "access.col.route", "access.col.users", ""]
};
function inside(node, root) {
  for (let parent = node; parent; parent = parent.parentNode || parent.parentElement) if (parent === root) return true;
  return false;
}
function indexControls() {
  const controls = [];
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (node.dataset && (node.dataset.agentId || node.dataset.agentArea)) controls.push(node);
    Array.from(node.children || []).forEach(visit);
  };
  visit(agentIndex);
  return controls;
}
function guideButton(labelKey, scenario, className = "btn") {
  return h("button." + className.split(" ").join("."), { type: "button", dataset: { guide: scenario().kind },
    onclick: () => openOperatorHandoff({ scenario: scenario(), t, locale: i18n.getLocale, onReadback: readback }) }, t(labelKey));
}
function roleNames() { return groups.filter(s => groupArea(s.meta) === "roles").map(s => s.meta.title); }
function agentNames() { return groups.filter(s => groupArea(s.meta) === "agents").map(s => s.meta.title); }
function profileNames() { return groups.filter(s => groupArea(s.meta) === "profiles").map(s => s.meta.title); }
function renderAgentIndex(closedId = "") {
  const active = document.activeElement;
  const insideIndex = inside(active, agentIndex);
  const focus = closedId ? { agentId: closedId, agentArea: "" }
    : insideIndex && active?.dataset ? { agentId: active.dataset.agentId || "", agentArea: active.dataset.agentArea || "" }
      : null;
  const areas = ACCESS_SECTIONS[accessSection()] || [];
  const blocks = [];
  let total = 0;
  for (const area of areas) {
    const rows = groups.filter(state => accessMatches(state) && groupArea(state.meta) === area)
      .sort((a, b) => a.meta.title.localeCompare(b.meta.title));
    total += rows.length;
    const searching = !!searchValue().trim();
    if (!rows.length && searching) continue;
    blocks.push(h("section.access-block", { dataset: { accessBlock: area } },
      h("header.access-block-head", null,
        h("h2", null, t("access.block." + area), h("span.count", null, String(rows.length))),
        h("p", null, t("access.blockHelp." + area))),
      rows.length ? h("div.access-table", { dataset: { columns: area } },
        h("div.access-row-head", { "aria-hidden": "true" }, COLUMNS[area].map(key => h("span", null, key ? t(key === "access.col.model" && modelRoutes.status !== "read" ? "access.col.savedModel" : key) : ""))),
        ...rows.map(accessRow))
        : h("p.access-empty", null, t("access.empty." + area))));
  }
  if (accessSection() === "agents") {
    const missing = supportedAgents.filter(item => !(item.configuredIds || []).length);
    if (missing.length) blocks.push(h("p.access-footnote", null,
      t("access.alsoSupported") + " " + missing.map(item => item.label).join(" · ")));
  }
  if (!total && searchValue().trim()) blocks.unshift(h("p.access-empty", null, t("settings.noMatches")));
  agentIndex.replaceChildren(...blocks);
  const current = selectedAccess();
  if (current) refreshDerived(current);
  if (!focus) return;
  const candidates = indexControls();
  let restored = focus.agentId ? candidates.find(node => node.dataset.agentId === focus.agentId) : null;
  if (!restored && focus.agentArea) restored = candidates.find(node => !node.dataset.agentId && node.dataset.agentArea === focus.agentArea);
  if (restored && restored !== document.activeElement) restored.focus();
}
function renderInspectorEmpty() {
  accessLayout.dataset.detail = "closed";
  agentInspector.replaceChildren();
}
// Detail motion. Wide: list and detail glide to their new columns (a View
// Transition, names exist only while it runs). Narrow, or a row switch while
// open: the new content rises in. Reduced motion or no API: instant.
function accessMotionAllowed() {
  return typeof matchMedia === "function" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function accessTransition(update) {
  const root = typeof document !== "undefined" ? document.documentElement : null;
  const wide = accessLayout.getBoundingClientRect?.().width >= 900;
  if (!root || !wide || !accessMotionAllowed() || typeof document.startViewTransition !== "function" || document.hidden) { update(); return; }
  root.classList.add("vt-access");
  let transition;
  try { transition = document.startViewTransition(update); } catch { root.classList.remove("vt-access"); update(); return; }
  transition.finished.finally(() => root.classList.remove("vt-access"));
}
function riseIn(el) {
  if (!el || typeof el.animate !== "function" || !accessMotionAllowed()) return;
  el.animate([{ opacity: 0, transform: "translate3d(0,6px,0)" }, { opacity: 1, transform: "none" }],
    { duration: 180, easing: "cubic-bezier(.2,0,0,1)" });
}
function selectAccess(state) {
  const wasOpen = accessLayout.dataset.detail === "open";
  const opening = !!state && !wasOpen;
  if (!state && wasOpen || opening) {
    const wide = accessLayout.getBoundingClientRect?.().width >= 900;
    accessTransition(() => applyAccessSelection(state));
    if (!wide) riseIn(state ? agentInspector : agentIndex);
    return;
  }
  const switching = !!state && state !== selectedAccess();
  applyAccessSelection(state);
  if (switching) riseIn(agentInspector.firstElementChild || agentInspector);
}
function applyAccessSelection(state) {
  if (!state) {
    const closedId = selectedAccess()?.meta.id || "";
    agentInspectorOpen = false;
    groups.forEach(item => { item.selected = false; });
    renderInspectorEmpty();
    renderAgentIndex(closedId);
    return;
  }
  agentInspectorOpen = true;
  accessLayout.dataset.detail = "open";
  if (state === selectedAccess() && inside(state.inspectorContent, agentInspector)) return;
  groups.forEach(item => { item.selected = false; });
  state.selected = true;
  // A member may already be open and edited. Moving its one content host
  // preserves that live form; a never-selected member gets a loading host.
  if (state.loaded || state.loadError || state.form) {
    if (!state.inspectorContent) state.inspectorContent = state.content;
    state.inspectorContent.classList.add("agent-inspector-content");
    state.content = state.inspectorContent;
    agentInspector.replaceChildren(state.inspectorContent);
  } else if (state.inspectorContent) {
    agentInspector.replaceChildren(state.inspectorContent);
  } else {
    const loading = h("p.settings-receipt", { role: "status" }, t("settings.loading"));
    state.inspectorContent = h("div.agent-inspector-content", null, loading);
    state.content = state.inspectorContent;
    agentInspector.replaceChildren(state.inspectorContent);
  }
  filterGroups();
  renderAgentIndex();
  if (!state.loaded && !state.loading) void loadGroup(state);
  // On narrow layouts the detail replaces the list: bring it into view and
  // keep keyboard focus in it rather than on a now-hidden row.
  const replaced = typeof getComputedStyle === "function" && getComputedStyle(agentIndex).display === "none";
  if (replaced) agentInspector.scrollIntoView?.({ block: "start" });
  const back = state.backButton;
  if (back && typeof back.focus === "function" && (replaced || inside(document.activeElement, agentIndex))) back.focus({ preventScroll: true });
}
async function readback() {
  for (const state of groups) if (!state.dirty && !state.pending && !state.unknown) state.loaded = false;
  await Promise.all([start(), loadRoutes()]);
}
function renderAgentActions() {
  $("#role-access-actions")?.replaceChildren(guideButton("access.guide.roles",
    () => ({ kind: "role-new", roles: roleNames(), agents: agentNames(), profiles: profileNames() }), "btn btn-primary"));
  $("#agent-access-actions")?.replaceChildren(guideButton("access.guide.agents",
    () => ({ kind: "agent-new", configured: agentNames(),
      unconfigured: supportedAgents.filter(item => !(item.configuredIds || []).length).map(item => item.label) }), "btn btn-primary"));
}
renderAgentActions();
i18n.subscribe(renderAgentActions);
function isAgentGroup(meta) { return /^(agent|role|profile)\//.test(meta.id); }
function filterGroups() {
  groups.forEach(state => {
    if (isAgentGroup(state.meta)) {
      state.root.hidden = true;
      return;
    }
    state.root.hidden = !state.matched;
    if (!state.root.hidden && state.root.open) void loadGroup(state);
  });
  if (accessSection()) {
    mountAccessFrame();
    renderAgentIndex();
    // Each page explains the other: Agent facts (adapter, native defaults)
    // annotate Role rows, and Role bindings say who uses an Agent.
    for (const state of groups) {
      if (accessMatches(state) || state.matched && isAgentGroup(state.meta)) void loadGroup(state);
    }
    const current = selectedAccess();
    if (current && !accessMatches(current)) {
      current.selected = false;
      agentInspectorOpen = false;
      renderInspectorEmpty();
      renderAgentIndex();
    } else if (!current) renderInspectorEmpty();
  }
}
async function loadRoutes() {
  try {
    const view = await requestJson("/api/models");
    const registry = view?.registry || {};
    modelRoutes = { status: "read", bindings: registry.bindings || [], endpoints: registry.endpoints || [], modules: registry.modules || [] };
  } catch (error) {
    modelRoutes = { status: "unavailable", error: error.message, bindings: [], endpoints: [], modules: [] };
  }
  if (accessSection()) renderAgentIndex();
  const current = selectedAccess();
  if (current) refreshDerived(current);
}
settingsReady = true;
showSection(section);
let searchGeneration = 0;
let searchTimer;
function setSearch(value) {
  [serverSearch, agentSearch].forEach(input => { if (input && input.value !== value) input.value = value; });
  searchGeneration++;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => start(), 200);
}
[serverSearch, agentSearch].forEach(input => input?.addEventListener("input", () => setSearch(input.value)));
serverMore?.addEventListener("click", () => start(serverMore.dataset.cursor));
agentMore?.addEventListener("click", () => start(agentMore.dataset.cursor));
window.addEventListener("beforeunload", event => {
  if (!groups.some(g => g.dirty || g.pending || g.unknown)) return;
  event.preventDefault(); event.returnValue = "";
});

function format(value) { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
// Responsibilities, constraints and Skills are lists of short sentences: they
// are edited one item per line, not as JSON, whenever every item fits a line.
const LINE_LIST_KEYS = ["responsibilities", "constraints", "skills"];
function lineList(field) {
  return field.kind === "json" && LINE_LIST_KEYS.includes(field.key) && Array.isArray(field.value)
    && field.value.every(item => typeof item === "string" && !item.includes("\n"));
}
function linesOf(text) {
  return String(text).split("\n").map(line => line.trim()).filter(Boolean);
}
function inputValue(field, control) {
  if (lineList(field)) return linesOf(control.value);
  if (field.kind === "json") return JSON.parse(control.value);
  if (field.kind === "number") {
    if (!control.value.trim() || !Number.isFinite(Number(control.value))) throw new Error(t("settings.invalidNumber"));
    return Number(control.value);
  }
  if (field.kind === "boolean") return control.value === "true";
  return control.value;
}

function fieldText(kind, field, fallback = "") {
  return t("settings." + kind + "." + field.key, fallback);
}
function editor(field, group, state) {
  // Execution members show short labels in their compact block; the full
  // name stays available as the label's title.
  const shortKey = /^(agent|role|profile)\//.test(group.id || "") ? "access.short." + field.key : "";
  const fieldLabel = () => shortKey && t(shortKey, "") ? h("span", { title: fieldText("field", field, field.label) }, t(shortKey))
    : h("span", { "data-i18n": "settings.field." + field.key, "data-i18n-fallback": field.label }, fieldText("field", field, field.label));
  const label = h("label.field", null, fieldLabel());
  let control;
  if (field.kind === "boolean" || field.choices && field.choices.length) {
    const values = field.kind === "boolean" ? ["true", "false"] : field.choices;
    control = h("select", null, values.map(v => h("option", { value: v },
      field.kind === "boolean" ? t(v === "true" ? "settings.booleanOn" : "settings.booleanOff") : v || t("settings.inherit"))));
    if (!values.includes(String(field.value ?? ""))) control.append(h("option", { value: String(field.value ?? "") }, String(field.value ?? "") || t("settings.inherit")));
  } else control = h(field.kind === "json" || field.kind === "multiline" ? "textarea" : "input", {
    ...(field.kind === "number" ? { type: "number", step: "any" } : {}),
    ...(field.kind === "json" || field.kind === "multiline" ? { rows: 4 } : {})
  });
  const lines = lineList(field);
  const initial = lines ? field.value.join("\n") : field.kind === "json" ? JSON.stringify(field.value, null, 2) : String(field.value ?? "");
  control.value = initial;
  // Execution members' long text (description, instructions, lists) sizes to
  // its content and opens a full editor that shows the saved text beside the
  // edited one.
  const longText = !!shortKey && (field.kind === "multiline" || lines);
  if (longText) {
    control.rows = 2;
    control.placeholder = lines ? t("settings.text.onePerLine") : " ";
  }
  label.append(control);
  const reset = h("input", { type: "checkbox" });
  const help = fieldText("help", field);
  const takesEffect = fieldText("takesEffect", field);
  const technical = [
    field.source ? t("settings.source." + field.source, field.source) : "",
    Object.hasOwn(field, "defaultValue") ? t("settings.default") + ": " + format(field.defaultValue) : "",
    // A field left to the Agent's default says so once, not also "inherit".
    !field.source && (field.value === "" || lines && !field.value.length) ? t("settings.inherit") : ""
  ].filter(Boolean).join(" · ");
  const helpText = help || field.summary || "";
  const helpId = helpText ? "help-" + String(group.id + "-" + field.key).replace(/[^A-Za-z0-9_-]/g, "-") : "";
  if (helpId && control.setAttribute) control.setAttribute("aria-describedby", helpId);
  const expand = longText ? h("button.btn-link.agent-text-expand", { type: "button", dataset: { textExpand: field.key } }, t("settings.text.expand")) : null;
  const row = h("div.settings-field", { dataset: { field: field.key, ...(longText ? { text: lines ? "lines" : "multiline" } : {}) }, ...(helpText ? { title: helpText } : {}) }, label,
    helpText ? h("p.agent-field-help", { id: helpId }, helpText) : null,
    technical || takesEffect || field.takesEffect ? h("small.settings-field-meta", { title: [technical, takesEffect || field.takesEffect].filter(Boolean).join(" · ") },
      [technical, takesEffect || field.takesEffect].filter(Boolean).join(" · ")) : null,
    // Execution members have no separate reset control: the user picks or
    // types the value; emptying a clearable field removes the saved setting.
    field.reset && !shortKey ? h("label.settings-reset", { title: t("settings.reset") }, reset, t("settings.resetShort")) : null,
    expand);
  expand?.addEventListener("click", () => openTextEditor({
    label: fieldText("field", field, field.label), saved: initial, draft: control.value,
    editable: !state.readOnly && !control.disabled, lines,
    done: value => {
      if (value === control.value) return;
      control.value = value;
      mark(); item.onChange?.();
    }
  }));
  let unavailable = false;
  function mark() {
    control.disabled = state.readOnly || reset.checked || unavailable;
    state.dirty = state.editors.some(e => e.changed());
    state.profileApplication?.invalidate();
    markDirty("server", groups.some(g => g.dirty && !isAgentGroup(g.meta)));
    markAccessDirty();
    state.save.disabled = state.readOnly || !state.dirty || state.pending || state.capabilityPending || state.unknown;
    if (!state.unknown && !state.pending) state.receipt.textContent = "";
    state.dirtyIndicator && (state.dirtyIndicator.textContent = t("settings.editCount").replace("{count}", String(state.editors.filter(e => e.changed()).length)));
    if (state.dirtyIndicator) state.dirtyIndicator.dataset.dirty = String(state.dirty);
    if (state.form?.dataset) state.form.dataset.dirty = String(state.dirty);
    if (accessSection()) renderAgentIndex();
  }
  function listen() {
    control.addEventListener("input", mark);
    control.addEventListener("change", () => { mark(); item.onChange?.(); });
  }
  reset.addEventListener("change", mark);
  const hint = h("small");
  const choiceActions = h("div.settings-actions");
  row.append(choiceActions, hint);
  const item = { row, get control() { return control; }, field,
    get value() { return reset.checked ? "" : control.value; },
    get blocked() { return unavailable && !reset.checked && control.value !== "" && control.value !== initial; },
    changed: () => reset.checked || control.value !== initial,
    change: () => reset.checked || (field.reset && (shortKey || ["model", "effort"].includes(field.key)) && String(control.value).trim() === "")
      ? { key: field.key, reset: true } : { key: field.key, value: inputValue(field, control) },
    setChoices(choices, options = {}) {
      const value = control.value;
      unavailable = options.available === false || (!choices.length && options.allowCustom === false);
      const values = choices.map(c => c.value);
      const selected = h("select", null, h("option", { value: "" }, t("settings.inherit")),
        choices.map(c => h("option", { value: c.value }, c.label)));
      if (value && !values.includes(value)) selected.append(h("option", { value }, value + " · " + t("settings.notListed")));
      control = choices.length ? selected : h("input");
      control.value = value;
      control.disabled = state.readOnly || reset.checked || unavailable;
      listen();
      label.replaceChildren(fieldLabel(), control);
      choiceActions.replaceChildren();
      if (choices.length && options.allowCustom && !unavailable) {
        const custom = h("button.btn", { type: "button", disabled: state.readOnly }, t("settings.custom"));
        custom.addEventListener("click", () => {
          if (state.readOnly) return;
          const value = control.value;
          control = h("input", { value });
          control.disabled = reset.checked;
          listen(); label.replaceChildren(fieldLabel(), control); choiceActions.replaceChildren();
          control.focus();
        });
        choiceActions.append(custom);
      }
      hint.textContent = (options.reason || "") +
        (value && !values.includes(value) ? " " + t("settings.notListedHelp") : "");
    }
  };
  reset.addEventListener("change", () => item.onChange?.());
  listen();
  return item;
}

function applyCapabilities(state, result) {
  const catalog = result.catalog;
  const model = state.editors.find(e => e.field.key === "model");
  const effort = state.editors.find(e => e.field.key === "effort");
  if (!model) return;
  const modelField = catalog.fields.find(f => f.key === "model");
  model.setChoices(catalog.models, modelField || { allowCustom: true });
  function updateEffort() {
    if (!effort) return;
    const selected = !model.value ? catalog.models.find(m => m.isDefault)
      : catalog.models.find(m => m.value === model.value)
        || catalog.models.find(m => m.resolvedModel === model.value && !m.isDefault)
        || catalog.models.find(m => m.resolvedModel === model.value);
    const field = catalog.fields.find(f => f.key === "effort");
    const choices = selected?.efforts.length ? selected.efforts : field?.choices || [];
    effort.setChoices(choices, {
      allowCustom: !choices.length && field?.allowCustom !== false,
      available: choices.length ? true : field?.available,
      reason: selected?.defaultEffort ? t("settings.nativeEffort") + ": " + selected.defaultEffort : field?.reason
    });
  }
  model.onChange = updateEffort;
  updateEffort();
}

function groupSnapshot(state) {
  const group = state.group;
  const area = groupArea(state.meta);
  const field = key => group?.fields.find(item => item.key === key);
  const native = area === "agents" ? group?.observation?.native : null;
  const runtime = area === "profiles" ? group?.observation : null;
  return {
    group, area, native, runtime,
    model: native?.model || field("model")?.value || (runtime?.status === "resolved" ? runtime.binding?.config?.model : ""),
    effort: native?.effort || field("effort")?.value || (runtime?.status === "resolved" ? runtime.binding?.config?.effort : ""),
    unavailable: !!state.loadError || native?.status === "unavailable" || runtime?.status === "unavailable"
  };
}
function renderGroupSummary(state) {
  if (!state.summary || !isAgentGroup(state.meta)) return;
  const group = state.group;
  const area = groupArea(state.meta);
  const field = key => group?.fields.find(item => item.key === key);
  const { native, runtime, model, effort, unavailable } = groupSnapshot(state);
  const source = state.loadError ? t("settings.summaryUnavailable") + ": " + state.loadError
    : !group ? t("settings.loading")
    : runtime?.status === "unavailable" ? t("settings.profileUnavailable") + ": " + runtime.reason
    : runtime?.source === "global-worker" ? t("settings.inheritWorker")
    : area === "profiles" ? t("settings.explicitTemplate")
    : area === "roles" ? t("settings.roleDefaults") : t("settings.nativeConfiguration");
  const fact = (label, value) => h("span.settings-summary-fact", null,
    h("small", null, t(label)), h("span", null, value || t(unavailable ? "settings.summaryUnavailable"
      : !group ? "settings.summaryLoading" : area === "agents" && native?.status !== "read"
        ? "settings.summaryUnread" : "settings.summaryNativeDefault")));
  state.summary.replaceChildren(
    h("span.settings-group-name", null, h("strong", null, state.meta.title), h("small", null, state.meta.id),
      field("enabled")?.value === false ? h("span.badge", null, t("settings.summaryDisabled")) : null),
    h("span.settings-summary-facts", null,
      area !== "agents" ? fact("settings.assignmentAgent", group?.agentId || t(!group ? "settings.summaryLoading" : "settings.summaryUnavailable")) : null,
      fact("settings.nativeModel", model), fact("settings.nativeEffort", effort),
      area === "agents" ? fact("settings.cachedModels", native?.models?.length ? String(native.models.length) : t("settings.summaryUnread")) : null),
    h("span.settings-summary-context", null, source,
      area === "roles" && field("model")?.source ? " · " + t("settings.source." + field("model").source, field("model").source) : ""),
    h("span.settings-group-affordance", null, t("settings.viewConfiguration")));
}

// A Profile is copied once into a Role. Selection and preview never change
// the Role's draft, nor claim a durable Profile binding.
// A template diff reads as single settings: nested objects (the Agent
// execution configuration) are flattened to their changed leaves, and an
// adapter id that only repeats the Agent change is left out.
function profileDiffRows(changes) {
  const plain = value => value && typeof value === "object" && !Array.isArray(value);
  const shown = value => value === undefined || value === null || value === "" ? "—"
    : Array.isArray(value) ? (value.length ? value.map(item => typeof item === "string" ? item : JSON.stringify(item)).join("\n") : "—")
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  const label = key => t("access.short." + key, t("settings.field." + key, key));
  const rows = [];
  const agentChanged = changes.some(change => ["agent", "activeAgentId"].includes(change.key));
  for (const change of changes) {
    if (plain(change.before) || plain(change.after)) {
      const walk = (before, after, path) => {
        for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
          const b = before?.[key], a = after?.[key];
          if (plain(b) || plain(a)) walk(plain(b) ? b : {}, plain(a) ? a : {}, path.concat(key));
          else if (JSON.stringify(b) !== JSON.stringify(a) && !(key === "adapterId" && agentChanged))
            rows.push({ label: path.concat(key).map(label).join(" · "), before: shown(b), after: shown(a) });
        }
      };
      walk(plain(change.before) ? change.before : {}, plain(change.after) ? change.after : {}, []);
    } else rows.push({ label: label(change.key), before: shown(change.before), after: shown(change.after) });
  }
  return rows;
}
// Description, instructions and constraints decide whether a template fits.
// The dialog shows a short excerpt of each as the Role will read it; long or
// changed text opens a side-by-side comparison (current | after applying).
const PROFILE_TEXT_KEYS = ["description", "systemPrompt", "constraints"];
function blankValue(value) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);
}
// null, "" and [] mean the same thing to a Role: not a change.
function meaningfulChanges(changes) {
  return changes.filter(change => !(blankValue(change.before) && blankValue(change.after)));
}
function textOf(value) {
  if (blankValue(value)) return "";
  if (Array.isArray(value)) return value.map(item => "• " + (typeof item === "string" ? item : JSON.stringify(item))).join("\n");
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
// One modal shell for long text: a header with the field name, one or two
// panes, and an optional footer. Esc and × close it; focus returns to the
// control that opened it.
function textDialog(label, { panes, tag = null, footer = null, closeOnBackdrop = true, onClose = () => {} }) {
  const close = h("button.icon-btn.guide-close", { type: "button", "aria-label": t("guide.close"), title: t("guide.close") }, "×");
  const dialog = h("dialog.text-compare", { "aria-label": label, dataset: { panes: String(panes.length) } },
    h("header.text-compare-head", null, h("h2", null, label), tag, h("span.spacer"), close),
    h("div.text-compare-grid", null, panes), footer);
  const opener = typeof document !== "undefined" ? document.activeElement : null;
  const done = () => { onClose(); if (dialog.open) dialog.close?.(); dialog.remove?.(); opener?.focus?.(); };
  close.addEventListener("click", done);
  dialog.addEventListener?.("cancel", event => { event.preventDefault?.(); done(); });
  if (closeOnBackdrop) dialog.addEventListener?.("click", event => { if (event.target === dialog) done(); });
  document.body?.append?.(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.open = true;
  return { dialog, done, close };
}
function textPane(title, value, extraClass = "") {
  const text = textOf(value);
  return h("section.text-compare-pane" + extraClass, null, title ? h("h3", null, title) : null,
    text ? h("pre.text-compare-body", { tabindex: "0" }, text) : h("p.profile-text-empty", null, t("access.profileEmpty")));
}
function openTextCompare(label, before, after) {
  const view = textDialog(label, { panes: [textPane(t("settings.profileBefore"), before), textPane(t("settings.profileAfter"), after)] });
  view.close.focus?.();
  return view.dialog;
}
// Full editor for an execution member's long text: the saved text on the left,
// the edited text on the right. Done writes back to the field's draft; Cancel
// and Esc discard. Read-only shows the text alone.
function openTextEditor({ label, saved, draft, editable, lines, done }) {
  if (!editable && draft === saved) {
    const view = textDialog(label, { panes: [textPane("", lines ? linesOf(saved) : saved, ".text-compare-single")] });
    view.close.focus?.();
    return view.dialog;
  }
  const area = h("textarea.text-compare-input", { "aria-label": t("settings.text.edited") });
  area.value = draft;
  if (lines) area.placeholder = t("settings.text.onePerLine");
  if (!editable) area.readOnly = true;
  const tag = h("span.profile-text-tag", { dataset: { changed: "false" } });
  const sync = () => {
    const changed = area.value !== saved;
    tag.dataset.changed = String(changed);
    tag.textContent = t(changed ? "settings.text.changed" : "settings.text.unchanged");
  };
  area.addEventListener("input", sync);
  sync();
  const cancel = h("button.btn", { type: "button" }, t(editable ? "models.cancel" : "guide.close"));
  const apply = editable ? h("button.btn.btn-primary", { type: "button" }, t("settings.text.done")) : null;
  const footer = h("footer.text-compare-foot", null,
    h("span.text-compare-note", null, lines ? t("settings.text.onePerLine") : ""), cancel, apply);
  const view = textDialog(label, {
    panes: [textPane(t("settings.text.saved"), lines ? linesOf(saved) : saved),
      h("section.text-compare-pane", null, h("h3", null, t("settings.text.edited")), area)],
    tag, footer, closeOnBackdrop: false
  });
  cancel.addEventListener("click", view.done);
  apply?.addEventListener("click", () => { const value = area.value; view.done(); done(value); });
  area.focus?.();
  return view.dialog;
}
function profileTextSection(value) {
  const changes = meaningfulChanges(value.changes);
  const changeOf = key => changes.find(change => change.key === key);
  const blocks = PROFILE_TEXT_KEYS.map(key => {
    const change = changeOf(key);
    const known = value.result && Object.hasOwn(value.result, key);
    const after = change ? change.after : known ? value.result[key] : undefined;
    const before = change ? change.before : after;
    const label = t("settings.field." + key, key);
    const text = textOf(after);
    const body = after === undefined ? h("p.profile-text-empty", null, t("access.profileSame"))
      : !text ? h("p.profile-text-empty", null, t("access.profileEmpty"))
      : h("p.profile-text-body", null, text);
    const long = text.length > 160 || text.split("\n").length > 2;
    const compare = change || long ? h("button.btn-link.profile-text-toggle", { type: "button", dataset: { compare: key } },
      t(change ? "access.profileCompare" : "access.profileReadAll")) : null;
    compare?.addEventListener("click", () => openTextCompare(label, before, after));
    return h("div.profile-text", { dataset: { key, changed: String(!!change) } },
      h("div.profile-text-head", null, h("span", null, label),
        h("span.profile-text-tag", { dataset: { changed: String(!!change) } }, t(change ? "access.profileWillChange" : "access.profileUnchanged")),
        compare),
      body);
  });
  return h("section.profile-texts", { "aria-label": t("access.profileContent") }, blocks);
}
// Role ← Profile template. A row in the detail opens one dialog: pick a
// template card, read the exact change list, confirm. The copy is one-time;
// the live-Session acknowledgement appears only when a Session may be live.
function roleProfileApplication(state, group) {
  let epoch = 0, preview = null, loading = false, selected = "";
  const generation = state.renderGeneration;
  const session = group.observation?.session;
  const mayBeLive = session !== "absent";
  // A template is recognised by its name and what it is for; launch facts
  // belong to the change list below, not to the choice itself.
  const profileDescription = profile => {
    if (profile.description) return profile.description;
    const member = groups.find(item => item.meta?.id === "profile/" + profile.id);
    const value = member?.group?.fields?.find(field => field.key === "description")?.value;
    return typeof value === "string" ? value : "";
  };
  const options = group.profiles.map(profile => {
    // The description may come from the Profile list, which can load after
    // this Role; it is filled each time the dialog opens.
    const facts = h("small.profile-option-desc");
    const option = h("button.profile-option", { type: "button", role: "radio", "aria-checked": "false",
      disabled: !profile.available, dataset: { profileAction: "option", profileId: profile.id } },
      h("span.profile-option-mark", { "aria-hidden": "true" }),
      h("strong", null, profile.id),
      profile.available ? facts : h("small.profile-option-reason", null, profile.reason || t("settings.profileUnavailable")));
    option.addEventListener("click", () => choose(profile.id));
    return { profile, option, facts };
  });
  const list = h("div.profile-options", { role: "radiogroup", "aria-label": t("settings.profileChoose") }, options.map(item => item.option));
  const info = h("p.profile-status", { role: "status", "aria-live": "polite" }, t("access.profilePick"));
  const result = h("div.settings-profile-preview", { dataset: { profileAction: "preview" } });
  const acknowledge = h("input", { type: "checkbox", dataset: { profileAction: "acknowledge" } });
  const ackRow = h("label.profile-ack", null, acknowledge, t("settings.profileAcknowledge"));
  ackRow.hidden = !mayBeLive;
  const confirm = h("button.btn.btn-primary", { type: "button", disabled: true, dataset: { profileAction: "confirm" } }, t("access.profileConfirm"));
  const cancel = h("button.btn", { type: "button", onclick: () => close() }, t("access.profileCancel"));
  const blocked = () => state.dirty || state.pending || state.unknown || state.capabilityPending;
  function sync() {
    const lock = !!blocked() && !loading;
    for (const { profile, option } of options) {
      option.disabled = !profile.available || lock;
      option.setAttribute?.("aria-checked", String(profile.id === selected));
      option.dataset.selected = String(profile.id === selected);
    }
    confirm.disabled = state.readOnly || !!blocked() || loading || !preview;
    acknowledge.disabled = state.readOnly || !!blocked() || !preview;
    trigger.disabled = !group.profiles.length;
  }
  function invalidate() {
    epoch++; preview = null; loading = false;
    result.replaceChildren(); delete result.dataset.profileId;
    info.textContent = state.unknown ? t("settings.unknown") : blocked() ? t("settings.profileDraftBlocked") : t("access.profilePick");
    sync();
  }
  function choose(profileId) {
    selected = profileId;
    return read();
  }
  async function read() {
    const current = ++epoch;
    preview = null; result.replaceChildren(); delete result.dataset.profileId; acknowledge.checked = false;
    const profileId = selected;
    if (blocked() || !group.profiles.some(profile => profile.id === profileId && profile.available)) {
      loading = false; info.textContent = blocked() ? t("settings.profileDraftBlocked") : t("access.profilePick"); sync(); return;
    }
    const baseline = state.group;
    loading = true; info.textContent = t("settings.profileLoading"); sync();
    try {
      const value = await requestJson("/api/settings/profile?" + new URLSearchParams({ id: group.id, profileId }));
      if (current !== epoch || state.renderGeneration !== generation || baseline !== state.group || blocked()) return;
      if (value.id !== group.id || value.profileId !== profileId) throw Error(t("settings.profilePreviewInvalid"));
      preview = value;
      result.dataset.profileId = profileId;
      const changes = meaningfulChanges(value.changes);
      const textChanges = changes.filter(change => PROFILE_TEXT_KEYS.includes(change.key));
      const rows = profileDiffRows(changes.filter(change => !PROFILE_TEXT_KEYS.includes(change.key)));
      result.replaceChildren(...[
        h("p.profile-status", null, t("access.profileChanges").replace("{count}", String(rows.length + textChanges.length)).replace("{profile}", profileId)),
        profileTextSection(value),
        rows.length ? h("table.settings-profile-diff", null,
          h("thead", null, h("tr", null, ["settings.profileField", "settings.profileBefore", "settings.profileAfter"]
            .map(label => h("th", { scope: "col" }, t(label))))),
          h("tbody", null, rows.map(row => h("tr", null,
            h("th", { scope: "row" }, row.label),
            h("td", null, h("pre", null, row.before)),
            h("td", null, h("pre", null, row.after))))))
          : textChanges.length ? null : h("p", null, t("access.profileNoChange")),
        h("p.profile-copy-note", null, t("settings.profileCopyHelp"))].filter(Boolean));
      info.textContent = "";
    } catch (error) {
      if (current === epoch && state.renderGeneration === generation) info.textContent = error.message;
    } finally {
      if (current === epoch && state.renderGeneration === generation) { loading = false; sync(); }
    }
  }
  confirm.addEventListener("click", async () => {
    if (state.readOnly || blocked() || loading || !preview || state.renderGeneration !== generation) return;
    const confirmed = preview;
    const acknowledged = mayBeLive && acknowledge.checked;
    state.pending = true; epoch++; loading = false; sync(); state.save.disabled = true;
    const controls = [...state.content.querySelectorAll("input,select,textarea,button")];
    const disabled = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    try {
      const saved = await submitMutation("settings/" + group.id, "/api/settings/profile", {
        id: group.id, profileId: confirmed.profileId, revision: confirmed.revision, acknowledgeLive: acknowledged
      });
      close();
      renderGroup(state, saved.group);
      // The command transcript stays available on hover, not as page text.
      state.receipt.textContent = t("settings.profileApplied");
      state.receipt.title = [saved.output, saved.adoption, saved.refresh].filter(Boolean).join("\n");
    } catch (error) {
      state.unknown = error.disposition !== "not-submitted";
      preview = null;
      info.textContent = error.message + "\n" + t(state.unknown ? "settings.unknown" : "settings.profileReadAgain");
      state.receipt.textContent = info.textContent;
      controls.forEach((control, i) => { control.disabled = disabled[i]; });
    } finally {
      state.pending = false;
      state.save.disabled = state.readOnly || !state.dirty || state.unknown;
      state.profileApplication?.sync();
    }
  });
  const dialog = h("dialog.profile-dialog", { "aria-labelledby": "profile-dialog-title-" + group.id.replace(/[^A-Za-z0-9_-]/g, "-") },
    h("header.profile-dialog-head", null,
      h("div", null, h("h2", { id: "profile-dialog-title-" + group.id.replace(/[^A-Za-z0-9_-]/g, "-") },
        t("access.profileTitle").replace("{role}", stateTitle(state) || group.id.slice(5))),
        h("p", null, t("access.profileLead"))),
      h("button.icon-btn.guide-close", { type: "button", "aria-label": t("guide.close"), title: t("guide.close"), onclick: () => close() }, "×")),
    group.profiles.length ? list : h("p", null, t("settings.profileEmpty")),
    info, result,
    h("footer.profile-dialog-foot", null, ackRow, h("span.spacer"), cancel, confirm));
  let opener = null;
  function open() {
    opener = trigger;
    for (const item of options) item.facts.textContent = profileDescription(item.profile);
    invalidate();
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.open = true;
    (options.find(item => item.profile.available)?.option || dialog).focus?.();
  }
  function close() {
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.open = false;
    selected = ""; preview = null; epoch++; result.replaceChildren(); sync();
    if (opener && typeof opener.focus === "function" && opener.isConnected !== false) opener.focus();
  }
  dialog.addEventListener?.("cancel", event => { event.preventDefault?.(); close(); });
  const trigger = h("button.access-row-action", { type: "button", dataset: { profileAction: "open" }, onclick: () => open() },
    h("span.access-row-action-title", null, t("settings.profileApplyTitle")),
    h("span.agent-config-hint", null, t("access.groupHint.profile")),
    h("span.agent-config-count", null, group.profiles.length ? String(group.profiles.length) : ""));
  state.profileApplication = { invalidate, sync, controls: () => [...options.map(item => item.option), trigger], selected: () => selected, open, close };
  sync();
  return { trigger, dialog };
}

function editCount(state) {
  return state.editors.filter(editor => editor.changed()).length;
}
function collapsedSection(titleKey, items) {
  const changed = () => items.some(item => item.changed());
  const count = h("span.agent-config-count");
  const hint = t(titleKey.replace("settings.group.", "access.groupHint."), "");
  const node = h("details.agent-config-section.agent-config-more", null,
    h("summary", null, h("h3", null, t(titleKey)), hint ? h("span.agent-config-hint", null, hint) : null, count));
  node.addEventListener("input", () => { count.textContent = changed() ? t("settings.unsavedShort") : ""; });
  node.addEventListener("change", () => { count.textContent = changed() ? t("settings.unsavedShort") : ""; });
  return node;
}
function configSection(titleKey, className = "") {
  return h("section.agent-config-section" + (className ? "." + className : ""), null,
    h("h3", null, t(titleKey)));
}
function fieldGroupKey(field, area) {
  if (area === "server") {
    if (["default-agent", "default-workspace", "time-zone"].includes(field.key)) return "settings.group.defaults";
    if (field.key === "review") return "settings.group.workflow";
    if (field.key.startsWith("resources-")) return "settings.group.resources";
    if (field.key.startsWith("tmux-") || field.key.startsWith("telemetry-")) return "settings.group.tools";
    return "settings.group.runtime";
  }
  if (["activeAgentId", "enabled", "agent", "access"].includes(field.key)) return "settings.group.identity";
  if (["model", "effort"].includes(field.key)) return "settings.group.models";
  if (field.key === "workspace") return "settings.group.workspace";
  if (["description", "systemPrompt", "instructions", "expectedOutput", "responsibilities", "constraints", "skills", "profile"].includes(field.key)) return "settings.group.instructions";
  if (field.key === "command" || field.key === "baseArgs" || field.key === "environment") return "settings.group.launch";
  return "settings.group.permissions";
}
function fieldOrder(field) {
  const order = {
    "default-agent": 0, "default-workspace": 1, "time-zone": 2,
    "reconciliation-interval-seconds": 10, "controller-task-concurrency": 11, "runtime-health": 12,
    "agent-launch-inactivity-timeout-seconds": 13, "delivery-timeout-seconds": 14,
    "review": 20, "resources-gc-mode": 30, "resources-gc-auto-quarantine": 31,
    "resources-quarantine-ttl-hours": 32, "tmux-bin": 40, "tmux-history-limit": 41,
    "telemetry-enabled": 50, "telemetry-terminal-keep": 51, "telemetry-run-cap": 52,
    "enabled": 0, "agent": 1, "activeAgentId": 1, "access": 2, "model": 3, "effort": 4,
    "workspace": 5, "description": 6, "systemPrompt": 7, "instructions": 7, "expectedOutput": 8,
    "responsibilities": 9, "constraints": 10, "skills": 11,
    "command": 20, "baseArgs": 21, "environment": 22
  };
  return order[field.key] ?? 100 + Object.keys(order).length;
}
function statusPill(label, tone = "") {
  return h("span.agent-status-pill" + (tone ? ".tone-" + tone : ""), null, label);
}
function sourceBlock(state, group) {
  const provenance = group.provenance;
  const native = group.observation?.native;
  const runtime = group.id.startsWith("profile/") ? group.observation : null;
  const details = [];
  if (group.agentId) details.push(h("div.agent-source-row", null,
    h("span", null, t("settings.assignmentAgent")), h("code", null, group.agentId)));
  if (native) {
    if (native.sourceFile) details.push(h("div.agent-source-row", null,
      h("span", null, t("settings.nativeFile")), h("code", null, native.sourceFile)));
    if (native.catalogSource) details.push(h("div.agent-source-row", null,
      h("span", null, t("settings.source.catalog")), h("span", null, native.catalogSource)));
    if (native.catalogFetchedAt) details.push(h("div.agent-source-row", null,
      h("span", null, t("settings.source.observed")), h("time", { datetime: native.catalogFetchedAt }, native.catalogFetchedAt)));
  }
  if (runtime?.reason) details.push(h("div.agent-source-row", null,
    h("span", null, t("settings.source.runtime")), h("span", null, runtime.reason)));
  if (!details.length && !group.observation) return null;
  return h("details.agent-source", null,
    h("summary", null, t("settings.source.title")),
    h("div.agent-source-body", null,
      details.length ? details : h("p", null, t("settings.source.technical")),
      group.observation ? h("details.agent-technical", null,
        h("summary", null, t("settings.source.raw")),
        h("pre.settings-observation", null, JSON.stringify(group.observation, null, 2))) : null));
}
function nativeOverview(group) {
  const native = group.observation?.native;
  if (!native) return null;
  const observedAt = native.catalogFetchedAt || native.observedAt || "";
  const rows = [
    ["settings.nativeModel", native.model],
    ["settings.nativeEffort", native.effort],
    ["settings.nativeProvider", native.provider]
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  return h("section.agent-native-card", null,
    h("div.agent-native-head", null,
      h("div", null, h("h3", null, t("settings.nativeConfiguration")),
        h("p", null, t("settings.nativeIndependent"))),
      statusPill(observedAt ? t("settings.source.observed") + " · " + observedAt : t("settings.source.observationUnknown"), observedAt ? "info" : "")),
    rows.length ? h("dl.agent-fact-grid", null, rows.map(([key, value]) => h("div", null,
      h("dt", null, t(key)), h("dd", null, String(value))))) : null,
    h("p.agent-native-note", null, t(native.models?.length ? "settings.nativeModelsCached" : "settings.nativeModelsUnknown")),
    native.models?.length ? h("details.agent-cached-models", null,
      h("summary", null, t("settings.nativeModels") + " · " + native.models.length),
      h("ul", null, native.models.map(model => h("li", null,
        typeof model === "string" ? model : (model.label || model.name || model.id || model.value),
        typeof model === "object" && model.efforts?.length ? h("small", null, " · " +
          model.efforts.map(e => typeof e === "string" ? e : e.label || e.value).join(", ")) : null)))) : null);
}
function renderGroup(state, group) {
  const previousContent = state.content;
  const generation = state.renderGeneration = (state.renderGeneration || 0) + 1;
  state.loadError = null;
  state.group = group; state.editors = []; state.dirty = false; state.unknown = false;
  state.readOnly = !!(settingsReadOnly || group.readOnly);
  state.capabilityPending = false;
  state.profileApplication = null;
  markDirty("server", groups.some(g => g.dirty && !isAgentGroup(g.meta)));
  markAccessDirty();
  const area = group.id.startsWith("agent/") ? "agents" : group.id.startsWith("role/") ? "roles"
    : group.id.startsWith("profile/") ? "profiles" : "server";
  const isRole = group.id.startsWith("role/");
  const noticeKey = area === "server" ? "settings.notice.server" : area === "agents" ? "settings.notice.agent"
    : area === "profiles" ? "settings.notice.profile" : "settings.notice.role";
  const notice = h("p.agent-notice", null, t(noticeKey));
  const receipt = h("p.settings-receipt.agent-receipt", { role: "status", "aria-live": "polite" });
  const save = h("button.btn.btn-primary", { type: "submit", disabled: true, "data-i18n": "settings.save" }, t("settings.save"));
  state.save = save; state.receipt = receipt;
  const form = h("form.settings-stack.agent-inspector-form", { dataset: { dirty: "false" } });
  const canvas = h("div.agent-inspector-canvas");
  const actionFooter = h("div.agent-action-bar");
  renderGroupSummary(state);
  // Facts derived from other members and the model registry. They refresh in
  // place, never by rebuilding this form (which would discard drafts).
  state.derived = area === "server" ? null : h("div.access-derived");
  if (state.derived) canvas.append(state.derived);
  const native = nativeOverview(group);
  if (native) canvas.append(native);
  const grouped = new Map();
  // The Role workspace is not a daily choice and is left out of execution
  // members; it is never written from here.
  const visibleFields = area === "server" ? group.fields : group.fields.filter(field => field.key !== "workspace");
  for (const field of [...visibleFields].sort((a, b) => fieldOrder(a) - fieldOrder(b))) {
    const item = editor(field, group, state);
    state.editors.push(item);
    const key = fieldGroupKey(field, area);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  let capabilities;
  if (group.agentId && group.fields.some(field => field.key === "model")) {
    const info = h("p.agent-capability-info", { role: "status" }, t("settings.notQueried"));
    const query = h("button.btn", { type: "button" }, t("settings.queryCapabilities"));
    const refresh = h("button.btn", { type: "button", disabled: state.readOnly }, t("settings.refreshCapabilities"));
    const output = h("div.agent-capability-output");
    async function load(force) {
      if (state.pending || state.capabilityPending || force && state.readOnly) return;
      if (state.editors.some(e => e.field.key === "activeAgentId" && e.changed())) {
        info.textContent = t("settings.saveAgentFirst"); return;
      }
      state.capabilityPending = true; save.disabled = true;
      state.profileApplication?.invalidate();
      query.disabled = refresh.disabled = true; info.textContent = t("settings.querying");
      try {
        const result = await requestJson("/api/settings/capabilities?" + new URLSearchParams({ id: group.id, refresh: String(force) }));
        if (state.renderGeneration !== generation) return;
        if (state.pending) { info.textContent = t("settings.notQueried"); return; }
        if (result.catalog.agentId !== group.agentId) {
          info.textContent = t("settings.agentChanged"); return;
        }
        if (state.editors.some(e => e.field.key === "activeAgentId" && e.changed())) {
          info.textContent = t("settings.saveAgentFirst"); return;
        }
        info.textContent = t("settings.capability." + result.source, result.source) + " · " + (result.fetchedAt || result.attemptedAt) +
          (result.failure ? " · " + result.failure.code + ": " + result.failure.message : "");
        applyCapabilities(state, result);
        output.replaceChildren(
          ...result.catalog.warnings.map(w => h("p", null, w)),
          h("details.agent-technical", null, h("summary", null, t("settings.capabilityDetails")),
            h("pre.settings-observation", null, JSON.stringify(result.catalog, null, 2))));
      } catch (error) { info.textContent = t("settings.queryFailed") + ": " + error.message; }
      finally {
        query.disabled = false; refresh.disabled = state.readOnly;
        if (state.renderGeneration === generation) {
          state.capabilityPending = false;
          state.save.disabled = state.readOnly || !state.dirty || state.pending || state.unknown;
          state.profileApplication?.sync();
        }
      }
    }
    query.addEventListener("click", () => { refresh.hidden = state.readOnly; return load(false); });
    refresh.addEventListener("click", () => load(true));
    refresh.hidden = true;
    capabilities = h("div.agent-capability-section.agent-capability-inline", { title: t("settings.capability.help") },
      h("div.agent-capability-line", null, info, h("div.settings-actions", null, query, refresh)), output);
  }
  const groupOrder = area === "server"
    ? ["settings.group.defaults", "settings.group.runtime", "settings.group.workflow", "settings.group.resources", "settings.group.tools"]
    : ["settings.group.identity", "settings.group.models", "settings.group.workspace", "settings.group.instructions", "settings.group.launch", "settings.group.permissions"];
  // Execution members: the short daily choices (enabled, Agent, model,
  // effort) form one compact block without headings; each is one line.
  if (area !== "server") {
    const core = ["settings.group.identity", "settings.group.models", "settings.group.workspace"].flatMap(key => grouped.get(key) || []);
    if (core.length) {
      const section = h("section.agent-config-section.agent-config-primary.agent-config-core");
      section.append(h("div.agent-field-grid.agent-field-grid-compact", null, core.map(item => item.row)));
      if (capabilities) section.append(capabilities);
      canvas.append(section);
    }
    grouped.delete("settings.group.identity"); grouped.delete("settings.group.models"); grouped.delete("settings.group.workspace");
  }
  for (const key of groupOrder) {
    const items = grouped.get(key);
    if (!items?.length) continue;
    const primary = key === "settings.group.identity" || key === "settings.group.models";
    // Execution members keep the daily choices open; less frequent groups
    // stay one click away instead of lengthening every detail.
    const section = area !== "server" && !primary ? collapsedSection(key, items)
      : configSection(key, primary ? "agent-config-primary" : "");
    section.append(h("div.agent-field-grid" + (primary ? ".agent-field-grid-primary" : ""), null,
      items.map(item => item.row)));
    if (key === "settings.group.models" && capabilities) section.append(capabilities);
    canvas.append(section);
  }
  if (capabilities && !capabilities.parentNode) canvas.append(capabilities);
  if (isRole && Array.isArray(group.profiles)) {
    const profileApplication = roleProfileApplication(state, group);
    const entry = h("div.agent-config-section.agent-config-more.agent-profile-more", null, profileApplication.trigger);
    const core = canvas.querySelector?.(".agent-config-core");
    if (core && typeof core.after === "function" && core.parentNode === canvas) core.after(entry); else canvas.append(entry);
    canvas.append(profileApplication.dialog);
  }
  const acknowledge = h("input", { type: "checkbox" });
  const liveAcknowledge = area === "agents" ? t("settings.acknowledge.agent") : area === "roles" ? t("settings.acknowledge.role") : "";
  if (liveAcknowledge) canvas.append(h("label.settings-reset.agent-live-ack", null,
    acknowledge, liveAcknowledge));
  const compare = h("button.btn", { type: "button", "data-i18n": "settings.compare" }, t("settings.compare"));
  compare.addEventListener("click", async () => {
    compare.disabled = true;
    try {
      const current = await requestJson("/api/settings/group?" + new URLSearchParams({ id: group.id }));
      const values = h("div.settings-observation.agent-comparison", null,
        h("p", null, t("settings.compare." + area)),
        current.fields.map(field => h("p", null,
          fieldText("field", field, field.label) + ": " +
          (field.value === "" ? t("settings.inherit") : format(field.value)) +
          (field.source ? " · " + t("settings.source." + field.source, field.source) : ""))));
      const agentChanged = current.agentId !== group.agentId;
      if (agentChanged) values.append(h("p.settings-error", null, t("settings.agentChanged")));
      const adopt = h("button.btn", { type: "button", disabled: state.unknown || agentChanged }, t("settings.useBaseline"));
      adopt.addEventListener("click", () => {
        state.group = current;
        state.profileApplication?.invalidate();
        receipt.textContent = t("settings.baselineChanged");
        values.remove(); adopt.remove();
      });
      canvas.append(values, adopt);
    } catch (error) { receipt.textContent = error.message; }
    finally { compare.disabled = false; }
  });
  const dirtyIndicator = h("span.agent-dirty-indicator", { "data-dirty": String(state.dirty) },
    t("settings.editCount").replace("{count}", String(editCount(state))));
  state.dirtyIndicator = dirtyIndicator;
  const footStatus = h("div.agent-foot-status", null, dirtyIndicator, notice, receipt);
  actionFooter.append(footStatus, h("div.agent-action-buttons", null, compare, save));
  const source = area === "server" ? sourceBlock(state, group) : null;
  if (source) canvas.append(source);
  form.append(canvas, actionFooter);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (state.readOnly || state.pending || state.capabilityPending || state.unknown) return;
    let changes;
    if (state.editors.some(e => e.blocked)) {
      receipt.textContent = t("settings.unsupportedDraft"); return;
    }
    try { changes = state.editors.filter(e => e.changed()).map(e => e.change()); }
    catch (error) { receipt.textContent = error.message; receipt.classList.add("settings-error"); return; }
    if (!changes.length) return;
    state.pending = true; save.disabled = true;
    state.profileApplication?.invalidate();
    const controls = [...form.querySelectorAll("input,select,textarea,button")];
    const disabled = controls.map(c => c.disabled);
    controls.forEach(c => { c.disabled = true; });
    try {
      const result = await submitMutation("settings/" + group.id, "/api/settings/group", {
        id: group.id, revision: state.group.revision, changes, acknowledgeLive: acknowledge.checked
      });
      renderGroup(state, result.group);
      const transcript = [result.output, result.adoption, result.refresh].filter(Boolean).join("\n");
      // Execution members confirm in one line; the command transcript stays
      // available on hover. Server settings keep the full result.
      if (area === "server") state.receipt.textContent = t("settings.saved") + "\n" + transcript;
      else { state.receipt.textContent = t("settings.savedShort"); state.receipt.title = transcript; }
    } catch (error) {
      state.unknown = error.disposition !== "not-submitted";
      receipt.textContent = error.message + "\n" + (state.unknown ? t("settings.unknown") : t("settings.draftKept"));
      receipt.classList.add("settings-error");
      controls.forEach((c, i) => { c.disabled = disabled[i]; });
    } finally {
      state.pending = false;
      state.save.disabled = state.readOnly || !state.dirty || state.unknown;
      state.profileApplication?.sync();
    }
  });
  // Inspector identity chrome belongs only to Agent/Role/Profile members.
  // Server cards keep their own summary and form so a system group is never
  // mislabeled as an execution tool.
  const inspectorLeading = /^(agent|role|profile)\//.test(group.id) ? [inspectorHeader(state)] : [];
  state.content.replaceChildren(...inspectorLeading, form);
  refreshDerived(state);
  state.form = form;
  state.canvas = canvas;
  if (previousContent && previousContent !== state.content) {
    state.content.classList.add("agent-inspector-content");
  }
  state.save.disabled = state.readOnly || !state.dirty || state.unknown;
  if (state.readOnly) {
    const profileControls = new Set(state.profileApplication ? state.profileApplication.controls() : []);
    form.querySelectorAll("input,select,textarea").forEach(control => {
      if (!profileControls.has(control)) control.disabled = true;
    });
    state.profileApplication?.sync();
  }
}

function memberScenario(state) {
  const area = stateArea(state);
  const group = state.group;
  const route = routeFor(group?.agentId)?.binding.endpointId || "";
  const routeKnown = modelRoutes.status === "read";
  if (area === "agents") return { kind: "agent", id: stateTitle(state), adapter: agentAdapter(group?.agentId),
    roles: rolesUsing(group?.agentId).map(role => role.meta.title), route, routeKnown };
  if (area === "profiles") return { kind: "profile", id: stateTitle(state), inherit: group?.observation?.source === "global-worker",
    agentId: effective(state)?.agentId || "" };
  return { kind: "role", name: stateTitle(state), agentId: group?.agentId || "", adapter: agentAdapter(group?.agentId), route, routeKnown };
}
function inspectorHeader(state) {
  const area = state.group?.id.startsWith("agent/") ? "agents" : state.group?.id.startsWith("role/") ? "roles"
    : state.group?.id.startsWith("profile/") ? "profiles" : groupArea(state.meta || { id: "" });
  const title = state.meta?.title || state.group?.title || "";
  const id = state.meta?.id || state.group?.id || "";
  // One control closes the detail: a back link where the detail replaces the
  // list (narrow), a close mark where both are visible (wide).
  const close = h("button.btn.btn-ghost.access-back", { type: "button", "aria-label": t("settings.closeInspector"), title: t("settings.closeInspector"),
    onclick: () => selectAccess(null) }, h("span.access-back-label", null, "← " + t("access.back")), h("span.access-close-mark", { "aria-hidden": "true" }, "×"));
  state.backButton = close;
  state.headerFacts = h("div.access-detail-facts");
  renderHeaderFacts(state);
  const guide = guideButton("access.guide.member", () => memberScenario(state), "btn btn-sm access-detail-guide");
  return h("header.agent-inspector-head.access-detail-head", { dataset: { area }, title: id }, close,
    h("div.agent-inspector-identity.access-detail-title", null,
      h("h2", null, title), state.headerFacts), guide);
}
function fact(label, value, note, tone) {
  return h("div.access-fact" + (tone ? ".tone-" + tone : ""), null, h("span", null, label),
    h("strong", null, value), note ? h("small", null, note) : null);
}
function renderHeaderFacts(state) {
  if (!state.headerFacts || !state.group) return;
  const area = stateArea(state);
  const e = effective(state);
  const items = [];
  if (area === "agents") {
    items.push(fact(t("access.col.kind"), agentKind(state.group.agentId) || t("access.unknown")),
      fact(t("access.col.native"), (e.model || t("access.nativeDefault")) + (e.effort ? " · " + e.effort : "")),
      fact(t("access.col.route"), modelRoutes.status !== "read" ? t("access.unknown") : e.route ? e.route.binding.endpointId : t("access.routeNative")));
  } else if (e?.unavailable) {
    items.push(fact(t("access.col.model"), t("access.unresolved"), e.unavailable, "warn"));
  } else if (e) {
    items.push(fact(t("access.col.agent"), (area === "profiles" && state.group.observation?.source === "global-worker" ? t("access.inheritWorker") + " · " : "") + (e.agentId || t("access.unknown"))),
      fact(t(e.routeStatus === "read" ? "access.newSession" : "access.savedLaunch"), (e.model || t("access.nativeDefault")) + " · " + (e.effort || t("access.nativeDefault")),
        sourceLine(e), e.routeStatus === "unavailable" ? "warn" : ""));
  }
  state.headerFacts.replaceChildren(...items);
}
// Explains the launch result in words the list cannot: an endpoint binding
// that replaces the Role model, or which Roles depend on an Agent.
function refreshDerived(state) {
  renderHeaderFacts(state);
  const host = state.derived;
  if (!host || !state.group) return;
  const area = stateArea(state);
  const e = effective(state);
  const lines = [];
  if (area === "agents") {
    const users = rolesUsing(state.group.agentId);
    const route = e.route;
    lines.push(h("div.access-derived-row", null, h("span", null, t("access.col.route")),
      h("div", null, modelRoutes.status !== "read"
        ? h("p", null, t(modelRoutes.status === "loading" ? "settings.summaryLoading" : "access.routeUnknown"))
        : route ? h("p", null, t("access.routeBound").replace("{endpoint}", route.binding.endpointId).replace("{model}", route.binding.model)
            + " " + (route.module ? t("access.routeVia").replace("{module}", (route.module.kind === "metabridge" ? "metabridge" : "CPA") + " · " + route.module.id) : t("access.directEndpoint")))
          : h("p", null, t("access.routeNativeLong")),
        h("a.access-link", { href: "/models/providers" }, t("access.openServices")))));
    lines.push(h("div.access-derived-row", null, h("span", null, t("access.col.users")),
      h("div.access-chips", null, users.length ? users.map(role => h("button.access-chip.access-chip-link", { type: "button",
        onclick: () => { navigateManage({ page: "settings", section: "roles" }); selectAccess(role); } }, role.meta.title))
        : h("p", null, t("access.noRolesLong")))));
  } else if (e && !e.unavailable) {
    // The header already states the model and its source; only a saved value
    // that will not launch needs words here.
    if (e.route && e.ownModel) lines.push(h("p.access-warn", null, t("access.routeOverrides").replace("{model}", e.ownModel)));
  } else if (e?.unavailable) lines.push(h("p.access-warn", null, e.unavailable));
  host.replaceChildren(...lines);
}

async function loadGroup(state) {
  if (state.loaded || state.loading || state.dirty || state.pending || state.unknown) return;
  state.loading = true;
  state.loadError = null;
  renderGroupSummary(state);
  state.content.textContent = t("settings.loading");
  try {
    renderGroup(state, await requestJson("/api/settings/group?" + new URLSearchParams({ id: state.meta.id })));
    state.loaded = true;
    // The index has an independent summary surface. Refresh it after the
    // read so a selected member's evidence appears without replacing the
    // member's live draft form.
    if (accessSection()) renderAgentIndex();
  } catch (error) {
    state.loadError = error.message;
    renderGroupSummary(state);
    state.content.replaceChildren(h("p.settings-error", null, error.message),
      h("button.btn", { type: "button", onclick: () => loadGroup(state) }, t("settings.retry")));
  } finally { state.loading = false; }
}
async function start(cursor) {
  const generation = ++searchGeneration;
  const query = searchValue().trim();
  const status = currentStatus();
  const more = currentMore();
  status.textContent = t("settings.loading");
  more.disabled = true;
  try {
    const data = await requestJson("/api/settings?" + new URLSearchParams({ q: query, cursor: cursor || "0" }));
    if (generation !== searchGeneration) return;
    settingsReadOnly = !!data.readOnly;
    supportedAgents = data.supportedAgents || [];
    renderAgentActions();
    if (!cursor) groups.forEach(state => { state.matched = false; state.root.hidden = true; });
    data.groups.forEach(meta => {
      const existing = groups.find(g => g.meta.id === meta.id);
      if (existing) {
        existing.matched = true;
        if (query) { existing.root.open = true; void loadGroup(existing); }
        return;
      }
      const content = h("div");
      const summary = h("summary", null, t("settings.section." + meta.section, meta.section) + " · " + meta.title);
      const area = groupArea(meta);
      const root = h("details.settings-card" + (area !== "server" ? ".settings-group.settings-group-" + area : ""),
        { open: meta.id === "system" || !!query }, summary, content);
      const state = { meta, root, content, summary, dirty: false, loaded: false, loading: false, matched: true, selected: false };
      groups.push(state);
      if (area === "server") serverGroups.append(root);
      else agentGroups.append(root);
      renderGroupSummary(state);
      root.addEventListener("toggle", () => { if (root.open) void loadGroup(state); });
      if (root.open) void loadGroup(state);
    });
    filterGroups();
    // Execution pages show the snapshot badge in their heading; the list
    // itself reports no-match states.
    status.textContent = accessSection() ? ""
      : data.provenance ? data.provenance.label + " · " + data.provenance.capturedAt
        : data.total ? t("settings.serverGroupsHelp") : t("settings.noMatches");
    more.hidden = !data.nextCursor;
    if (data.nextCursor) more.dataset.cursor = data.nextCursor;
    else delete more.dataset.cursor;
  } catch (error) { status.textContent = error.message; }
  finally { if (generation === searchGeneration) more.disabled = false; }
}
i18n.subscribe(() => {
  [serverMore, agentMore].forEach(button => { if (button) button.textContent = t("settings.more"); });
  groups.forEach(renderGroupSummary);
  for (const state of groups) {
    if (state.group && state.form && !state.dirty && !state.pending && !state.unknown && /^(agent|role|profile)\//.test(state.group.id)) renderGroup(state, state.group);
  }
  if (accessSection()) { mountAccessFrame(); renderAgentIndex(); }
});
void start();
void loadRoutes();
`;
