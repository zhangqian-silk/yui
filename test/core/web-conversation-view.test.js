import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { CONVERSATION_SCRIPT } from "../../dist/web/assets/client/views/dock/conversation.js";

// Exercise the shipped controller with disposable DOM/network boundaries.
function fixture() {
  const elements = [], storage = new Map(), calls = [];
  let interval, delayedRead, delayedReceipt;
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
      return { currentSessionId: "thread", sessions: [{ nativeSessionId: "thread", current: true,
        status: "active", adapterId: "codex" }], authority: { owner: "controller" },
        turn: { status: "accepted", nativeTurnId: "turn" }, total: 1, nextOffset: null };
    },
    submitMutation: async () => ({ state: "submitted" })
  });
  vm.runInContext(CONVERSATION_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const controller = context.createConversationController(host, k => k);
  return { controller, calls, storage, host,
    button: key => elements.find(n => n.spec.startsWith("button") && n.children.includes("conversation." + key)),
    get input() { return elements.find(n => n.spec.startsWith("textarea")); },
    get feed() { return elements.find(n => n.spec === "div.feed"); },
    tick: async () => { interval?.(); await flush(); },
    delayRead: () => { delayedRead = {}; return delayedRead; },
    finishRead: () => { const pending = delayedRead; delayedRead = null; pending.resolve({}); },
    delayReceipt: () => { delayedReceipt = {}; return delayedReceipt; }
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

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
