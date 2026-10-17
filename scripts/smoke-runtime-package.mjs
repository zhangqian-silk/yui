import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
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
const development = process.argv[2] === "--development";
if (process.argv.length !== (assembled || development ? 4 : 2)) {
  throw new Error("Usage: smoke-runtime-package.mjs [--assembled <package-root> | --development <checkout>]");
}
// Imports resolve physically, including macOS /var -> /private/var. Compare
// installed Skill paths against that same package identity.
const root = realpathSync(resolve(assembled || development ? process.argv[3] : process.env.YUI_INSTALLED_ROOT ?? process.cwd()));
const sandbox = mkdtempSync(join(tmpdir(), "yui-runtime-package-smoke-"));
const isolatedHome = join(sandbox, "home");
const yuiHome = join(isolatedHome, ".yui");
const fakeBin = join(sandbox, "bin");
// Yui canonicalizes YUI_HOME to its physical path before deriving the tmux
// server name; /var is a system symlink to /private/var on macOS, so hash the
// physical path here to stay on the same server.
const canonicalYuiHome = (() => {
  try {
    mkdirSync(yuiHome, { recursive: true, mode: 0o700 });
    return realpathSync(yuiHome);
  } catch {
    return resolve(yuiHome);
  }
})();
const tmuxServer = `yui-${createHash("sha256").update(canonicalYuiHome).digest("hex").slice(0, 24)}`;
let cli;
let environment;
let operatorHostPid;
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
    `#!${process.execPath}\nprocess.env.YUI_FAKE_UNIQUE_THREADS = "1";\nimport(${JSON.stringify(fakeCodex.href)}).catch(error => { console.error(error); process.exitCode = 1; });\n`,
    { mode: 0o755 });
  symlinkSync(process.execPath, join(fakeBin, "node"));
  // Optional real Git for the compatibility matrix; never replace system Git.
  if (process.env.YUI_TEST_GIT !== undefined) {
    assert.ok(isAbsolute(process.env.YUI_TEST_GIT), "YUI_TEST_GIT must be an absolute executable path");
    console.log(execFileSync(process.env.YUI_TEST_GIT, ["--version"], { encoding: "utf8" }).trim());
    symlinkSync(process.env.YUI_TEST_GIT, join(fakeBin, "git"));
  }

  // Linux places tmux in /usr/bin; macOS Homebrew uses /opt/homebrew/bin
  // (Apple Silicon) or /usr/local/bin (Intel). Resolve the host's tmux and
  // add its directory to the otherwise deterministic PATH.
  const hostTmuxBin = (() => {
    const resolved = spawnSync("/bin/sh", ["-c", "command -v tmux"], {
      env: { ...process.env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return resolved.status === 0 ? dirname(resolved.stdout.trim()) : undefined;
  })();

  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(packageJson.os.includes(process.platform));
  assert.ok(packageJson.cpu.includes(process.arch));
  // Exercise the installed binary, not a checkout helper or a fake Provider.
  const nativeRoot = join(root, "dist/runtime/native", `${process.platform}-${process.arch}`);
  assert.equal(execFileSync(join(nativeRoot, "claude-process-owner"),
    ["/bin/echo", "native-ready"], { encoding: "utf8" }).trim(), "native-ready");
  if (process.platform === "darwin") {
    assert.match(execFileSync(join(nativeRoot, "process-identity"), [String(process.pid)],
      { encoding: "utf8" }).trim(), /^[1-9][0-9]+$/u);
  }
  // Follow the actual instructions' local Markdown links, including cross-Role
  // references, in the installed tree. Source-only references cannot satisfy
  // this check; prose/heading changes do not invalidate the contract.
  const skillRoot = resolve(root, "skills");
  const { checkCurrentSkills } = await import(pathToFileURL(join(root, "dist/context/currentSkills.js")).href);
  const installedSkills = checkCurrentSkills(yuiHome, skills);
  assert.deepEqual(installedSkills.map(skill => skill.path), skills.map(id => join(skillRoot, id)));
  for (const skill of installedSkills) {
    assert.match(skill.version, /^[1-9][0-9]*$/);
    assert.equal(skill.versionPath, join(skill.path, "VERSION"));
  }
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
  if (!development && (installedMode & 0o111) === 0) {
    throw new Error(
      `Installed dist/cli.js must be executable, received ${installedMode.toString(8).padStart(4, "0")}.`
    );
  }

  cli = development ? join(root, "output/dev/bin/yui")
    : assembled ? installedCli : resolve(root, "..", "..", ".bin", "yui");
  if (!existsSync(cli)) {
    throw new Error("Installed runtime package did not create its yui bin.");
  }
  // Sessions use the normal launch PATH, pointing at this exact fixture package.
  symlinkSync(cli, join(fakeBin, "yui"));
  environment = {
    HOME: isolatedHome,
    CODEX_HOME: join(isolatedHome, ".codex"),
    YUI_HOME: yuiHome,
    PATH: [
      fakeBin,
      "/usr/bin",
      "/bin",
      ...(hostTmuxBin !== undefined && hostTmuxBin !== "/usr/bin" && hostTmuxBin !== "/bin"
        ? [hostTmuxBin]
        : [])
    ].join(delimiter),
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
  const offlineLeader = { ...environment, YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-fixture",
    YUI_ROLE: "leader", YUI_NATIVE_SESSION_ID: "offline-help-only" };
  const scopedHelp = runCli(cli, ["help", "task", "role"], offlineLeader);
  if (!scopedHelp.includes("yui task role <command>") || !scopedHelp.includes("add")) {
    throw new Error("Installed CLI nested help did not render the restored command catalog.");
  }
  const publicTree = JSON.parse(runCli(cli, ["--json", "help", "task"], environment)).data;
  assert.ok(!publicTree.children.some(child => child.path === "task role"),
    "Public discovery must not expose internal role coordination.");
  assert.equal(spawnSync(cli, ["help", "task", "role"], { env: environment, encoding: "utf8" }).status, 2);
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

  const doctorStarted = Date.now();
  const doctor = json("doctor");
  assert.equal(doctor.storage.healthy, true);
  const sqliteCheck = doctor.checks.find(check => check.name === "sqlite driver");
  assert.equal(sqliteCheck?.status, "ok");
  assert.match(sqliteCheck.detail, /sqlite-(modern|compat)@.*SQLite \d+\.\d+\.\d+/);
  assert.match(sqliteCheck.detail, /fallback/);
  console.log(`SQLite Doctor: ${sqliteCheck.detail}`);
  const ptyChecks = doctor.checks.filter(check => check.name === "node-pty" || check.name.startsWith("pty "));
  assert.ok(ptyChecks.some(check => check.name === "pty spawn"));
  assert.ok(ptyChecks.every(check => check.status === "ok"), JSON.stringify(ptyChecks));
  const consumerRequire = createRequire(join(root, "package.json"));
  assert.equal(packageJson.dependencies["node-pty"], "1.2.0-beta.15");
  assert.equal(consumerRequire("node-pty/package.json").version, "1.2.0-beta.15");
  assert.ok(ptyChecks.find(check => check.name === "node-pty").detail.includes(consumerRequire.resolve("node-pty")));
  console.log(`Default Doctor passed in ${Date.now() - doctorStarted}ms: ${JSON.stringify(ptyChecks)}`);
  if (!assembled) {
    const consumerModules = realpathSync(resolve(root, "../.."));
    const resolvedPty = consumerRequire.resolve("node-pty");
    assert.ok(!relative(consumerModules, resolvedPty).startsWith(".."),
      `PTY must resolve inside the consumer install, not the checkout: ${resolvedPty}`);
  }
  if (process.platform === "darwin") {
    // Damage only a disposable copy; never chmod the real install under test.
    const copyRoot = join(sandbox, "broken-pty");
    const copyModule = join(copyRoot, "node_modules/node-pty");
    cpSync(dirname(consumerRequire.resolve("node-pty/package.json")), copyModule, { recursive: true });
    const { inspectPty } = await import(pathToFileURL(join(root, "dist/doctor/ptyProbe.js")).href);
    const requireFrom = pathToFileURL(join(copyRoot, "entry.cjs")).href;
    const healthy = inspectPty({ requireFrom });
    assert.ok(healthy.every(check => check.status === "ok"), JSON.stringify(healthy));
    const helperCheck = healthy.find(check => check.name === "pty helper");
    const helper = helperCheck.detail.match(/helper=(.*?); mode=/u)?.[1];
    // Node resolves the native module physically (/var -> /private/var on macOS).
    assert.ok(helper?.startsWith(`${realpathSync(copyModule)}/`), helperCheck.detail);
    chmodSync(helper, 0o644);
    const denied = inspectPty({ requireFrom });
    const failed = denied.find(check => check.name === "pty helper");
    assert.equal(failed.status, "invalid");
    assert.ok(failed.detail.includes(helper));
    assert.match(failed.detail, /mode=0644.*permission denied/);
    assert.equal(statSync(helper).mode & 0o777, 0o644, "Doctor must not repair the helper");
    assert.equal(denied.some(check => check.name === "pty spawn"), false);
    console.log(`Damaged macOS helper diagnosed without repair: ${failed.detail}`);
  }
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
  assert.equal(lifecycle.identity.controllerProtocolVersion, status.identity.runtime.protocolVersion);
  assert.equal(lifecycle.identity.storageVersion, status.identity.storage.storageVersion);
  assert.equal(lifecycle.identity.minimumStorageVersion, status.identity.storage.minimumStorageVersion);
  const { task } = json("task", "create", "runtime smoke");
  assert.equal(task.status, "draft");
  assert.throws(() => runCli(cli, ["task", "activate", task.id], environment), error => {
    assert.match(String(error.stderr), /activation request.*required/i);
    return true;
  }, "Activation must not invent request-free intent.");
  assert.equal(json("task", "show", task.id).task.status, "draft");
  const original = "Keep the original requirement across restart. Archive this fixture Task after completion.";
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

  let eventCursor = json("task", "context", task.id).coreCursor;
  const observedEvents = [];
  const events = () => {
    let continuation;
    do {
      const page = json("task", "context", "delta", task.id, "--after", eventCursor,
        ...(continuation === undefined ? [] : ["--continuation", continuation]));
      for (const entry of page.events) observedEvents.push(entry.value ??
        json("task", "context", "inspect", task.id, "--store", entry.ref.store,
          "--ref", entry.ref.refId, "--digest", entry.ref.digest).value);
      continuation = page.continuation;
      if (continuation === undefined) eventCursor = page.throughCursor;
    } while (continuation !== undefined);
    return observedEvents;
  };
  const wakes = () => listItems("task", "wake", "list", task.id)
    .map(entry => json("task", "wake", "show", task.id, entry.id).wake);
  json("task", "activation", "request", task.id, "--request-id", "execute", "--environment", "scratch");
  await waitFor(() => JSON.stringify(events()).includes("Native Codex result."),
    "CLI input did not traverse Controller, Host and fake Provider back to durable results.",
    () => JSON.stringify({ task: json("task", "show", task.id), events: json("task", "event", "list", task.id) }));
  assert.equal(json("task", "show", task.id).task.status, "active");
  assert.equal(existsSync(join(yuiHome, "runtime", "session-cli")), false,
    "Launching and waking a Leader must not generate a Session CLI script.");
  const { checkSessionSkills, readSessionBootstrapManifest } =
    await import(pathToFileURL(join(root, "dist/context/sessionBootstrapManifest.js")).href);
  const manifests = () => readdirSync(join(yuiHome, "runtime/session-manifests")).map(file =>
    join(yuiHome, "runtime/session-manifests", file));
  const leaderManifestPath = manifests().find(path => {
    const manifest = readSessionBootstrapManifest(path);
    return manifest.owner.scope === "task" && manifest.owner.taskId === task.id;
  });
  assert.ok(leaderManifestPath);
  const leaderSkills = checkSessionSkills(yuiHome, leaderManifestPath);
  assert.deepEqual(leaderSkills.skills.map(skill => skill.id), ["yui-runtime", "yui-leader"]);
  assert.equal(readSessionBootstrapManifest(leaderManifestPath).contextProtocol.skillCheckCommand,
    "yui session skills --json");
  for (const skill of leaderSkills.skills) assert.equal(skill.path, join(skillRoot, skill.id));
  // Desktop entry has only the native identity. The fixture explicitly
  // acknowledges its handled originals; a fake terminal is not that receipt.
  const leaderNative = events().find(event => event.type === "runtime.native-connection-bound"
    && event.payload.roleName === "leader").payload.nativeSessionId;
  const desktopLeader = { ...environment, CODEX_THREAD_ID: leaderNative };
  // A real CLI claim, followed by a legal Session replacement, must not fence
  // the very successor which needs to inspect and settle that claim.
  const oldWindow = JSON.parse(runCli(cli, ["--json", "inbox", "list"], desktopLeader)).data.items
    .find(item => item.kind === "notification-window" && item.blocked === null);
  assert.ok(oldWindow);
  runCli(cli, ["inbox", "show", oldWindow.id, "--json"], desktopLeader);
  const oldClaim = JSON.parse(runCli(cli, ["inbox", "claim", oldWindow.id,
    "--request-id", "interrupted-handler", "--json"], desktopLeader)).data.inbox.claim;
  json("controller", "restart");
  runCli(cli, ["task", "role", "session", "new", task.id, "leader",
    "--reason", "Fixture handler ended before acknowledgement; preserve its obligation."], desktopLeader);
  await waitFor(() => events().some(event => event.type === "runtime.native-connection-bound"
    && event.payload.roleName === "leader" && event.payload.nativeSessionId !== leaderNative),
  "Retained claim prevented the replacement Leader from cold-starting.",
  () => JSON.stringify({ events: events().slice(-16), wakes: wakes() }));
  const successorNative = events().filter(event => event.type === "runtime.native-connection-bound"
    && event.payload.roleName === "leader").at(-1).payload.nativeSessionId;
  desktopLeader.CODEX_THREAD_ID = successorNative;
  const retained = JSON.parse(runCli(cli, ["inbox", "show", oldWindow.id, "--json"], desktopLeader)).data;
  assert.deepEqual(retained.inbox.claim, oldClaim);
  assert.equal(retained.inbox.ack, undefined, "replacement is not handling");
  await waitFor(() => events().some(event => event.type === "runtime.observation"
    && event.payload.kind === "turn.completed"
    && JSON.parse(event.payload.observation).fence.nativeSessionId === successorNative),
  "Successor initialization did not finish.");
  const successorWakes = wakes();
  json("task", "reconcile", task.id);
  json("task", "reconcile", task.id);
  assert.deepEqual(wakes(), successorWakes, "reconcile must not repeatedly wake for the same retained obligation");
  const disposition = ["inbox", "ack", oldWindow.id, "--request-id", "successor-settlement",
    "--reason", "Read original and verified existing deterministic result; no business replay.", "--json"];
  const settled = JSON.parse(runCli(cli, disposition, desktopLeader)).data;
  // Lost response recovery repeats only the exact ack, never the business.
  assert.deepEqual(JSON.parse(runCli(cli, disposition, desktopLeader)).data, settled);
  assert.equal(settled.inbox.ack.actor.nativeSessionId, successorNative);
  console.log("Retained-claim Session replacement and idempotent successor settlement passed.");
  const acknowledgeWindows = () => {
    const pending = JSON.parse(runCli(cli, ["--json", "inbox", "list"], desktopLeader)).data;
    assert.equal(pending.identity.roleName, "leader");
    for (const item of pending.items.filter(item => item.kind === "notification-window" && item.blocked === null)) {
      runCli(cli, ["inbox", "show", item.id, "--json"], desktopLeader);
      const claimed = JSON.parse(runCli(cli, ["--json", "inbox", "claim", item.id,
        "--request-id", `fixture-claim-${item.id}`], desktopLeader)).data;
      runCli(cli, ["task", "wake", "show", task.id, claimed.id, "--json"], desktopLeader);
      runCli(cli, ["inbox", "ack", claimed.id, "--request-id", `fixture-ack-${item.id}`,
        "--reason", "Fixture inspected original and deterministic result."], desktopLeader);
    }
  };
  const desktopSkills = JSON.parse(runCli(cli, ["session", "skills", "--json"], desktopLeader)).data;
  assert.deepEqual(desktopSkills.skills.map(skill => skill.id), ["yui-runtime", "yui-leader"]);
  acknowledgeWindows();
  json("task", "complete", task.id, "--summary", "The deterministic Provider result is accepted.");
  assert.equal(json("task", "show", task.id).task.status, "completed");

  // Exercise the public reopen -> Operator submission path in the same Home
  // and conversation. Deliberately let the lifecycle-only notification finish
  // first, so a second, exact Message must reach the Host on its own wake.
  const followupStarted = performance.now();
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
    const wake = wakes().find(w => w.reasons.includes("task-reopened"));
    return wake !== undefined && terminalForWake(wake);
  }, "Reopen notification did not finish through the existing Host.");
  const request = ["operator", "submit", "Continue this same accepted result; local fixture only.",
    "--task", task.id, "--intent", "develop", "--request-id", "authorized-followup"];
  runCli(cli, request, environment);
  runCli(cli, request, environment);
  const inputs = listItems("task", "message", "list", task.id)
    .map(entry => json("task", "message", "show", `${task.id}/${entry.ref.refId}`));
  const followups = inputs.filter(message => message?.submissionKey === "authorized-followup");
  assert.equal(followups.length, 1, "Matching Operator retries must retain one original Message.");
  const followup = followups[0];
  assert.equal(followup.submissionReceipt.routing.kind, "active-context");
  assert.equal(followup.submissionReceipt.feedback.delivery, "queued");
  await waitFor(() => {
    const wake = wakes().find(w =>
      w.refs?.some(ref => ref.type === "message" && ref.id === followup.id));
    return wake !== undefined && terminalForWake(wake);
  }, "The exact follow-up Message did not traverse CLI/Controller/Host/native terminal.");
  assert.equal(events().filter(event => event.type === "task.reopened").length, 1);
  assert.deepEqual(events().find(event => event.id === originalCompletion.id), originalCompletion);
  acknowledgeWindows();
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
  const sourceMessage = json("task", "context", "list", task.id, "--store", "task-message").items
    .map(entry => json("task", "message", "show", `${task.id}/${entry.ref.refId}`))
    .find(message => message?.body === original);
  assert.ok(sourceMessage);
  const connection = events().filter(event => event.type === "runtime.native-connection-bound"
    && event.payload.roleName === "leader").at(-1);
  assert.ok(connection);
  const manifestDirectory = join(yuiHome, "runtime", "session-manifests");
  const manifestPath = readdirSync(manifestDirectory).map(name => join(manifestDirectory, name))
    .find(path => {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      return manifest.owner.scope === "task" && manifest.owner.taskId === task.id
        && manifest.roleKind === "leader";
    });
  assert.ok(manifestPath);
  const archiveReply = JSON.parse(runCli(cli, ["--json", "task", "archive", task.id, "--integrated",
    "--source-message", sourceMessage.id, "--purpose", "Archive this fixture Task after completion.",
    "--request-id", "leader-fixture-archive"], {
    ...environment, YUI_SESSION_SCOPE: "task", YUI_TASK_ID: task.id, YUI_ROLE: "leader",
    YUI_NATIVE_SESSION_ID: connection.payload.nativeSessionId, YUI_SESSION_MANIFEST: manifestPath
  }));
  assert.equal(archiveReply.ok, true, JSON.stringify(archiveReply));
  assert.equal(archiveReply.data.kind, "value", JSON.stringify({
    archiveReply, events: archiveReply.data.kind === "value" ? [] : events().slice(-20)
  }));
  assert.equal(archiveReply.data.value.status, "archived", JSON.stringify(archiveReply));
  assert.equal(json("task", "show", task.id).task.status, "archived");
  assert.ok(events().some(event => event.type === "task.leader-archive-result"
    && event.payload.status === "archived"), "Self-stop must leave a readable Controller-owned receipt.");
  assert.equal(processExited(panePid), true, "Archive must release the Host, not just its durable Session.");
  const sessions = tmux("list-sessions", "-F", "#{session_name}").trim().split("\n");
  assert.deepEqual(sessions, [neighbor], "Archive must remove its live/dead panes and viewer, but not task-10.");
  json("task", "archive", task.id, "--integrated");
  assert.deepEqual(tmux("list-sessions", "-F", "#{session_name}").trim().split("\n"), [neighbor]);
  const serverPid = Number(tmux("display-message", "-p", "-t", `=${neighbor}:`, "#{pid}").trim());
  tmux("kill-session", "-t", `=${neighbor}`);
  await waitFor(() => processExited(serverPid), "The empty fixture tmux server did not exit.");

  const updateStarted = performance.now();
  // Keep a real Host alive across the updater's Controller replacement. Only
  // the external Provider is fake; its direct notifications represent Desktop
  // input, not another managed turn/start or a fabricated durable terminal.
  const directPort = join(sandbox, "direct.port");
  writeFileSync(join(fakeBin, "codex"),
    `#!${process.execPath}\nprocess.env.YUI_FAKE_DIRECT_PORT_FILE = ${JSON.stringify(directPort)};\n`
    + `process.env.YUI_FAKE_TURN_HANDLER = ${JSON.stringify(new URL("../test/fixtures/inbox-smoke-handler.mjs", import.meta.url).href)};\n`
    + `import(${JSON.stringify(fakeCodex.href)}).catch(error => { console.error(error); process.exitCode = 1; });\n`,
    { mode: 0o755 });
  const { callFileTaskController } = await import(pathToFileURL(join(root, "dist/controller/clientRuntime.js")).href);
  const { inspectAgentHost } = await import(pathToFileURL(join(root, "dist/runtime/agentHost.js")).href);
  const { FileRuntimeEventInbox } = await import(pathToFileURL(join(root, "dist/controller/runtimeEventInbox.js")).href);
  const target = { home: yuiHome, scope: "global", roleName: "operator" };
  await callFileTaskController(yuiHome, "runtime.ensure-role-session",
    { scope: "global", roleName: "operator" }, { environment, requestTimeoutMs: 15_000 });
  // --pending is an Agent handling view, not a delivery queue. This smoke uses
  // a fake Provider without semantic inbox acknowledgements; only test its
  // original delivery receipts here, never infer that it handled the inputs.
  const pending = () => listItems("role", "message", "list", "operator", "--pending")
    .filter(message => message.delivery === undefined && message.notDelivered === undefined
      && (message.inputAction === "queue" || message.interruptThen));
  const context = () => json("session", "context", "operator");
  await waitFor(async () => (await inspectAgentHost(target)).state === "idle" && pending().length === 0,
    "Operator startup did not settle.");
  const hostBefore = await inspectAgentHost(target);
  const hostPid = Number(tmux("list-panes", "-a", "-F", "#{pane_pid}").trim());
  assert.ok(Number.isInteger(hostPid) && hostPid > 0);
  operatorHostPid = hostPid;
  const directEvent = (method, status) => ({ method, params: {
    threadId: hostBefore.nativeSessionId,
    turn: { id: "desktop-update", status,
      items: [{ id: "update-output", type: "agentMessage", text: "Original update-window result." }] }
  } });
  await sendDirect(directPort, directEvent("turn/started", "inProgress"));
  await waitFor(() => context().nativeTurn?.attemptId === "direct:desktop-update",
    "Desktop input was not observed before handover.");
  const queuedBody = "Preserve this input across update.";
  const queued = json("role", "message", "queue", "operator", queuedBody,
    "--request-id", "update-pending").message;
  const notificationTask = json("task", "create", "update notification fixture").task;
  json("task", "cancel", notificationTask.id, "--summary", "Notify the busy Operator.");
  await waitFor(() => pending().some(message => message.id !== queued.id),
    "The Task fact did not produce a pending engineering notice.");
  const queuedBefore = pending().map(message => json("role", "message", "show", "operator", message.id));
  assert.ok(queuedBefore.some(message => message.id !== queued.id && message.body.includes(notificationTask.id)),
    "The pending engineering notice must reference this exact Task fact.");
  assert.equal(context().nativeTurn.status, "accepted", "Busy Desktop input must fence queued delivery.");
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
    assert.equal(processExited(hostPid), false, "Controller replacement must preserve the original Host.");
    await sendDirect(directPort, directEvent("turn/completed", "completed"));
    const inbox = new FileRuntimeEventInbox(yuiHome);
    const terminal = () => inbox.list().find(event => event.type === "runtime-observation"
      && event.observation.kind === "turn.completed"
      && event.observation.fence.nativeSessionId === hostBefore.nativeSessionId
      && event.observation.fence.nativeTurnId === "desktop-update");
    await waitFor(() => terminal() !== undefined,
    "The surviving Host did not persist its terminal while the Controller was offline.");
    const retainedTerminal = terminal();
    assert.match(JSON.stringify(retainedTerminal.observation.payload), /Original update-window result\./);
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
  await waitFor(() => pending().length === 0 && context().nativeTurn?.status === "completed",
    "Replacement Controller did not consume the retained terminal and drain pending inputs.",
    () => JSON.stringify(context()));
  const hostAfter = await inspectAgentHost(target);
  for (const key of ["nativeSessionId", "processInstanceId", "endpointImplementation",
    "authorityEpoch", "authorityOwner", "authorityHolderId"]) {
    assert.deepEqual(hostAfter[key], hostBefore[key], `Handover must preserve the original Host's ${key}.`);
  }
  assert.equal(processExited(hostPid), false);
  for (const original of queuedBefore) {
    const delivered = json("role", "message", "show", "operator", original.id);
    assert.ok(delivered.delivery, `Pending input ${original.id} was not accepted.`);
    const { delivery, control, inbox, ...retained } = delivered;
    assert.deepEqual(retained, original, "Delivery must retain each original input, target and request identity.");
  }
  const missingReceipt = json("role", "message", "show", "operator", queued.id);
  assert.equal(missingReceipt.inbox?.claim.requestId, "fixture-routing-claim");
  assert.equal(missingReceipt.inbox?.ack, undefined, "successful routing and final must not synthesize ACK");
  assert.equal(json("task", "list", "--search", "inbox routing effect").total, 1,
    "the deterministic Provider performed exactly one real isolated routing effect");
  const checkNotices = listItems("role", "message", "list", "operator")
    .map(message => json("role", "message", "show", "operator", message.id))
    .filter(message => message.inputControl?.requestId.startsWith("inbox-check:")
      && message.body.includes(`"${missingReceipt.inbox.claim.actor.attemptId}"`));
  assert.equal(checkNotices.length, 1, "the real Controller/Host path must detect the missing receipt exactly once");
  const ownOperator = { ...environment, CODEX_THREAD_ID: hostBefore.nativeSessionId };
  const ackCommand = ["inbox", "ack", queued.id, "--request-id", "fixture-routing-ack",
    "--reason", "Verified the existing routed Task; no business replay"];
  const ack = runCli(cli, ackCommand, ownOperator);
  assert.equal(runCli(cli, ackCommand, ownOperator), ack, "lost ACK response retries the same disposition only");
  assert.equal(json("task", "list", "--search", "inbox routing effect").total, 1);
  assert.ok(context().pending.historyCount > 0, "unhandled historical notices remain a separate evidence count");
  process.stdout.write("Inbox handling smoke passed: real routing effect, omitted ACK, bounded reminder, idempotent receipt recovery.\n");
  const completedTurn = context().nativeTurn;
  json("role", "message", "queue", "operator", queuedBody, "--request-id", "update-pending");
  assert.equal(listItems("role", "message", "list", "operator").filter(message => message.id === queued.id).length, 1);
  assert.deepEqual(context().nativeTurn, completedTurn, "Retrying the same saved request must not start another Turn.");
  // Restore an idle, valid historical Session shape through the real package/
  // Controller/Host chain. Removing optional audit metadata in this disposable
  // fixture does not forge any native acceptance or change the original queue.
  const { SqliteTaskStore } = await import(pathToFileURL(join(root, "dist/storage/sqliteStore.js")).href);
  const fixtureStore = new SqliteTaskStore(yuiHome);
  try {
    fixtureStore.transaction(store => {
      const sessions = store.getGlobalRoleSessionSet("operator");
      const active = sessions.sessions[sessions.activeAgentId];
      const { skillPackages, ...historicalEffective } = active.effective;
      store.saveGlobalRoleSessionSet({ ...sessions, sessions: { ...sessions.sessions,
        [sessions.activeAgentId]: { ...active, effective: historicalEffective } } });
    });
  } finally { fixtureStore.close(); }
  const beforeHostRestart = listItems("role", "message", "list", "operator");
  await waitFor(async () => (await inspectAgentHost(target)).state === "idle",
    "Only an idle fixture Host may be restarted.");
  process.kill(hostPid, "SIGTERM");
  await waitFor(() => processExited(hostPid), "Original fixture Host did not exit.");
  await callFileTaskController(yuiHome, "runtime.ensure-role-session",
    { scope: "global", roleName: "operator" }, { environment, requestTimeoutMs: 15_000 });
  await waitFor(async () => (await inspectAgentHost(target)).state === "idle",
    "Historical Session did not restore after Host restart.");
  operatorHostPid = Number(tmux("list-panes", "-a", "-F", "#{pane_pid}").trim());
  assert.ok(Number.isInteger(operatorHostPid) && operatorHostPid > 0 && operatorHostPid !== hostPid);
  assert.equal((await inspectAgentHost(target)).nativeSessionId, hostBefore.nativeSessionId);
  assert.equal(Object.hasOwn(context(), "skillPackages"), false,
    "Default Context must not carry historical Skill packages.");
  const restoredStore = new SqliteTaskStore(yuiHome);
  try {
    const sessions = restoredStore.getGlobalRoleSessionSet("operator");
    assert.equal(sessions.sessions[sessions.activeAgentId].effective.skillPackages, undefined,
      "Restore must not invent historical Skill provenance.");
  } finally { restoredStore.close(); }
  assert.deepEqual(listItems("role", "message", "list", "operator"), beforeHostRestart);
  const restoredInput = json("role", "message", "queue", "operator", "Continue the same restored Session.",
    "--request-id", "restored-session-input").message;
  await waitFor(() => context().nativeTurn?.status === "completed"
    && json("role", "message", "show", "operator", restoredInput.id).delivery?.via === "provider",
    "The restored historical Session did not process its new input.");
  // Teardown live work before the Controller, not just a tmux server sweep.
  runCli(cli, ["session", "stop", "--all"], environment);
  await waitFor(() => processExited(operatorHostPid), "The fixture Operator Host did not exit.");
  assert.equal(updatePorts.controllerStatus(yuiHome).running, false,
    "Session maintenance must stop its Controller after releasing the Host.");
  process.stdout.write(`Update handover lifecycle smoke passed (${Math.round(performance.now() - updateStarted)} ms).\n`);
} finally {
  // Even a failed handover check must stop its live fixture Host before
  // stopping the Controller or deleting the Home it could still write.
  if (environment !== undefined) {
    try { tmux("kill-server"); }
    catch (error) {
      if (!/no server running|No such file or directory/.test(String(error.stderr))) throw error;
    }
    if (operatorHostPid !== undefined) {
      await waitFor(() => processExited(operatorHostPid), "Fixture Host cleanup failed; Home retained.");
    }
  }
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
  // tmux kill-server tears its panes down asynchronously; a Host inside a
  // dying pane can still flush one inbox file. Retry the removal briefly so
  // teardown does not race that shutdown (observed on macOS).
  const removeDeadline = Date.now() + 3000;
  for (;;) {
    try {
      rmSync(sandbox, { recursive: true, force: true });
      break;
    } catch (error) {
      if (
        Date.now() >= removeDeadline
        || (error.code !== "ENOTEMPTY" && error.code !== "EBUSY" && error.code !== "EPERM")
      ) {
        throw error;
      }
      await delay(100);
    }
  }
}
process.stdout.write("Runtime package smoke passed.\n");

function runCli(cli, args, env, input) {
  return execFileSync(cli, args, { encoding: "utf8", env, input, timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] });
}

