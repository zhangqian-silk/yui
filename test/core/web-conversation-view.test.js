import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { CONVERSATION_SCRIPT } from "../../dist/web/assets/client/views/dock/conversation.js";
import { SELECTION_SCRIPT } from "../../dist/web/assets/client/app/selection.js";
import { WORKSPACE_SCRIPT } from "../../dist/web/assets/client/layout/workspace.js";
import { PREFS_SCRIPT } from "../../dist/web/assets/client/lib/prefs.js";
import { TERMINAL_SCRIPT } from "../../dist/web/assets/client/views/dock/terminal.js";
import { SESSION_PAGE_SCRIPT } from "../../dist/web/assets/client/views/dock/session.js";

// Exercise the shipped controller with disposable DOM/network boundaries.
function fixture(submitResult = { state: "submitted" }, extra = {}) {
  const elements = [], storage = new Map(), calls = [], mutations = [], taskAnswers = [];
  const preferences = extra.preferences ?? new Map();
  let interval, delayedRead, delayedReceipt, currentSessionId = "thread";
  const h = (spec, attrs, ...children) => {
    const node = { spec, ...attrs, children: children.filter(Boolean), handlers: {}, value: "", scrollTop: 0,
      scrollHeight: 0, clientHeight: 0, textContent: "", hidden: attrs?.hidden ?? false,
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      addEventListener(event, handler) { this.handlers[event] = handler; },
      setAttribute(name, value) { this[name] = String(value); },
      closest() { return null; }, querySelectorAll() { return []; },
      classList: { add() {}, remove() {}, toggle() {} },
      get lastChild() { return this.children.at(-1); },
      focus() { context.document.activeElement = this; },
      contains(node) { const walk = n => n === node || (n.children || []).some(c => typeof c === "object" && walk(c)); return walk(this); },
      // Enough selector support for the controller: tag prefixes and [aria-selected=true].
      querySelector(selector) {
        const match = n => selector === "[aria-selected=true]" ? n["aria-selected"] === "true" : n.spec.startsWith(selector);
        const walk = n => { for (const c of n.children || []) { if (typeof c !== "object") continue; if (match(c)) return c; const f = walk(c); if (f) return f; } return null; };
        return walk(this);
      },
      get options() { return this.children; } };
    node.dataset = { ...attrs?.dataset };
    if (attrs?.value) node.value = attrs.value;
    elements.push(node); return node;
  };
  const host = h("host");
  const context = vm.createContext({
    h, icon: name => h("icon", { name }), clear: n => n.replaceChildren(), richText: (_title, text) => h("prose", null, text),
    localStorage: { getItem: k => preferences.get(k) ?? null,
      setItem: (k, v) => { if (extra.storageUnavailable) throw new Error("storage blocked"); preferences.set(k, v); },
      removeItem: k => preferences.delete(k) },
    api: { answerInput: async (...args) => taskAnswers.push(args) }, releaseMutation() {},
    inputCard: (input, _t, _locale, answer) => h("input-card", { answer: value => answer(input, value, {}) }),
    URLSearchParams, crypto: { randomUUID: () => "request-id" }, document: { hidden: false, activeElement: null },
    formatClock: iso => "clock:" + iso, formatDateTime: iso => "date:" + iso, formatShort: iso => iso ? "short:" + iso : "",
    fill: (template, values) => template + JSON.stringify(values),
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    window: { setInterval: fn => { interval = fn; return 1; }, clearInterval: () => { interval = null; } },
    requestJson: async url => {
      calls.push(url);
      const query = new URL(url, "http://fixture").searchParams;
      if (url.startsWith("/api/conversation/model?")) return extra.catalog ?? { source: "live", catalog: { models: [{ value: "model-new", label: "New" }] } };
      if (query.has("requestId")) {
        if (delayedReceipt) return new Promise(resolve => { delayedReceipt.resolve = resolve; });
        return { state: extra.receiptState ?? "accepted" };
      }
      if (delayedRead) return new Promise(resolve => { delayedRead.resolve = resolve; });
      if (query.has("session")) {
        const tool = [{ id: "tool", turnId: "turn", kind: "activity", text: "npm test" }];
        const older = query.has("cursor");
        const page = { status: "active", observedAt: "now", nextCursor: older && extra.olderItems ? null : "older",
          runConfiguration: typeof extra.runConfiguration === "function" ? extra.runConfiguration(query.get("session")) : extra.runConfiguration,
          nativeRequests: extra.nativeRequests || [],
          items: older ? extra.olderItems ?? tool : extra.items ?? tool };
        // A held page answers only when the test releases it (a late response).
        if (extra.hold?.(query.get("session"))) return new Promise(resolve => { extra.held = () => resolve(page); });
        return page;
      }
      return { currentSessionId, sessions: extra.sessions?.(currentSessionId) ?? [{ nativeSessionId: currentSessionId, current: true,
        status: "active", adapterId: "codex" }, ...(extra.history ?? []).map(id => ({ nativeSessionId: id, current: false,
        status: "ended", adapterId: "codex", createdAt: "2026-01-01T00:00:00.000Z" }))], authority: { owner: "controller" },
        terminalWriter: extra.terminalWriter, leaderQuestions: extra.leaderQuestions,
        turn: extra.idle ? null : { status: extra.turnStatus || "accepted", nativeTurnId: "turn" }, total: 1, nextOffset: null };
    },
    submitMutation: async (...args) => { mutations.push(args); return extra.submit ? extra.submit(...args) : submitResult; }
  });
  vm.runInContext(PREFS_SCRIPT.replace(/^export /gm, ""), context);
  vm.runInContext(CONVERSATION_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const controller = context.createConversationController(host, k => k);
  return { controller, calls, storage, host, elements, mutations, taskAnswers, writes: mutations, preferences, context,
    button: key => elements.find(n => n.spec.startsWith("button")
      && (n.children.includes("conversation." + key) || n["aria-label"] === "conversation." + key)),
    get input() { return elements.find(n => n.spec.startsWith("textarea")); },
    get materialList() { return elements.find(n => n.spec === "div.row-stack"); },
    get materialAlert() { return elements.find(n => n.role === "alert"); },
    // Choose a Session the way a user does: through the picker's option.
    pick: async id => {
      elements.findLast(n => n.spec === "button.cv-session-opt" && n.dataset.session === id).handlers.click();
      await flush();
    },
    text: spec => elements.findLast(n => n.spec === spec)?.textContent,
    replaceCurrent: id => { currentSessionId = id; },
    get feed() { return elements.find(n => n.spec === "div.feed"); },
    tick: async () => { interval?.(); await flush(); },
    delayRead: () => { delayedRead = {}; return delayedRead; },
    finishRead: () => { const pending = delayedRead; delayedRead = null; pending.resolve({}); },
    delayReceipt: () => { delayedReceipt = {}; return delayedReceipt; }
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("unresolved send identity survives a new tab without sharing its private draft", async () => {
  const owner = { scope: "task", taskId: "task-1", roleName: "leader" };
  const first = fixture({}, { idle: true, receiptState: "unknown", submit() { throw Error("lost acknowledgement"); } });
  first.controller.open(owner);
  await flush();
  first.input.value = "One intended input";
  await first.button("send").handlers.click();
  assert.equal(first.button("send").disabled, true);
  first.controller.close();
  const options = { idle: true, receiptState: "unknown", preferences: first.preferences };
  const next = fixture({}, options);
  next.controller.open(owner);
  await flush();
  assert.equal(next.button("send").disabled, true, "closing the old tab must not release uncertain effects");
  assert.ok(next.calls.some(url => url.includes("requestId=request-id")), "inspect the exact original identity");
  assert.equal(next.input.value, "", "unsent drafts remain tab-local");
  assert.equal(next.mutations.length, 0, "opening never replays input");
  const alreadyOpen = fixture({}, { idle: true, receiptState: "unknown", preferences: new Map() });
  alreadyOpen.controller.open(owner);
  await flush();
  for (const [key, value] of first.preferences) alreadyOpen.preferences.set(key, value);
  alreadyOpen.input.value = "Do not resend from an already open tab";
  await alreadyOpen.button("send").handlers.click();
  assert.equal(alreadyOpen.mutations.length, 0, "check shared identity again at the send boundary");
  alreadyOpen.controller.close();
  const other = fixture({}, { idle: true, preferences: first.preferences });
  other.controller.open({ ...owner, taskId: "task-2" });
  await flush();
  assert.equal(!!other.button("send").disabled, false, "unresolved identity is scoped to its exact owner and Thread");
  other.controller.close();
  options.receiptState = "accepted";
  await next.tick();
  assert.equal(!!next.button("send").disabled, false);
  assert.equal([...next.preferences.keys()].some(k => k.endsWith(".pending")), false);
  assert.equal(next.mutations.length, 0);
  next.controller.close();
  const blocked = fixture({}, { idle: true, storageUnavailable: true });
  blocked.controller.open(owner);
  await flush();
  blocked.input.value = "Cannot safely remember request";
  await blocked.button("send").handlers.click();
  assert.equal(blocked.mutations.length, 0, "do not submit if recovery identity cannot be saved");
  blocked.controller.close();
});

test("Slash completion is local and unknown commands require explicit literal submission", async () => {
  const f = fixture();
  f.controller.open({ scope: "global", roleName: "operator" });
  await flush();
  f.input.value = "/he";
  let prevented = false;
  f.input.handlers.keydown({ key: "Tab", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.input.value, "/help");
  f.button("send").handlers.click();
  await flush();
  assert.equal(f.mutations.length, 0, "help is not a model prompt or CLI execution");
  f.input.value = "/exec untrusted";
  f.button("send").handlers.click();
  await flush();
  assert.equal(f.mutations.length, 0);
  assert.equal(f.input.value, "/exec untrusted");
  f.button("literal").handlers.click();
  await flush();
  assert.equal(f.mutations[0][2].body, "/exec untrusted", "explicit literal choice preserves text");
  f.input.value = "/stop";
  f.input.handlers.input();
  const slash = f.elements.find(n => n.spec === "div.conversation-slash");
  assert.equal(slash.children.length, 1);
  const target = f.controller.captureDraftTarget();
  f.controller.insertReference(target, "reference-only\n> history");
  const quoted = "/stop\n\nreference-only\n> history";
  assert.equal(f.input.value, quoted, "a leading Slash draft is preserved");
  assert.equal(slash.children.length, 0, "appending reference text refreshes stale command suggestions");
  assert.equal(f.button("literal").hidden, false);
  assert.equal(f.mutations.length, 1, "inserting a reference never executes /stop");
  f.button("send").handlers.click();
  await flush();
  assert.equal(f.mutations.length, 1, "combined text is not a supported Slash command");
  assert.equal(f.input.value, quoted);
  f.button("literal").handlers.click();
  await flush();
  assert.equal(f.mutations[1][2].body, quoted, "only explicit literal send submits the preserved draft");
  f.controller.close();
});

test("model selection is explicit, survives catalog refresh, and never re-applies the confirmed model", async () => {
  const f = fixture({}, { idle: true, runConfiguration: { status: "observed", observedAt: "2026-10-22",
    axes: [{ category: "model", current: { status: "observed", value: "model-current" } }] },
    catalog: { source: "live", catalog: { models: [{ value: "model-current", label: "Current" }, { value: "model-new", label: "New" }] } } });
  f.controller.open({ scope: "global", roleName: "operator" });
  await flush();
  await f.button("modelsLoad").handlers.click();
  assert.equal(f.button("modelApply").disabled, true);
  const rows = () => f.elements.findLast(n => n.spec === "div.cv-options").children;
  rows()[1].handlers.click();
  assert.equal(f.button("modelApply").disabled, false);
  assert.equal(f.mutations.length, 0, "picking is not an implicit write");
  assert.equal(rows()[1]["aria-selected"], "true");
  await f.button("modelsLoad").handlers.click();
  assert.equal(rows()[1]["aria-selected"], "true", "refresh preserves the user's selection");
  assert.equal(f.text("span.cv-model-label"), "model-current", "selection is not confirmation");
  rows()[0].handlers.click();
  assert.equal(f.button("modelApply").disabled, true);
  f.controller.close();
});

test("model adoption preserves drafts and an unknown effect blocks replay across reopen", async () => {
  for (const disposition of ["not-submitted", "unknown"]) {
    const f = fixture({}, { idle: true, submit() {
      throw Object.assign(new Error("fixture failure"), { disposition });
    } });
    const owner = { scope: "global", roleName: "operator" };
    f.controller.open(owner);
    await flush();
    const target = f.controller.captureDraftTarget();
    f.input.value = "Keep my draft";
    await f.button("modelsLoad").handlers.click();
    const select = f.elements.find(n => n["aria-label"] === "conversation.model");
    select.value = "model-new"; select.handlers.change();
    assert.equal(!!f.button("modelApply").disabled, false);
    await f.button("modelApply").handlers.click();
    assert.equal(f.mutations.length, 1);
    assert.equal(f.input.value, "Keep my draft");
    f.controller.open(owner, { current: true });
    await flush();
    assert.equal(f.input.value, "Keep my draft");
    assert.equal(!!f.button("send").disabled, disposition === "unknown");
    assert.equal([...f.storage.keys()].some(k => k.endsWith(".modelPending")), disposition === "unknown");
    assert.equal(f.mutations.length, 1, "reopening never replays model adoption");
    const pill = f.elements.findLast(n => n.spec === "details.cv-pop.cv-model");
    const state = f.elements.findLast(n => n.spec === "span.cv-model-state");
    assert.equal(pill.dataset.state, disposition === "unknown" ? "pending" : "unknown");
    assert.equal(state.hidden ? "" : state.textContent, disposition === "unknown" ? "conversation.modelStatePending" : "",
      "an unsettled switch reads as applying in visible text");
    if (disposition === "unknown") {
      assert.equal(f.controller.captureDraftTarget(), null);
      assert.throws(() => f.controller.insertReference(target, "history"), /targetChanged/);
      assert.equal(f.input.value, "Keep my draft");
    }
    f.controller.close();
  }
});

test("background polls keep the open model picker stable; an action during a read waits instead of racing", async () => {
  const observed = { status: "observed", observedAt: "2026-10-22T09:00:00Z",
    axes: [{ category: "model", current: { status: "observed", value: "model-current" } }] };
  const extra = { idle: true, runConfiguration: observed,
    catalog: { source: "live", catalog: { models: [{ value: "model-current", label: "Current" }, { value: "model-new", label: "New" }] } } };
  const f = fixture({ runConfiguration: observed }, extra);
  f.controller.open({ scope: "global", roleName: "operator" });
  await flush();
  await f.button("modelsLoad").handlers.click();
  const rows = f.elements.findLast(n => n.spec === "div.cv-options");
  rows.children[1].handlers.click();
  rows.children[1].focus();
  const facts = f.elements.findLast(n => n.spec === "dl.cv-facts.cv-model-facts");
  const before = [...facts.children];
  const surface = () => [...rows.children.map(r => !!r.disabled), !!f.button("modelApply").disabled, !!f.button("send").disabled];
  const stable = surface();
  // Three ordinary poll cycles with unchanged facts, each observed mid-read.
  for (let cycle = 0; cycle < 3; cycle++) {
    extra.hold = () => true;
    await f.tick();
    assert.deepEqual(surface(), stable, "a background read never greys the picker or composer");
    extra.hold = null;
    extra.held();
    await flush();
    assert.deepEqual(surface(), stable);
  }
  assert.deepEqual(facts.children, before, "unchanged facts are not cleared and rebuilt");
  assert.equal(f.context.document.activeElement, rows.children[1], "keyboard focus stays on the option");
  assert.equal(rows.children[1]["aria-selected"], "true", "the selection survives polling");
  // Apply pressed while a read is in flight waits for it, then submits once.
  extra.hold = () => true;
  await f.tick();
  const applied = f.button("modelApply").handlers.click();
  await flush();
  assert.equal(f.mutations.length, 0, "no write overlaps the in-flight read");
  extra.hold = null;
  extra.held();
  await applied;
  assert.equal(f.mutations.length, 1, "the click is not silently dropped");
  assert.equal(f.mutations[0][2].model, "model-new");
  f.controller.close();
});

test("actions waiting for a poll never transfer to a reopened Session or a changed selection", async () => {
  for (const change of ["reopen", "selection", "draft"]) {
    const extra = { idle: true, catalog: { source: "live", catalog: { models: [
      { value: "model-new", label: "New" }, { value: "model-other", label: "Other" }
    ] } } };
    const f = fixture({}, extra);
    const owner = { scope: "global", roleName: "operator" };
    f.controller.open(owner);
    await flush();
    await f.button("modelsLoad").handlers.click();
    const rows = f.elements.findLast(n => n.spec === "div.cv-options");
    rows.children[0].handlers.click();
    f.input.value = "Original draft";
    extra.hold = () => true;
    await f.tick();
    const action = f.button(change === "draft" ? "send" : "modelApply").handlers.click();
    await flush();
    if (change === "reopen") { f.controller.close(); f.controller.open(owner); }
    if (change === "selection") rows.children[1].handlers.click();
    if (change === "draft") f.input.value = "Not submitted";
    extra.hold = null;
    extra.held();
    await action;
    await flush();
    assert.equal(f.mutations.length, 0, change + ": an old click must not submit the new intent");
    f.controller.close();
  }
});

test("only a matching native confirmation closes the model picker; keyboard focus does not select", async () => {
  for (const confirmed of [true, false]) {
    const f = fixture({ runConfiguration: { status: "observed", observedAt: "2026-10-22T09:00:00Z",
      axes: [{ category: "model", current: { status: "observed", value: confirmed ? "model-new" : "other" } }] } }, { idle: true });
    f.controller.open({ scope: "global", roleName: "operator" });
    await flush();
    await f.button("modelsLoad").handlers.click();
    const rows = f.elements.find(n => n.spec === "div.cv-options");
    rows.handlers.keydown({ key: "Home", preventDefault() {} });
    assert.equal(f.context.document.activeElement, rows.children[0]);
    assert.equal(f.button("modelApply").disabled, true, "focus alone is not selection");
    rows.children[0].handlers.click();
    const menu = f.elements.find(n => n.spec === "details.cv-pop.cv-model");
    menu.open = true;
    await f.button("modelApply").handlers.click();
    assert.equal(menu.open, !confirmed);
    assert.equal(f.button("modelApply").disabled, true);
    assert.equal([...f.storage.keys()].some(k => k.endsWith(".modelPending")), !confirmed);
    assert.equal(f.mutations.length, 1);
    f.controller.close();
  }
});

test("history references append to the captured writable draft, never send or cross Sessions", async () => {
  const f = fixture({}, { history: ["historical"] });
  const owner = { scope: "task", taskId: "task-1", roleName: "leader" };
  assert.equal(f.controller.captureDraftTarget(), null);
  f.controller.open(owner);
  await flush();
  const target = f.controller.captureDraftTarget();
  assert.ok(target);
  f.input.value = "Unsent draft";
  f.controller.insertReference(target, "reference-only\n> Source text");
  assert.equal(f.input.value, "Unsent draft\n\nreference-only\n> Source text");
  assert.ok([...f.storage.values()].includes(f.input.value));
  const before = f.input.value;
  f.host.hidden = true;
  assert.equal(f.controller.captureDraftTarget(), null);
  assert.throws(() => f.controller.insertReference(target, "hidden conversation"), /targetChanged/);
  f.host.hidden = false;
  assert.throws(() => f.controller.insertReference(target, "x".repeat(12000)), /capacity/);
  assert.equal(f.input.value, before);
  f.controller.open({ scope: "global", roleName: "operator" });
  await flush();
  assert.throws(() => f.controller.insertReference(target, "wrong owner"), /targetChanged/);
  f.replaceCurrent("replacement");
  f.controller.open(owner, { current: true });
  await flush();
  assert.throws(() => f.controller.insertReference(target, "wrong Session"), /targetChanged/);
  await f.pick("historical");
  assert.equal(f.controller.captureDraftTarget(), null);
  assert.equal(f.mutations.length, 0);
  f.controller.close();
  assert.equal(f.controller.captureDraftTarget(), null);
  for (const extra of [{ terminalWriter: true }, { turnStatus: "submitting" }, { turnStatus: "delivery-unknown" }]) {
    const blocked = fixture({}, extra);
    blocked.controller.open(owner);
    await flush();
    assert.equal(blocked.controller.captureDraftTarget(), null);
    assert.throws(() => blocked.controller.insertReference(target, "history"), /targetChanged/);
    assert.equal(blocked.input.value, "");
    assert.equal(blocked.mutations.length, 0);
    blocked.controller.close();
  }
});

test("a full draft rejects an entire diff pair visibly and admits both versions after space is freed", async () => {
  const f = fixture();
  const owner = { scope: "task", taskId: "task-1", roleName: "leader" };
  const existing = Array.from({ length: 7 }, (_, i) => ({
    taskId: "task-1", relativePath: `note-${i}.md`, commit: "a".repeat(40), digest: "b".repeat(64)
  }));
  const pair = [
    { ...existing[0], relativePath: "result.md", commit: "c".repeat(40) },
    { ...existing[0], relativePath: "result.md", commit: "d".repeat(40) }
  ];
  f.controller.open(owner, { current: true, materials: existing });
  await flush();
  f.input.value = "Please compare both versions";
  f.controller.open(owner, { current: true, materials: pair });
  await flush();
  const key = [...f.storage.keys()].find(k => k.endsWith(".materials"));
  assert.deepEqual(JSON.parse(f.storage.get(key)), existing, "never attach only half the diff pair");
  assert.equal(f.input.value, "Please compare both versions");
  assert.equal(f.materialAlert.textContent, "materials.capacity");
  assert.equal(f.writes.length, 0);
  f.materialList.children[0].children[1].handlers.click();
  f.controller.open(owner, { current: true, materials: pair });
  await flush();
  assert.deepEqual(JSON.parse(f.storage.get(key)), [...existing.slice(1), ...pair]);
  assert.equal(f.materialAlert.textContent, "");
  f.controller.open(owner, { current: true, materials: pair });
  await flush();
  assert.equal(JSON.parse(f.storage.get(key)).length, 8, "deduplicate before checking capacity");
  f.button("send").handlers.click();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(f.writes[0][2].materials)), [...existing.slice(1), ...pair]);
  f.controller.close();
});

test("version feedback fills a draft without sending, persists exact refs, and never crosses owners", async () => {
  const f = fixture();
  const owner = { scope: "task", taskId: "task-1", roleName: "leader" };
  const ref = { taskId: "task-1", relativePath: "notes.md", commit: "a".repeat(40), digest: "b".repeat(64) };
  f.controller.open(owner, { current: true, materials: [ref] });
  await flush();
  assert.equal(f.writes.length, 0);
  const materialKey = [...f.storage.keys()].find(k => k.endsWith(".materials"));
  assert.deepEqual(JSON.parse(f.storage.get(materialKey)), [ref]);
  f.input.value = "Revise this version";
  f.button("send").handlers.click();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(f.writes[0][2].materials)), [ref]);
  assert.equal(JSON.parse(f.storage.get(materialKey)).length, 0);
  f.delayRead();
  f.controller.open(owner, { current: true, materials: [ref] });
  f.controller.open({ scope: "task", taskId: "task-2", roleName: "leader" });
  f.finishRead();
  await flush();
  assert.ok(![...f.storage.entries()].some(([key, value]) => key.includes("task-2") && value.includes(ref.commit)));
  assert.equal(f.writes.length, 1, "owner transitions never send a material");
  f.controller.close();
});

