import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createWebTaskSurface } from "../../dist/web/webTaskSurface.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";
import { runIterationCommand } from "../../dist/commands/iterationCommands.js";

test("Web creates only an explicit experimental Draft and reads fixed knowledge through authenticated endpoints", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-iteration-web-"));
  const store = new SqliteTaskStore(home);
  let server;
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    store.close(); rmSync(home, { recursive: true, force: true });
  });
  const now = new Date();
  const agent = createConfiguredAgent("fixture", "codex", "unused", [], [], now);
  store.saveConfiguredAgent(agent);
  store.saveGlobalRole(createGlobalRole("leader", [createRoleAgentBinding(agent)], agent.id, home, now));
  const surface = createWebTaskSurface(store, { yuiHome: home });
  server = createYuiWebServer(store, { surface, token: "iteration-fixture" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "x-yui-web-token": "iteration-fixture", "content-type": "application/json" };
  const created = await fetch(base + "/api/tasks", { method: "POST", headers, body: JSON.stringify({
    title: "Experiment", requirements: "Only offline fixtures", projectIds: [], plan: false,
    requestId: "create-experiment", mode: "experiment"
  }) });
  assert.equal(created.status, 200);
  const { task } = await created.json();
  assert.equal(task.status, "draft");
  assert.equal(store.getRole(task.id, "leader").template, "experiment-leader");
  assert.equal(store.listRuns(task.id).length, 0);
  const initialized = await runIterationCommand(["init", task.id], store, {});
  const record = { schemaVersion: 1, kind: "direction", id: "latency", title: "<script>unsafe</script>",
    problem: "slow", goal: "faster", metrics: ["p95"], constraints: ["offline only"], priority: "high",
    status: "active", next: "paired measurement", unresolved: ["dataset"] };
  const saved = await runIterationCommand(["save", task.id, JSON.stringify(record), "--request-id", "direction",
    "--expected-head", initialized.commit], store, {});
  const endpoint = base + `/api/tasks/${task.id}/iteration`;
  assert.notEqual((await fetch(endpoint)).status, 200);
  const current = await (await fetch(endpoint, { headers })).json();
  assert.equal(current.directions[0].goal, "faster");
  const pinned = await (await fetch(endpoint + "?" + new URLSearchParams({ ref: JSON.stringify(saved.ref) }), { headers })).json();
  assert.equal(pinned.value.title, "<script>unsafe</script>", "API returns data, never executable HTML");
  assert.equal((await fetch(endpoint, { headers, method: "POST", body: "{}" })).status, 405);
  const workbench = await (await fetch(base + `/api/tasks/${task.id}/workbench`, { headers })).json();
  assert.equal(workbench.task.mode, "experiment");
  assert.match(workbench.core.iteration.read, /iteration overview/);
});
