// Real CLI -> Controller -> SQLite -> HTTP smoke. Only the external Codex
// protocol is deterministic. No Store injection, HTTP interception or account.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { jobPreviewSocketRoot } from "../dist/storage/homeLayout.js";
import { startFaultProxy } from "../test/fixtures/web-fault-proxy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serve = process.argv.includes("--serve");
const port = Number(process.env.YUI_SMOKE_PORT ?? 18819);
const evidence = resolve(process.env.YUI_SMOKE_EVIDENCE ?? join(root, "output/web-runtime-smoke", new Date().toISOString().replaceAll(":", "-")));
mkdirSync(evidence, { recursive: true });
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "yui-web-runtime-")));
const home = join(sandbox, "home");
const bin = join(sandbox, "bin");
const cli = join(root, "output/dev/bin/yui");
const tmuxServer = `yui-${createHash("sha256").update(home).digest("hex").slice(0, 24)}`;
const env = {
  HOME: sandbox, CODEX_HOME: join(sandbox, "codex"), YUI_HOME: home,
  PATH: `${bin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  TMPDIR: join(sandbox, "tmp"), NO_COLOR: "1",
  GIT_AUTHOR_NAME: "Regression Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Regression Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid"
};
const report = {
  commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
  node: process.version, platform: `${process.platform}-${process.arch}`, cli, sandbox, home, tmuxServer, fixturePid: process.pid,
  startedAt: new Date().toISOString(), checks: [], commands: [], http: [], cleanup: {}
};
let web, webExit, token, task, project, stopProxy;
const jobs = [];
const activated = [];
let shuttingDown = false;
let cleaning = false;
const shutdown = new Promise(resolve => {
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
    shuttingDown = true; resolve();
  });
});
function command(args, { json = true, allowFailure = false, input, environment = {} } = {}) {
  const result = spawnSync(cli, [...(json ? ["--json"] : []), ...args],
    { env: { ...env, ...environment }, cwd: sandbox, encoding: "utf8", timeout: 30000, input });
  report.commands.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr,
    ...(result.error ? { error: String(result.error) } : {}) });
  if (!allowFailure) assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  if (!json || allowFailure || result.status !== 0) return result;
  const value = JSON.parse(result.stdout);
  assert.notEqual(value.ok, false, result.stdout);
  // The current Job CLI still wraps its domain JSON in output, unlike the
  // structured Task commands. Keep the original envelope in the evidence.
  if (args[0] === "job" && value.data === undefined && typeof value.output === "string") return JSON.parse(value.output);
  return value.data ?? value;
}
async function waitFor(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (shuttingDown && !cleaning) throw new Error("Fixture interrupted");
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timeout: ${label}`);
}
async function api(path, body, expected = 200, authenticated = true) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(authenticated ? { "x-yui-web-token": token } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const value = await response.json();
  report.http.push({ path, body, authenticated, status: response.status, value });
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
  return value;
}
async function check(name, run, { required = false } = {}) {
  const start = Date.now();
  try {
    await run();
    report.checks.push({ name, status: "passed", milliseconds: Date.now() - start });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: "failed", error: String(error.stack ?? error) });
    console.error(`FAIL ${name}: ${error.message}`);
    if (required) throw error;
  } finally { saveReport(); }
}
function saveReport() {
  writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
async function startWeb() {
  web = spawn(cli, ["web", "--port", String(port)], { env, cwd: sandbox, stdio: ["ignore", "pipe", "pipe"] });
  webExit = once(web, "exit");
  web.stdout.on("data", data => process.stdout.write(data));
  web.stderr.on("data", data => process.stderr.write(data));
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const html = await response.text();
      token = /name="yui-web-token" content="([^"]+)"/.exec(html)?.[1];
      return token;
    } catch { return false; }
  }, "Web listener");
}
async function stopWeb() {
  if (web?.exitCode === null && web?.signalCode === null) {
    web.kill("SIGTERM");
    await Promise.race([webExit, delay(10000).then(() => { throw new Error("Web CLI did not exit"); })]);
  }
}

