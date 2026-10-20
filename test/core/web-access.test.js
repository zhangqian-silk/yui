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
import { createWebAccess, safeReturnPath } from "../../dist/web/webAccess.js";

async function signIn(base, password, extra = {}) {
  return fetch(base + "/auth/login", {
    method: "POST", redirect: "manual",
    headers: { origin: base, "content-type": "application/json", ...(extra.headers ?? {}) },
    body: JSON.stringify({ password, ...(extra.next === undefined ? {} : { next: extra.next }) })
  });
}

test("LAN access signs in through a page session before documents, APIs, previews and upgrades; Host/Origin remain bounded", async t => {
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
  assert.equal(server.access.authentication, "password");
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const basic = { authorization: `Basic ${Buffer.from(`yui:${password}`).toString("base64")}` };

  // Navigations go to the sign-in page with a safe return path; nothing sends
  // a Basic challenge, and a Basic header is no longer a credential.
  for (const [path, location] of [["/", "/login"], ["/settings/server?q=1", "/login?next=%2Fsettings%2Fserver%3Fq%3D1"]]) {
    const result = await fetch(base + path, { redirect: "manual", headers: basic });
    assert.equal(result.status, 303);
    assert.equal(result.headers.get("location"), location);
    assert.equal(result.headers.get("www-authenticate"), null);
  }
  for (const path of ["/api/projects", "/preview/task-1/example/", "/assets/app.js"]) {
    const result = await fetch(base + path, { headers: basic });
    assert.equal(result.status, 401);
    assert.equal(result.headers.get("www-authenticate"), null);
    assert.equal((await result.json()).code, "authentication-required");
  }
  const loginPage = await fetch(base + "/login?next=%2Fsettings");
  assert.equal(loginPage.status, 200);
  const loginHtml = await loginPage.text();
  assert.match(loginHtml, /id="login-password"/);
  assert.doesNotMatch(loginHtml, /page-token|yui-web-token/);
  assert.equal((await fetch(base + "/assets/js/app/login.js")).status, 200, "the sign-in module is public");
  assert.equal((await fetch(base + "/assets/js/lib/api.js")).status, 401, "workbench modules are not");
  assert.equal(reads, 0);

  // Sign-in is same-origin JSON only; failures never set a cookie.
  assert.equal((await fetch(base + "/auth/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }) })).status, 403, "Origin is required");
  assert.equal((await fetch(base + "/auth/login", { method: "POST", headers: { origin: base, "content-type": "text/plain" },
    body: JSON.stringify({ password }) })).status, 403, "a simple cross-site form body is refused");
  assert.equal((await signIn(base, password, { headers: { origin: "http://attacker.example" } })).status, 403);
  const wrong = await signIn(base, "wrong-password");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);
  assert.equal(wrong.headers.get("www-authenticate"), null);
  assert.doesNotMatch(await wrong.text(), /wrong-password/);
  assert.equal((await (await signIn(base, password, { next: "//attacker.example/x" })).json()).location, "/");
  assert.equal((await (await signIn(base, password, { next: "/api/projects" })).json()).location, "/");
  const ok = await signIn(base, password, { next: "/settings/server?q=1" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).location, "/settings/server?q=1");
  const setCookie = ok.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.doesNotMatch(setCookie, new RegExp(password));
  const session = { cookie: setCookie.split(";")[0] };
  assert.match(session.cookie, new RegExp(`^yui_session_${options.port}=`));

  // Neither the workbench nor management pages offer a sign-out control.
  for (const path of ["/", "/settings", "/models"]) {
    const page = await fetch(base + path, { headers: session });
    assert.equal(page.status, 200);
    assert.doesNotMatch(await page.text(), /sign-out|signOut|yui-web-auth/);
  }
  const back = await fetch(base + "/login?next=%2Fsettings", { headers: session, redirect: "manual" });
  assert.equal(back.status, 303);
  assert.equal(back.headers.get("location"), "/settings");
  assert.equal((await fetch(base + "/api/projects", { headers: session })).status, 403);
  assert.equal((await fetch(base + "/api/projects", {
    headers: { ...session, "x-yui-web-token": "page-token" }
  })).status, 200);
  const rawStatus = headers => new Promise((resolve, reject) => {
    const req = httpRequest(base, { headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(await rawStatus({ ...session, host: "attacker.example" }), 403);
  assert.equal(await rawStatus({ ...session, host: "127.0.0.1:1" }), 403);
  assert.equal((await fetch(base + "/", { headers: { ...session, origin: "http://attacker.example" } })).status, 403);
  assert.equal((await fetch(base + "/", { headers: { ...session, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await fetch(base + "/api/projects", {
    method: "POST", headers: { ...session, "x-yui-web-token": "page-token" }, body: "{}"
  })).status, 403, "LAN mutation requires same-origin evidence as well as the token");
  const connect = (headers, token = "page-token") => new Promise((resolve, reject) => {
    const socket = new WebSocket(base.replace("http:", "ws:")
      + `/api/terminal?scope=global&role=operator&cols=80&rows=24&token=${token}`, { headers });
    socket.on("error", reject);
    socket.once("unexpected-response", (_req, response) => {
      response.resume(); socket.terminate(); resolve({ status: response.statusCode });
    });
    socket.once("message", () => resolve({ status: 101, socket }));
  });
  const upgrade = async (headers, token) => {
    const result = await connect(headers, token);
    result.socket?.terminate();
    return result.status;
  };
  assert.equal(await upgrade({ ...basic, origin: base }), 403);
  assert.equal(await upgrade({ ...session, origin: "http://attacker.example" }), 403);
  assert.equal(await upgrade({ ...session, origin: base }, "wrong"), 403);
  assert.equal(terminals, 0);
  assert.equal(await upgrade({ ...session, origin: base }), 101);
  assert.equal(terminals, 1);
  assert.equal((await fetch(base + "/preview/task-1/example/", { headers: session })).status, 200);

  // Sign-out revokes the server session and closes its live terminal.
  const live = await connect({ ...session, origin: base });
  assert.equal(live.status, 101);
  const closed = new Promise(resolve => live.socket.once("close", resolve));
  assert.equal((await fetch(base + "/auth/logout", { method: "POST", headers: { ...session } })).status, 403);
  const out = await fetch(base + "/auth/logout", { method: "POST",
    headers: { ...session, origin: base, "content-type": "application/json" }, body: "{}" });
  assert.equal(out.status, 200);
  assert.equal((await out.json()).location, "/login?reason=signed-out");
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  await closed;
  const stale = await fetch(base + "/settings", { headers: session, redirect: "manual" });
  assert.equal(stale.status, 303);
  assert.equal(stale.headers.get("location"), "/login?next=%2Fsettings&reason=expired");
  assert.match(stale.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await fetch(base + "/api/projects", { headers: { ...session, "x-yui-web-token": "page-token" } })).status, 401);
  assert.equal(await upgrade({ ...session, origin: base }), 403);

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
  const request = { headers: {}, socket: { remoteAddress: "10.0.0.9" } };
  assert.equal(replaced.login(request, password).ok, false, "new listener rejects the previous credential");
  assert.equal(replaced.authenticated({ headers: session }), false, "and every earlier session");
});

test("Web sessions expire on idle and absolute limits, and failed sign-ins are throttled per address", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-web-session-"));
  try {
    const authFile = join(home, "password");
    const password = "session-fixture-password-32-characters";
    writeFileSync(authFile, password, { mode: 0o600 });
    let now = 1_000_000;
    const access = createWebAccess({ host: "127.0.0.1", port: 4173, authFile }, {}, {
      idleMs: 1000, absoluteMs: 5000, maxSessions: 2, failureWindowMs: 10_000, maxFailures: 3, now: () => now
    });
    const from = (remoteAddress, cookie) => ({ headers: cookie ? { cookie } : {}, socket: { remoteAddress } });
    const cookieOf = result => result.cookie.split(";")[0];
    const first = cookieOf(access.login(from("a"), password));
    assert.equal(access.authenticated(from("a", first)), true);
    now += 900;
    assert.equal(access.authenticated(from("a", first)), true, "activity refreshes the idle window");
    now += 900;
    assert.equal(access.authenticated(from("a", first)), true);
    now += 1000;
    assert.equal(access.authenticated(from("a", first)), false, "idle session expires");
    assert.equal(access.presentedSession(from("a", first)), true);
    const second = cookieOf(access.login(from("a"), password));
    for (let i = 0; i < 8; i++) { now += 700; access.authenticated(from("a", second)); }
    assert.equal(access.authenticated(from("a", second)), false, "absolute lifetime ends an active session");
    const a = cookieOf(access.login(from("a"), password));
    const b = cookieOf(access.login(from("a"), password));
    now += 1;
    access.authenticated(from("a", b));
    cookieOf(access.login(from("a"), password));
    assert.equal(access.authenticated(from("a", a)), false, "the least recently used session is evicted at capacity");
    assert.equal(access.authenticated(from("a", b)), true);

    for (let i = 0; i < 3; i++) assert.equal(access.login(from("x"), "wrong").reason, "invalid");
    const throttled = access.login(from("x"), password);
    assert.equal(throttled.reason, "throttled", "even the correct password waits out the window");
    assert.equal(throttled.retryAfterSeconds, 10);
    assert.equal(access.login(from("y"), password).ok, true, "other addresses are unaffected");
    now += 10_000;
    assert.equal(access.login(from("x"), password).ok, true);
    assert.equal(access.login(from("x"), "wrong").reason, "invalid", "success resets the failure count");

    assert.equal(safeReturnPath("/settings/server?q=1#x"), "/settings/server?q=1");
    for (const unsafe of ["//evil.example", "/\\evil.example", "https://evil.example/", "/login?next=/", "/auth/logout",
      "/api/projects", "/assets/app.js", "relative", "/\u0000x", 42]) assert.equal(safeReturnPath(unsafe), "/");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("terminal sockets recheck the browser session before relaying output, input, resize or ready, without waiting for the sweep", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-web-terminal-session-"));
  const authFile = join(home, "password");
  const password = "terminal-session-fixture-password-32-chars";
  writeFileSync(authFile, password + "\n", { mode: 0o600 });
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  const opened = [];
  let gate;
  let server;
  t.after(async () => {
    Date.now = realNow;
    if (server) {
      server.closeTerminals();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    rmSync(home, { recursive: true, force: true });
  });
  // A disposable terminal port: nothing runs; each connection records what
  // the server relays to it and lets the test emit output on demand.
  const terminal = { async open() {
    const record = { writes: [], resizes: [], closed: 0, listeners: [] };
    opened.push(record);
    if (gate) await gate.promise;
    return {
      readOnly: false,
      history: { limit: 10, target: 10 },
      onData(listener) { record.listeners.push(listener); return () => { record.listeners = record.listeners.filter(l => l !== listener); }; },
      onExit: () => () => {},
      write(data) { record.writes.push(data); },
      resize(columns, rows) { record.resizes.push([columns, rows]); },
      close() { record.closed++; }
    };
  } };
  server = createYuiWebServer({}, { token: "page-token", terminal },
    parseWebCommandOptions(["--host", "127.0.0.1", "--auth-file", authFile]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const signInCookie = async () => {
    const response = await signIn(base, password);
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  // Opens a terminal and resolves once the socket is open; frames and the
  // close code are collected for later assertions.
  const open = cookie => new Promise((resolve, reject) => {
    const socket = new WebSocket(base.replace("http:", "ws:")
      + "/api/terminal?scope=global&role=operator&cols=80&rows=24&token=page-token",
      { headers: { cookie, origin: base } });
    const frames = [];
    const closed = new Promise(done => socket.once("close", code => done(code)));
    socket.on("message", data => frames.push(JSON.parse(String(data))));
    socket.once("error", reject);
    socket.once("open", () => resolve({ socket, frames, closed, record: () => opened.at(-1) }));
  });
  const ready = async connection => {
    while (!connection.frames.some(frame => frame.type === "ready")) await new Promise(r => setTimeout(r, 5));
    return connection;
  };
  const expire = () => { skew += 25 * 60 * 60 * 1000; };

  // While the session is valid, output, input and resize are relayed.
  const valid = await ready(await open(await signInCookie()));
  const validRecord = valid.record();
  validRecord.listeners.forEach(listener => listener("output-before-expiration"));
  valid.socket.send(JSON.stringify({ type: "input", data: "input-before-expiration" }));
  valid.socket.send(JSON.stringify({ type: "resize", columns: 100, rows: 30 }));
  while (validRecord.resizes.length === 0) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(validRecord.writes, ["input-before-expiration"]);
  assert.ok(valid.frames.some(frame => frame.type === "data" && frame.data === "output-before-expiration"));
  valid.socket.terminate();

  // Output produced after expiry, before any sweep tick, is never sent.
  const outputCookie = await signInCookie();
  const output = await ready(await open(outputCookie));
  const outputRecord = output.record();
  expire();
  assert.equal((await fetch(base + "/api/projects", { headers: { cookie: outputCookie, "x-yui-web-token": "page-token" } })).status, 401);
  outputRecord.listeners.forEach(listener => listener("output-after-expiration"));
  assert.equal(await output.closed, 1008);
  assert.equal(output.frames.some(frame => frame.type === "data"), false);
  assert.equal(outputRecord.closed, 1);
  skew = 0;

  // Input and resize sent after expiry reach neither write nor resize.
  for (const message of [{ type: "input", data: "input-after-expiration" }, { type: "resize", columns: 120, rows: 40 }]) {
    const connection = await ready(await open(await signInCookie()));
    const record = connection.record();
    expire();
    connection.socket.send(JSON.stringify(message));
    assert.equal(await connection.closed, 1008);
    assert.deepEqual(record.writes, []);
    assert.deepEqual(record.resizes, []);
    assert.equal(record.closed, 1);
    skew = 0;
  }

  // A terminal whose asynchronous open resolves after expiry sends neither
  // ready nor history, and its connection is released.
  let release;
  gate = { promise: new Promise(resolve => { release = resolve; }) };
  const before = opened.length;
  const pending = await open(await signInCookie());
  while (opened.length === before) await new Promise(r => setTimeout(r, 5));
  const pendingRecord = opened[before];
  expire();
  release();
  assert.equal(await pending.closed, 1008);
  assert.deepEqual(pending.frames, []);
  assert.equal(pendingRecord.closed, 1);
  assert.equal(pendingRecord.listeners.length, 0, "no output listener is attached to an expired terminal");
  gate = undefined;
  skew = 0;

  // An evicted session (beyond the session cap) is treated the same way.
  const evicted = await ready(await open(await signInCookie()));
  const evictedRecord = evicted.record();
  for (let index = 0; index < 32; index++) await signInCookie();
  evicted.socket.send(JSON.stringify({ type: "input", data: "input-after-eviction" }));
  assert.equal(await evicted.closed, 1008);
  assert.deepEqual(evictedRecord.writes, []);
});

test("loopback without a credential file needs no sign-in and redirects the sign-in page home", async t => {
  const server = createYuiWebServer({}, { token: "page-token" }, { host: "127.0.0.1", port: 4173 });
  t.after(async () => { server.closeTerminals(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /sign-out|signOut|yui-web-auth/);
  const login = await fetch(base + "/login?next=%2Fsettings", { redirect: "manual" });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/settings");
  assert.equal((await signIn(base, "anything")).status, 404);
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
