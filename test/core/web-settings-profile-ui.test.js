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
  vm.runInContext(SETTINGS_SCRIPT.replace(/^import .*;\n/gm, "").replace("void start();", ""), context);
  const state = { content: h("div"), pending: false };
  context.renderGroup(state, role());
  return { context, state, reads, writes };
}
const walk = node => typeof node === "object" && node ? [node, ...node.children.flatMap(walk)] : [];
const text = node => typeof node === "object" && node ? [node.textContent || "", ...node.children.map(text)].join(" ") : String(node);
const control = (state, key) => walk(state.content).find(node => node.dataset.profileAction === key);
const preview = profileId => ({ id: "role/worker", profileId, revision: "composite-" + profileId, agentId: "other",
  changes: [{ key: "model", before: "current", after: "new" }], notice: "Copies once" });
const role = () => ({ id: "role/worker", revision: "role-rev", agentId: "fixture",
  fields: [{ key: "model", label: "Model", kind: "text", value: "current" }],
  profiles: [{ id: "reader", available: true }, { id: "writer", available: true },
    { id: "broken", available: false, reason: "Agent missing" }] });

test("Role Profile application previews a single snapshot and shares guarded settings mutation identity", async () => {
  const { state, context, reads, writes } = mount();
  const select = control(state, "select");
  assert.ok(select, "the Role exposes one template selector");
  assert.equal(select.value, "");
  assert.equal(select.children.find(option => option.value === "broken").disabled, true);
  assert.match(text(state.content), /Agent missing/);
  select.value = "reader";
  await select.handlers.change();
  assert.equal(reads.length, 1);
  assert.equal(writes.length, 0, "choosing a template is read-only");
  assert.match(text(control(state, "preview")), /current.*new/);
  assert.equal(control(state, "confirm").disabled, false);
  control(state, "acknowledge").checked = true;
  let finish;
  context.submitMutation = (...args) => { writes.push(args); return new Promise(resolve => { finish = resolve; }); };
  const applying = control(state, "confirm").handlers.click();
  assert.equal(select.disabled, true);
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
  assert.equal(control(state, "select").value, "", "success resets the selector instead of implying a durable binding");

  context.renderGroup(state, { ...role(), readOnly: true });
  assert.equal(control(state, "select").disabled, false, "snapshot preview remains available outside disabled field controls");
  control(state, "select").value = "reader";
  await control(state, "select").handlers.change();
  assert.equal(control(state, "confirm").disabled, true);
  await control(state, "confirm").handlers.click();
  assert.equal(writes.length, 1, "readonly never posts");
});

test("Profile previews fence stale selection, draft edits and unknown outcomes without losing user intent", async () => {
  const { state, context } = mount();
  const pending = [];
  context.requestJson = () => new Promise(resolve => pending.push(resolve));
  const select = control(state, "select");
  select.value = "reader"; const first = select.handlers.change();
  select.value = "writer"; const second = select.handlers.change();
  pending[1](preview("writer")); await second;
  pending[0](preview("reader")); await first;
  assert.match(text(control(state, "preview")), /writer/);
  assert.doesNotMatch(text(control(state, "preview")), /reader/);
  select.value = "reader"; const late = select.handlers.change();
  const draft = state.editors[0].control;
  draft.value = "draft"; draft.handlers.input();
  pending[2](preview("reader")); await late;
  assert.equal(control(state, "confirm").disabled, true);
  assert.equal(draft.value, "draft");
  assert.equal(state.dirty, true);
  context.renderGroup(state, role());
  context.requestJson = async () => preview("reader");
  control(state, "select").value = "reader"; await control(state, "select").handlers.change();
  context.submitMutation = async () => { throw Object.assign(Error("Configuration changed"), { disposition: "not-submitted" }); };
  await control(state, "confirm").handlers.click();
  assert.equal(state.unknown, false);
  assert.equal(control(state, "select").value, "reader", "a proven rejection retains the selection");
  assert.equal(control(state, "confirm").disabled, true, "rejected application requires a fresh preview");
  await control(state, "select").handlers.change();
  let count = 0;
  context.submitMutation = async () => { count++; throw Object.assign(Error("Lost response"), { disposition: "unknown" }); };
  await control(state, "confirm").handlers.click();
  assert.equal(state.unknown, true);
  assert.equal(control(state, "select").value, "reader");
  assert.match(text(state.content), /Lost response/);
  await control(state, "confirm").handlers.click();
  assert.equal(count, 1, "unknown writes must not replay");
});