function json(...args) {
  const read = tail => {
    const reply = JSON.parse(runCli(cli, ["--json", ...args, ...tail], environment));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.data;
  };
  let data = read([]);
  if (data?.contentPage === undefined) return data;
  const { source, digest } = data.contentPage;
  let text = "";
  for (;;) {
    const page = data.contentPage;
    assert.equal(page.source, source);
    assert.equal(page.digest, digest);
    assert.equal(page.offset, text.length);
    text += page.text;
    if (page.complete) {
      assert.equal(page.nextCursor, null);
      return JSON.parse(text);
    }
    data = read(["--cursor", page.nextCursor]);
  }
}

function listItems(...args) {
  const items = [];
  let cursor;
  do {
    const page = json(...args, ...(cursor === undefined ? [] : ["--cursor", cursor]));
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}

function tmux(...args) {
  return execFileSync("tmux", ["-L", tmuxServer, ...args],
    { env: environment, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
}

function processExited(pid) {
  if (process.platform !== "linux") {
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === "EPERM" ? false : true; }
  }
  try { return /^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}

async function waitFor(check, message, diagnostics = () => "") {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`${message} Fixture: ${sandbox}\n${diagnostics()}`);
}

function sendDirect(portFile, event) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(readFileSync(portFile, "utf8")) });
    socket.setTimeout(5000, () => socket.destroy(new Error("Direct fixture notification timed out.")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify([event])}\n`));
    socket.once("data", () => { socket.end(); resolve(); });
  });
}
