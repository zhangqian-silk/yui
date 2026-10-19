import assert from "node:assert/strict";
import test from "node:test";
import { createWebPermissions } from "../../dist/web/webPermissions.js";
import { discoveryCommandTree } from "../../dist/cli/commandDiscovery.js";
import { BUILTIN_CAPABILITIES } from "../../dist/kernel/builtinCapabilities.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";

function fixture() {
  // Any private read or write is a failure, including provider/Grant access.
  return createWebPermissions(new Proxy({
    listGlobalRoles: () => [{ name: "operator" }, { name: "researcher",
      systemPrompt: "private-prompt", agentBindings: { secret: "private-binding" } }]
  }, { get(target, key) {
    if (!(key in target)) throw new Error(`Unexpected store access: ${String(key)}`);
    return target[key];
  } }));
}
function paths(node) {
  return [...(node.kind !== "group" ? [node.path.join(" ")] : []), ...node.children.flatMap(paths)];
}

test("permission templates cover the CLI projection without authenticating roles or evaluating targets", () => {
  const service = fixture();
  const meta = service.index();
  assert.ok(meta.roles.some(r => r.id === "global:researcher" && r.audience === "global"));
  const rows = [];
  let cursor = "0";
  do {
    const page = service.commands({ cursor });
    assert.ok(page.items.length <= 30);
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  for (const role of meta.roles) {
    const expected = paths(discoveryCommandTree({}, role.audience)).sort();
    const actual = rows.filter(row => service.command(row.id, role.id).roles[0].visible).map(r => r.id).sort();
    assert.deepEqual(actual, expected, role.id);
  }
  assert.ok(rows.some(r => r.id === "yui schedule create"));
  assert.ok(rows.some(r => r.id === "yui job start"));
  assert.ok(!rows.some(r => r.id.startsWith("yui internal")));
  const worker = service.command("yui task message send", "worker");
  assert.equal(worker.roles[0].visible, true);
  assert.doesNotMatch(worker.roles[0].usage.join(" "), /--intent/);
  assert.equal(service.command("yui task work dispatch", "worker").roles[0].visible, false);
  assert.equal(service.command("yui task work dispatch", "leader").roles[0].visible, true);
  assert.equal(worker.evaluation, "not-performed");
  const capabilities = service.capabilities();
  assert.deepEqual(capabilities.items.map(c => c.name), BUILTIN_CAPABILITIES.slice(0, 30).map(c => c.name));
  assert.ok(capabilities.items.every(c => !("access" in c)));
  assert.ok(capabilities.items.find(c => c.name === "resource.local.read").requiredInputs.includes("resourceId"));
  assert.doesNotMatch(JSON.stringify([meta, rows, worker, capabilities]), /private-prompt|private-binding/);
  assert.throws(() => service.commands({ cursor: "-1" }));
  assert.throws(() => service.commands({ role: "task-99/leader" }));
  assert.throws(() => service.command("yui internal agent-host", "operator"));
});

test("permission HTTP surface is GET-only and retains token/Origin protection", async t => {
  const server = createYuiWebServer({}, { permissions: fixture(), token: "permission-test" });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "x-yui-web-token": "permission-test" };
  assert.equal((await fetch(base + "/settings/permissions")).status, 200);
  assert.equal((await fetch(base + "/api/permissions")).status, 403);
  assert.equal((await fetch(base + "/api/permissions", { headers: { ...headers, origin: "http://evil.invalid" } })).status, 403);
  for (const route of ["", "/commands", "/command?id=yui%20task%20show", "/capabilities"]) {
    assert.equal((await fetch(base + "/api/permissions" + route, { headers })).status, 200);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal((await fetch(base + "/api/permissions" + route, { headers, method })).status, 405);
    }
  }
  assert.equal((await fetch(base + "/api/permissions/commands?task=private-task", { headers })).status, 400);
  assert.equal((await fetch(base + "/api/permissions/commands?role=leader&role=operator", { headers })).status, 400);
  assert.equal((await fetch(base + "/api/permissions/call", { headers })).status, 404);
});
