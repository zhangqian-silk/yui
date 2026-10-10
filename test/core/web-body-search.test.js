import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { BODY_SEARCH_SCRIPT } from "../../dist/web/assets/client/views/bodySearch.js";

test("textarea selection retains original CRLF and Unicode source offsets", () => {
  const context = vm.createContext({});
  vm.runInContext(BODY_SEARCH_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const selection = context.selectedSearchText({ content: "😀\r\nmatch\r\n", offset: 100 },
    { selectionStart: 3, selectionEnd: 9 });
  assert.equal(selection.excerpt, "match\r\n");
  assert.equal(selection.offset, 103);
});

test("search reads only requested text pages and stages pinned selection without navigating or sending", async () => {
  const nodes = [], reads = [], inserts = [], searches = [], navigations = [];
  const h = (spec, attrs, ...children) => {
    const node = { spec, children, handlers: {}, dataset: {}, value: "", textContent: "", ...attrs,
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      addEventListener(event, fn) { this.handlers[event] = fn; },
      showModal() {}, close() { this.handlers.close?.(); }, focus() {} };
    nodes.push(node); return node;
  };
  const open = h("button");
  const item = { taskId: "task-1", kind: "message", field: "$.body", offset: 9, snippet: "match",
    ref: { store: "task-message", refId: "message-1", digest: "a".repeat(64), revision: "2026-10-10" } };
  let failure = false, empty = false, delayed;
  const context = vm.createContext({ h, URLSearchParams,
    button: text => h("button", { textContent: text }),
    document: { body: h("body"), querySelector: () => open } });
  vm.runInContext(BODY_SEARCH_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const controller = context.bindBodySearch({ t: k => k, currentTask: () => "task-2",
    captureDraftTarget: () => JSON.stringify([{ scope: "global", roleName: "operator" }, "captured-thread"]),
    insertReference: (...args) => inserts.push(args),
    selectTask: task => navigations.push(task),
    api: {
      searchBodies: async query => {
        searches.push(query.toString());
        if (failure) throw new Error("offline");
        return { items: empty ? [] : [item], nextCursor: null };
      },
      searchSource: async (hit, offset) => {
        reads.push(offset);
        if (delayed) return new Promise(resolve => { delayed.resolve = resolve; });
        return { content: offset === 9 ? "match tail" : offset === 2 ? "match" : "😀match",
          offset, nextOffset: offset === 0 ? 4000 : null, totalCharacters: 5000 };
      }
    }
  });
  const button = key => nodes.findLast(n => n.textContent === "bodySearch." + key);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const search = async () => {
    nodes.find(n => n.spec.startsWith("form")).handlers.submit({ preventDefault() {} }); await flush();
  };
  open.handlers.click();
  nodes.find(n => n.type === "search").value = "match";
  await search();
  assert.equal(reads.length, 0);
  button("original").handlers.click(); await flush();
  assert.deepEqual(reads, [0], "opening a long original never drains its pages");
  const text = nodes.findLast(n => n.spec === "textarea.search-source");
  text.selectionStart = 2; text.selectionEnd = 7;
  button("quoteSelection").handlers.click(); await flush();
  // UTF-16 textarea selection maps to code-point offsets used by search.
  assert.equal(reads.at(-1), 1);
  // Fixture deliberately returns mismatching source: fail closed.
  assert.equal(inserts.length, 0);
  button("quoteSnippet").handlers.click(); await flush();
  assert.equal(JSON.parse(inserts[0][0])[1], "captured-thread");
  assert.ok(inserts[0][1].includes(item.ref.digest));
  assert.match(inserts[0][1], /"offset":9/);
  assert.match(inserts[0][1], /> match/);
  assert.equal(navigations.length, 0);
  delayed = {};
  button("quoteSnippet").handlers.click();
  controller.dialog.close();
  delayed.resolve({ content: "match" }); await flush();
  assert.equal(inserts.length, 1, "a closed/reopened search cannot stage a stale async result");
  delayed = null;
  open.handlers.click();
  const scope = nodes.find(n => n["aria-label"] === "bodySearch.scope");
  scope.value = "current"; scope.handlers.change();
  await search();
  assert.match(searches.at(-1), /task=task-2/);
  button("locate").handlers.click();
  assert.deepEqual(navigations, ["task-1"]);
  empty = true;
  await search();
  assert.ok(nodes.some(n => n.textContent === "bodySearch.empty"));
  failure = true;
  await search();
  assert.ok(nodes.some(n => n.textContent === "bodySearch.failed offline"));
});
