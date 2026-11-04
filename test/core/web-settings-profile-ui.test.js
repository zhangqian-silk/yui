import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { SETTINGS_SCRIPT } from "../../dist/web/assets/client/app/settings.js";

function mount() {
  function h(spec, attrs, ...children) {
    const node = { tagName: spec.split(".")[0].toUpperCase(), children: [], handlers: {}, dataset: {},
      value: "", checked: false, disabled: false, classList: { add() {} },
      append(...items) { for (const child of items.flat(Infinity).filter(item => item != null)) {
        if (typeof child === "object") child.parent = this;
        this.children.push(child);
      } },
      replaceChildren(...items) { this.children = []; this.append(...items); },
      addEventListener(name, fn) { const old = this.handlers[name]; this.handlers[name] = old ? event => { old(event); return fn(event); } : fn; },
      after() {}, before() {}, remove() {}, focus() {},
      querySelectorAll(selector) { const tags = selector.toUpperCase().split(","); return walk(this).slice(1).filter(item => tags.includes(item.tagName)); }
    };
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node[key] = value;
    }
    node.append(...children);
    return node;
  }
  const elements = new Map();
  const reads = [], writes = [];
  const context = vm.createContext({ h, URLSearchParams,
    document: { querySelector: key => { if (!elements.has(key)) elements.set(key, h("div")); return elements.get(key); }, querySelectorAll: () => [] },
    window: { location: { search: "?section=agents" }, addEventListener() {} },
    i18n: { t: key => key, subscribe() {} }, pageSections: () => ["agents", "server"],
    createManageShell: () => ({ set() {}, setDirty() {} }), registerManagePage() {}, navigateManage() {},
    createThemeController: () => ({}), mountSkills() {}, readSessionAccessMode: () => "native",
    requestJson: async url => { reads.push(url); return preview(new URL(url, "http://fixture").searchParams.get("profileId")); },
    submitMutation: async (...args) => { writes.push(args); return { group: role(), output: "Applied", adoption: "Later launch", refresh: "None" }; }
  });
  vm.runInContext(SETTINGS_SCRIPT.replace(/^import .*;\n/gm, "").replace("void start();", "").replace("void loadRoutes();", ""), context);
  const state = { content: h("div"), pending: false };
  context.renderGroup(state, role());
  return { context, state, reads, writes };
}
const walk = node => typeof node === "object" && node ? [node, ...node.children.flatMap(walk)] : [];
const text = node => typeof node === "object" && node ? [node.textContent || "", ...node.children.map(text)].join(" ") : String(node);
const control = (state, key) => walk(state.content).find(node => node.dataset.profileAction === key);
const option = (state, id) => walk(state.content).find(node => node.dataset.profileAction === "option" && node.dataset.profileId === id);
const choose = (state, id) => option(state, id).handlers.click();
const preview = profileId => ({ id: "role/worker", profileId, revision: "composite-" + profileId, agentId: "other",
  changes: [{ key: "model", before: "current", after: "new" }, { key: "systemPrompt", before: "", after: "Inspect " + profileId },
    { key: "skills", before: [], after: null }],
  result: { description: "Template for " + profileId, systemPrompt: "Inspect " + profileId, constraints: ["No writes"] }, notice: "Copies once" });
const role = () => ({ id: "role/worker", revision: "role-rev", agentId: "fixture",
  fields: [{ key: "model", label: "Model", kind: "text", value: "current" }],
  profiles: [{ id: "reader", available: true }, { id: "writer", available: true },
    { id: "broken", available: false, reason: "Agent missing" }] });

