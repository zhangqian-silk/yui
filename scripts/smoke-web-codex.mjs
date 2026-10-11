// Explicit opt-in only. Uses a real account/model; never imported by npm test.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";

assert.equal(process.env.YUI_LIVE_CODEX, "authorized", "Explicit live-resource authorization and YUI_LIVE_CODEX=authorized required");
assert.equal(process.platform, "linux", "This opt-in fixture uses Linux /proc ownership checks; macOS needs its own authorized environment");
const native = process.env.YUI_LIVE_CODEX_BINARY;
const sourceHome = process.env.CODEX_HOME;
assert.ok(native && sourceHome, "Select exact native binary and authorized authentication source");
const root = process.cwd(), cli = join(root, "output/dev/bin/yui");
const evidence = resolve(process.env.YUI_SMOKE_EVIDENCE);
assert.ok(!fs.existsSync(join(evidence, "report.json")), "Use fresh evidence; do not replay an unknown round");
fs.mkdirSync(evidence, {recursive: true});
const scratch = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "yui-native-execution-")));
const codexHome = fs.mkdtempSync("/tmp/yui-native-");
const home = join(scratch, "home"), bin = join(scratch, "bin");
const hash = path => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
const authSource = join(sourceHome, "auth.json"), authHash = hash(authSource);
const port = Number(process.env.YUI_SMOKE_PORT ?? 19029);
const env = {HOME: scratch, CODEX_HOME: codexHome, YUI_HOME: home,
  PATH: `${bin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  TMPDIR: join(scratch, "tmp"), NO_COLOR: "1", YUI_SETUP_INTERACTIVE: "1",
  ...Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].filter(k => process.env[k]).map(k => [k, process.env[k]]))};
const report = {startedAt: new Date().toISOString(), fixturePid: process.pid, scratch, home, codexHome,
  native, cli, port, url: `http://127.0.0.1:${port}`, node: process.version, platform: `${process.platform}-${process.arch}`,
  commit: spawnSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).stdout.trim(),
  nativeSha256: hash(native), model: "gpt-6-luna", turnLimit: 5, commands: [], cleanup: {}};