test("the dock leaves the access preference to Settings and keeps the current Session", async () => {
  const f = fixture();
  vm.runInContext(WORKSPACE_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), f.context);
  f.controller.open({ scope: "global", roleName: "operator" });
  await flush();
  assert.equal(f.elements.some(n => n.spec === "select" && n["aria-label"] !== "conversation.model"), false,
    "no second preference control inside the dock");
  assert.equal(f.context.preferredMode(), "chat");
  // The Settings page writes through this helper; the open view is unaffected.
  f.context.writeSessionAccessMode("native");
  await f.tick();
  assert.equal(f.preferences.get("yui.session.accessMode"), "native");
  assert.equal(f.context.preferredMode(), "terminal");
  assert.equal(f.controller.selection().nativeSessionId, "thread");
  assert.equal(f.mutations.length, 0, "saving a browser preference is not runtime adoption");
  f.controller.close();
});

test("workbench continuation resolves the current Leader afresh without replaying historical input", async () => {
  const f = fixture({}, { history: ["old-thread"] });
  const owner = { scope: "task", taskId: "task-1", roleName: "leader" };
  f.controller.open(owner);
  await flush();
  f.input.value = "Current draft";
  await f.pick("old-thread");
  f.input.value = "Historical draft";
  f.replaceCurrent("replacement-thread");
  f.controller.open(owner, { current: true });
  await flush();
  const query = new URL(f.calls.at(-1), "http://fixture").searchParams;
  assert.equal(query.get("task"), "task-1");
  assert.equal(query.get("role"), "leader");
  assert.equal(query.get("session"), "replacement-thread");
  assert.equal(f.input.value, "");
  assert.ok([...f.storage.values()].includes("Current draft"));
  assert.ok([...f.storage.values()].includes("Historical draft"));
  assert.equal([...f.storage.keys()].some(k => k.endsWith(".pending")), false);
  f.controller.close();
});

