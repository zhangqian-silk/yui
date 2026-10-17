import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import WebSocket from "ws";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createYuiWebServer, parseWebCommandOptions } from "../../dist/web/webServer.js";
import { createControllerWeb } from "../../dist/web/controllerWeb.js";
import { createWebAccess } from "../../dist/web/webAccess.js";

test("LAN access authenticates before documents, APIs, previews and upgrades; Host/Origin remain bounded", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-web-access-"));
  const authFile = join(home, "password");
  const password = "isolated-fixture-password-32-characters";
  writeFileSync(authFile, password + "\n", { mode: 0o600 });
  let server;
  t.after(async () => {
    if (server) {
      server.closeTerminals();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    rmSync(home, { recursive: true, force: true });
  });
  assert.throws(() => parseWebCommandOptions(["--host", "0.0.0.0"]), /auth-file/);
  const options = parseWebCommandOptions(["--host", "0.0.0.0", "--auth-file", authFile]);
  assert.equal(options.host, "0.0.0.0");
  let reads = 0;
  let terminals = 0;
  server = createYuiWebServer({}, {
    token: "page-token",
    surface: { projects() { reads++; return { projects: [] }; } },
    previews: () => ({ authenticated: () => false, serve(_req, res) { reads++; res.end("preview"); } }),
    terminal: { async open() {
      terminals++;
      return { readOnly: true, onData: () => () => {}, onExit: () => () => {},
        write() {}, resize() {}, close() {} };
    } }
  }, options);
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Basic ${Buffer.from(`yui:${password}`).toString("base64")}` };
  for (const path of ["/", "/api/projects", "/preview/task-1/example/", "/assets/app.js"]) {
    const result = await fetch(base + path);
    assert.equal(result.status, 401);
    assert.match(result.headers.get("www-authenticate"), /Basic/);
    assert.doesNotMatch(await result.text(), /page-token/);
  }
  assert.equal(reads, 0);
  assert.equal((await fetch(base + "/", { headers: auth })).status, 200);
  assert.equal((await fetch(base + "/api/projects", { headers: auth })).status, 403);
  assert.equal((await fetch(base + "/api/projects", {
    headers: { ...auth, "x-yui-web-token": "page-token" }
  })).status, 200);
  const rawStatus = headers => new Promise((resolve, reject) => {
    const req = httpRequest(base, { headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(await rawStatus({ ...auth, host: "attacker.example" }), 403);
  assert.equal(await rawStatus({ ...auth, host: "127.0.0.1:1" }), 403);
  assert.equal((await fetch(base + "/", { headers: { ...auth, origin: "http://attacker.example" } })).status, 403);
  assert.equal((await fetch(base + "/", { headers: { ...auth, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await fetch(base + "/api/projects", {
    method: "POST", headers: { ...auth, "x-yui-web-token": "page-token" }, body: "{}"
  })).status, 403, "LAN mutation requires same-origin evidence as well as the token");
  const upgrade = (headers, token = "page-token") => new Promise((resolve, reject) => {
    const socket = new WebSocket(base.replace("http:", "ws:")
      + `/api/terminal?scope=global&role=operator&cols=80&rows=24&token=${token}`, { headers });
    socket.on("error", reject);
    socket.once("unexpected-response", (_req, response) => {
      response.resume(); socket.terminate(); resolve(response.statusCode);
    });
    socket.once("message", () => { socket.terminate(); resolve(101); });
  });
  assert.equal(await upgrade({ origin: base }), 403);
  assert.equal(await upgrade({ ...auth, origin: "http://attacker.example" }), 403);
  assert.equal(await upgrade({ ...auth, origin: base }, "wrong"), 403);
  assert.equal(terminals, 0);
  assert.equal(await upgrade({ ...auth, origin: base }), 101);
  assert.equal(terminals, 1);
  assert.equal((await fetch(base + "/preview/task-1/example/", { headers: auth })).status, 200);
  chmodSync(authFile, 0o644);
  assert.throws(() => createWebAccess(options), /owner-only/);
  chmodSync(authFile, 0o600);
  const empty = createWebAccess(options, {});
  assert.deepEqual(empty.urls, []);
  assert.ok(empty.warnings.some(warning => warning.includes("No usable")));
  const interfaces = { fixture: [
    { address: "10.1.2.3", family: "IPv4" }, { address: "192.168.4.5", family: "IPv4" },
    { address: "fd00:0000::1", family: "IPv6" }, { address: "203.0.113.4", family: "IPv4" },
    { address: "fe80::1", family: "IPv6" }
  ] };
  assert.deepEqual(createWebAccess(options, interfaces).urls, ["http://10.1.2.3:4173", "http://192.168.4.5:4173"]);
  assert.deepEqual(createWebAccess({ ...options, host: "::" }, interfaces).urls,
    ["http://10.1.2.3:4173", "http://192.168.4.5:4173", "http://[fd00::1]:4173"]);
  writeFileSync(authFile, "new-isolated-fixture-password-32-characters");
  const replaced = createWebAccess(options);
  assert.equal(replaced.authenticated({ headers: auth }), false, "new listener rejects the previous credential");
});

test("Web lifecycle rejects absent and Task callers before reading or opening the user ingress", async () => {
  const web = createControllerWeb({}, {});
  await assert.rejects(web.dispatch("web.status", {}), /caller/i);
  await assert.rejects(web.dispatch("web.status", {
    caller: { scope: "task", taskId: "task-1", role: "leader", nativeSessionId: "test" }
  }), /Operator/);
  assert.equal(await web.dispatch("web.status", { caller: { scope: "user" } }), null);
  const role = { name: "operator", activeAgentId: "codex", agentBindings: { codex: { agentId: "codex", adapterId: "codex" } } };
  const session = { agentId: "codex", adapterId: "codex", nativeSessionId: "current",
    status: "active", effective: { workspace: { root: "/fixture" } } };
  const managed = createControllerWeb({
    getGlobalRole: () => role,
    getGlobalRoleSessionSet: () => ({ activeAgentId: "codex", sessions: { codex: session } })
  }, {});
  const caller = { scope: "global", role: "operator", agentId: "codex", adapterId: "codex", nativeSessionId: "current" };
  assert.equal(await managed.dispatch("web.status", { caller }), null);
  await assert.rejects(managed.dispatch("web.status", { caller: { ...caller, nativeSessionId: "old" } }), /current managed/);
  await assert.rejects(managed.dispatch("web.status", { caller: { ...caller, role: "custom" } }), /Operator/);
  session.status = "released";
  await assert.rejects(managed.dispatch("web.status", { caller }), /current managed/);
});

test("Controller shutdown owns an in-flight Web bind and leaves no surviving listener", async t => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const web = createControllerWeb({}, {});
  t.after(() => web.close());
  const starting = web.dispatch("web.start", {
    id: "shutdown-race", host: "127.0.0.1", port, caller: { scope: "user" }
  });
  const refused = assert.rejects(starting, /shut down/);
  await Promise.all([refused, web.close()]);
  assert.equal(await web.dispatch("web.status", { caller: { scope: "user" } }), null);
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
});