// Teardown exists before setup, including all early assertion failures.
try {
  for (const path of [home, bin, env.CODEX_HOME, env.TMPDIR]) mkdirSync(path, { recursive: true });
  assert.ok(existsSync(cli), "Run make install-local first.");
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
process.env.YUI_FAKE_TURN_HANDLER = ${JSON.stringify(new URL("../test/fixtures/web-runtime-turn.mjs", import.meta.url).href)};
process.env.YUI_SMOKE_CLI = ${JSON.stringify(cli)};
process.env.YUI_FAKE_TUI_LOG = ${JSON.stringify(join(home, "native-tui.jsonl"))};
process.env.YUI_FAKE_UNIQUE_THREADS = ${JSON.stringify(process.env.YUI_SMOKE_RECOVERY ?? "")};
process.env.YUI_FAKE_MODELS = ${JSON.stringify(JSON.stringify([
  { id: "fast", model: "fast", displayName: "Fast fixture", isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }], defaultReasoningEffort: "low" },
  { id: "deep", model: "deep", displayName: "Deep fixture", isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }], defaultReasoningEffort: "high" }
]))};
process.env.YUI_FAKE_RESUMED_TURNS = ${JSON.stringify(JSON.stringify([
  { id: "historical-fixture-turn", status: "completed", items: [
    { id: "historical-user", type: "userMessage", content: [{ type: "text", text: "Render a code sample 😀" }] },
    { id: "historical-assistant", type: "agentMessage", text: "Fixture history\n\n```js\nconst answer = 42;\n```\n<script>window.injected = true</script>" }
  ] }
]))};
import(${JSON.stringify(new URL("../test/fixtures/fake-codex-cli.mjs", import.meta.url).href)});
`,
    { mode: 0o755 });
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(cli, join(bin, "yui"));
  command(["setup"], { json: false, input: "codex\n", environment: { YUI_SETUP_INTERACTIVE: "1" } });
  command(["config", "runtime", "set", "reconciliation-interval-seconds", "5"]);
  const repository = join(sandbox, "source");
  mkdirSync(repository);
  writeFileSync(join(repository, "server.cjs"), `
