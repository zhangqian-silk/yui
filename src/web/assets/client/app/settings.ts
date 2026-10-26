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
const dirtySections = { skills: false, server: false, agents: false };
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
  const editor = $("#settings-editor");
  if (next === "agents" || next === "server") {
    $(next === "agents" ? "#agent-access-host" : "#server-settings-host").append(next === "agents" ? agentAccessLayout : editor);
    editor.hidden = next === "agents";
    if (next === "agents") agentAccessLayout.hidden = false;
    if (settingsReady) filterGroups();
  }
  shell.set(next);
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

const container = $("#settings-groups");
const status = $("#settings-status");
const search = $("#settings-search");
const groups = [];
const groupAreas = {};
const agentAccess = $("#agent-access-host");
const agentIndex = h("aside.agent-index", { "aria-label": t("settings.agentIndex") });
const agentInspector = h("section.agent-inspector", { "aria-live": "polite" });
const agentAccessLayout = h("div.agent-access-layout", null, agentIndex, agentInspector);
agentAccess?.append(agentAccessLayout);
const agentAreaFilters = h("div.agent-area-filters", { role: "group", "aria-label": t("settings.filterArea") });
let agentAreaFilter = "all";
for (const name of ["agents", "roles", "profiles", "server"]) {
  const list = h("div.settings-group-list.settings-group-list-" + name, { dataset: { agentGroupList: name } });
  const title = h(name === "profiles" ? "summary" : "header", null);
  const root = name === "server" ? list : h(name === "profiles" ? "details.settings-profile-library" : "section.settings-group-area.settings-area-" + name,
    { "aria-labelledby": "settings-area-" + name }, title, list);
  groupAreas[name] = { root, list, title };
  if (name !== "server") container.append(root);
}
function renderAreaTitles() {
  for (const name of ["agents", "roles", "profiles"]) {
    const count = groups.filter(state => state.matched && groupArea(state.meta) === name).length;
    groupAreas[name].title.replaceChildren(
      h(name === "profiles" ? "span.settings-area-title" : "h2", { id: "settings-area-" + name }, t("settings.area." + name),
        h("span.settings-area-count", null, String(count))),
      h(name === "profiles" ? "span.settings-area-help" : "p", null, t("settings.areaHelp." + name)));
  }
}
function groupArea(meta) {
  return meta.id.startsWith("agent/") ? "agents" : meta.id.startsWith("role/") ? "roles"
    : meta.id.startsWith("profile/") ? "profiles" : "server";
}
const ACCESS_AREAS = ["agents", "roles", "profiles"];
function accessLabel(area) { return t("settings.area." + area); }
function selectedAccess() { return groups.find(state => state.selected) || null; }
function showAgentAreaFilter(name) {
  agentAreaFilter = name;
  agentAreaFilters.querySelectorAll("[data-agent-area]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.agentArea === name));
  });
  filterGroups();
}
function renderAgentAreaFilters() {
  const counts = { all: 0, agents: 0, roles: 0, profiles: 0 };
  groups.forEach(state => {
    if (!state.matched || !ACCESS_AREAS.includes(groupArea(state.meta))) return;
    counts.all++;
    counts[groupArea(state.meta)]++;
  });
  agentAreaFilters.replaceChildren(...["all", ...ACCESS_AREAS].map(name =>
    h("button.chip-tab", { type: "button", "aria-pressed": String(agentAreaFilter === name),
      dataset: { agentArea: name }, onclick: () => showAgentAreaFilter(name) },
      name === "all" ? t("settings.filterAll") : accessLabel(name), h("span.count", null, String(counts[name])))));
}
function accessMatches(state) {
  return state.matched && (agentAreaFilter === "all" || groupArea(state.meta) === agentAreaFilter);
}
function defaultAccess() {
  for (const area of ACCESS_AREAS) {
    const row = groups.find(state => accessMatches(state) && groupArea(state.meta) === area);
    if (row) return row;
  }
  return null;
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
    unavailable: state.loadError || native?.status === "unavailable" || runtime?.status === "unavailable"
  };
}
function accessFacts(state) {
  if (state.loadError) return t("settings.summaryUnavailable");
  if (!state.group) return t("settings.summaryLoading");
  const snapshot = groupSnapshot(state);
  if (snapshot.unavailable) return t("settings.summaryUnavailable");
  const facts = [snapshot.model, snapshot.effort].filter(Boolean);
  return facts.length ? facts.join(" · ") : t(snapshot.area === "agents"
    ? "settings.summaryNativeDefault" : "settings.summaryUnavailable");
}
function accessRow(state) {
  const area = groupArea(state.meta);
  return h("button.agent-index-row", { type: "button",
    "aria-current": state.selected ? "true" : null, dataset: { agentId: state.meta.id, agentArea: area },
    onclick: () => selectAccess(state) },
    h("span.agent-index-icon.tone-" + (area === "agents" ? "info" : area === "roles" ? "accent" : "idle"), null,
      h("span", null, area === "agents" ? "A" : area === "roles" ? "R" : "P")),
    h("span.agent-index-copy", null, h("strong", null, state.meta.title),
      h("small", null, area === "agents" ? t("settings.kind.agent")
        : area === "roles" ? t("settings.kind.role") : t("settings.kind.profile")),
      h("span.agent-index-facts", null, accessFacts(state))),
    state.dirty ? h("span.badge.tone-warn", null, t("settings.unsavedShort")) : null,
    h("span.agent-index-caret", { "aria-hidden": "true" }, "→"));
}
function renderAgentIndex() {
  renderAgentAreaFilters();
  const children = [h("header.agent-index-head", null,
    h("div", null, h("h2", null, t("settings.agentIndex")), h("p", null, t("settings.agentIndexHelp"))),
    agentAreaFilters)];
  let total = 0;
  for (const area of ACCESS_AREAS) {
    if (agentAreaFilter !== "all" && agentAreaFilter !== area) continue;
    const rows = groups.filter(state => accessMatches(state) && groupArea(state.meta) === area)
      .sort((a, b) => a.meta.title.localeCompare(b.meta.title));
    if (!rows.length) continue;
    total += rows.length;
    children.push(h("section.agent-index-group", null,
      h("h3", null, accessLabel(area), h("span.count", null, String(rows.length))),
      h("div.agent-index-list", null, rows.map(accessRow))));
  }
  if (!total) children.push(h("p.empty", null, t(search.value.trim() ? "settings.noMatches" : "settings.agentEmpty")));
  agentIndex.replaceChildren(...children);
}
function selectAccess(state) {
  if (!state) {
    groups.forEach(item => { item.selected = false; });
    agentInspector.replaceChildren();
    return;
  }
  if (state === selectedAccess() && state.inspectorContent?.parent === agentInspector) return;
  groups.forEach(item => { item.selected = false; });
  state.selected = true;
  // A Role may already be open, edited, and then shown in the Role summary
  // rail. Moving its one content host preserves that live form. A member that
  // has never been selected has no mounted form; do not render the closed
  // summary card's loading text into the inspector.
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
}
const agentActions = $("#agent-management-actions");
function renderAgentActions() {
  agentActions.replaceChildren(h("button.btn.btn-primary", { type: "button", onclick: () => openOperatorHandoff({
    topic: "agent", t, locale: i18n.getLocale, onReadback: async () => {
      for (const state of groups) if (!state.dirty && !state.pending && !state.unknown) state.loaded = false;
      await start();
    }
  }) }, t("models.configure.agent")),
    supportedAgents.length ? h("p.faint", null, t("settings.supportedAgents") + ": ",
      supportedAgents.map(agent => agent.label + " · " +
        (agent.configuredIds.length ? agent.configuredIds.join(", ") : t("settings.notConfigured"))).join(" / ")) : null);
}
renderAgentActions();
i18n.subscribe(renderAgentActions);
function isAgentGroup(meta) { return /^(agent|role|profile)\//.test(meta.id); }
function filterGroups() {
  groups.forEach(state => {
    state.root.hidden = !state.matched || isAgentGroup(state.meta) !== (section === "agents");
    if (!state.root.hidden && !isAgentGroup(state.meta) && state.root.open) void loadGroup(state);
  });
  for (const [name, area] of Object.entries(groupAreas)) {
    area.root.hidden = !groups.some(state => !state.root.hidden && groupArea(state.meta) === name);
  }
  if (search.value.trim() && !groupAreas.profiles.root.hidden) groupAreas.profiles.root.open = true;
  renderAreaTitles();
  if (section === "agents") {
    renderAgentIndex();
    for (const state of groups) {
      if (accessMatches(state)) void loadGroup(state);
    }
    const current = selectedAccess();
    if (!current || !accessMatches(current)) selectAccess(defaultAccess());
  }
}
settingsReady = true;
showSection(section);
let searchGeneration = 0;
let searchTimer;
const more = h("button.btn", { type: "button", hidden: true }, t("settings.more"));
container.after(more);
window.addEventListener("beforeunload", event => {
  if (!groups.some(g => g.dirty || g.pending || g.unknown)) return;
  event.preventDefault(); event.returnValue = "";
});

function format(value) { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function inputValue(field, control) {
  if (field.kind === "json") return JSON.parse(control.value);
  if (field.kind === "number") {
    if (!control.value.trim() || !Number.isFinite(Number(control.value))) throw new Error(t("settings.invalidNumber"));
    return Number(control.value);
  }
  if (field.kind === "boolean") return control.value === "true";
  return control.value;
}

function editor(field, group, state) {
  const fieldLabel = () => h("span", { "data-i18n": "settings.field." + field.key, "data-i18n-fallback": field.label }, t("settings.field." + field.key, field.label));
  const label = h("label.field", null, fieldLabel());
  let control;
  if (field.kind === "boolean" || field.choices && field.choices.length) {
    const values = field.kind === "boolean" ? ["true", "false"] : field.choices;
    control = h("select", null, values.map(v => h("option", { value: v }, v || t("settings.inherit"))));
    if (!values.includes(String(field.value ?? ""))) control.append(h("option", { value: String(field.value ?? "") }, String(field.value ?? "")));
  } else control = h(field.kind === "json" || field.kind === "multiline" ? "textarea" : "input", {
    ...(field.kind === "number" ? { type: "number", step: "any" } : {}),
    ...(field.kind === "json" || field.kind === "multiline" ? { rows: 4 } : {})
  });
  const initial = field.kind === "json" ? JSON.stringify(field.value, null, 2) : String(field.value ?? "");
  control.value = initial;
  label.append(control);
  const reset = h("input", { type: "checkbox" });
  const row = h("div.settings-field", { dataset: { field: field.key } }, label,
    field.summary ? h("p", null, field.summary) : null,
    h("small", null, t("settings.current") + ": " + (field.value === "" ? t("settings.inherit") : format(field.value)) +
      (field.source ? " · " + t("settings.source." + field.source, field.source) : "") +
      (Object.hasOwn(field, "defaultValue") ? " · " + t("settings.default") + ": " + format(field.defaultValue) : "")),
    field.takesEffect ? h("small", null, field.takesEffect) : null,
    field.reset ? h("label.settings-reset", null, reset, t("settings.reset")) : null);
  let unavailable = false;
  function mark() {
    control.disabled = state.readOnly || reset.checked || unavailable;
    state.dirty = state.editors.some(e => e.changed());
    state.profileApplication?.invalidate();
    markDirty("server", groups.some(g => g.dirty && !isAgentGroup(g.meta)));
    markDirty("agents", groups.some(g => g.dirty && isAgentGroup(g.meta)));
    state.save.disabled = state.readOnly || !state.dirty || state.pending || state.capabilityPending || state.unknown;
    if (!state.unknown && !state.pending) state.receipt.textContent = state.dirty ? t("settings.unsaved") : "";
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
    change: () => reset.checked || (["model", "effort"].includes(field.key) && field.reset && control.value === "")
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
function roleProfileApplication(state, group) {
  let epoch = 0, preview = null, loading = false;
  const generation = state.renderGeneration;
  const select = h("select", { dataset: { profileAction: "select" } },
    h("option", { value: "" }, t("settings.profileChoose")),
    group.profiles.map(profile => h("option", { value: profile.id, disabled: !profile.available },
      profile.id + (profile.available ? "" : " · " + (profile.reason || t("settings.profileUnavailable"))))));
  select.value = "";
  const info = h("p.settings-receipt", { role: "status", "aria-live": "polite" });
  const result = h("div.settings-profile-preview", { dataset: { profileAction: "preview" } });
  const acknowledge = h("input", { type: "checkbox", dataset: { profileAction: "acknowledge" } });
  const confirm = h("button.btn.btn-primary", { type: "button", disabled: true, dataset: { profileAction: "confirm" } }, t("settings.profileApply"));
  const reread = h("button.btn", { type: "button", disabled: true }, t("settings.profilePreview"));
  const blocked = () => state.dirty || state.pending || state.unknown || state.capabilityPending;
  function sync() {
    select.disabled = !!blocked();
    reread.disabled = !!blocked() || loading || !select.value;
    confirm.disabled = state.readOnly || !!blocked() || loading || !preview;
    acknowledge.disabled = state.readOnly || !!blocked() || !preview;
  }
  function invalidate() {
    epoch++; preview = null; loading = false;
    result.replaceChildren();
    info.textContent = state.unknown ? t("settings.unknown") : t("settings.profilePreviewInvalid");
    sync();
  }
  async function read() {
    const current = ++epoch;
    preview = null; result.replaceChildren(); acknowledge.checked = false;
    const profileId = select.value;
    if (blocked() || !group.profiles.some(profile => profile.id === profileId && profile.available)) {
      loading = false; info.textContent = blocked() ? t("settings.profileDraftBlocked") : ""; sync(); return;
    }
    const baseline = state.group;
    loading = true; info.textContent = t("settings.profileLoading"); sync();
    // Changing the selection is allowed while a read is in flight.
    select.disabled = false;
    try {
      const value = await requestJson("/api/settings/profile?" + new URLSearchParams({ id: group.id, profileId }));
      if (current !== epoch || state.renderGeneration !== generation || baseline !== state.group || blocked()) return;
      if (value.id !== group.id || value.profileId !== profileId) throw Error(t("settings.profilePreviewInvalid"));
      preview = value;
      result.replaceChildren(h("h4", null, t("settings.profileDifference") + " · " + profileId),
        h("p", null, value.notice),
        h("div.settings-profile-diff-scroll", null, h("table.settings-profile-diff", null,
          h("thead", null, h("tr", null, ["settings.profileField", "settings.profileBefore", "settings.profileAfter"]
            .map(label => h("th", { scope: "col" }, t(label))))),
          h("tbody", null, value.changes.map(change => h("tr", null,
            h("th", { scope: "row" }, t("settings.field." + change.key, change.key)),
            h("td", null, h("pre", null, format(change.before) ?? "—")),
            h("td", null, h("pre", null, format(change.after) ?? "—"))))))));
      info.textContent = state.readOnly ? t("settings.profileReadOnly") : t("settings.profileConfirmHelp");
    } catch (error) {
      if (current === epoch && state.renderGeneration === generation) info.textContent = error.message;
    } finally {
      if (current === epoch && state.renderGeneration === generation) { loading = false; sync(); }
    }
  }
  select.addEventListener("change", read); reread.addEventListener("click", read);
  confirm.addEventListener("click", async () => {
    if (state.readOnly || blocked() || loading || !preview || state.renderGeneration !== generation) return;
    const confirmed = preview;
    const acknowledged = acknowledge.checked;
    state.pending = true; epoch++; loading = false; sync(); state.save.disabled = true;
    const controls = [...state.content.querySelectorAll("input,select,textarea,button")];
    const disabled = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    try {
      const saved = await submitMutation("settings/" + group.id, "/api/settings/profile", {
        id: group.id, profileId: confirmed.profileId, revision: confirmed.revision, acknowledgeLive: acknowledged
      });
      renderGroup(state, saved.group);
      state.receipt.textContent = t("settings.profileApplied") + "\n" + saved.output + "\n" + saved.adoption + "\n" + saved.refresh;
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
  state.profileApplication = { invalidate, sync };
  sync();
  return h("section.settings-profile-apply", null,
    h("h3", null, t("settings.profileApplyTitle")), h("p", null, t("settings.profileCopyHelp")),
    h("div.settings-profile-picker", null, h("label.field", null, h("span", null, t("settings.profileChoose")), select), reread),
    group.profiles.length ? null : h("p", null, t("settings.profileEmpty")),
    ...group.profiles.filter(profile => !profile.available).map(profile =>
      h("p.faint", null, profile.id + " · " + (profile.reason || t("settings.profileUnavailable")))),
    result, info, h("label.settings-reset", null, acknowledge, t("settings.acknowledge")),
    h("div.settings-actions", null, confirm));
}

function renderGroup(state, group) {
  const generation = state.renderGeneration = (state.renderGeneration || 0) + 1;
  state.loadError = null;
  state.group = group; state.editors = []; state.dirty = false; state.unknown = false;
  state.readOnly = !!(settingsReadOnly || group.readOnly);
  state.capabilityPending = false;
  state.profileApplication = null;
  markDirty("server", groups.some(g => g.dirty && !isAgentGroup(g.meta)));
  markDirty("agents", groups.some(g => g.dirty && isAgentGroup(g.meta)));
  const form = h("form.settings-stack");
  const receipt = h("p.settings-receipt", { role: "status", "aria-live": "polite" });
  const save = h("button.btn.btn-primary", { type: "submit", disabled: true, "data-i18n": "settings.save" }, t("settings.save"));
  state.save = save; state.receipt = receipt;
  form.append(h("p", null, group.notice));
  if (group.provenance) form.append(h("p.models-note", null,
    group.provenance.label + " · " + group.provenance.capturedAt));
  if (state.readOnly) form.append(h("p.faint", null, t("settings.snapshotReadOnly")));
  const native = group.observation?.native;
  renderGroupSummary(state);
  if (native) {
    const rows = [
      ["settings.nativeModel", native.model],
      ["settings.nativeEffort", native.effort],
      ["settings.nativeProvider", native.provider],
      ["settings.nativeFile", native.sourceFile]
    ].filter(([, value]) => value !== undefined && value !== null && value !== "");
    form.append(h("section.models-native-config", null, h("h3", null, t("settings.nativeConfiguration")),
      h("p", null, t("settings.nativeIndependent")),
      h("dl.models-balances", null, rows.map(([key, value]) => h("div", null, h("dt", null, t(key)), h("dd", null, String(value))))),
      native.models?.length ? h("details", null, h("summary", null, t("settings.nativeModels") + " · " + native.models.length),
        h("p.faint", null, (native.catalogSource || "") + (native.catalogFetchedAt ? " · " + native.catalogFetchedAt : "")),
        h("ul", null, native.models.map(model => h("li", null,
        typeof model === "string" ? model : (model.label || model.name || model.id || model.value),
        typeof model === "object" && model.efforts?.length ? " · " + model.efforts.map(e => typeof e === "string" ? e : e.label || e.value).join(", ") : "")))) : h("p.faint", null, t("settings.nativeModelsUnknown"))));
  }
  const isRole = group.id.startsWith("role/");
  if (isRole) form.append(h("p", null, "Agent: " + group.agentId + " · " + t("settings.roleScope")));
  const advanced = h("details", { open: !!search.value.trim() }, h("summary", null, t("settings.advancedFields")));
  const common = h("div.settings-grid");
  group.fields.forEach(field => {
    const item = editor(field, group, state);
    state.editors.push(item);
    if (isRole) (["activeAgentId", "model", "effort"].includes(field.key) ? common : advanced).append(item.row);
    else if (group.id.startsWith("agent/")) advanced.append(item.row);
    else form.append(item.row);
  });
  if (isRole) form.append(common, advanced);
  else if (group.id.startsWith("agent/")) form.append(advanced);
  const acknowledge = h("input", { type: "checkbox" });
  if (group.id.startsWith("role/") || group.id.startsWith("agent/")) form.append(h("label.settings-reset", null,
    acknowledge, t("settings.acknowledge")));
  const compare = h("button.btn", { type: "button", "data-i18n": "settings.compare" }, t("settings.compare"));
  compare.addEventListener("click", async () => {
    compare.disabled = true;
    try {
      const current = await requestJson("/api/settings/group?" + new URLSearchParams({ id: group.id }));
      const values = h("div.settings-observation", null,
        h("p", null, current.notice),
        current.fields.map(field => h("p", null,
          t("settings.field." + field.key, field.label) + ": " +
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
      state.content.append(values, adopt);
    } catch (error) { receipt.textContent = error.message; }
    finally { compare.disabled = false; }
  });
  form.append(h("div.settings-actions", null, save, compare), receipt);
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
    // Keep controls frozen during one submission. Failed saves keep all drafts.
    const controls = [...form.querySelectorAll("input,select,textarea,button")];
    const disabled = controls.map(c => c.disabled);
    controls.forEach(c => { c.disabled = true; });
    try {
      const result = await submitMutation("settings/" + group.id, "/api/settings/group", {
        id: group.id, revision: state.group.revision, changes, acknowledgeLive: acknowledge.checked
      });
      renderGroup(state, result.group);
      state.receipt.textContent = t("settings.saved") + "\n" + result.output + "\n" + result.adoption + "\n" + result.refresh;
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
  if (group.observation) form.append(h("details", null, h("summary", null, t("settings.observation")),
    h("pre.settings-observation", null, JSON.stringify(group.observation, null, 2))));
  if (group.agentId) {
    const info = h("p", { role: "status" }, t("settings.notQueried"));
    const query = h("button.btn", { type: "button" }, t("settings.queryCapabilities"));
    const refresh = h("button.btn", { type: "button", disabled: state.readOnly }, t("settings.refreshCapabilities"));
    const output = h("div");
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
          h("details", null, h("summary", null, t("settings.capabilityDetails")),
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
    query.addEventListener("click", () => load(false)); refresh.addEventListener("click", () => load(true));
    const capabilities = h("div", null, h("div.settings-actions", null, query, refresh), info, output);
    if (isRole) common.before(capabilities);
    else form.append(capabilities);
  }
  if (state.readOnly) form.querySelectorAll("input,select,textarea").forEach(control => { control.disabled = true; });
  const inspectorLeading = [];
  if (isRole && Array.isArray(group.profiles)) inspectorLeading.push(roleProfileApplication(state, group));
  if (state.meta && isAgentGroup(state.meta)) {
    form.classList.add("agent-inspector-form");
    inspectorLeading.unshift(inspectorHeader(state));
  }
  state.content.replaceChildren(...inspectorLeading, form);
  state.form = form;
}
function inspectorHeader(state) {
  const area = groupArea(state.meta);
  const close = h("button.icon-btn", { type: "button", "aria-label": t("settings.closeInspector"), title: t("settings.closeInspector"),
    onclick: () => { state.selected = false; agentInspector.replaceChildren(); filterGroups(); renderAgentIndex(); } }, "×");
  const relation = area === "roles" && state.group?.agentId ? t("settings.inspectorRoleRelation").replace("{agent}", state.group.agentId)
    : area === "profiles" ? t("settings.inspectorProfileRelation") : t("settings.inspectorAgentRelation");
  return h("header.agent-inspector-head", null,
    h("div.agent-inspector-identity", null,
      h("span.agent-index-icon.tone-" + (area === "agents" ? "info" : area === "roles" ? "accent" : "idle"), null,
        h("span", null, area === "agents" ? "A" : area === "roles" ? "R" : "P")),
      h("div", null, h("p.kicker", null, accessLabel(area)), h("h2", null, state.meta.title),
        h("code.id", null, state.meta.id), h("p.agent-inspector-relation", null, relation))),
    close);
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
    if (section === "agents") renderAgentIndex();
  } catch (error) {
    state.loadError = error.message;
    renderGroupSummary(state);
    state.content.replaceChildren(h("p.settings-error", null, error.message),
      h("button.btn", { type: "button", onclick: () => loadGroup(state) }, t("settings.retry")));
  } finally { state.loading = false; }
}
search.addEventListener("input", () => {
  searchGeneration++;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => start(), 200);
});
async function start(cursor) {
  const generation = ++searchGeneration;
  const query = search.value.trim();
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
      groups.push(state); groupAreas[area].list.append(root);
      renderGroupSummary(state);
      root.addEventListener("toggle", () => { if (root.open) void loadGroup(state); });
      if (root.open) void loadGroup(state);
    });
    filterGroups();
    status.textContent = data.provenance ? data.provenance.label + " · " + data.provenance.capturedAt
      : data.total ? t(section === "agents" ? "settings.agentGroupsHelp" : "settings.serverGroupsHelp") : t("settings.noMatches");
    more.hidden = !data.nextCursor;
    more.onclick = () => start(data.nextCursor);
  } catch (error) { status.textContent = error.message; }
  finally { if (generation === searchGeneration) more.disabled = false; }
}
i18n.subscribe(() => {
  more.textContent = t("settings.more");
  renderAreaTitles();
  groups.forEach(renderGroupSummary);
});
void start();
`;