test("hiding the dock pauses the session page and showing it resumes the same owner and Session", () => {
  const context = vm.createContext({ writePreference() {}, document: { activeElement: null } });
  vm.runInContext(WORKSPACE_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const owner = { scope: "task", taskId: "task-1", roleName: "reviewer" };
  const calls = [];
  let layoutVisible;
  const ws = {
    dock: { mode: "conversation", open: true }, narrow: { matches: false },
    deps: { state: { selected: "task-1" }, el: { dock: { contains: () => false } }, session: {
      current: () => owner, close: () => calls.push("close"), reconnect: () => calls.push("reconnect"),
      open: (...args) => calls.push(["open", ...args]), setMode: mode => calls.push(["mode", mode])
    } }
  };
  context.observeLayout = value => { layoutVisible = context.dockVisible(value); };
  vm.runInContext("updateLayout = observeLayout", context);
  context.setDockOpen(ws, false);
  assert.equal(context.dockVisible(ws), false);
  context.setDockOpen(ws, true);
  assert.deepEqual(calls, ["close", "reconnect"], "no new Session is opened, created or resolved by the dock");
  assert.equal(layoutVisible, true);
  // The legacy native shortcut opens the same page in its terminal mode.
  context.setDockOpen(ws, false);
  context.toggleDock(ws, "session");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.slice(2))), ["close", "reconnect", ["mode", "terminal"]]);
});