const http = require("node:http");
http.createServer((req, res) => {
  res.setHeader("content-type", req.url === "/app.js" ? "text/javascript" : "text/html");
  res.end(req.url === "/app.js" ? "document.querySelector('h1').textContent='Relative asset loaded'" :
    '<h1>Managed fixture</h1><script src="app.js"></script>');
}).listen(process.env.YUI_PREVIEW_SOCKET);
`);
  for (const args of [["init", "-b", "main"], ["add", "."], ["commit", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: repository, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const remote = join(sandbox, "origin.git");
  const clone = spawnSync("git", ["clone", "--bare", repository, remote], { env, encoding: "utf8" });
  assert.equal(clone.status, 0, clone.stderr);
  project = command(["project", "add", "fixture", repository, "--stable", "main", "--remote", remote]).project;
  await startWeb();
  await check("96: authenticated Web Draft creation is durable, idempotent, and does not start a Session", async () => {
    await api("/api/dashboard", undefined, 403, false);
    const input = { title: "Batch regression fixture", requirements: "Keep Unicode 😀 and CRLF\r\nSecond line",
      projectIds: [project.id], plan: false, requestId: "web-draft" };
    const first = await api("/api/tasks", input);
    report.created = first;
    const second = await api("/api/tasks", input, 409);
    assert.match(second.error, /already saved/);
    const list = command(["task", "list"]);
    report.taskList = list;
    const tasks = list.tasks ?? list.items?.map(i => i.value ?? i);
    task = tasks.find(t => t.title === input.title);
    assert.ok(task, JSON.stringify(list));
    assert.equal(tasks.filter(t => t.title === input.title).length, 1);
    assert.equal(command(["task", "show", task.id]).task.status, "draft");
    const context = await api(`/api/tasks/${task.id}/context`);
    report.draftContext = context;
    assert.equal(JSON.stringify(context).includes('"nativeSessionId"'), false);
    await api("/api/tasks", { ...input, title: "Conflicting reuse" }, 409);
  }, { required: true });
  await check("97/106: CLI and Web share configuration; CAS and invalid multi-field writes preserve saved values", async () => {
    const group = await api("/api/settings/group?id=system");
    report.systemGroup = group;
    const field = group.fields.find(f => f.key === "time-zone");
    assert.ok(field);
    const next = field.value === "UTC" ? "Asia/Shanghai" : "UTC";
    const saved = await api("/api/settings/group", { id: group.id, revision: group.revision,
      changes: [{ key: field.key, value: next }] });
    assert.equal(saved.status, "saved");
    const cliConfig = command(["config", "system", "show"]);
    assert.ok(JSON.stringify(cliConfig).includes(next));
    await api("/api/settings/group", { id: group.id, revision: group.revision,
      changes: [{ key: field.key, value: field.value }] }, 409);
    const current = await api("/api/settings/group?id=system");
    await api("/api/settings/group", { id: group.id, revision: current.revision,
      changes: [{ key: field.key, value: field.value }, { key: "unknown-field", value: 1 }] }, 409);
    assert.deepEqual(await api("/api/settings/group?id=system"), current);
    command(["config", "system", "set", "time-zone", "UTC"]);
  });
  await check("97/106: CLI must reject the same retained-effort/model mismatch as Web", async () => {
    const role = await api("/api/settings/group?id=role%2Fleader");
    const configured = await api("/api/settings/group", { id: role.id, revision: role.revision,
      changes: [{ key: "model", value: "fast" }, { key: "effort", value: "low" }] });
    await api("/api/settings/group", { id: role.id, revision: configured.group.revision,
      changes: [{ key: "model", value: "deep" }] }, 409);
    assert.deepEqual(await api("/api/settings/group?id=role%2Fleader"), configured.group);
    const invalid = command(["config", "role", "update", "leader", "--model", "deep"], { allowFailure: true });
    const afterCli = await api("/api/settings/group?id=role%2Fleader");
    // Restore fixture configuration via the supported API so this finding does
    // not contaminate the independent native Session and preview scenarios.
    await api("/api/settings/group", { id: role.id, revision: afterCli.revision,
      changes: [{ key: "model", value: "fast" }, { key: "effort", value: "low" }] });
    assert.notEqual(invalid.status, 0, "CLI accepted deep/low although native metadata only allows deep/high");
    assert.deepEqual(afterCli, configured.group);
    command(["config", "role", "update", "leader", "--model", "deep", "--effort", "high"]);
    const valid = await api("/api/settings/group?id=role%2Fleader");
    assert.equal(valid.fields.find(f => f.key === "effort").value, "high");
    command(["config", "role", "update", "leader", "--clear-effort"]);
    assert.equal((await api("/api/settings/group?id=role%2Fleader")).fields.find(f => f.key === "effort").value, "");
    command(["config", "role", "update", "leader", "--model", "fast", "--effort", "low"]);
  });
  await check("94/99: exact Unicode source, request-id conflict, and persisted messages survive Controller restart", async () => {
    const args = ["task", "message", "send", task.id, "来源 😀\r\nKeep this exact body",
      "--intent", "record", "--request-id", "source-message"];
    command(args); command(args);
    const before = command(["task", "message", "list", task.id]);
    const conflict = command([...args.slice(0, 4), "different", ...args.slice(5)], { allowFailure: true });
    assert.notEqual(conflict.status, 0);
    assert.deepEqual(command(["task", "message", "list", task.id]), before);
    await stopWeb();
    const restarted = command(["controller", "restart"]);
    report.restart = restarted;
    assert.notEqual(restarted.pid, restarted.previousPid);
    assert.deepEqual(command(["task", "message", "list", task.id]), before);
    command(args);
    assert.deepEqual(command(["task", "message", "list", task.id]), before);
    await startWeb();
    const search = await api("/api/search?query=" + encodeURIComponent("来源"));
    report.search = search;
    assert.ok(JSON.stringify(search).includes(task.id));
  });
  await check("101/108: package browse, explicit binding, and stale revision guard use real Controller state", async () => {
    const source = join(home, "skills", "regression");
    mkdirSync(join(source, "references"), { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: regression\ndescription: Regression fixture\n---\nRead references/guide.md\n");
    writeFileSync(join(source, "references/guide.md"), "attachment v1\n");
    const catalog = await api("/api/skills/catalog?q=regression");
    assert.equal(catalog.items[0].id, "regression");
    const target = { scope: "global", role: "leader" };
    const current = await api("/api/skills/role?scope=global&role=leader");
    const saved = await api("/api/skills/role", { target, revision: current.revision, skills: ["regression"] });
    report.skillSaved = saved;
    assert.ok(JSON.stringify(command(["config", "role", "show", "leader"])).includes("regression"));
    await api("/api/skills/role", { target, revision: current.revision, skills: [] }, 409);
    const file = await api("/api/skills/file?id=regression&resource=references%2Fguide.md");
    assert.equal(file.content, "attachment v1\n");
    await api("/api/skills/file?id=regression&resource=..%2Foutside", undefined, 409);
    const taskRole = await api(`/api/skills/role?scope=task&task=${task.id}&role=leader`);
    await api("/api/skills/role", { target: { scope: "task", task: task.id, role: "leader" },
      revision: taskRole.revision, skills: ["regression"] });
  });
  await check("99/107: real search cursors and source pages preserve long Unicode content without overlap", async () => {
    const body = "LONG-REFERENCE " + "中😀\r\n".repeat(2300) + "END";
    command(["task", "message", "send", task.id, body, "--intent", "record", "--request-id", "long-source"]);
    for (let i = 0; i < 21; i++) {
      command(["task", "message", "send", task.id, `PAGE-MARKER ${i}`,
        "--intent", "record", "--request-id", `page-${i}`]);
    }
    const query = "query=PAGE-MARKER&limit=20";
    const first = await api(`/api/search?${query}`);
    assert.equal(first.items.length, 20);
    assert.ok(first.nextCursor);
    const second = await api(`/api/search?${query}&cursor=${encodeURIComponent(first.nextCursor)}`);
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map(i => i.ref.refId)).size, 21);
    await api(`/api/search?query=OTHER&limit=20&cursor=${encodeURIComponent(first.nextCursor)}`, undefined, 400);
    const [item] = (await api("/api/search?query=LONG-REFERENCE")).items;
    const parameters = new URLSearchParams({ store: item.ref.store, ref: item.ref.refId,
      digest: item.ref.digest, field: item.field });
    let offset = 0, actual = "";
    do {
      const page = await api(`/api/tasks/${task.id}/search-source?${parameters}&offset=${offset}`);
      assert.equal(page.offset, offset);
      actual += page.content;
      if (page.nextOffset === null) break;
      assert.equal(page.nextOffset, offset + Array.from(page.content).length);
      offset = page.nextOffset;
    } while (offset < Array.from(body).length);
    assert.equal(actual, body);
    report.longSource = { item, characters: Array.from(body).length };
  });
  await check("100: scope-only Knowledge changes, exact replay, retirement and CLI/Web Context agree", async () => {
    const propose = scope => command(["project", "knowledge", "propose", project.id, "--task", task.id,
      "--title", "Bounded rule", "--body", "Read exact sources.", "--scope", scope,
      "--expires-when", "After explicit retirement"]);
    propose("Leaders"); propose("Leaders");
    command(["project", "knowledge", "accept", project.id, "proposal-1"]);
    propose("Leaders and reviewers");
    command(["project", "knowledge", "accept", project.id, "proposal-2", "--update", "knowledge-1"]);
    const context = command(["task", "context", task.id]);
    const ref = context.records.find(r => r.ref.store === "project-knowledge").ref;
    const params = new URLSearchParams({ store: ref.store, ref: ref.refId, digest: ref.digest });
    const fromCli = command(["task", "context", "inspect", task.id, "--store", ref.store, "--ref", ref.refId, "--digest", ref.digest]);
    const fromWeb = await api(`/api/tasks/${task.id}/inspect?${params}`);
    assert.deepEqual(fromWeb.value, fromCli.value);
    assert.equal(fromCli.value.scope, "Leaders and reviewers");
    assert.equal(fromCli.value.version, 2);
    command(["project", "knowledge", "retire", project.id, "knowledge-1"]);
    const retired = await api(`/api/tasks/${task.id}/context`);
    assert.equal(retired.records.some(r => r.ref.store === "project-knowledge"), false);
    await api(`/api/tasks/${task.id}/inspect?${params}`, undefined, 409);
  });
  await check("94/98/104/105: activation traverses real Host; native CLI saves artifacts and starts Runner HTTP socket", async () => {
    command(["task", "activation", "request", task.id, "--request-id", "execute", "--environment", "empty"]);
    const marker = join(home, "web-smoke-native-result.json");
    await waitFor(() => {
      const current = command(["task", "show", task.id]).task;
      assert.notEqual(current.activationRequest?.disposition, "failed", current.activationRequest?.outcome);
      return existsSync(marker);
    }, "native CLI fixture result", 30000);
    report.native = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(command(["task", "show", task.id]).task.status, "active");
    activated.push(task.id);
    const job = report.native.job.job;
    jobs.push(job);
    const listing = await waitFor(async () => {
      const list = await api(`/api/tasks/${task.id}/previews`);
      return list.services.find(s => s.state === "ready") && list;
    }, "real Runner socket registration");
    report.preview = listing.services.find(s => s.id === job.id || s.jobId === job.id) ?? listing.services[0];
    const page = await fetch(`http://127.0.0.1:${port}${report.preview.url}`);
    assert.match(await page.text(), /Managed fixture/);
    assert.match(page.headers.get("content-security-policy"), /sandbox allow-scripts/);
    const asset = await fetch(`http://127.0.0.1:${port}${report.preview.url}app.js`);
    assert.match(await asset.text(), /Relative asset loaded/);
    assert.equal((await fetch(`http://127.0.0.1:${port}${report.preview.url}`, { method: "POST" })).status, 405);
    const conversation = await api(`/api/conversation?scope=task&task=${task.id}&role=leader`);
    report.conversation = conversation;
    assert.ok(JSON.stringify(conversation).includes(report.native.nativeSessionId));
    const artifacts = await api(`/api/tasks/${task.id}/artifacts`);
    report.artifacts = artifacts;
    assert.ok(JSON.stringify(artifacts).includes("report.md"));
    assert.ok(JSON.stringify(artifacts).includes("pixel.png"));
    const usage = await api(`/api/tasks/${task.id}/usage`);
    report.usage = usage;
    assert.equal(usage.tokens.status, "unknown");
    assert.equal(usage.tokens.value, null);
    assert.equal(usage.costs.actual.status, "unknown");
    assert.deepEqual(usage.costs.actual.amounts, []);
  });
  if (report.native) {
    await check("101/108: attachment-only changes affect the next launch, never the existing frozen Session", async () => {
      const endpoint = `/api/skills/role?scope=task&task=${task.id}&role=leader`;
      const before = await api(endpoint);
      const frozen = before.session.packages.find(p => p.id === "regression");
      assert.ok(frozen);
      writeFileSync(join(home, "skills/regression/references/guide.md"), "attachment v2\n");
      const target = { scope: "task", task: task.id, role: "leader" };
      await api("/api/skills/role", { target, revision: before.revision, skills: [] });
      const current = await api(endpoint);
      assert.deepEqual(current.session, before.session);
      assert.equal(existsSync(join(home, "skills/regression/SKILL.md")), true);
      const q = new URLSearchParams({ ...target, id: "regression", frozen: "true",
        digest: frozen.digest, resource: "references/guide.md" });
      assert.equal((await api(`/api/skills/file?${q}`)).content, "attachment v1\n");
      const next = command(["task", "create", "Next Skill snapshot", "--project", project.id]).task;
      command(["task", "activation", "request", next.id, "--request-id", "next-snapshot", "--environment", "empty"]);
      activated.push(next.id);
      const inspection = await waitFor(() => {
        const value = command(["task", "role", "session", "inspect", next.id, "leader"]);
        return value.session && value.providerBinding?.run?.status === "completed" && value;
      }, "next Skill Session");
      const updated = inspection.session.effective.skillPackages.find(p => p.id === "regression");
      assert.ok(updated);
      assert.notEqual(updated.digest, frozen.digest);
      report.frozenSkill = { old: frozen, next: updated };
    });
    await check("94/103: current model adoption preserves Thread and defaults; wrong Session is rejected", async () => {
      const statePath = `/api/conversation?scope=task&task=${task.id}&role=leader`;
      const before = await api(statePath);
      const role = await api("/api/settings/group?id=role%2Fleader");
      const modelPath = statePath.replace("/api/conversation?", "/api/conversation/model?")
        + `&session=${before.currentSessionId}`;
      assert.equal((await api(modelPath)).catalog.models.length, 2);
      await api(modelPath, { model: "deep" });
      const after = await api(statePath);
      assert.equal(after.currentSessionId, before.currentSessionId);
      assert.deepEqual(after.turn, before.turn);
      assert.deepEqual(await api("/api/settings/group?id=role%2Fleader"), role);
      await api(statePath + "&session=wrong-session",
        { action: "queue", requestId: "wrong-session", body: "must not send" }, 409);
    });
  }
  report.url = `http://127.0.0.1:${port}/`;
  report.taskId = task.id;
  if (process.env.YUI_SMOKE_RECOVERY === "1") {
    stopProxy = await startFaultProxy(port + 1, port, join(evidence, "transport.jsonl"));
    report.proxyUrl = `http://127.0.0.1:${port + 1}/`;
  }
  report.status = report.checks.some(c => c.status === "failed") ? "failed" : "passed";
  saveReport();
  console.log(`READY ${report.url} ${evidence}`);
  if (serve) {
    // The Controller owns HTTP; the CLI can already have exited. An unresolved
    // Promise alone does not keep Node alive or guarantee its finally runs.
    const keepAlive = setInterval(() => {}, 1000);
    try { await shutdown; } finally { clearInterval(keepAlive); }
  }
  if (report.status === "failed") process.exitCode = 1;
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack ?? error);
  console.error(error);
  if (task) {
    for (const args of [["task", "show", task.id], ["task", "event", "list", task.id],
      ["task", "role", "session", "inspect", task.id, "leader"]]) {
      command(args, { allowFailure: true });
    }
  }
  process.exitCode = 1;
} finally {
  cleaning = true;
  if (stopProxy) await stopProxy();
  const nativeLog = join(home, "native-tui.jsonl");
  if (existsSync(nativeLog)) {
    report.nativeTuiObservations = readFileSync(nativeLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
  }
  try {
    for (const job of jobs) {
      const stopped = await api(`/api/tasks/${job.taskId}/previews/${job.id}/stop`, {});
      report.cleanup.jobStop = stopped;
      const settled = await waitFor(() => {
        const current = command(["job", "get", "--task", job.taskId, "--job", job.id]);
        return ["cancelled", "failed", "succeeded"].includes(current.status) && current;
      }, "Job cancellation");
      report.cleanup.job = settled;
      assert.equal(settled.status, "cancelled");
      const directory = join(home, settled.artifactsLocator);
      report.cleanup.exit = JSON.parse(readFileSync(join(directory, "exit.json"), "utf8"));
      assert.equal(existsSync(jobPreviewSocketRoot(directory)), false, "Runner must clean its exact socket");
    }
    for (const taskId of activated) {
      await check(`96/105: ${taskId} completes and archives only after owned Job settlement`, async () => {
        command(["task", "complete", taskId, "--summary", "Isolated deterministic fixture operations inspected."]);
        assert.equal(command(["task", "show", taskId]).task.status, "completed");
        command(["task", "archive", taskId, "--integrated"]);
        assert.equal(command(["task", "show", taskId]).task.status, "archived");
      });
    }
    report.status = report.checks.some(c => c.status === "failed") ? "failed" : "passed";
    const browserResults = join(evidence, "browser-results.json");
    if (existsSync(browserResults)) {
      report.browserChecks = JSON.parse(readFileSync(browserResults, "utf8"));
      if (report.browserChecks.some(c => c.status === "failed")) report.status = "failed";
    }
    if (report.status === "failed") process.exitCode = 1;
    await stopWeb();
    const stopped = command(["controller", "stop"], { json: false });
    report.cleanup.controller = stopped.status === 0;
    const tmux = spawnSync("tmux", ["-L", tmuxServer, "kill-server"], { env, encoding: "utf8" });
    report.cleanup.tmux = tmux.status === 0 || /no server|No such file/.test(tmux.stderr);
    assert.equal(report.cleanup.tmux, true, tmux.stderr);
    if (report.status === "passed") {
      rmSync(sandbox, { recursive: true, force: true });
      report.cleanup.removed = true;
    } else {
      report.cleanup.retained = sandbox;
    }
  } catch (error) {
    report.cleanup.error = String(error.stack ?? error);
    report.cleanup.retained = sandbox;
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  saveReport();
}
