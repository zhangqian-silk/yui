export const SETTINGS_SCRIPT = String.raw`
import { h } from "/assets/js/lib/dom.js";
import { requestJson, submitMutation } from "/assets/js/lib/api.js";
import { createI18n } from "/assets/js/lib/i18n.js";
import { createThemeController } from "/assets/js/lib/theme.js";
import { clearPreference, readPreference, readSessionAccessMode, writeSessionAccessMode } from "/assets/js/lib/prefs.js";

const $ = selector => document.querySelector(selector);
const i18n = createI18n($("#locale-select"));
const t = i18n.t;
const theme = createThemeController($("#theme-options"), t);
i18n.subscribe(() => theme.render());
const access = $("#access-mode");
access.value = readSessionAccessMode();
access.addEventListener("change", () => {
  $("#browser-receipt").textContent = writeSessionAccessMode(access.value) ? t("settings.browserSaved") : t("settings.storageFailed");
});
$("#reset-layout").addEventListener("click", () => {
  const keys = ["yui.sidebar.width", "yui.dock.width", "yui.dock.side", "yui.dock.open"];
  keys.forEach(clearPreference);
  $("#browser-receipt").textContent = keys.every(k => readPreference(k, null) === null) ? t("settings.layoutReset") : t("settings.storageFailed");
});

const container = $("#settings-groups");
const status = $("#settings-status");
const search = $("#settings-search");
const groups = [];
let searchGeneration = 0;
let searchTimer;
const more = h("button.btn", { type: "button", hidden: true }, t("settings.more"));
container.after(more);
window.addEventListener("beforeunload", event => {
  if (!groups.some(g => g.dirty)) return;
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
  const label = h("label.field", null, h("span", null, field.label));
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
    h("small", null, t("settings.current") + ": " + format(field.value) +
      (field.source ? " · " + field.source : "") +
      (Object.hasOwn(field, "defaultValue") ? " · " + t("settings.default") + ": " + format(field.defaultValue) : "")),
    field.takesEffect ? h("small", null, field.takesEffect) : null,
    field.reset ? h("label.settings-reset", null, reset, t("settings.reset")) : null);
  function mark() {
    control.disabled = reset.checked;
    state.dirty = state.editors.some(e => e.changed());
    state.save.disabled = !state.dirty || state.pending || state.unknown;
    state.receipt.textContent = state.dirty ? t("settings.unsaved") : "";
  }
  control.addEventListener("input", mark);
  control.addEventListener("change", mark);
  reset.addEventListener("change", mark);
  return { row, control, field, changed: () => reset.checked || control.value !== initial,
    change: () => reset.checked ? { key: field.key, reset: true } : { key: field.key, value: inputValue(field, control) } };
}

function renderGroup(state, group) {
  state.group = group; state.editors = []; state.dirty = false; state.unknown = false;
  const form = h("form.settings-stack");
  const receipt = h("p.settings-receipt", { role: "status", "aria-live": "polite" });
  const save = h("button.btn.btn-primary", { type: "submit", disabled: true }, t("settings.save"));
  state.save = save; state.receipt = receipt;
  form.append(h("p", null, group.notice));
  group.fields.forEach(field => {
    const item = editor(field, group, state);
    state.editors.push(item); form.append(item.row);
  });
  const acknowledge = h("input", { type: "checkbox" });
  if (group.id.startsWith("role/") || group.id.startsWith("agent/")) form.append(h("label.settings-reset", null,
    acknowledge, t("settings.acknowledge")));
  const compare = h("button.btn", { type: "button" }, t("settings.compare"));
  compare.addEventListener("click", async () => {
    compare.disabled = true;
    try {
      const current = await requestJson("/api/settings/group?" + new URLSearchParams({ id: group.id }));
      const values = h("pre.settings-observation", null, JSON.stringify(current, null, 2));
      const adopt = h("button.btn", { type: "button", disabled: state.unknown }, t("settings.useBaseline"));
      adopt.addEventListener("click", () => {
        state.group = current;
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
    if (state.pending || state.unknown) return;
    let changes;
    try { changes = state.editors.filter(e => e.changed()).map(e => e.change()); }
    catch (error) { receipt.textContent = error.message; receipt.classList.add("settings-error"); return; }
    if (!changes.length) return;
    state.pending = true; save.disabled = true;
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
      state.save.disabled = !state.dirty || state.unknown;
    }
  });
  if (group.observation) form.append(h("details", null, h("summary", null, t("settings.observation")),
    h("pre.settings-observation", null, JSON.stringify(group.observation, null, 2))));
  if (group.agentId) {
    const info = h("p", { role: "status" }, t("settings.notQueried"));
    const query = h("button.btn", { type: "button" }, t("settings.queryCapabilities"));
    const refresh = h("button.btn", { type: "button" }, t("settings.refreshCapabilities"));
    const output = h("div");
    async function load(force) {
      query.disabled = refresh.disabled = true; info.textContent = t("settings.querying");
      try {
        const result = await requestJson("/api/settings/capabilities?" + new URLSearchParams({ id: group.id, refresh: String(force) }));
        info.textContent = result.source + " · " + (result.fetchedAt || result.attemptedAt) +
          (result.failure ? " · " + result.failure.code + ": " + result.failure.message : "");
        // Preserve query/cache/fallback, field availability and warnings verbatim.
        output.replaceChildren(h("pre.settings-observation", null, JSON.stringify(result.catalog, null, 2)));
        const model = state.editors.find(e => e.field.key === "model");
        if (model && model.control.tagName === "INPUT") {
          const list = h("datalist", { id: "models-" + group.id.replace(/\W/g, "-") },
            result.catalog.models.map(m => h("option", { value: m.value }, m.label)));
          model.control.setAttribute("list", list.id); output.append(list);
        }
      } catch (error) { info.textContent = t("settings.queryFailed") + ": " + error.message; }
      finally { query.disabled = refresh.disabled = false; }
    }
    query.addEventListener("click", () => load(false)); refresh.addEventListener("click", () => load(true));
    form.append(h("div.settings-actions", null, query, refresh), info, output);
  }
  state.content.replaceChildren(form);
}

async function loadGroup(state) {
  if (state.loaded || state.loading) return;
  state.loading = true;
  state.content.textContent = t("settings.loading");
  try {
    renderGroup(state, await requestJson("/api/settings/group?" + new URLSearchParams({ id: state.meta.id })));
    state.loaded = true;
  } catch (error) {
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
    if (!cursor) groups.forEach(state => { state.root.hidden = true; });
    data.groups.forEach(meta => {
      const existing = groups.find(g => g.meta.id === meta.id);
      if (existing) {
        existing.root.hidden = false;
        if (query) { existing.root.open = true; void loadGroup(existing); }
        return;
      }
      const content = h("div");
      const root = h("details.settings-card", { open: !meta.advanced || !!query },
        h("summary", null, t("settings.section." + meta.section, meta.section) + " · " + meta.title), content);
      const state = { meta, root, content, dirty: false, loaded: false, loading: false };
      groups.push(state); container.append(root);
      root.addEventListener("toggle", () => { if (root.open) void loadGroup(state); });
      if (!meta.advanced || query) void loadGroup(state);
    });
    status.textContent = data.total ? String(data.total) + " " + t("settings.groups") : t("settings.noMatches");
    more.hidden = !data.nextCursor;
    more.onclick = () => start(data.nextCursor);
  } catch (error) { status.textContent = error.message; }
  finally { if (generation === searchGeneration) more.disabled = false; }
}
void start();
`;