test("the page's one panel switch mirrors the dock, keeps its view and takes focus back on close", () => {
  const document = { activeElement: null };
  const context = vm.createContext({ writePreference() {}, markSelected() {}, document });
  vm.runInContext(WORKSPACE_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  vm.runInContext("drawTarget = function () {}; updateLayout = function (ws) { syncDockButtons(ws); }", context);
  const attrs = {};
  const toggle = { setAttribute(k, v) { attrs[k] = v; }, focus() { document.activeElement = toggle; } };
  const inside = {};
  let reconnects = 0;
  const ws = {
    dock: { mode: "conversation", open: false }, narrow: { matches: false },
    deps: { t: key => key, state: { selected: "task-1" },
      el: { dock: { contains: node => node === inside },
        detail: { querySelectorAll: () => [toggle], querySelector: () => toggle } },
      session: { close() {}, reconnect() { reconnects++; }, current: () => ({ scope: "global", roleName: "operator" }) } }
  };
  context.toggleDock(ws);
  assert.equal(context.dockVisible(ws), true);
  assert.equal(ws.dock.mode, "conversation", "the first open uses the default view");
  assert.equal(attrs["aria-expanded"], "true");
  assert.equal(attrs["aria-label"], "dock.hide");
  assert.equal(reconnects, 1);
  ws.dock.mode = "preview";
  document.activeElement = inside;
  context.toggleDock(ws);
  assert.equal(context.dockVisible(ws), false);
  assert.equal(attrs["aria-expanded"], "false");
  assert.equal(attrs["aria-label"], "dock.show");
  assert.equal(document.activeElement, toggle, "focus leaves the hidden panel for its switch");
  context.toggleDock(ws);
  assert.equal(ws.dock.mode, "preview", "reopening keeps the last view");
  assert.equal(attrs["aria-expanded"], "true");
  document.activeElement = null;
  context.setDockOpen(ws, false);
  assert.equal(document.activeElement, null, "focus outside the panel is left where it is");
});

// The session page with the shipped chat and terminal controllers; only the
// network, xterm and WebSocket edges are fakes. Each script keeps its own
// context because the controllers share private helper names.
function sessionFixture(extra = {}) {
  const f = fixture(extra.submitResult ?? {}, extra);
  const connections = [], sockets = [], notes = [], held = [];
  const term = vm.createContext({
    URLSearchParams, clear() {}, sessionExpired() {}, fill: template => template,
    ResizeObserver: class { observe() {} disconnect() {} }, WebSocket: { OPEN: 1 },
    requestJson: url => {
      if (!f.holdTerminal) return f.context.requestJson(url);
      return new Promise(resolve => held.push(() => resolve(f.context.requestJson(url))));
    },
    fakeMount: () => ({ terminal: { onData() { return { dispose() {} }; }, dispose() {}, focus() {}, options: {} }, fit: { fit() {} } }),
    fakeConnect: target => {
      connections.push(target.nativeSessionId);
      const socket = { readyState: 1, closed: false, sent: [], listeners: {},
        addEventListener(type, listener) { this.listeners[type] = listener; },
        send(data) { this.sent.push(data); }, close() { this.closed = true; } };
      sockets.push(socket);
      return socket;
    }
  });
  vm.runInContext(TERMINAL_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), term);
  vm.runInContext("mountTerminal = function () { return fakeMount(); }; connect = function (target) { return fakeConnect(target); }", term);
  const pageContext = vm.createContext({ h: f.context.h, icon: f.context.icon, formatShort: iso => iso, document: f.context.document,
    createConversationController: f.context.createConversationController, createTerminalController: term.createTerminalController });
  vm.runInContext(SESSION_PAGE_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), pageContext);
  const pane = f.context.h("dock-pane");
  let changes = 0;
  const page = pageContext.createSessionPage(pane, k => k, () => "en", message => notes.push(message), () => { changes++; });
  return Object.defineProperties(f, Object.getOwnPropertyDescriptors({ page, pane, connections, sockets, notes, held, get changes() { return changes; },
    modeButton: mode => f.elements.findLast(n => n.spec === "button.seg-btn" && n.dataset.mode === mode),
    get draft() { return f.elements.findLast(n => n.spec.startsWith("textarea")); },
    get view() { return pane.children[0]; },
    lastSession: () => new URL(f.calls.filter(url => url.includes("session=")).at(-1), "http://fixture").searchParams.get("session"),
    switchTo: async mode => { f.modeButton(mode).handlers.click(); await flush(); },
    release: async () => { held.splice(0).forEach(go => go()); await flush(); await flush(); }
  }));
}

