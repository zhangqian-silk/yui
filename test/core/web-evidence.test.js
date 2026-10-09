import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask } from "../../dist/task/task.js";
import { saveArtifactCapability } from "../../dist/artifacts/artifactCapability.js";
import { createWebTaskSurface } from "../../dist/web/webTaskSurface.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";
import { WEB_ASSETS } from "../../dist/web/assets/assetManifest.js";
import { RECORDS_SCRIPT } from "../../dist/web/assets/client/records.js";
import { API_SCRIPT } from "../../dist/web/assets/client/api.js";

test("Web source reads expose exact message control facts and the original report without writing", async () => {
  const element = (spec, attrs, ...children) => ({
    spec, dataset: {}, disabled: false, children: children.filter(child => child != null), handlers: {},
    append(...items) { this.children.push(...items); },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    replaceChildren(...items) { this.children = items; },
    remove() { this.removed = true; }
  });
  const context = vm.createContext({
    h: element, icon: name => element(name), mono: text => text, note: text => text,
    button: text => element("button", null, text),
    richText: (title, text) => element("report", null, title, text)
  });
  vm.runInContext(RECORDS_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const ref = { store: "task-message", refId: "message-1", revision: 3, digest: "exact-digest" };
  const value = { body: "Summary", inputControl: { action: "steer", requestId: "request-1" },
    control: { outcome: "delivery-unknown" } };
  const calls = [];
  let finish;
  const reader = context.recordReader({ ref, value, omitted: false }, "task-1", key => key, {
    inspect: (...args) => {
      calls.push(args);
      return new Promise(resolve => { finish = resolve; });
    }
  });
  const open = reader.children[0].children[0];
  const pending = open.handlers.click();
  assert.equal(open.disabled, true);
  assert.equal(reader.dataset.reading, "true");
  assert.deepEqual(calls, [["task-1", ref]], "use the Context reference including its digest");
  finish({ value, result: { output: "Original report", diagnostic: "Original diagnostic" } });
  await pending;
  assert.equal(reader.dataset.reading, "false");
  assert.equal(open.removed, true);
  assert.match(JSON.stringify(reader.children), /delivery-unknown.*Original report|Original report.*delivery-unknown/u);
  assert.match(JSON.stringify(reader.children), /Original diagnostic/u);
  assert.equal(calls.length, 1, "only the explicitly requested source read is performed");
});

test("authenticated Web evidence reads keep a fixed Task file and cannot mutate or escape its repository", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-web-evidence-"));
  const store = new SqliteTaskStore(home);
  let server;
  t.after(async () => {
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
  store.saveTask(createTask("task-1", "Read evidence", new Date()));
  const first = await saveArtifactCapability(home, "task-1", { relativePath: "plans/result.html",
    content: "<script>throw new Error('must stay text')</script>old result" });
  const surface = createWebTaskSurface(store);
  server = createYuiWebServer(store, { surface, token: "fixture-token" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/tasks/task-1/artifacts`;
  const headers = { "x-yui-web-token": "fixture-token" };
  assert.equal((await fetch(url)).status, 403);
  const list = await (await fetch(url, { headers })).json();
  assert.equal(list.commit, first.commit);
  const second = await saveArtifactCapability(home, "task-1", { relativePath: "plans/result.html", content: "new result" });
  const read = await fetch(url + "?" + new URLSearchParams({ path: "plans/result.html", commit: list.commit }), { headers });
  assert.match(read.headers.get("content-type"), /application\/json/);
  assert.equal((await read.json()).content, "<script>throw new Error('must stay text')</script>old result");
  assert.equal((await fetch(url + "?path=plans/result.html", { headers })).status, 409);
  assert.equal((await fetch(url + "?" + new URLSearchParams({ path: "../task-2/secret", commit: first.commit }), { headers })).status, 409);
  assert.equal((await fetch(url + "?" + new URLSearchParams({ path: "plans/result.html", commit: "0".repeat(40) }), { headers })).status, 409);
  assert.equal((await fetch(url, { method: "POST", headers })).status, 405);
  assert.equal((await surface.artifacts("task-1")).commit, second.commit);
  assert.equal(store.listMessages("task-1").length, 0);
  const base = `http://127.0.0.1:${server.address().port}`;
  // Paged family discovery is the same read-only summary list as the CLI.
  const listUrl = base + "/api/tasks/task-1/list?store=task-message&limit=5";
  assert.equal((await fetch(listUrl)).status, 403);
  const page = await (await fetch(listUrl, { headers })).json();
  assert.equal(page.total, 0);
  assert.deepEqual(page.items, []);
  assert.equal((await fetch(base + "/api/tasks/task-1/list?store=unknown-family", { headers })).status, 409);
  assert.equal((await fetch(listUrl.replace("limit=5", "limit=abc"), { headers })).status, 409);
  assert.equal((await fetch(listUrl, { method: "POST", headers })).status, 405);
  store.saveTask(createTask("task-2", "Different page", new Date()));
  const catalog = await (await fetch(base + "/api/dashboard?search=Read", { headers })).json();
  const sessions = await (await fetch(base + "/api/dashboard/sessions?search=Read", { headers })).json();
  assert.deepEqual(catalog.tasks.map(task => task.id), ["task-1"]);
  assert.deepEqual(sessions.tasks.map(task => task.taskId), ["task-1"]);
  assert.equal(sessions.scope, "current-catalog-page");
  assert.equal(catalog.sessions, undefined, "compact discovery must not load Session observations");
  assert.equal((await fetch(base + "/api/dashboard/sessions")).status, 403);
  assert.equal((await fetch(base + "/api/dashboard/sessions?view=compact", { headers })).status, 400,
    "do not restore the retired view selector");
  const description = "完整报告🙂".repeat(3000);
  store.saveTask(createTask("task-3", "Long original", new Date(), { description }));
  const snapshot = await surface.read("task-3");
  const ref = snapshot.records.find(entry => entry.ref.store === "task").ref;
  const client = vm.createContext({
    document: { querySelector: () => ({ content: "fixture-token" }) }, URLSearchParams,
    fetch: (path, options) => fetch(base + path, options)
  });
  vm.runInContext(API_SCRIPT.replace(/^export /gm, "") + "\nglobalThis.clientApi = api;", client);
  const original = await client.clientApi.inspect("task-3", ref);
  assert.equal(original.value?.description, description, "Web must collect all exact original pages before parsing");
  // The shipped UI is JavaScript carried by TypeScript strings; tsc alone
  // cannot catch a syntax error that would make every Task inaccessible.
  for (const [path, asset] of Object.entries(WEB_ASSETS).filter(([path]) => path.endsWith(".js"))) {
    new vm.Script(asset.body.replace(/^import[\s\S]*?;$/gm, "").replace(/^export /gm, ""), { filename: path });
  }
});