test("Role Profile application previews a single snapshot and shares guarded settings mutation identity", async () => {
  const { state, context, reads, writes } = mount();
  assert.ok(control(state, "open"), "the Role exposes one entry that opens the template dialog");
  assert.ok(option(state, "reader") && option(state, "writer"), "each template is one selectable card");
  assert.equal(state.profileApplication.selected(), "");
  assert.equal(option(state, "broken").disabled, true);
  assert.match(text(state.content), /Agent missing/);
  control(state, "open").handlers.click();
  await choose(state, "reader");
  assert.equal(option(state, "reader").dataset.selected, "true");
  assert.equal(reads.length, 1);
  assert.equal(writes.length, 0, "choosing a template is read-only");
  assert.match(text(control(state, "preview")), /current.*new/);
  assert.match(text(control(state, "preview")), /settings.profileCopyHelp/,
    "the localized one-time-copy contract replaces backend English prose in the preview");
  assert.doesNotMatch(text(control(state, "preview")), /Copies once/);
  const previewText = text(control(state, "preview"));
  for (const expected of [/settings.field.description.*Template for reader/, /settings.field.systemPrompt.*access.profileWillChange.*Inspect reader/, /settings.field.constraints.*No writes/])
    assert.match(previewText, expected, "description, instructions and constraints are previewed as the Role will read them");
  assert.doesNotMatch(previewText, /\bnull\b|settings.field.skills/, "no stray null and no empty-to-empty change");
  const compare = walk(control(state, "preview")).find(node => node.dataset?.compare === "systemPrompt");
  assert.ok(compare, "changed instructions open a before/after comparison");
  const shown = compare.handlers.click();
  assert.match(text(shown), /settings.profileBefore.*settings.profileAfter.*Inspect reader/, "the comparison shows current and applied text side by side");
  assert.equal(control(state, "confirm").disabled, false);
  control(state, "acknowledge").checked = true;
  let finish;
  context.submitMutation = (...args) => { writes.push(args); return new Promise(resolve => { finish = resolve; }); };
  const applying = control(state, "confirm").handlers.click();
  assert.equal(option(state, "writer").disabled, true);
  assert.equal(state.editors[0].control.disabled, true, "both profile and ordinary editors are frozen during application");
  await control(state, "confirm").handlers.click();
  assert.equal(writes.length, 1, "an in-flight application cannot be duplicated");
  finish({ group: role(), output: "Applied", adoption: "Later launch", refresh: "None" });
  await applying;
  assert.equal(writes[0][0], "settings/role/worker");
  assert.equal(writes[0][1], "/api/settings/profile");
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0][2])), {
    id: "role/worker", profileId: "reader", revision: "composite-reader", acknowledgeLive: true
  });
  assert.equal(state.profileApplication.selected(), "", "success resets the choice instead of implying a durable binding");

  context.renderGroup(state, { ...role(), readOnly: true });
  assert.equal(option(state, "reader").disabled, false, "snapshot preview remains available outside disabled field controls");
  await choose(state, "reader");
  assert.equal(control(state, "confirm").disabled, true);
  await control(state, "confirm").handlers.click();
  assert.equal(writes.length, 1, "readonly never posts");
});

test("Profile previews fence stale selection, draft edits and unknown outcomes without losing user intent", async () => {
  const { state, context } = mount();
  const pending = [];
  context.requestJson = () => new Promise(resolve => pending.push(resolve));
  const first = choose(state, "reader");
  const second = choose(state, "writer");
  pending[1](preview("writer")); await second;
  pending[0](preview("reader")); await first;
  assert.equal(control(state, "preview").dataset.profileId, "writer", "a stale earlier preview never replaces the latest choice");
  const late = choose(state, "reader");
  const draft = state.editors[0].control;
  draft.value = "draft"; draft.handlers.input();
  pending[2](preview("reader")); await late;
  assert.equal(control(state, "confirm").disabled, true);
  assert.equal(draft.value, "draft");
  assert.equal(state.dirty, true);
  context.renderGroup(state, role());
  context.requestJson = async () => preview("reader");
  await choose(state, "reader");
  context.submitMutation = async () => { throw Object.assign(Error("Configuration changed"), { disposition: "not-submitted" }); };
  await control(state, "confirm").handlers.click();
  assert.equal(state.unknown, false);
  assert.equal(state.profileApplication.selected(), "reader", "a proven rejection retains the selection");
  assert.equal(control(state, "confirm").disabled, true, "rejected application requires a fresh preview");
  await choose(state, "reader");
  let count = 0;
  context.submitMutation = async () => { count++; throw Object.assign(Error("Lost response"), { disposition: "unknown" }); };
  await control(state, "confirm").handlers.click();
  assert.equal(state.unknown, true);
  assert.equal(state.profileApplication.selected(), "reader");
  assert.match(text(state.content), /Lost response/);
  await control(state, "confirm").handlers.click();
  assert.equal(count, 1, "unknown writes must not replay");
});

