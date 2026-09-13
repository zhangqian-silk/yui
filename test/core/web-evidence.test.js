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
  // The shipped UI is JavaScript carried by TypeScript strings; tsc alone
  // cannot catch a syntax error that would make every Task inaccessible.
  for (const [path, asset] of Object.entries(WEB_ASSETS).filter(([path]) => path.endsWith(".js"))) {
    new vm.Script(asset.body.replace(/^import[\s\S]*?;$/gm, "").replace(/^export /gm, ""), { filename: path });
  }
});