test("chat and terminal are one page: a mode switch keeps the owner and Session and rebuilds the view", async () => {
  const f = sessionFixture();
  const owner = { scope: "task", taskId: "task-1", roleName: "leader" };
  f.page.open(owner, { mode: "chat", current: true });
  await flush();
  assert.equal(f.lastSession(), "thread");
  assert.equal(f.modeButton("chat")["aria-checked"], "true");
  assert.equal(f.modeButton("terminal")["aria-disabled"], "false");
  f.draft.value = "unsent words";
  f.draft.handlers.input();
  assert.ok([...f.storage.values()].includes("unsent words"));
  await f.switchTo("terminal");
  assert.equal(f.page.mode(), "terminal");
  assert.ok(f.view.spec.endsWith("is-terminal"), "the old chat view is gone from the pane");
  assert.deepEqual(f.connections, ["thread"], "the terminal attaches to the Session the chat had selected");
  assert.equal([...f.storage.values()].includes("unsent words"), false, "unsent drafts do not survive a mode switch");
  const reads = f.calls.length;
  await f.tick();
  assert.equal(f.calls.length, reads, "the destroyed chat no longer polls");
  await f.switchTo("chat");
  assert.equal(f.sockets[0].closed, true, "leaving the terminal releases its socket");
  assert.equal(f.lastSession(), "thread");
  assert.equal(f.draft.value, "");
  assert.equal(f.changes, 3, "the dock header redraws after each build");
  assert.deepEqual(JSON.parse(JSON.stringify(f.page.current())), owner);
  assert.equal(f.mutations.length, 0, "switching never sends or adopts anything");
  assert.deepEqual(f.sockets[0].sent, []);
  f.page.close();
});

test("a pending submission receipt survives a mode switch and is never replayed", async () => {
  const f = sessionFixture({ idle: true, receiptState: "unknown", submit() { throw Error("lost acknowledgement"); } });
  f.page.open({ scope: "task", taskId: "task-1", roleName: "leader" }, { mode: "chat", current: true });
  await flush();
  f.draft.value = "One intended input";
  await f.elements.findLast(n => n.spec.startsWith("button") && (n.children.includes("conversation.send") || n["aria-label"] === "conversation.send")).handlers.click();
  assert.equal(f.mutations.length, 1);
  await f.switchTo("terminal");
  await f.switchTo("chat");
  assert.equal(f.elements.findLast(n => n.spec.startsWith("button") && (n.children.includes("conversation.send") || n["aria-label"] === "conversation.send")).disabled, true,
    "an unknown effect still blocks input in the rebuilt view");
  assert.ok([...f.preferences.keys()].some(k => k.endsWith(".pending")), "the receipt is a fact, not view state");
  assert.ok([...f.storage.values()].includes("One intended input"), "the receipt keeps its body");
  assert.equal(f.mutations.length, 1, "no replay");
  f.page.close();
});