test("execution configs show the model a new Session launches with, using the launch precedence", async () => {
  const groups = {
    "role/routed": { id: "role/routed", revision: "a", agentId: "codex",
      fields: [{ key: "model", label: "Model", kind: "text", value: "saved-model" }, { key: "effort", label: "Effort", kind: "text", value: "high" }] },
    "role/plain": { id: "role/plain", revision: "b", agentId: "claude",
      fields: [{ key: "model", label: "Model", kind: "text", value: "" }, { key: "effort", label: "Effort", kind: "text", value: "" }] },
    "agent/codex": { id: "agent/codex", revision: "c", agentId: "codex", fields: [],
      observation: { adapterId: "codex", native: { status: "read", model: "codex-native", effort: "medium" } } },
    "agent/claude": { id: "agent/claude", revision: "d", agentId: "claude", fields: [],
      observation: { adapterId: "claude", native: { status: "read", model: "claude-native", effort: "xhigh" } } }
  };
  const meta = Object.keys(groups).map(id => ({ id, title: id.split("/")[1], section: id.split("/")[0] + "s" }));
  function h(spec, attrs, ...children) {
    const node = { tagName: spec.split(".")[0].toUpperCase(), children: [], handlers: {}, dataset: {},
      value: "", disabled: false, classList: { add() {} },
      append(...items) { for (const child of items.flat(Infinity).filter(item => item != null)) {
        if (typeof child === "object") child.parent = this;
        this.children.push(child);
      } },
      replaceChildren(...items) { this.children = []; this.append(...items); },
      addEventListener(name, fn) { this.handlers[name] = fn; }, focus() {}, remove() {},
      querySelectorAll(selector) { const tags = selector.toUpperCase().split(","); return walk(this).slice(1).filter(item => tags.includes(item.tagName)); }
    };
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else node[key] = value;
    }
    node.append(...children);
    return node;
  }
  const elements = new Map();
  const panels = ["roles", "agents"].map(section => ({ hidden: false, dataset: { section } }));
  const context = vm.createContext({ h, URLSearchParams,
    document: { querySelector: key => { if (!elements.has(key)) elements.set(key, h("div")); return elements.get(key); }, querySelectorAll: () => panels },
    window: { location: { search: "?section=roles" }, addEventListener() {} },
    i18n: { t: key => key, subscribe() {} }, pageSections: () => ["roles", "agents", "server"],
    createManageShell: () => ({ set() {}, setDirty() {} }), registerManagePage() {}, navigateManage() {},
    createThemeController: () => ({}), mountSkills() {}, readSessionAccessMode: () => "native",
    requestJson: async url => {
      if (url === "/api/models") return { registry: { modules: [], endpoints: [{ id: "gateway", moduleId: null, protocol: "responses" }],
        bindings: [{ agentId: "codex", adapterId: "codex", endpointId: "gateway", model: "routed-model", scope: "yui-new-session" }] } };
      if (url.startsWith("/api/settings/group?")) return groups[new URL(url, "http://fixture").searchParams.get("id")];
      return { groups: meta, total: meta.length, supportedAgents: [] };
    },
    submitMutation: async () => { throw new Error("no writes"); }
  });
  vm.runInContext(SETTINGS_SCRIPT.replace(/^import .*;\n/gm, "").replace("void start();", "").replace("void loadRoutes();", ""), context);
  await context.start();
  await context.loadRoutes();
  await new Promise(resolve => setTimeout(resolve, 0));
  const index = () => vm.runInContext("agentIndex", context);
  const row = id => walk(index()).find(node => node.dataset?.agentId === id);
  assert.match(text(row("role/routed")), /routed-model.*high/, "an endpoint binding sets the model; the Role keeps its effort");
  assert.match(text(row("role/routed")), /access.source.route/);
  assert.doesNotMatch(text(row("role/routed")), /saved-model/, "a model that will not launch is not presented as current");
  assert.match(text(row("role/plain")), /claude-native.*xhigh/, "an empty Role falls back to its Agent's native default");
  assert.match(text(row("role/plain")), /access.source.native/);
  assert.equal(row("agent/codex"), undefined, "Agents have their own page");
  row("role/routed").handlers.click();
  assert.match(text(vm.runInContext("agentInspector", context)), /access.routeOverrides/,
    "the detail explains that the saved Role model does not apply while the binding exists");
  context.showSection("agents");
  assert.match(text(row("agent/codex")), /gateway/);
  assert.match(text(row("agent/codex")), /routed/, "an Agent row names the Roles that use it");
  assert.equal(vm.runInContext("accessLayout.dataset.detail", context), "closed", "a Role detail does not stay open on the Agents page");
});

test("long execution text is edited one item per line and in a saved-beside-edited editor", () => {
  const { context, state } = mount();
  const constraints = ["No writes", "Ask before real-resource checks"];
  context.renderGroup(state, { id: "role/worker", revision: "r", agentId: "fixture", fields: [
    { key: "systemPrompt", label: "Instructions", kind: "multiline", value: "Inspect first." },
    { key: "constraints", label: "Constraints", kind: "json", value: constraints, reset: true }] });
  const item = key => state.editors.find(editor => editor.field.key === key);
  assert.equal(item("constraints").control.value, constraints.join("\n"), "a list reads one item per line, not as JSON");
  const expand = key => walk(state.content).find(node => node.dataset.textExpand === key);
  const cancelled = expand("constraints").handlers.click();
  const area = walk(cancelled).find(node => node.tagName === "TEXTAREA");
  assert.match(text(cancelled), /settings.text.saved.*No writes.*settings.text.edited/s, "the saved text sits beside the editable one");
  area.value = "Changed";
  walk(cancelled).find(node => node.tagName === "BUTTON" && node.children.includes("models.cancel")).handlers.click();
  assert.equal(item("constraints").changed(), false, "cancel discards the dialog edit");
  const edited = expand("constraints").handlers.click();
  walk(edited).find(node => node.tagName === "TEXTAREA").value = "No writes\n\n  Keep drafts  ";
  walk(edited).find(node => node.tagName === "BUTTON" && node.children.includes("settings.text.done")).handlers.click();
  assert.equal(JSON.stringify(item("constraints").change()), JSON.stringify({ key: "constraints", value: ["No writes", "Keep drafts"] }), "Done writes back a trimmed list");
  item("constraints").control.value = "";
  assert.equal(JSON.stringify(item("constraints").change()), JSON.stringify({ key: "constraints", reset: true }), "an emptied list clears the saved setting");
});