const tmux = `yui-${createHash("sha256").update(home).digest("hex").slice(0,24)}`;
let task, web, stopping = false, stop;
const stopped = new Promise(r => stop = r);
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {stopping = true; stop();});
const save = () => fs.writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 2));
function command(args, {json = true, allowFailure = false, input} = {}) {
  const r = spawnSync(cli, [...(json ? ["--json"] : []), ...args],
    {cwd: scratch, env, encoding: "utf8", timeout: 45000, input});
  report.commands.push({args, status: r.status, stdout: r.stdout, stderr: r.stderr}); save();
  if (!allowFailure) assert.equal(r.status, 0, `${args.join(" ")}: ${r.stdout} ${r.stderr}`);
  if (!json || allowFailure) return {status: r.status, stdout: r.stdout, stderr: r.stderr};
  const v = JSON.parse(r.stdout); assert.notEqual(v.ok, false); return v.data ?? v;
}
async function wait(fn, name, milliseconds = 30000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (stopping) throw Error("Fixture stopped");
    if (fs.existsSync(join(evidence, "preflight-failure.json"))) throw Error(fs.readFileSync(join(evidence, "preflight-failure.json"), "utf8"));
    const value = await fn(); if (value) return value;
    await delay(200);
  }
  throw Error(`Timeout: ${name}; inspect original receipt, do not resend`);
}
// Register cleanup before setup or any native command.
try {
  for (const path of [home, bin, env.TMPDIR]) fs.mkdirSync(path, {recursive: true, mode: 0o700});
  fs.symlinkSync(cli, join(bin, "yui"));
  const config = fs.readFileSync(join(sourceHome, "config.toml"), "utf8");
  const provider = /^model_provider\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  assert.ok(provider, "Use the existing configured provider; never silently substitute");
  const block = config.split(/\n(?=\[)/).find(s => s.startsWith(`[model_providers.${provider}]`));
  assert.ok(block);
  fs.copyFileSync(authSource, join(codexHome, "auth.json")); fs.chmodSync(join(codexHome, "auth.json"), 0o600);
  fs.writeFileSync(join(codexHome, "config.toml"),
    `model_provider = ${JSON.stringify(provider)}\nmodel = "gpt-6-luna"\ncli_auth_credentials_store = "file"\nweb_search = "disabled"\n${block}\n`, {mode: 0o600});
  report.provider = provider;
  report.nativeVersion = spawnSync(native, ["--version"], {env, encoding: "utf8"}).stdout.trim();
  const wrapper = join(bin, "codex");
  fs.writeFileSync(wrapper, `#!${process.execPath}
import {runProbeProxy} from ${JSON.stringify(new URL("./lib/codex-preflight-proxy.mjs", import.meta.url).href)};
await runProbeProxy(${JSON.stringify(native)}, process.argv.slice(2), ${JSON.stringify(evidence)}, 5);
`, {mode: 0o700});
  command(["setup"], {json: false, input: "codex\n"});
  command(["config", "agent", "update", "codex", "--command", wrapper]);
  const capabilities = command(["config", "agent", "capabilities", "codex", "--refresh"]);
  fs.writeFileSync(join(evidence, "capabilities.json"), JSON.stringify(capabilities, null, 2));
  assert.ok(JSON.stringify(capabilities).includes('"gpt-6-luna"'), "Exact model missing");
  command(["config", "role", "update", "leader", "--model", "gpt-6-luna", "--clear-effort",
    "--permission-strategy", "bypass", "--constraint",
    "Disposable authorized execution test. Read own Manifest, Role Skills/profile and complete current Context command. Do only the bounded file task stated in the current Message. No delegation, external calls, package installs, task completion, or input requests. Do not inspect accounts or other directories. On activation, read context and respond READY without changing files; later structured Message authorizes the small output. Stop after each response."]);
  const created = command(["task", "create", "Native execution browser smoke"]);
  task = created.task?.id ?? created.id; report.taskId = task;
  command(["task", "update", task, "--description",
    "Disposable execution smoke. On activation read your own required Manifest/Role Skills/profile and full current Context, then respond READY. Do not complete this Task or alter files on activation. Wait for a later structured Message describing one bounded local file transformation. No external side effects or delegation."]);
  web = spawn(cli, ["web", "--port", String(port)], {env, cwd: scratch, stdio: ["ignore", "pipe", "pipe"]});
  web.stdout.on("data", d => process.stdout.write(d)); web.stderr.on("data", d => process.stderr.write(d));
  let token;
  await wait(async () => {
    try { const html = await (await fetch(`http://127.0.0.1:${port}`)).text();
      token = /name="yui-web-token" content="([^"]+)"/.exec(html)?.[1]; return token;
    } catch { return false; }
  }, "Web");
  // The transparent proxy holds the first turn/start until command/exec
  // preflight passes, after Yui adopts the actual Thread identity.
  report.activation = command(["task", "activation", "request", task, "--request-id", "execution-smoke-activation", "--environment", "empty"]);
  await wait(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/conversation?scope=task&task=${task}&role=leader`,
      {headers: {"x-yui-web-token": token}});
    report.conversation = await r.json(); save();
    return report.conversation.turn?.status === "completed";
  }, "activation completion", 120000);
  const daemon = fs.realpathSync(join(codexHome, "packages/app-server-daemon/current/bin/codex"));
  report.daemon = {path: daemon, sha256: hash(daemon),
    version: spawnSync(daemon, ["--version"], {env, encoding: "utf8"}).stdout.trim()};
  report.ready = true; save(); console.log("LIVE EXECUTION READY");
  const keepAlive = setInterval(() => {}, 1000);
  try {await stopped;} finally {clearInterval(keepAlive);}
} catch (error) {
  report.error = String(error.stack ?? error); console.error(report.error); process.exitCode = 1;
} finally {
  try {
    const database = join(codexHome, "thread_history_1.sqlite");
    if (fs.existsSync(database)) {
      const db = new Database(database, {readonly: true});
      try {
        report.nativeTurns = db.prepare("select thread_id,turn_id,status,started_at,completed_at,duration_ms,error_json from thread_turns order by started_at").all();
      } finally {db.close();}
    }
    const startupPath = join(evidence, "native-startup.json");
    if (fs.existsSync(startupPath)) {
      const cwd = JSON.parse(fs.readFileSync(startupPath, "utf8")).startup.cwd;
      const files = {};
      for (const name of ["fixture-value.txt", "preflight-proof.json", "business-result.json"]) {
        if (fs.existsSync(join(cwd,name))) files[name] = fs.readFileSync(join(cwd,name), "utf8");
      }
      fs.writeFileSync(join(evidence,"workspace-files.json"), JSON.stringify(files,null,2));
    }
  } catch (error) {report.evidenceError = String(error); process.exitCode = 1;}
  try {
    if (task) report.cleanup.execution = command(["task", "execution", "stop", task, "--force", "--reason", "Owned native execution smoke teardown"], {allowFailure: true});
    web?.kill("SIGTERM");
    report.cleanup.controller = command(["controller", "stop"], {json: false, allowFailure: true});
    report.cleanup.tmuxStatus = spawnSync("tmux", ["-L", tmux, "kill-server"], {encoding: "utf8"}).status;
    const stoppedNative = spawnSync(native, ["app-server", "daemon", "stop"], {env, encoding: "utf8", timeout: 15000});
    report.cleanup.native = {status: stoppedNative.status, stdout: stoppedNative.stdout, stderr: stoppedNative.stderr};
    // Native daemon stop may leave its updater. Resolve exact executable and
    // exact argv under this owned Home before terminating that process only.
    const daemonPath = join(codexHome, "packages/app-server-daemon/current/bin/codex");
    const exact = fs.existsSync(daemonPath) ? fs.realpathSync(daemonPath) : null;
    report.cleanup.signals = [];
    for (const pid of fs.readdirSync("/proc").filter(x => /^\d+$/.test(x))) {
      try {
        const executable = fs.readlinkSync(`/proc/${pid}/exe`);
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
        const environment = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        const updater = exact && executable === exact
          && JSON.stringify(args.slice(1)) === JSON.stringify(["app-server", "daemon", "pid-update-loop"]);
        const ownedWeb = environment.includes(`YUI_HOME=${home}`) && args.includes("web")
          && args.includes(String(port)) && args.some(a => a.endsWith("/dist/cli.js"));
        if (!updater && !ownedWeb) continue;
        process.kill(Number(pid), "SIGTERM");
        report.cleanup.signals.push({pid: Number(pid), executable, kind: updater ? "updater" : "web"});
      } catch {}
    }
    await delay(800);
    fs.rmSync(join(codexHome, "auth.json"), {force: true});
    report.cleanup.sourceAuthUnchanged = hash(authSource) === authHash;
    report.cleanup.credentialRemoved = !fs.existsSync(join(codexHome, "auth.json"));
    report.cleanup.remaining = [];
    for (const pid of fs.readdirSync("/proc").filter(x => /^\d+$/.test(x))) {
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        const environment = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        if (environment.includes(`YUI_HOME=${home}`) || environment.includes(`CODEX_HOME=${codexHome}`)
          || args.includes(scratch) || args.includes(codexHome)) report.cleanup.remaining.push(Number(pid));
      } catch {}
    }
    report.cleanup.tmuxRemaining = spawnSync("tmux", ["-L", tmux, "list-sessions"], {encoding: "utf8"}).status === 0;
    report.cleanup.socketRemaining = fs.existsSync(join(codexHome, "app-server-control/app-server-control.sock"));
    if (report.cleanup.remaining.length || report.cleanup.tmuxRemaining || report.cleanup.socketRemaining) {
      report.cleanup.retained = [scratch, codexHome];
      throw Error("Owned resources remain; preserve their Homes for exact recovery");
    }
    // The paths are the exact mkdtemp allocations above, never a shared root.
    fs.rmSync(scratch, {recursive: true});
    fs.rmSync(codexHome, {recursive: true});
    report.cleanup.removed = [scratch, codexHome];
  } catch (error) {
    report.cleanup.error = String(error);
    report.cleanup.retained = [scratch, codexHome].filter(p => fs.existsSync(p));
    process.exitCode = 1;
  } finally {
    // Credential removal is independent of evidence collection and teardown.
    fs.rmSync(join(codexHome, "auth.json"), {force: true});
    report.cleanup.credentialRemoved = !fs.existsSync(join(codexHome, "auth.json"));
  }
  report.finishedAt = new Date().toISOString(); save();
}
