import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexClientInitialization } from "../../dist/runtime/codexAppServerRuntime.js";
import {
  openCodexInteractiveConnection,
  startStructuredProviderSession
} from "../../dist/runtime/structuredProviderHost.js";
import {
  codexAppNeedsRestart,
  isCodexInspectionPermissionError
} from "../../dist/runtime/codexSharedDaemon.js";
import { codexAgentsInUse, prepareLocalCodexStartup } from "../../dist/runtime/localStartup.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { checkCodexSharedDaemon, checkMacCodexApp } from "../../dist/doctor/doctor.js";
import { CommandExecutionError } from "../../dist/tmux/commandExecutor.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fake = join(root, "test/fixtures/fake-codex-shared-daemon.mjs");

function launch(t) {
  const home = mkdtempSync("/tmp/yui-codex-daemon-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    command: process.execPath,
    args: [fake, "app-server", "proxy"],
    cwd: root,
    environment: {
      ...process.env,
      HOME: home,
      CODEX_HOME: home,
      YUI_FAKE_THREAD_ID: "shared-daemon-thread",
      YUI_AGENT_BASE_ARGS: JSON.stringify([fake])
    }
  };
}

function commands(home) {
  return readFileSync(join(home, "commands"), "utf8").trim().split("\n");
}

test("interactive Codex starts a missing shared daemon once and reconnects", async t => {
  const input = launch(t);
  const connection = await openCodexInteractiveConnection(input, true);
  t.after(() => connection.close());
  const initialized = await connection.request("initialize", codexClientInitialization());
  assert.equal(initialized.codexHome, input.home);
  await connection.notify("initialized");
  assert.deepEqual(commands(input.home), ["proxy", "start", "proxy"]);
});

test("managed Codex uses the same missing-daemon recovery before starting its thread", async t => {
  const input = launch(t);
  input.args.splice(1, 0, "--model", "thread-only-model");
  let session;
  t.after(async () => {
    if (session === undefined) return;
    session.terminate("SIGTERM");
    await session.waitForExit();
  });
  const opened = await startStructuredProviderSession({
    schemaVersion: 1,
    ...input,
    childLifecycle: "persistent",
    startMode: "provider",
    providerControl: {
      schemaVersion: 1,
      adapterId: "codex",
      kind: "start",
      mode: "new",
      transport: "codex-app-server-proxy",
      authority: { epoch: 1, owner: "controller", holderId: "daemon-test" },
      codexThread: {}
    }
  }, { mirrorOutput: () => {} });
  session = opened.session;
  assert.equal(session.nativeSessionId, "shared-daemon-thread");
  assert.deepEqual(commands(input.home), ["proxy", "start", "proxy"]);
});

test("native control does not start a daemon while its socket is missing", async t => {
  const input = launch(t);
  await assert.rejects(openCodexInteractiveConnection(input));
  assert.deepEqual(commands(input.home), ["proxy"]);
});

test("a failed proxy does not restart a daemon with a live socket", async t => {
  const input = launch(t);
  const directory = join(input.home, "app-server-control");
  mkdirSync(directory);
  const server = createServer();
  const socket = join(directory, "app-server-control.sock");
  await new Promise((resolve, reject) => server.listen(socket, (error) => error ? reject(error) : resolve()));
  t.after(() => server.close());
  await assert.rejects(openCodexInteractiveConnection(input, true));
  assert.deepEqual(commands(input.home), ["proxy"]);
});

test("an already running App only needs a restart when its connection is stale", () => {
  const url = "ws+unix://localhost/Users/test/.codex/app-server-control/app-server-control.sock:/rpc";
  const command = `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT CODEX_APP_SERVER_WS_URL=${url}`;
  assert.equal(codexAppNeedsRestart(command, url, false), false);
  assert.equal(codexAppNeedsRestart(command, url, true), true);
  assert.equal(codexAppNeedsRestart("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", url, false), true);
  assert.equal(codexAppNeedsRestart(command, `${url}-other`, false), true);
});

test("denied shared daemon inspection remains unverified instead of reported unavailable", () => {
  const denied = new CommandExecutionError("COMMAND_FAILED", 1, "Operation not permitted (os error 1)");
  const check = checkCodexSharedDaemon("codex", [], {}, {
    run: () => { throw denied; }
  }, "codex");
  assert.equal(check.status, "invalid");
  assert.match(check.detail, /state is unverified/);
  assert.doesNotMatch(check.detail, /is unavailable/);
  assert.equal(isCodexInspectionPermissionError(new Error("socket probe failed", {
    cause: Object.assign(new Error("denied"), { code: "EPERM" })
  })), true);
  assert.equal(isCodexInspectionPermissionError(new Error("Connection refused")), false);
});