test("the terminal never attaches to a historical or replaced Session in place of the current one", async () => {
  const f = sessionFixture({ history: ["old-thread"] });
  f.page.open({ scope: "task", taskId: "task-1", roleName: "leader" }, { mode: "chat", current: true });
  await flush();
  await f.pick("old-thread");
  assert.equal(f.modeButton("terminal")["aria-disabled"], "true");
  assert.equal(f.modeButton("terminal").title, "terminal.notCurrentText");
  await f.switchTo("terminal");
  assert.equal(f.page.mode(), "chat", "a blocked switch keeps the chat");
  assert.deepEqual(f.notes, ["terminal.notCurrentText"], "and says why");
  assert.equal(f.lastSession(), "old-thread", "the historical selection is kept");
  await f.pick("thread");
  await f.switchTo("terminal");
  assert.deepEqual(f.connections, ["thread"]);
  // Hidden while the owner moved to a replacement Session: report, never exchange.
  f.page.close();
  assert.equal(f.sockets[0].closed, true);
  f.replaceCurrent("thread-b");
  f.page.reconnect();
  await flush();
  assert.deepEqual(f.connections, ["thread"], "no attachment to the replacement Session");
  assert.equal(f.text("p.terminal-empty-title"), "terminal.notCurrentTitle");
  assert.equal(f.page.selection(), null);
  assert.equal(f.page.mode(), "terminal");
  // Returning to the chat keeps the selected (now previous) Session.
  await f.switchTo("chat");
  assert.equal(f.lastSession(), "thread");
  f.page.close();
});

test("a Role without a Session shows why the terminal is unavailable and starts nothing", async () => {
  const f = sessionFixture({ sessions: () => [] });
  f.replaceCurrent(null);
  f.page.open({ scope: "task", taskId: "task-1", roleName: "reviewer" }, { mode: "terminal", current: true });
  await flush();
  assert.deepEqual(f.connections, []);
  assert.equal(f.text("p.terminal-empty-title"), "terminal.noSessionTitle");
  assert.equal(f.mutations.length, 0);
  f.page.close();
});

test("late answers from a destroyed view or an earlier owner never reach the page", async () => {
  const f = sessionFixture();
  const leader = { scope: "task", taskId: "task-1", roleName: "leader" };
  const reviewer = { scope: "task", taskId: "task-1", roleName: "reviewer" };
  f.page.open(leader, { mode: "chat", current: true });
  await flush();
  f.holdTerminal = true;
  await f.switchTo("terminal");
  await f.switchTo("chat");
  await f.release();
  assert.deepEqual(f.connections, [], "the abandoned terminal never attaches");
  assert.equal(f.page.mode(), "chat");
  assert.equal(f.modeButton("terminal")["aria-disabled"], "false");
  await f.switchTo("terminal");
  f.page.open(reviewer, {});
  f.holdTerminal = false;
  await f.release();
  await flush();
  assert.equal(f.page.mode(), "terminal", "choosing another owner keeps the mode");
  assert.deepEqual(JSON.parse(JSON.stringify(f.page.current())), reviewer);
  assert.deepEqual(f.connections, ["thread"]);
  assert.equal(f.sockets.length, 1);
  f.page.close();
});

test("the dock's single target menu offers the selected Task's Roles and marks live ones", () => {
  const made = [];
  const h = (spec, attrs, ...children) => { const node = { spec, ...attrs, children: children.filter(Boolean) }; made.push(node); return node; };
  const context = vm.createContext({ writePreference() {}, markSelected() {}, document: { activeElement: null }, h,
    icon: name => h("icon", { name }), clear: node => { node.children = []; } });
  vm.runInContext(WORKSPACE_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const options = { dataset: {}, children: [], append(node) { this.children.push(node); } };
  let opened;
  const ws = { dock: { mode: "conversation", open: true }, narrow: { matches: false },
    targets: [{ scope: "task", taskId: "task-1", roleName: "reviewer", live: true }, { scope: "task", taskId: "task-9", roleName: "other" }],
    deps: { t: k => k, state: { selected: "task-1" },
      el: { dockTargetLabel: {}, dockTargetIcon: { replaceChildren() {} }, dockTargetOptions: options, dockTarget: { open: true },
        detail: { querySelectorAll: () => [] }, dock: {}, divider: {}, discussion: {}, conversation: {}, preview: {} },
      session: { current: () => ({ scope: "task", taskId: "task-1", roleName: "leader" }), open: (...args) => { opened = args; } } } };
  vm.runInContext("updateLayout = function () {}", context);
  context.drawTarget(ws);
  const labels = options.children.map(item => item.children.find(c => c.spec === "span").children[0]);
  assert.deepEqual(labels, ["actions.operator", "leader · task-1", "reviewer · task-1"]);
  assert.equal(options.children.filter(item => item.children.some(c => c.spec === "i.dock-target-dot.is-live")).length, 1);
  options.children[2].onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ scope: "task", roleName: "reviewer", taskId: "task-1" }, {}],
    "choosing a Role keeps the page's mode and resolves no Session itself");
  assert.equal(ws.deps.el.dockTarget.open, false);
});

test("conversation preserves unsent drafts and reading state while receipts and refreshes arrive", async () => {
  const f = fixture();
  f.controller.open({ scope: "global", roleName: "operator" });
  await flush();
  f.input.value = "Unsent draft";
  await f.button("stop").handlers.click();
  await flush();
  assert.equal(f.input.value, "Unsent draft", "stopping a Turn does not send its draft");
  f.input.value = "Submitted text";
  const pending = f.delayReceipt();
  f.button("send").handlers.click();
  await flush();
  f.input.value = "New draft while awaiting receipt";
  pending.resolve({ state: "accepted" });
  await flush();
  assert.equal(f.input.value, "New draft while awaiting receipt");
  const tool = f.feed.children[0];
  tool.open = true;
  await f.tick();
  assert.equal(f.feed.children[0], tool, "unchanged item keeps its DOM and expansion");
  assert.equal(tool.open, true);
  f.controller.close();
});

test("native answers keep original identity and pending state; Leader questions use the Task channel", async () => {
  const extra = { nativeRequests: [{ id: "native-1", method: "item/commandExecution/requestApproval",
    turnId: "turn", params: { command: "fixture" } }], leaderQuestions: [{ id: "input-1" }] };
  const f = fixture({ outcome: "accepted" }, extra);
  const owner = { scope: "task", taskId: "task-1", roleName: "leader" };
  f.controller.open(owner);
  await flush();
  await f.button("decline").handlers.click();
  assert.equal(f.mutations[0][2].nativeRequestId, "native-1");
  assert.equal(f.mutations[0][2].expectedTarget, "turn");
  assert.equal(f.mutations[0][2].result.decision, "decline");
  f.controller.close();
  f.controller.open(owner);
  await flush();
  const declines = f.elements.filter(n => n.children.includes("conversation.decline"));
  assert.equal(declines.at(-1).disabled, true, "reopening never repeats an uncertain native answer");
  const cards = f.elements.filter(n => n.spec === "input-card");
  await cards.at(-1).answer("business answer");
  assert.deepEqual(f.taskAnswers, [["task-1", "input-1", "business answer"]]);
  assert.equal(f.mutations.length, 1, "Task answer is not a second native prompt");
  f.controller.close();
  const mcp = fixture({ outcome: "accepted" }, { nativeRequests: [{
    id: "mcp", method: "mcpServer/elicitation/request", turnId: null, params: { message: "Choose" }
  }] });
  mcp.controller.open(owner);
  await flush();
  await mcp.button("decline").handlers.click();
  assert.equal(mcp.mutations[0][2].expectedTarget, null, "do not fabricate a Turn for thread-level requests");
  assert.equal(mcp.mutations[0][2].result.action, "decline");
  assert.equal(mcp.mutations[0][2].result.content, null);
  mcp.controller.close();
});

