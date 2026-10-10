import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDurableJob, startDurableJob } from "../../dist/job/durableJob.js";
import { createTaskPreviews } from "../../dist/web/taskPreviews.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";
import { httpPreviewSocket, prepareHttpPreview, validateHttpPreview } from "../../dist/job/httpPreview.js";
import { jobPreviewSocketRoot } from "../../dist/storage/homeLayout.js";
import { PREVIEW_SCRIPT } from "../../dist/web/assets/client/views/dock/preview.js";

test("registered HTTP preview uses only its exact Job socket and an isolated, revocable ticket", async t => {
  const home = mkdtempSync(join(tmpdir(), "yp-"));
  let web, app, endpoint;
  t.after(async () => {
    for (const server of [web, app]) {
      if (!server?.listening) continue;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    if (endpoint) {
      // The deliberate invalid symlink is fixture-owned, not runtime cleanup.
      rmSync(endpoint.socket, { force: true });
      endpoint.cleanup();
    }
    rmSync(home, { recursive: true, force: true });
  });
  const now = new Date();
  let job = startDurableJob(createDurableJob({
    id: "job-1", taskId: "task-1", owner: { kind: "task" }, projectId: "project-1",
    workspace: home, head: "a".repeat(40), env: { YUI_HTTP_PREVIEW: "1" },
    steps: [{ name: "demo", command: "fixture" }], artifactsLocator: "artifacts/jobs/task-1/job-1",
    operation: { requestId: "fixture", actorId: "fixture", authorityRef: "fixture", inputDigest: "a".repeat(64) }
  }, now), { pid: process.pid, startIdentity: "fixture" }, now);
  const store = {
    getTask: id => id === "task-1" ? { status: "active", executionGate: { state: "enabled" } } : null,
    listDurableJobs: id => id === "task-1" ? [job] : [],
    getDurableJob: (task, id) => task === "task-1" && id === job.id ? job : null,
    saveDurableJob: (_task, next) => { job = next; },
    transaction: fn => fn(store)
  };
  const dependencies = { previews: () => createTaskPreviews(store, home), token: "control-secret" };
  web = createYuiWebServer(store, dependencies);
  await new Promise(resolve => web.listen(0, "127.0.0.1", resolve));
  let base = `http://127.0.0.1:${web.address().port}`;
  const headers = { "x-yui-web-token": "control-secret" };
  const listPath = "/api/tasks/task-1/previews";
  assert.equal((await fetch(base + listPath)).status, 403);
  let listing = await (await fetch(base + listPath, { headers })).json();
  assert.equal(listing.services[0].state, "starting");
  assert.equal(listing.services[0].url, undefined);
  const socketDir = join(home, job.artifactsLocator);
  mkdirSync(socketDir, { recursive: true });
  endpoint = prepareHttpPreview(socketDir);
  const received = [];
  app = createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    res.setHeader("set-cookie", "control=stolen");
    res.setHeader("content-security-policy", "default-src * 'unsafe-inline'");
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/" }); res.end(); return; }
    if (req.url === "/compressed") { res.writeHead(200, { "content-encoding": "gzip" }); res.end("not identity"); return; }
    res.setHeader("content-type", req.url === "/app.js" ? "text/javascript" : "text/html");
    res.end(req.url === "/app.js" ? "document.body.dataset.ready='yes'" : '<h1>Live fixture</h1><script src="app.js"></script>');
  });
  await new Promise(resolve => app.listen(endpoint.socket, resolve));
  listing = await (await fetch(base + listPath, { headers })).json();
  let service = listing.services[0];
  assert.equal(service.state, "ready");
  assert.ok(service.url.startsWith("/preview/task-1/job-1/"));
  const page = await fetch(base + service.url, { headers: { cookie: "secret=yes", authorization: "Bearer secret", "x-yui-web-token": "control-secret" } });
  assert.match(await page.text(), /Live fixture/);
  assert.match(page.headers.get("content-security-policy"), /sandbox allow-scripts/);
  assert.doesNotMatch(page.headers.get("content-security-policy"), /allow-same-origin/);
  assert.equal(page.headers.get("set-cookie"), null);
  assert.equal(page.headers.get("access-control-allow-origin"), "null");
  assert.equal(received.at(-1).headers.cookie, undefined);
  assert.equal(received.at(-1).headers.authorization, undefined);
  assert.equal(received.at(-1).headers["x-yui-web-token"], undefined);
  assert.equal((await fetch(base + service.url + "app.js")).status, 200);
  assert.equal((await fetch(base + service.url + "redirect", { redirect: "manual" })).status, 502);
  assert.equal((await fetch(base + service.url + "compressed")).status, 502);
  assert.equal((await fetch(base + service.url.replace("task-1", "task-2"))).status, 403);
  assert.equal((await fetch(base + service.url.replace("job-1", "job-2"))).status, 403);
  assert.equal((await fetch(base + service.url + "?url=http://localhost:1")).status, 200);
  assert.equal(received.at(-1).url, "/?url=http://localhost:1", "query remains data for the registered service");
  assert.equal((await fetch(base + service.url, { method: "POST", body: "not forwarded" })).status, 405);
  web.closeAllConnections();
  await new Promise(resolve => web.close(resolve));
  web = createYuiWebServer(store, dependencies);
  await new Promise(resolve => web.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${web.address().port}`;
  assert.equal((await fetch(base + service.url)).status, 403, "a restarted listener revokes old tickets");
  service = (await (await fetch(base + listPath, { headers })).json()).services[0];
  // Merely closing a page does not request cancellation.
  assert.equal(job.cancelRequestedAt, undefined);
  const stop = await fetch(base + listPath + "/job-1/stop", {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}"
  });
  assert.equal(stop.status, 200);
  assert.ok(job.cancelRequestedAt);
  assert.equal((await fetch(base + service.url)).status, 409);
  assert.equal((await (await fetch(base + listPath, { headers })).json()).services[0].state, "stopping");
  job = { ...job, status: "cancelled", result: { outcome: "cancelled", steps: [], exitCode: null, signal: null } };
  assert.equal((await (await fetch(base + listPath, { headers })).json()).services[0].state, "stopped");
  // A socket symlink must never turn the fixed service path into an arbitrary endpoint.
  await new Promise(resolve => app.close(resolve));
  symlinkSync("/does-not-exist", endpoint.socket);
  job = { ...job, status: "running", cancelRequestedAt: undefined };
  assert.equal((await (await fetch(base + listPath, { headers })).json()).services[0].state, "failed");
});

test("foreground preview Job receives an exact endpoint and cancellation cleans its socket", async t => {
  const home = mkdtempSync(join(tmpdir(), "yp-run-"));
  const artifactDir = join(home, "artifacts/jobs/task-1/job-1");
  let runner, exited;
  t.after(async () => {
    if (runner && runner.exitCode === null && runner.signalCode === null) runner.kill("SIGTERM");
    if (exited) await exited;
    assert.equal(existsSync(jobPreviewSocketRoot(artifactDir)), false, "exact socket cleanup must finish");
    rmSync(home, { recursive: true, force: true });
  });
  assert.throws(() => validateHttpPreview({ YUI_HTTP_PREVIEW: "1" }, []), /one foreground/);
  assert.throws(() => validateHttpPreview({ YUI_PREVIEW_SOCKET: "/arbitrary" }, []), /assigned/);
  mkdirSync(artifactDir, { recursive: true });
  const script = "const http=require('node:http'); const s=http.createServer((q,r)=>r.end('real service'));"
    + "s.listen(process.env.YUI_PREVIEW_SOCKET);";
  const specPath = join(home, "spec.json");
  writeFileSync(specPath, JSON.stringify({
    jobId: "job-1", taskId: "task-1", workspace: home, env: { YUI_HTTP_PREVIEW: "1" },
    steps: [{ name: "server", command: "node fixture", argv: [process.execPath, "-e", script], timeoutMs: 3000 }],
    defaultStepTimeoutMs: 3000, artifactDir, head: "a".repeat(40)
  }));
  runner = spawn(process.execPath, ["dist/job/jobRunner.js", specPath], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  runner.stderr.on("data", chunk => { stderr += chunk; });
  exited = once(runner, "exit");
  const socketPath = httpPreviewSocket(artifactDir);
  for (let i = 0; i < 100 && !existsSync(socketPath) && runner.exitCode === null; i++) await delay(10);
  assert.ok(existsSync(socketPath), stderr);
  const body = await new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/" }, res => {
      let text = ""; res.on("data", c => { text += c; }); res.on("end", () => resolve(text));
    });
    req.on("error", reject); req.end();
  });
  assert.equal(body, "real service");
  runner.kill("SIGTERM");
  assert.equal((await exited)[0], 0, stderr);
  const receipt = JSON.parse(readFileSync(join(artifactDir, "exit.json"), "utf8"));
  assert.equal(receipt.outcome, "cancelled");
  assert.equal(existsSync(jobPreviewSocketRoot(artifactDir)), false);
});

test("preview view mounts a sandbox, opens an isolated window, and close never stops a Job", async () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.attributes = {}; }
    append(node) { node.parent = this; this.children.push(node); }
    replaceChildren() { this.children = []; }
    remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(key, callback) { this.events[key] = callback; }
  }
  const root = new Element("section");
  const writes = [];
  let state = "ready", timer;
  const runtime = vm.createContext({
    document: { createElement: tag => new Element(tag) }, AbortSignal,
    clearTimeout() {}, setTimeout: callback => { timer = callback; },
    requestJson: async () => ({ complete: true, services: [{
      id: "job-1", name: "<not-html>", state, detail: "HTTP 200", readAt: "now", canStop: true,
      ...(state === "ready" ? { url: "/preview/task-1/job-1/ticket/" } : {})
    }] }),
    submitMutation: async (...args) => { writes.push(args); state = "stopping"; return { stopped: false }; }
  });
  vm.runInContext(PREVIEW_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), runtime);
  const controller = runtime.createPreviewController(root, key => key);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const all = node => [node, ...node.children.flatMap(all)];
  controller.open("task-1"); await settle();
  let frame = all(root).find(node => node.tag === "iframe");
  assert.equal(frame.attributes.sandbox, "allow-scripts");
  assert.equal(frame.referrerPolicy, "no-referrer");
  const link = all(root).find(node => node.tag === "a");
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(link.href, frame.src);
  controller.close();
  assert.equal(writes.length, 0);
  assert.equal(root.children.length, 0);
  timer(); await settle();
  assert.equal(root.children.length, 0, "closed views cannot be repopulated by a stale poll");
  controller.open("task-1"); await settle();
  await all(root).find(node => node.textContent === "preview.stop").events.click();
  await settle();
  assert.equal(writes.length, 1);
  assert.match(writes[0][1], /task-1\/previews\/job-1\/stop$/);
  assert.equal(all(root).find(node => node.tag === "iframe"), undefined);
  controller.close();
});