test("startup demand follows active Role bindings, not installed or configured Codex agents", async () => {
  const codex = createConfiguredAgent("codex", "codex", "unused", [], [], new Date());
  const claude = createConfiguredAgent("claude", "claude", "unused", [], [], new Date());
  const agents = new Map([[codex.id, codex], [claude.id, claude]]);
  let activeIds = [claude.id];
  const store = {
    listGlobalRoles: () => activeIds.map(activeAgentId => ({ activeAgentId })),
    listActiveTaskIds: () => [],
    listRoles: () => [],
    getConfiguredAgent: id => agents.get(id),
    getGlobalRole: () => ({ activeAgentId: activeIds[0] })
  };
  assert.deepEqual(codexAgentsInUse(store), []);
  assert.deepEqual(await prepareLocalCodexStartup(store, "/unused", {}, undefined), {
    daemons: [], app: "not-applicable"
  });
  activeIds = [codex.id, claude.id];
  assert.deepEqual(codexAgentsInUse(store).map(agent => agent.id), [codex.id]);
  assert.deepEqual(codexAgentsInUse(store, claude.id), []);
});

test("active Codex Role reuses its exact shared daemon on Linux without App setup", async t => {
  const home = mkdtempSync("/tmp/yui-active-codex-start-");
  const socketDir = join(home, "app-server-control");
  mkdirSync(socketDir);
  const socketPath = join(socketDir, "app-server-control.sock");
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(socketPath, error => error ? reject(error) : resolve()));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const agent = createConfiguredAgent("codex", "codex", process.execPath, [fake], [], new Date());
  const store = {
    listGlobalRoles: () => [{ activeAgentId: agent.id }],
    listActiveTaskIds: () => [],
    listRoles: () => [],
    getConfiguredAgent: id => id === agent.id ? agent : undefined,
    getGlobalRole: () => ({ activeAgentId: agent.id })
  };
  const result = await prepareLocalCodexStartup(store, home, {
    HOME: home, CODEX_HOME: home
  }, undefined, "linux");
  assert.deepEqual(result, {
    daemons: [{ agentIds: [agent.id], socketPath, started: false }],
    app: "not-applicable"
  });
});

test("doctor distinguishes App process, next-launch setup and actual daemon socket peer", t => {
  const home = mkdtempSync("/tmp/yui-mac-app-doctor-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const socketDir = join(home, "app-server-control");
  mkdirSync(socketDir);
  const socketPath = join(socketDir, "app-server-control.sock");
  writeFileSync(socketPath, "");
  const url = `ws+unix://localhost${home}/app-server-control/app-server-control.sock:/rpc`;
  const app = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
  const daemon = { name: "agent:codex:daemon", status: "ok", detail: "running" };
  const connectedSockets = `p222\nf29\nd0xaaaa\nn${realpathSync(socketPath)}\np123\nf128\nd0xbbbb\nn->0xaaaa\n`;
  const inspect = (launchUrl, appCommand, sockets = connectedSockets, daemonCheck = daemon) => checkMacCodexApp(
    "codex", { CODEX_HOME: home }, home, daemonCheck,
    { run: (command, args) => {
      if (command === "/bin/launchctl") return launchUrl;
      if (command === "/usr/sbin/lsof") return sockets;
      if (args[0] === "-axo") return appCommand === undefined ? "" : `123 ${app}\n`;
      return appCommand;
    } }, app
  );
  const status = (checks, suffix) => checks.find(check => check.name.endsWith(suffix)).status;
  const closed = inspect(url, undefined);
  assert.equal(status(closed, ":mac-app"), "missing");
  assert.equal(status(closed, ":mac-app-launch"), "ok");
  assert.equal(status(closed, ":mac-app-connection"), "missing");
  const connected = inspect(url, `${app} CODEX_APP_SERVER_WS_URL=${url}`);
  assert.equal(status(connected, ":mac-app"), "ok");
  assert.equal(status(connected, ":mac-app-connection"), "ok");
  assert.equal(status(inspect(url, app, connectedSockets.replace("->0xaaaa", "->0xcccc")), ":mac-app-connection"), "missing");
  assert.equal(status(inspect("", app), ":mac-app-launch"), "missing");
  assert.equal(status(inspect(url, app, connectedSockets, { ...daemon, status: "missing" }), ":mac-app-connection"), "missing");
});
