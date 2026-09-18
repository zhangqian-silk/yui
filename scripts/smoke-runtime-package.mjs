import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const assembled = process.argv[2] === "--assembled";
if (process.argv.length !== (assembled ? 4 : 2)) {
  throw new Error("Usage: smoke-runtime-package.mjs [--assembled <package-root>]");
}
const root = resolve(assembled ? process.argv[3] : process.env.YUI_INSTALLED_ROOT ?? process.cwd());
const sandbox = mkdtempSync(join(tmpdir(), "yui-runtime-package-smoke-"));
const isolatedHome = join(sandbox, "home");
const yuiHome = join(isolatedHome, ".yui");
const fakeBin = join(sandbox, "bin");
const tmuxServer = `yui-${createHash("sha256").update(resolve(yuiHome)).digest("hex").slice(0, 24)}`;
let cli;
let environment;
const skills = [
  "yui-leader",
  "yui-worker",
  "yui-operator",
  "yui-reviewer",
  "yui-runtime"
];

try {
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  mkdirSync(fakeBin, { recursive: true, mode: 0o755 });
  const fakeCodex = new URL("../test/fixtures/fake-codex-cli.mjs", import.meta.url);
  writeFileSync(join(fakeBin, "codex"),
    `#!${process.execPath}\nimport(${JSON.stringify(fakeCodex.href)}).catch(error => { console.error(error); process.exitCode = 1; });\n`,
    { mode: 0o755 });
  symlinkSync(process.execPath, join(fakeBin, "node"));

  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  // Follow the actual instructions' local Markdown links, including cross-Role
  // references, in the installed tree. Source-only references cannot satisfy
  // this check; prose/heading changes do not invalidate the contract.
  const skillRoot = resolve(root, "skills");
  const pendingSkills = skills.map((skill) => join(skillRoot, skill, "SKILL.md"));
  const checkedSkills = new Set();
  while (pendingSkills.length > 0) {
    const path = pendingSkills.pop();
    if (checkedSkills.has(path)) continue;
    checkedSkills.add(path);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Installed Skill resource is missing: ${relative(skillRoot, path)}.`);
    }
    const content = readFileSync(path, "utf8");
    if (content.trim().length === 0) {
      throw new Error(`Installed Skill resource is empty: ${relative(skillRoot, path)}.`);
    }
    for (const [, href] of content.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/gu)) {
      if (/^[a-z][a-z\d+.-]*:/iu.test(href)) continue;
      const target = href.split("#")[0];
      if (!target.endsWith(".md")) continue;
      const resolved = resolve(dirname(path), target);
      const local = relative(skillRoot, resolved);
      if (local === ".." || local.startsWith("../") || isAbsolute(local)) {
        throw new Error(`Installed Skill reference leaves its package: ${href}.`);
      }
      pendingSkills.push(resolved);
    }
  }
  if (packageJson.bin?.yui !== "./dist/cli.js") {
    throw new Error("Installed runtime package does not expose the expected yui bin.");
  }
  // PR #110 regression: the installed CLI must stay executable. npm applies
  // the process umask on extraction, so the exact tarball mode (asserted as
  // 0755 in the package structure check) may land as 0700 locally; the
  // regression contract is a surviving execute bit, and the .bin/yui
  // invocations below prove it is runnable.
  const installedCli = join(root, "dist", "cli.js");
  const installedMode = statSync(installedCli).mode & 0o777;
  if ((installedMode & 0o111) === 0) {
    throw new Error(
      `Installed dist/cli.js must be executable, received ${installedMode.toString(8).padStart(4, "0")}.`
    );
  }

  cli = assembled ? installedCli : resolve(root, "..", "..", ".bin", "yui");
  if (!existsSync(cli)) {
    throw new Error("Installed runtime package did not create its yui bin.");
  }
  environment = {
    HOME: isolatedHome,
    CODEX_HOME: join(isolatedHome, ".codex"),
    YUI_HOME: yuiHome,
    PATH: [fakeBin, "/usr/bin", "/bin"].join(delimiter),
    TMPDIR: join(sandbox, "tmp"),
    NO_COLOR: "1"
  };
  mkdirSync(environment.CODEX_HOME, { recursive: true });
  mkdirSync(environment.TMPDIR, { recursive: true });

  const version = runCli(cli, ["version"], environment).trim();
  if (version !== packageJson.version) {
    throw new Error(`Installed CLI reported ${version}; expected ${packageJson.version}.`);
  }
  if (!runCli(cli, ["help"], environment).includes("Yui")) {
    throw new Error("Installed CLI help did not render.");
  }
  const scopedHelp = runCli(cli, ["help", "task", "role"], environment);
  if (!scopedHelp.includes("yui task role <command>") || !scopedHelp.includes("add")) {
    throw new Error("Installed CLI nested help did not render the restored command catalog.");
  }
  const completion = runCli(
    cli,
    ["config", "completion", "candidates", "ta", "--"],
    environment
  ).trim().split("\n");
  if (!completion.includes("task")) {
    throw new Error("Installed CLI command completion did not use the restored catalog.");
  }

  const setup = runCli(
    cli,
    ["setup"],
    { ...environment, YUI_SETUP_INTERACTIVE: "1" },
    "codex\n"
  );
  if (
    !setup.includes("Yui setup complete.")
    || !/^Operator: .+ \(created\)\.$/mu.test(setup)
    || !/^Leader: .+ \(created\)\.$/mu.test(setup)
  ) {
    throw new Error("Installed CLI setup did not create the minimum task-ready runtime.");
  }

  assert.equal(json("doctor").storage.healthy, true);
  const status = JSON.parse(runCli(cli, ["--json", "controller", "status"],
    { ...environment, YUI_STATUS_IDENTITY: "0" })).data;
  assert.ok(status.identity, "Status identity is unconditional, not a rollout flag.");
  const { createUpdatePorts } = await import(pathToFileURL(join(root, "dist", "cli", "updatePorts.js")).href);
  // Real update lifecycle children, bounded so a self-wait regression does not
  // spend the production 90-second handover deadline in CI. No npm operation.
  const updatePorts = createUpdatePorts(environment, (command, args, options) =>
    spawnSync(command, args, { ...options, timeout: 15_000 }));
  const lifecycle = updatePorts.controllerStatus(yuiHome);
  const controller = status.resources.find(resource => resource.kind === "controller" && resource.state === "current");
  assert.equal(lifecycle.running, true);
  assert.equal(lifecycle.pid, controller.processes[0].pid);
  assert.equal(lifecycle.identity.version, packageJson.version);
  const { task } = json("task", "create", "runtime smoke");
  assert.equal(task.status, "draft");
  assert.throws(() => runCli(cli, ["task", "activate", task.id], environment), error => {
    assert.match(String(error.stderr), /activation request.*required/i);
    return true;
  }, "Activation must not invent request-free intent.");
  assert.equal(json("task", "show", task.id).task.status, "draft");
  const original = "Keep the original requirement across restart.";
  json("task", "message", "send", task.id, original, "--intent", "record", "--request-id", "original");
  const beforeRestart = json("task", "message", "list", task.id);
  const previousPid = JSON.parse(readFileSync(join(yuiHome, "runtime/controller.json"), "utf8")).pid;
  const restarted = json("controller", "restart");
  assert.equal(restarted.previousPid, previousPid);
  assert.notEqual(restarted.pid, previousPid);
  assert.equal(processExited(previousPid), true, "The old Controller must actually exit.");
  assert.deepEqual(json("task", "message", "list", task.id), beforeRestart);
  json("task", "message", "send", task.id, original, "--intent", "record", "--request-id", "original");
  assert.deepEqual(json("task", "message", "list", task.id), beforeRestart, "A replay must not duplicate input.");

  json("task", "activation", "request", task.id, "--request-id", "execute", "--environment", "scratch");
  await waitFor(() => JSON.stringify(json("task", "event", "list", task.id)).includes("Native Codex result."),
    "CLI input did not traverse Controller, Host and fake Provider back to durable results.",
    () => JSON.stringify({ task: json("task", "show", task.id), events: json("task", "event", "list", task.id) }));
  assert.equal(json("task", "show", task.id).task.status, "active");
  json("task", "complete", task.id, "--summary", "The deterministic Provider result is accepted.");
  assert.equal(json("task", "show", task.id).task.status, "completed");

  // Exercise the public reopen -> Operator submission path in the same Home
  // and conversation. Deliberately let the lifecycle-only notification finish
  // first, so a second, exact Message must reach the Host on its own wake.
  const followupStarted = performance.now();
  const events = () => json("task", "event", "list", task.id).events;
  const originalCompletion = events().find(event => event.type === "task.completed");
  assert.throws(() => runCli(cli, ["operator", "submit", "Not an automatic reopen",
    "--task", task.id, "--intent", "discuss"], environment), error => {
    assert.match(String(error.stderr), /completed/);
    return true;
  });
  json("task", "reopen", task.id);
  json("task", "reopen", task.id);
  assert.equal(json("task", "show", task.id).task.completedAt, undefined);
  const terminalForWake = wake => events().some(event => {
    if (event.type !== "runtime.observation" || event.payload.kind !== "turn.completed") return false;
    const observation = JSON.parse(event.payload.observation);
    return observation.fence.receiptId?.startsWith(`notification:${task.id}/${wake.id}/`) === true;
  });
  await waitFor(() => {
    const wake = json("task", "wake", "list", task.id).wakes.find(w => w.reasons.includes("task-reopened"));
    return wake !== undefined && terminalForWake(wake);
  }, "Reopen notification did not finish through the existing Host.");
  const request = ["operator", "submit", "Continue this same accepted result; local fixture only.",
    "--task", task.id, "--intent", "develop", "--request-id", "authorized-followup"];
  runCli(cli, request, environment);
  runCli(cli, request, environment);
  const inputs = json("task", "context", task.id).records
    .filter(record => record.ref.store === "task-message").map(record => record.value);
  const followups = inputs.filter(message => message?.submissionKey === "authorized-followup");
  assert.equal(followups.length, 1, "Matching Operator retries must retain one original Message.");
  const followup = followups[0];
  assert.equal(followup.submissionReceipt.routing.kind, "active-context");
  assert.equal(followup.submissionReceipt.feedback.delivery, "queued");
  await waitFor(() => {
    const wake = json("task", "wake", "list", task.id).wakes.find(w =>
      w.refs?.some(ref => ref.type === "message" && ref.id === followup.id));
    return wake !== undefined && terminalForWake(wake);
  }, "The exact follow-up Message did not traverse CLI/Controller/Host/native terminal.");
  assert.equal(events().filter(event => event.type === "task.reopened").length, 1);
  assert.deepEqual(events().find(event => event.id === originalCompletion.id), originalCompletion);
  json("task", "complete", task.id, "--summary", "The authorized follow-up is separately accepted.");
  assert.equal(json("task", "show", task.id).task.status, "completed");
  assert.equal(events().filter(event => event.type === "task.completed").length, 2);
  assert.deepEqual(events().find(event => event.id === originalCompletion.id), originalCompletion);
  process.stdout.write(`Reopen and follow-up delivery smoke passed (${Math.round(performance.now() - followupStarted)} ms).\n`);

  const session = `yui-${tmuxServer.slice(4, 16)}-${task.id}`;
  const neighbor = `yui-${tmuxServer.slice(4, 16)}-${task.id}0`;
  // These are this fixture's terminal resources, not additional Agent work.
  const panePid = Number(tmux("display-message", "-p", "-t", `=${session}:=leader`, "#{pane_pid}").trim());
  assert.equal(processExited(panePid), false, "Completion must preserve the reusable conversation.");
  tmux("new-window", "-t", `=${session}`, "-n", "exited-fixture", "/bin/true");
  tmux("new-session", "-d", "-t", session, "-s", "fixture-viewer");
  tmux("new-session", "-d", "-s", neighbor, "/bin/sleep", "60");
  await waitFor(() => tmux("display-message", "-p", "-t", `=${session}:=exited-fixture`, "#{pane_dead}").trim() === "1",
    "The fixture pane did not exit.");
  json("task", "archive", task.id, "--integrated");
  assert.equal(json("task", "show", task.id).task.status, "archived");
  assert.equal(processExited(panePid), true, "Archive must release the Host, not just its durable Session.");
  const sessions = tmux("list-sessions", "-F", "#{session_name}").trim().split("\n");
  assert.deepEqual(sessions, [neighbor], "Archive must remove its live/dead panes and viewer, but not task-10.");
  json("task", "archive", task.id, "--integrated");
  assert.deepEqual(tmux("list-sessions", "-F", "#{session_name}").trim().split("\n"), [neighbor]);
  const serverPid = Number(tmux("display-message", "-p", "-t", `=${neighbor}:`, "#{pid}").trim());
  tmux("kill-session", "-t", `=${neighbor}`);
  await waitFor(() => processExited(serverPid), "The empty fixture tmux server did not exit.");

  const updateStarted = performance.now();
  const beforeUpdate = updatePorts.controllerStatus(yuiHome);
  assert.equal(beforeUpdate.running, true);
  const beforeUpdateMessages = json("task", "message", "list", task.id);
  const releaseHandover = updatePorts.beginControllerHandover(yuiHome);
  try {
    const lockPath = join(yuiHome, "runtime", "handover.lock");
    const lock = readFileSync(lockPath, "utf8");
    const runtimeModule = pathToFileURL(join(root, "dist", "controller", "clientRuntime.js")).href;
    // A lifecycle caller without the updater's owner identity must still wait,
    // even when the real OS parent happens to hold the lock.
    const blocked = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { stopFileTaskController } from ${JSON.stringify(runtimeModule)};
      try {
        await stopFileTaskController(process.env.YUI_HOME, {
          expectedPid: ${beforeUpdate.pid}, handoverWaitTimeoutMs: 50, pollIntervalMs: 5
        });
        process.stdout.write(JSON.stringify({ stopped: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ code: error.code }));
      }
    `], { env: environment, encoding: "utf8", timeout: 5000 }));
    assert.equal(blocked.code, "CONTROLLER_HANDOVER_TIMEOUT");
    assert.equal(processExited(beforeUpdate.pid), false);

    const stopped = updatePorts.stopController(yuiHome, beforeUpdate.pid);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.pid, beforeUpdate.pid);
    assert.equal(processExited(beforeUpdate.pid), true, "Update must drain its exact Controller.");
    updatePorts.restoreController(yuiHome, beforeUpdate.identity);
    const restored = updatePorts.controllerStatus(yuiHome);
    assert.equal(restored.running, true);
    assert.notEqual(restored.pid, beforeUpdate.pid);
    assert.deepEqual(restored.identity, beforeUpdate.identity, "Rollback must restore the captured launch identity.");
    assert.equal(readFileSync(lockPath, "utf8"), lock, "Lifecycle children cannot release the parent's lock.");
  } finally {
    releaseHandover();
  }
  assert.deepEqual(json("task", "message", "list", task.id), beforeUpdateMessages);
  process.stdout.write(`Update handover lifecycle smoke passed (${Math.round(performance.now() - updateStarted)} ms).\n`);
  const stopped = runCli(cli, ["controller", "stop"], environment);
  if (!stopped.includes("Controller stopped.")) {
    throw new Error("Installed CLI controller did not stop cleanly.");
  }
} finally {
  // setup can start a Controller before any Task command succeeds. Inspect the
  // fixture we own instead of setting a late "started" flag. Do not erase the
  // Home when shutdown fails: another Agent needs its exact identity to clean it.
  if (existsSync(join(yuiHome, "yui.db")) && cli !== undefined && environment !== undefined) {
    try {
      runCli(cli, ["controller", "stop"], environment);
    } catch (error) {
      throw new Error(`Runtime smoke cleanup failed; fixture retained at ${sandbox}.`, { cause: error });
    }
  }
  if (environment !== undefined) {
    try { tmux("kill-server"); }
    catch (error) {
      if (!/no server running|No such file or directory/.test(String(error.stderr))) throw error;
    }
  }
  rmSync(sandbox, { recursive: true, force: true });
}
process.stdout.write("Runtime package smoke passed.\n");

function runCli(cli, args, env, input) {
  return execFileSync(cli, args, { encoding: "utf8", env, input, timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] });
}

function json(...args) {
  const reply = JSON.parse(runCli(cli, ["--json", ...args], environment));
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.data;
}

function tmux(...args) {
  return execFileSync("tmux", ["-L", tmuxServer, ...args],
    { env: environment, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
}

function processExited(pid) {
  try { return /^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}

async function waitFor(check, message, diagnostics = () => "") {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(50);
  }
  throw new Error(`${message} Fixture: ${sandbox}\n${diagnostics()}`);
}