test("definite interrupt refusal releases input while unknown delivery remains blocked", async () => {
  for (const code of ["NO_ACTIVE_TURN", "TARGET_CHANGED", "INTERRUPT_UNSUPPORTED", "DELIVERY_UNKNOWN"]) {
    const f = fixture({ interrupt: { state: "not-interrupted", code } });
    f.controller.open({ scope: "global", roleName: "operator" });
    await flush();
    f.input.value = "Unsent";
    // Missing durable interrupt receipt cannot settle an unconfirmed action.
    const receipt = f.delayReceipt();
    f.button("stop").handlers.click();
    await flush();
    receipt.resolve?.({ state: "unknown" });
    await flush();
    const unknown = code === "DELIVERY_UNKNOWN";
    assert.equal(f.button("send").disabled, unknown, code);
    assert.equal([...f.storage.keys()].some(k => k.endsWith(".pending")), unknown, code);
    assert.equal(f.input.value, "Unsent");
    f.controller.open({ scope: "global", roleName: "operator" }, { current: true });
    await flush();
    assert.equal(f.button("send").disabled, unknown, "opening current does not clear an unknown submission");
    assert.equal(f.input.value, "Unsent");
    if (unknown) {
      assert.equal(f.controller.captureDraftTarget(), null);
      assert.throws(() => f.controller.insertReference(
        JSON.stringify([{ scope: "global", roleName: "operator" }, "thread"]), "history"), /targetChanged/);
      assert.equal(f.input.value, "Unsent");
    }
    f.controller.close();
  }
});

