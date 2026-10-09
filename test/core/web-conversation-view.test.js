import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { CONVERSATION_SCRIPT } from "../../dist/web/assets/client/views/dock/conversation.js";
import { SELECTION_SCRIPT } from "../../dist/web/assets/client/app/selection.js";

// Exercise the shipped controller with disposable DOM/network boundaries.
function fixture(submitResult = { state: "submitted" }) {
  const elements = [], storage = new Map(), calls = [], writes = [];
  let interval, delayedRead, delayedReceipt, currentSessionId = "thread";
  const h = (spec, attrs, ...children) => {
    const node = { spec, ...attrs, children: children.filter(Boolean), handlers: {}, value: "", scrollTop: 0,
      scrollHeight: 0, clientHeight: 0, textContent: "", hidden: attrs?.hidden ?? false,
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      addEventListener(event, handler) { this.handlers[event] = handler; },
      closest() { return null; }, querySelectorAll() { return []; },
      get options() { return this.children; } };
    if (attrs?.value) node.value = attrs.value;
    elements.push(node); return node;
  };
  const host = h("host");
  const context = vm.createContext({
    h, clear: n => n.replaceChildren(), richText: (_title, text) => h("prose", null, text),
    URLSearchParams, crypto: { randomUUID: () => "request-id" }, document: { hidden: false },
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    window: { setInterval: fn => { interval = fn; return 1; }, clearInterval: () => { interval = null; } },
    requestJson: async url => {
      calls.push(url);
      const query = new URL(url, "http://fixture").searchParams;
      if (query.has("requestId")) {
        if (delayedReceipt) return new Promise(resolve => { delayedReceipt.resolve = resolve; });
        return { state: "accepted" };
      }
      if (delayedRead) return new Promise(resolve => { delayedRead.resolve = resolve; });
      if (query.has("session")) return { status: "active", observedAt: "now", nextCursor: "older",
        items: [{ id: "tool", turnId: "turn", kind: "activity", text: "npm test" }] };
      return { currentSessionId, sessions: [{ nativeSessionId: currentSessionId, current: true,
        status: "active", adapterId: "codex" }], authority: { owner: "controller" },
        turn: { status: "accepted", nativeTurnId: "turn" }, total: 1, nextOffset: null };
    },
    submitMutation: async (...args) => { writes.push(args); return submitResult; }
  });
  vm.runInContext(CONVERSATION_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const controller = context.createConversationController(host, k => k);
  return { controller, calls, storage, host, writes,
    button: key => elements.find(n => n.spec.startsWith("button") && n.children.includes("conversation." + key)),
    get input() { return elements.find(n => n.spec.startsWith("textarea")); },
    get selector() { return elements.find(n => n.spec === "select"); },
    replaceCurrent: id => { currentSessionId = id; },
    get feed() { return elements.find(n => n.spec === "div.feed"); },
    tick: async () => { interval?.(); await flush(); },
    delayRead: () => { delayedRead = {}; return delayedRead; },
    finishRead: () => { const pending = delayedRead; delayedRead = null; pending.resolve({}); },
    delayReceipt: () => { delayedReceipt = {}; return delayedReceipt; }
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

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

test("workbench continuation resolves the current Leader afresh without replaying historical input", async () => {
  const f = fixture();
  const owner = { scope: "task", taskId: "task-1", roleName: "leader" };
  f.controller.open(owner);
  await flush();
  f.input.value = "Current draft";
  f.selector.value = "old-thread";
  f.selector.handlers.change();
  await flush();
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
    taskView: { hasUnsent: () => false, leaveTask() {}, showOverview() {}, updateSessionTargets() {} },
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