test("URL back navigation leaves the Task through the same owner transition as the back button", () => {
  const state = { selected: "task-1", detail: {} };
  let left = 0, owner = { scope: "task", taskId: "task-1", roleName: "leader" };
  const context = vm.createContext({
    window: { addEventListener() {} }, syncUrl() {}, urlTaskId: () => null
  });
  vm.runInContext(SELECTION_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const selection = context.createSelection({ state,
    workspace: { updateLayout() {}, leaveTask() { left++; owner = { scope: "global", roleName: "operator" }; } },
    taskView: { hasUnsent: () => false, leaveTask() {}, showOverview() {}, revealPage() {}, updateSessionTargets() {} },
    renderTaskList() {}
  });
  selection.followUrl(new URLSearchParams());
  assert.equal(state.selected, null);
  assert.equal(owner.scope, "global");
  assert.equal(left, 1);
  state.selected = "task-2";
  selection.clearSelection();
  assert.equal(left, 2);
});

test("owner switch during an older-page read eventually reads the new owner without replaying inputs", async () => {
  const f = fixture();
  f.controller.open({ scope: "task", taskId: "task-1", roleName: "leader" });
  await flush();
  f.delayRead();
  f.button("older").handlers.click();
  f.controller.open({ scope: "global", roleName: "operator" });
  f.finishRead();
  await flush();
  await f.tick();
  assert.ok(f.calls.some(url => url.includes("scope=global")));
  assert.equal(f.feed.children.length, 1);
  assert.equal(f.storage.size, 1, "only the old draft was saved, no input was replayed");
  f.controller.close();
});

test("a turn folds its process into one collapsed row and older pages accumulate in place", async () => {
  const turn = (id, kind, text, turnId = "t2") => ({ id, turnId, kind, text });
  const f = fixture(undefined, {
    items: [turn("a3", "assistant", "done"), turn("c2", "activity", "commandExecution · ls"),
      turn("a2", "assistant", "checking"), turn("c1", "activity", "commandExecution · pwd"), turn("u2", "user", "go")],
    olderItems: [turn("a1", "assistant", "earlier answer", "t1"), turn("u1", "user", "first", "t1")]
  });
  f.controller.open({ scope: "global", roleName: "operator" });
  await flush();
  assert.deepEqual(f.feed.children.map(n => n.spec.split(".").slice(0, 2).join(".")),
    ["article.cv-msg", "details.cv-activity", "article.cv-msg"], "user, one folded process row, final reply");
  assert.ok(!f.feed.children[1].open, "process starts collapsed");
  f.button("older").handlers.click();
  await flush();
  assert.equal(f.calls.filter(url => url.includes("cursor=")).length, 1);
  assert.equal(f.feed.children.length, 5, "older turn is prepended without dropping the latest page");
  f.controller.close();
});

test("a terminal closed by the server for an ended browser session returns the page to sign-in", () => {
  const listeners = {};
  let expired = 0;
  const states = [];
  const context = vm.createContext({ sessionExpired() { expired++; } });
  vm.runInContext(TERMINAL_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  vm.runInContext("setState = function(ctl, key) { ctl.stateKey = key; ctl.states.push(key); }", context);
  const socket = { addEventListener(type, listener) { listeners[type] = listener; } };
  const ctl = { generation: 1, stateKey: "terminal.writable", states };
  const link = { writable: true };
  context.bindSocket(ctl, socket, { write() {}, writeln() {} }, link, 1);
  listeners.close({ code: 1000 });
  assert.equal(expired, 0, "an ordinary detach stays on the page");
  assert.deepEqual(states, ["terminal.closed"]);
  listeners.close({ code: 1008 });
  assert.equal(expired, 1);
  assert.equal(link.writable, false);
  assert.deepEqual(states, ["terminal.closed"], "no misleading closed state before sign-in");
});

test("the current-model label never presents a launch snapshot as the Session's live model", async () => {
  const observed = (model, observedAt = "2026-10-21T12:00:00.000Z") => ({ status: "observed", observedAt, requested: [],
    handshake: { status: "unsupported", reason: "fixture" },
    axes: [{ key: "model", category: "model", current: { status: "observed", value: model }, offered: [] },
      // Effort is identified by category; its native key is reasoningEffort.
      { key: "reasoningEffort", category: "effort", current: { status: "observed", value: "medium" }, offered: [] }] });
  const unknown = { status: "unknown", reason: "No confirmed native model response." };
  let config = () => unknown;
  const extra = { idle: true, runConfiguration: session => config(session),
    sessions: id => [{ nativeSessionId: id, current: true, status: "active", adapterId: "codex", launchModel: "launch-model", launchEffort: "high" },
      { nativeSessionId: "old", current: false, status: "ended", adapterId: "codex", createdAt: "2026-01-01T00:00:00.000Z", launchModel: "old-launch" }] };
  const f = fixture({}, extra);
  f.controller.open({ scope: "global", roleName: "operator" });
  await flush();
  const menu = () => f.elements.findLast(n => n.spec === "details.cv-pop.cv-model");
  const label = () => f.text("span.cv-model-label");
  // Model facts as [label, value, note] rows from the model menu.
  const facts = () => {
    const rows = f.elements.findLast(n => n.spec === "dl.cv-facts.cv-model-facts").children;
    const out = [];
    for (let i = 0; i < rows.length; i += 2) out.push([rows[i].children[0], rows[i + 1].children[0].children[0], rows[i + 1].children[1]?.children[0]]);
    return out;
  };
  // What a reader sees without hovering: the state word plus the model.
  const visible = () => [f.elements.findLast(n => n.spec === "span.cv-model-state"), f.elements.findLast(n => n.spec === "span.cv-model-label")]
    .filter(n => !n.hidden).map(n => n.textContent).join(" ");
  const summary = () => f.elements.findLast(n => n.spec === "summary.cv-pill" && n.children.some(c => c.spec === "span.cv-model-label"));
  assert.equal(label(), "conversation.modelUnconfirmed", "a launch request is not the current model");
  assert.equal(menu().dataset.state, "unknown");
  assert.equal(visible(), "conversation.modelUnconfirmed", "unknown reads as text, not only a colour");
  assert.equal(facts().length, 2, "only execution and selection are shown");
  assert.equal(facts().some(r => r[0] === "conversation.launchModel"), false);
  assert.equal(facts().find(r => r[0] === "conversation.confirmedModel")[1], "conversation.modelUnconfirmed");

  config = session => session === "thread" ? observed("live-model") : unknown;
  await f.tick();
  assert.equal(label(), "live-model · medium", "only the Session's own native confirmation is shown");
  assert.equal(menu().dataset.state, "confirmed");
  assert.equal(visible(), "conversation.modelStateConfirmed live-model · medium", "last confirmation is named in visible text");
  assert.equal(summary()["aria-label"], "conversation.model · conversation.modelStateConfirmed live-model · medium");
  assert.match(summary().title, /modelConfirmedShort.*date:2026-10-21T12:00:00.000Z/, "the tooltip time carries the date");
  const confirmed = facts().find(r => r[0] === "conversation.confirmedModel");
  assert.equal(confirmed[1], "live-model · medium");
  assert.equal(confirmed[2], "conversation.modelStateConfirmed", "brief provenance stays visible; the dated detail is in the tooltip");

  config = () => unknown;
  await f.tick();
  assert.equal(label(), "conversation.modelUnconfirmed", "a confirmation the Host withdrew is not carried over");
  assert.equal(menu().dataset.state, "unknown");
  assert.equal(visible(), "conversation.modelUnconfirmed", "no stale state word is left behind");

  config = session => session === "thread" ? observed("live-model") : unknown;
  await f.tick();
  await f.pick("old");
  assert.equal(label(), "conversation.modelUnconfirmed", "a previous Session never borrows the current report");
  assert.equal(facts().some(r => r[1] === "old-launch"), false, "launch defaults do not clutter the picker");
  assert.ok(!facts().some(r => r[1] === "live-model"));

  // A current-Session read that answers after the user switched never lands on the other Session.
  await f.pick("thread");
  assert.equal(label(), "live-model · medium");
  extra.hold = session => session === "thread";
  f.controller.reconnect();
  await flush();
  extra.hold = null;
  await f.pick("old");
  config = session => session === "thread" ? observed("late-model") : unknown;
  extra.held();
  await flush();
  assert.equal(label(), "conversation.modelUnconfirmed", "late responses never cross Sessions");
  assert.equal(f.mutations.length, 0, "presentation never applies a model");
  f.controller.close();
});

test("the picker and the read-only notice keep the dock to one layer; user text is never split", async () => {
  // Ordinary tags and surrounding whitespace are the user's words: nothing is
  // guessed to be attached context, folded away, trimmed or re-indented.
  const userTexts = ["<b>关键要求</b>\n  后续正文保持缩进\n\n第二段", "<config>\n  mode: strict\n</config>\n请按此配置",
    "  \n<ambient-context>url: http://x</ambient-context>\n\tPlease review  \n"];
  const items = [...userTexts.map((text, i) => ({ id: "u" + i, turnId: "turn", kind: "user", text })),
    { id: "a", turnId: "turn", kind: "assistant", text: "<b>not context</b> reply" }];
  const long = "会话标题".repeat(30);
  const f = fixture({}, { idle: true, items, sessions: id => [{ nativeSessionId: id, current: true, status: "active", adapterId: "codex", title: long },
    { nativeSessionId: "old", current: false, status: "ended", endReason: "failed", adapterId: "codex", createdAt: "2026-01-01T00:00:00.000Z" }] });
  const copies = [];
  f.context.navigator = { clipboard: { writeText: async value => { copies.push(value); } } };
  f.controller.open({ scope: "global", roleName: "operator" });
  await flush();
  const options = () => f.elements.filter(n => n.spec === "button.cv-session-opt").slice(-2);
  assert.deepEqual(options().map(o => [o.dataset.session, o["aria-selected"]]), [["thread", "true"], ["old", "false"]]);
  assert.equal(f.text("span.cv-picker-name"), "conversation.current · " + long, "full name stays available; CSS ellipsizes");
  const notice = f.elements.findLast(n => n.spec === "p.cv-notice");
  assert.equal(notice.hidden, true, "a writable Session shows no notice");
  assert.equal(f.elements.some(n => n.spec === "details.cv-context"), false, "no guessed context fold");
  const bubbles = f.elements.filter(n => n.spec === "div.cv-bubble").map(n => n.children[0].children[0]);
  for (const text of userTexts) assert.ok(bubbles.includes(text), "shown verbatim: " + JSON.stringify(text));

  f.elements.find(n => n.spec === "button.cv-link" && n.children.some(c => c.children?.includes("conversation.copyIdentity"))).handlers.click();
  await flush();
  assert.deepEqual(copies, ["Global / operator / thread"]);

  await f.pick("old");
  assert.equal(notice.hidden, false);
  assert.equal(notice.children[1].textContent, "conversation.readOnlyHistory");
  assert.equal(f.button("send").disabled, true);
  assert.equal(f.input.placeholder, "conversation.placeholderHistory");
  assert.equal(f.elements.find(n => n.spec === "button.cv-link.cv-back").hidden, false);
  notice.children[2].handlers.click();
  await flush();
  assert.equal(f.controller.selection().nativeSessionId, "thread", "back to current from the notice");
  assert.equal(notice.hidden, true);
  const picker = f.elements.find(n => n.spec === "details.cv-pop.cv-picker");
  let stopped = 0;
  const escape = { key: "Escape", stopPropagation() { stopped++; } };
  picker.open = true;
  f.host.handlers.keydown(escape);
  assert.equal(picker.open, false);
  assert.equal(stopped, 1, "closing a popover must not also hide the dock");
  f.host.handlers.keydown(escape);
  assert.equal(stopped, 1, "with nothing open, Escape still reaches the dock");
  f.controller.close();
});
