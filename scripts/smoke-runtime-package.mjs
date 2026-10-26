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
import { parseArgs } from "node:util";
import { buildReleaseManifest } from "./lib/runtime-package.mjs";

const started = performance.now();
let phaseStarted = started;
let cliCalls = 0;
let cliElapsed = 0;
function phase(name) {
  const now = performance.now();
  console.log(`TIMING ${name}: ${Math.round(now - phaseStarted)} ms`);
  // Includes command execution and Controller waits, not just Node startup.
  // This is a subset of phase wall time; never add it to the phase total.
  console.log(`TIMING cli/${name}: ${cliCalls} calls, ${Math.round(cliElapsed)} ms`);
  cliCalls = 0;
  cliElapsed = 0;
  phaseStarted = now;
}
const { values } = parseArgs({ options: {
  assembled: { type: "string" },
  development: { type: "string" },
  profile: { type: "string", default: "full" }
} });
const assembled = values.assembled !== undefined;
const development = values.development !== undefined;
const profile = values.profile;
if ((assembled && development) || !["full", "lifecycle", "compatibility"].includes(profile)) {
  throw new Error("Usage: smoke-runtime-package.mjs [--assembled <root> | --development <root>] [--profile full|lifecycle|compatibility]");
}
// Imports resolve physically, including macOS /var -> /private/var. Compare
// installed Skill paths against that same package identity.
const root = realpathSync(resolve(values.assembled ?? values.development ?? process.env.YUI_INSTALLED_ROOT ?? process.cwd()));
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
let FixtureStore;
let operatorHostPid;
let scopeRefreshProject;
const skills = [
  "yui-leader",
  "yui-experiment-leader",
  "yui-worker",
  "yui-operator",
  "yui-reviewer",
  "yui-runtime"
];

try {
  console.log(`Runtime package profile: ${profile}; ${process.platform}/${process.arch}; Node ${process.version}`);
  console.log(`Runtime package fixture: ${sandbox}`);
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  mkdirSync(fakeBin, { recursive: true, mode: 0o755 });
  const fakeCodex = new URL("../test/fixtures/fake-codex-cli.mjs", import.meta.url);
  writeFileSync(join(fakeBin, "codex"),
    `#!${process.execPath}\nprocess.env.YUI_FAKE_UNIQUE_THREADS = "1";\n`
    + `process.env.YUI_FAKE_DIRECT_PORT_FILE = ${JSON.stringify(join(sandbox, "work-direct-"))} + (process.env.YUI_ROLE ?? "reader") + ".port";\n`
    + `process.env.YUI_FAKE_INPUT_LOG = ${JSON.stringify(join(sandbox, "skill-inputs.jsonl"))};\n`
    + `process.env.YUI_FAKE_MODELS = ${JSON.stringify(JSON.stringify([{ id: "smoke-model", model: "smoke-model",
      displayName: "Smoke fixture", isDefault: true, supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Fixture only" }
      ], defaultReasoningEffort: "medium" }]))};\n`
    + `process.env.YUI_FAKE_TURN_HANDLER = ${JSON.stringify(new URL("../test/fixtures/scope-refresh-smoke-handler.mjs", import.meta.url).href)};\n`
    + `import(${JSON.stringify(fakeCodex.href)}).catch(error => { console.error(error); process.exitCode = 1; });\n`,
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
  // Standalone configuration ships in dist, not the source-only scripts tree.
  // Help must load all its imports without any Home setup or Controller.
  assert.ok(statSync(join(root, "docs/model-connection-tools.md")).isFile());
  if (profile === "full") {
    // Resolve manuals through the installed HTTP handler, not checkout files.
    // Documentation routes need no Store, Controller or external component.
    const { createYuiWebServer } = await import(pathToFileURL(join(root, "dist/web/webServer.js")).href);
    const docsServer = createYuiWebServer({}, { token: "package-docs-fixture" });
    try {
      await new Promise((accept, reject) => {
        docsServer.once("error", reject);
        docsServer.listen(0, "127.0.0.1", accept);
      });
      for (const suffix of ["", "/connection", "/maintenance", "/metabridge", "/cliproxyapi"]) {
        const response = await fetch(`http://127.0.0.1:${docsServer.address().port}/models/docs${suffix}`);
        assert.equal(response.status, 200, `installed manual ${suffix || "index"}`);
        assert.match(response.headers.get("content-type"), /^text\/plain/);
        assert.ok((await response.text()).trim().length > 0);
      }
    } finally {
      await new Promise(resolve => docsServer.close(resolve));
    }
  }
  const connectionHelp = JSON.parse(execFileSync(process.execPath,
    [join(root, "dist/models/configureConnection.js"), "--help"], { encoding: "utf8",
      env: { PATH: process.env.PATH, CODEX_HOME: join(sandbox, "unused-codex-home") } }));
  assert.match(connectionHelp.usage, /preview --input/);
  const guideHome = join(sandbox, "unused-model-guide-home");
  const modelGuide = JSON.parse(execFileSync(process.execPath,
    [join(root, "dist/cli.js"), "models", "guide", "metabridge", "--json"], {
      encoding: "utf8", env: { PATH: process.env.PATH, HOME: isolatedHome, YUI_HOME: guideHome }
    })).data;
  assert.equal(modelGuide.topic, "metabridge");
  for (const manual of modelGuide.manuals) {
    assert.equal(dirname(manual), join(root, "docs"), "guide resolves installed manuals");
    assert.ok(statSync(manual).isFile());
  }
  assert.equal(existsSync(guideHome), false, "offline guide must not initialize a Home or Controller");
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
      if (!target.endsWith(".md") && !target.endsWith(".mjs")) continue;
      const resolved = resolve(dirname(path), target);
      const local = relative(skillRoot, resolved);
      if (local === ".." || local.startsWith("../") || isAbsolute(local)) {
        throw new Error(`Installed Skill reference leaves its package: ${href}.`);
      }
      pendingSkills.push(resolved);
    }
  }
  // Execute the packaged local helper, not a source-checkout substitute.
  // Its business comparison is covered in Core; here check shipped Node wiring.
  const verifier = spawnSync(process.execPath,
    [join(skillRoot, "yui-operator/scripts/verify-submission.mjs")], { encoding: "utf8" });
  assert.equal(verifier.status, 1);
  assert.match(JSON.parse(verifier.stderr).message, /^Usage: node verify-submission\.mjs /);
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
  const versionReply = JSON.parse(runCli(cli, ["--json", "version"], environment));
  const { yuiVersionIdentity } = await import(pathToFileURL(join(root, "dist/version.js")).href);
  assert.equal(versionReply.ok, true);
  assert.deepEqual(versionReply.data, yuiVersionIdentity());
  assert.equal(Object.hasOwn(versionReply.data, "storageLayoutVersion"), false);
  assert.equal(Object.hasOwn(versionReply.data, "aggregateSchemaVersion"), false);
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
  phase("package/start/setup");

  // Keep installation/startup cold. Repeated real CLI calls may reuse Node's
  // compiled JS only inside this disposable fixture; never cache native binaries,
  // command results or state across installations. Compatibility stays cold.
  if (profile !== "compatibility") {
    environment.NODE_COMPILE_CACHE = join(sandbox, "node-compile-cache");
    ({ SqliteTaskStore: FixtureStore } = await import(pathToFileURL(join(root, "dist/storage/sqliteStore.js")).href));
  }

  // Real public CLI -> Controller -> runner -> separate business/evidence reads,
  // before any Agent Session or Task exists. Only disposable local actions execute.
  // Business wiring runs once on the representative CI environment. Native
  // compatibility and OS process lifecycle coverage below do not depend on it.
  if (profile === "full") {
    const checkNoJobSession = () => observeFixture(store => {
      assert.equal(store.getGlobalRoleSessionSet("operator"), null);
      assert.equal(store.listTasks().length, 0);
      assert.equal(store.getWorkMailbox({ kind: "operator" }), null);
    });
    checkNoJobSession();
    json("job", "define", "--global", "--job", "public-probe", "--title", "Public probe",
      "--input", JSON.stringify({ kind: "builtin", action: "system.noop", input: {} }));
    try {
      const publicRun = json("job", "run", "--global", "--job", "public-probe", "--request-id", "once").run;
      const jobRef = ["--global", "--job", "public-probe", "--run", publicRun.id];
      await waitFor(() => observeFixture(store => store.getGlobalJobRun(publicRun.id)?.status === "succeeded"),
        "Public Job did not complete without a Session.",
        () => JSON.stringify(json("job", "run-evidence", ...jobRef)));
      assert.equal(json("job", "run", "--global", "--job", "public-probe", "--request-id", "once").run.id, publicRun.id);
      const confirmed = json("job", "run-confirm", ...jobRef);
      assert.equal(confirmed.id, publicRun.id);
      assert.equal(confirmed.status, "succeeded");
      assert.equal(json("job", "run-result", ...jobRef).result.data.action, "system.noop");
      assert.equal(json("job", "run-evidence", ...jobRef).processResult.exitCode, 0);
      const publication = json("job", "artifact-save", ...jobRef, "--artifact",
        JSON.stringify({ relativePath: "report.md", content: "# Public Run\n\nSaved without a Task." }));
      assert.equal(publication.status, "registered");
      const artifact = publication.reference;
      assert.equal(artifact.sourceRun.runId, publicRun.id);
      assert.equal(artifact.owner.scope.kind, "global");
      assert.equal(json("job", "artifact-read", ...jobRef, "--reference", JSON.stringify(artifact)).content,
        "# Public Run\n\nSaved without a Task.");
      // Save -> pinned read is the package boundary. Preview/list/result
      // projections remain covered by job-artifact.test.js, not repeated here.
      checkNoJobSession();
      // One real component-tool Job proves the packaged controlled executable,
      // private plan reconstruction and files-only receipt wiring. No service,
      // model, native user configuration or extra Controller is involved.
      const connectionDirectory = join(sandbox, "native-connection");
      mkdirSync(connectionDirectory, { mode: 0o700 });
      const configPath = join(connectionDirectory, "config.toml");
      writeFileSync(configPath, '# package fixture\nmodel = "native"\n', { mode: 0o600 });
      const connectionInput = { codex: { configPath, provider: {
        id: "package_fixture", name: "Package fixture", baseUrl: "http://127.0.0.1:19000/v1", auth: { type: "none" }
      } } };
      const { planConnectionConfig } = await import(pathToFileURL(join(root, "dist/models/connectionConfig.js")).href);
      const { modelDigest } = await import(pathToFileURL(join(root, "dist/models/modelManagementFiles.js")).href);
      const planDigest = modelDigest(planConnectionConfig(connectionInput, {}));
      json("job", "define", "--global", "--job", "native-connection", "--title", "Native connection fixture",
        "--input", JSON.stringify({ kind: "builtin", action: "models.connection",
          input: { input: connectionInput, planDigest, exclusiveWriter: true } }));
      const connectionRun = json("job", "run", "--global", "--job", "native-connection", "--request-id", "native-once").run;
      const connectionRef = ["--global", "--job", "native-connection", "--run", connectionRun.id];
      await waitFor(() => observeFixture(store => store.getGlobalJobRun(connectionRun.id)?.status === "succeeded"),
        "Packaged native configuration Job did not complete.",
        () => JSON.stringify(json("job", "run-result", ...connectionRef)));
      const connectionResult = json("job", "run-result", ...connectionRef).result;
      assert.equal(connectionResult.data.applied, "files-only");
      assert.equal(connectionResult.data.restarted, false);
      assert.ok(connectionResult.data.files.some(file => file.backupPath));
      const { parse } = createRequire(join(root, "package.json"))("smol-toml");
      const nativeConfig = parse(readFileSync(configPath, "utf8"));
      assert.equal(nativeConfig.model_providers.package_fixture.base_url, "http://127.0.0.1:19000/v1");
      assert.equal(nativeConfig.model_provider, undefined);
      checkNoJobSession();
      // Exercise the supported maintenance cadence inside the bounded smoke
      // deadline; the production default is intentionally 120 seconds.
      runCli(cli, ["config", "runtime", "set", "reconciliation-interval-seconds", "5"], environment);
      // The Project sync below already exercises existing-job dispatch through
      // the real Controller/runner. Add only the distinct new-job wiring here.
      const scheduleId = "public-new-job";
      json("schedule", "create", "--global", "--schedule", scheduleId, "--job", "public-probe",
        "--authorization", "service", "--target", JSON.stringify({ kind: "new-job", definitionRevision: 1 }),
        "--rule", JSON.stringify({ kind: "once", at: new Date(Date.now() + 2000).toISOString() }));
      await waitFor(() => observeFixture(store =>
        store.getSchedule({ kind: "global" }, scheduleId)?.state === "completed"),
        "Public service Schedule did not dispatch without a Session.",
        () => JSON.stringify(json("schedule", "show", "--global", "--schedule", scheduleId)));
      const completed = json("schedule", "show", "--global", "--schedule", scheduleId).schedule;
      assert.equal(completed.state, "completed");
      const receipt = completed.lastAttempt;
      const scheduledRef = ["--global", "--job", receipt.jobId, "--run", receipt.runId];
      await waitFor(() => observeFixture(store => store.getGlobalJobRun(receipt.runId)?.status === "succeeded"),
        "Service Job did not complete.", () => JSON.stringify(json("job", "run-evidence", ...scheduledRef)));
      const result = json("job", "run-result", ...scheduledRef);
      assert.equal(result.status, "succeeded");
      assert.equal(result.result.sourceRun.runId, receipt.runId);
      assert.equal(result.result.data.action, "system.noop");
      assert.notEqual(receipt.jobId, "public-probe");
      checkNoJobSession();
      // Builtin installation -> due service dispatch -> real local fast-forward.
      // Reuse this owned Home/Controller and its teardown, never a production remote.
      const syncRemote = join(sandbox, "sync-remote.git"), syncSeed = join(sandbox, "sync-seed");
      const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
        env: { ...environment, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]
      }).trim();
      git(sandbox, "init", "--bare", "--initial-branch=main", syncRemote);
      git(sandbox, "clone", syncRemote, syncSeed);
      writeFileSync(join(syncSeed, "value"), "before\n");
      git(syncSeed, "add", "value"); git(syncSeed, "commit", "-m", "before"); git(syncSeed, "push", "origin", "main");
      const before = git(syncSeed, "rev-parse", "HEAD");
      const project = json("project", "clone", "Sync fixture", syncRemote, "--stable", "main", "--development", "main").project;
      scopeRefreshProject = project;
      const syncId = `project-sync-${project.id}`;
      await waitFor(() => observeFixture(store => store.getSchedule({ kind: "global" }, syncId) !== null),
        "Builtin sync was not installed by Controller reconciliation.");
      let plan = json("schedule", "show", "--global", "--schedule", syncId).schedule;
      assert.equal(plan.target.kind, "existing-job");
      assert.equal(plan.authorization.grantedBy.scope, "service");
      assert.deepEqual(plan.rule, { kind: "cron", expression: "0 */6 * * *", timezone: "Asia/Shanghai" });
      writeFileSync(join(syncSeed, "value"), "after\n");
      git(syncSeed, "commit", "-am", "after"); git(syncSeed, "push", "origin", "main");
      const after = git(syncSeed, "rev-parse", "HEAD");
      json("schedule", "update", "--global", "--schedule", syncId, "--revision", String(plan.revision),
        "--rule", JSON.stringify({ kind: "interval", everyMs: 60000, anchor: new Date(Date.now() + 2000).toISOString() }));
      await waitFor(() => observeFixture(store =>
        store.getSchedule({ kind: "global" }, syncId)?.lastAttempt?.runId),
        "Builtin sync did not dispatch.");
      plan = json("schedule", "show", "--global", "--schedule", syncId).schedule;
      const syncRef = ["--global", "--job", syncId, "--run", plan.lastAttempt.runId];
      await waitFor(() => observeFixture(store => store.getGlobalJobRun(plan.lastAttempt.runId)?.status === "succeeded"),
        "Builtin sync did not fast-forward.", () => JSON.stringify({
          evidence: json("job", "run-evidence", ...syncRef),
          result: json("job", "run-result", ...syncRef),
          logs: json("job", "logs", ...syncRef)
        }));
      const syncResult = json("job", "run-result", ...syncRef);
      assert.equal(syncResult.status, "succeeded");
      assert.equal(syncResult.result.sourceRun.runId, plan.lastAttempt.runId);
      const refresh = syncResult.result.data.refresh;
      assert.equal(refresh.fromCommit, before);
      assert.equal(refresh.toCommit, after);
      assert.equal(refresh.changed, true);
      assert.equal(git(project.path, "rev-parse", "HEAD"), after);
      plan = json("schedule", "show", "--global", "--schedule", syncId).schedule;
      json("schedule", "disable", "--global", "--schedule", syncId, "--revision", String(plan.revision));
      json("controller", "restart");
      plan = json("schedule", "show", "--global", "--schedule", syncId).schedule;
      assert.equal(plan.builtin.enabled, false);
      assert.equal(plan.state, "disabled");
      assert.equal(plan.rule.everyMs, 60000);
      assert.equal(json("job", "runs", "--global", "--job", syncId).length, 1);
      checkNoJobSession();
      process.stdout.write("Builtin Project sync sessionless fast-forward/restart smoke passed.\n");
      runCli(cli, ["config", "runtime", "clear", "reconciliation-interval-seconds"], environment);
    } finally {
      for (const plan of json("schedule", "list", "--global")) {
        if (plan.state === "enabled") json("schedule", "disable", "--global", "--schedule", plan.id, "--revision", String(plan.revision));
      }
      for (const definition of json("job", "list", "--global")) {
        for (const run of json("job", "runs", "--global", "--job", definition.id)) {
          // Terminal Runs need no cancellation or another readiness query.
          if (!["queued", "running"].includes(run.status)) continue;
          const jobRef = ["--global", "--job", definition.id, "--run", run.id];
          json("job", "run-cancel", ...jobRef);
          await waitFor(() => observeFixture(store => {
            const current = store.getGlobalJobRun(run.id);
            return current !== null && !["queued", "running"].includes(current.status);
          }),
            "Public Job cleanup did not settle; retain fixture evidence.");
        }
      }
    }

    // Task delegation uses the existing Draft/Leader aggregate, never a runner
    // or an implicitly elevated Operator. Its delivery goal is still pending
    // until normal Task acceptance; cancellation does not stop that Task.
    json("job", "define", "--global", "--job", "task-delegate", "--title", "Task delegation",
      "--input", JSON.stringify({ kind: "task", goal: "delivery", target: { kind: "new",
        title: "Delegated Draft", description: "Isolated package fixture; no delivery requested.",
        projectBindings: [] } }));
    const delegated = json("job", "run", "--global", "--job", "task-delegate", "--request-id", "delegate-once").run;
    const delegatedRef = ["--global", "--job", "task-delegate", "--run", delegated.id];
    assert.equal(json("job", "run", "--global", "--job", "task-delegate", "--request-id", "delegate-once").run.id, delegated.id);
    assert.equal(json("job", "run-confirm", ...delegatedRef).status, "running");
    const delegatedTask = json("task", "show", delegated.delegation.taskId);
    assert.equal(delegatedTask.task.status, "draft");
    assert.equal(delegatedTask.task.source.run.runId, delegated.id);
    assert.equal(delegatedTask.delegations.items[0].jobId, "task-delegate");
    assert.equal(json("task", "list", "--source", "job").total, 1);
    assert.equal(json("job", "run-delegation", ...delegatedRef).taskId, delegatedTask.task.id);
    json("job", "run-cancel", ...delegatedRef);
    assert.equal(json("job", "run-confirm", ...delegatedRef).status, "cancelled");
    assert.equal(json("task", "show", delegatedTask.task.id).task.executionGate.state, "enabled");
    phase("jobs/schedules/delegation");
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
  phase("doctor/status");
  if (profile !== "compatibility") {
    const { createUpdatePorts } = await import(pathToFileURL(join(root, "dist", "cli", "updatePorts.js")).href);
    // Real update lifecycle children, bounded so a self-wait regression does not
    // spend the production 90-second handover deadline in CI. No npm operation.
    let updatePorts = createUpdatePorts(environment, (command, args, options) =>
      spawnSync(command, args, { ...options, timeout: 15_000 }));
    const lifecycle = updatePorts.controllerStatus(yuiHome);
    const controller = status.resources.find(resource => resource.kind === "controller" && resource.state === "current");
    assert.equal(lifecycle.running, true);
    assert.equal(lifecycle.pid, controller.processes[0].pid);
    assert.equal(lifecycle.identity.version, packageJson.version);
    assert.equal(lifecycle.identity.controllerProtocolVersion, status.identity.runtime.protocolVersion);
    assert.equal(lifecycle.identity.storageVersion, status.identity.storage.storageVersion);
    assert.equal(lifecycle.identity.minimumStorageVersion, status.identity.storage.minimumStorageVersion);
    phase("doctor/identity");
    const { task } = json("task", "create", "runtime smoke");
    assert.equal(task.status, "draft");
    if (profile === "full") {
      const experimentTask = json("task", "create", "experimental knowledge fixture", "--mode", "experiment").task;
      const overridden = json("task", "role", "update", experimentTask.id, "leader",
        "--model", "smoke-model", "--effort", "medium").role;
      assert.equal(overridden.agentBindings[overridden.activeAgentId].config.model, "smoke-model");
      assert.equal(overridden.agentBindings[overridden.activeAgentId].config.effort, "medium");
      const cleared = json("task", "role", "update", experimentTask.id, "leader", "--clear-agent-config").role;
      assert.equal(cleared.agentBindings[cleared.activeAgentId].config.model, undefined);
      const initialized = json("task", "iteration", "init", experimentTask.id);
      const direction = { schemaVersion: 1, kind: "direction", id: "latency", title: "Latency",
        problem: "slow", goal: "lower latency", metrics: ["p95"], constraints: ["offline fixture"],
        priority: "high", status: "active", next: "design measurement", unresolved: [] };
      const request = ["task", "iteration", "save", experimentTask.id, JSON.stringify(direction),
        "--request-id", "direction-fixture", "--expected-head", initialized.commit];
      const saved = json(...request);
      assert.deepEqual(json(...request), saved);
      assert.equal(json("task", "iteration", "read", experimentTask.id, JSON.stringify(saved.ref)).value.goal, direction.goal);
      assert.equal(json("task", "iteration", "overview", experimentTask.id).directions[0].id, "latency");
      assert.equal(json("task", "show", experimentTask.id).task.status, "draft");
    }
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
    const observeEvents = () => observeFixture(store => store.listEvents(task.id));
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
    const wakes = (excludedIds = new Set()) => listItems("task", "wake", "list", task.id)
      .filter(entry => !excludedIds.has(entry.id))
      .map(entry => json("task", "wake", "show", task.id, entry.id).wake);
    json("task", "activation", "request", task.id, "--request-id", "execute", "--environment", "scratch");
    await waitFor(() => JSON.stringify(observeEvents()).includes("Native Codex result."),
      "CLI input did not traverse Controller, Host and fake Provider back to durable results.",
      () => JSON.stringify({ task: json("task", "show", task.id), events: json("task", "event", "list", task.id) }));
    assert.match(JSON.stringify(events()), /Native Codex result\./);
    const initialInputs = readFileSync(join(sandbox, "skill-inputs.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(initialInputs.some(row => JSON.stringify(row.additionalContext ?? {}).includes("Current Skill pointers:")),
      "Actual Host-to-Provider input carries current pointers on first entry.");
    assert.ok(initialInputs.every(row => !/Yui Host checked current Skills|Current Skill pointers:/.test(JSON.stringify(row.input))),
      "Engineering metadata must not enter business input or its automatic title source.");
    const titleDirectory = join(yuiHome, "runtime/native-titles");
    const titleReceipt = () => {
      if (!existsSync(titleDirectory)) return undefined;
      return readdirSync(titleDirectory).flatMap(key => {
        const file = join(titleDirectory, key, "receipt.json");
        return existsSync(file) ? [JSON.parse(readFileSync(file, "utf8"))] : [];
      }).find(receipt => receipt.identity.taskId === task.id && receipt.identity.roleName === "leader");
    };
    await waitFor(() => titleReceipt()?.status === "confirmed",
      "Trusted-local Task title did not receive a native confirmation.", () => JSON.stringify(titleReceipt()));
    const confirmedTitle = titleReceipt();
    assert.equal(confirmedTitle.requestedTitle, `Yui Leader ${task.id} · runtime smoke`);
    const nativeTitleFile = join(environment.CODEX_HOME, "fixture-title-"
      + createHash("sha256").update(confirmedTitle.identity.threadId).digest("hex") + ".json");
    assert.equal(JSON.parse(readFileSync(nativeTitleFile, "utf8")).name, confirmedTitle.requestedTitle);
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
    await waitFor(() => observeEvents().some(event => event.type === "runtime.native-connection-bound"
      && event.payload.roleName === "leader" && event.payload.nativeSessionId !== leaderNative),
    "Retained claim prevented the replacement Leader from cold-starting.",
    () => JSON.stringify({ events: events().slice(-16), wakes: wakes() }));
    const successorNative = events().filter(event => event.type === "runtime.native-connection-bound"
      && event.payload.roleName === "leader").at(-1).payload.nativeSessionId;
    desktopLeader.CODEX_THREAD_ID = successorNative;
    const retained = JSON.parse(runCli(cli, ["inbox", "show", oldWindow.id, "--json"], desktopLeader)).data;
    assert.deepEqual(retained.inbox.claim, oldClaim);
    assert.equal(retained.inbox.ack, undefined, "replacement is not handling");
    const successorCompleted = source => source.some(event => event.type === "runtime.observation"
      && event.payload.kind === "turn.completed"
      && JSON.parse(event.payload.observation).fence.nativeSessionId === successorNative);
    await waitFor(() => successorCompleted(observeEvents()),
    "Successor initialization did not finish.");
    assert.ok(successorCompleted(events()));
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
    if (profile === "full") {
      json("task", "role", "add", task.id, "repair-worker", "--agent", "codex");
      const work = json("task", "work", "create", task.id, "Retained original result",
        "--role", "repair-worker").workItem;
      const workRef = `${task.id}/${work.id}`;
      json("task", "work", "dispatch", workRef);
      await waitFor(() => observeFixture(store => store.listRuns(task.id)
        .some(run => run.workItemId === work.id && run.status === "completed")),
      "Original WorkItem did not complete through its Host.");
      const originalRuns = observeFixture(store => store.listRuns(task.id).filter(run => run.workItemId === work.id));
      assert.equal(originalRuns.length, 1);
      json("task", "work", "update", workRef, "done", "--summary", "Original native result");
      json("task", "work", "accept", workRef, "--summary", "Original acceptance");
      const originalWork = json("task", "work", "show", workRef).workItem;
      const originalSession = json("task", "role", "session", "inspect", task.id, "repair-worker").session;
      json("task", "role", "session", "stop", task.id, "repair-worker", "--reason", "Retain repair identity");
      const retainedWorkerEnv = { ...environment, CODEX_THREAD_ID: originalSession.nativeSessionId };
      assert.equal(JSON.parse(runCli(cli, ["task", "work", "show", workRef, "--json"], retainedWorkerEnv))
        .data.workItem.status, "accepted");
      assert.deepEqual(JSON.parse(runCli(cli, ["session", "skills", "--json"], retainedWorkerEnv))
        .data.skills.map(skill => skill.id), ["yui-runtime", "yui-worker"]);
      json("task", "role", "session", "resume", task.id, "repair-worker");
      const restored = json("task", "role", "session", "inspect", task.id, "repair-worker").session;
      assert.equal(restored.nativeSessionId, originalSession.nativeSessionId);
      assert.deepEqual(json("task", "work", "show", workRef).workItem, originalWork);
      const workerEnv = { ...environment, CODEX_THREAD_ID: restored.nativeSessionId };
      const portFile = join(sandbox, "work-direct-repair-worker.port");
      const native = (method, id, status, text) => ({ method, params: {
        threadId: restored.nativeSessionId,
        turn: { id, status, items: [{ id: `${id}-result`, type: "agentMessage", text }] }
      } });
      await sendDirect(portFile, native("turn/started", "work-question", "inProgress", ""));
      await sendDirect(portFile, native("turn/completed", "work-question", "completed", "Explanation only"));
      await waitFor(() => observeFixture(store => store.getTaskRoleSessionSet(task.id, "repair-worker")
        ?.providerBinding?.run?.status === "completed"), "Original-conversation question did not finish.");
      assert.deepEqual(json("task", "work", "show", workRef).workItem, originalWork);
      await sendDirect(portFile, native("turn/started", "work-repair", "inProgress", ""));
      await waitFor(() => observeFixture(store => store.getTaskRoleSessionSet(task.id, "repair-worker")
        ?.providerBinding?.run?.nativeTurnId === "work-repair"), "Direct repair Turn was not observed.");
      const continueArgs = ["--json", "task", "work", "continue", workRef, "--request-id", "same-conversation-repair",
        "--expected-turn", "work-repair", "--input", "Fix this same result within the original scope."];
      const continued = JSON.parse(runCli(cli, continueArgs, workerEnv)).data;
      assert.equal(JSON.parse(runCli(cli, continueArgs, workerEnv)).data.run.id, continued.run.id);
      assert.notEqual(continued.run.id, originalRuns[0].id);
      assert.equal(json("task", "work", "show", workRef).workItem.status, "open");
      await sendDirect(portFile, native("turn/completed", "work-repair", "completed", "Repaired original result"));
      await waitFor(() => observeFixture(store => store.getRun(task.id, continued.run.id)?.status === "completed"),
        "Repair result did not bind to its fresh AgentRun.");
      json("task", "work", "update", workRef, "done", "--summary", "New same-conversation result");
      json("task", "work", "accept", workRef, "--summary", "Fresh acceptance of repaired result");
      const repaired = json("task", "work", "show", workRef).workItem;
      assert.equal(repaired.candidates.length, 2);
      assert.deepEqual(repaired.candidates[0], originalWork.candidates[0]);
      assert.notEqual(repaired.acceptedCandidateId, originalWork.acceptedCandidateId);
      assert.equal(json("task", "role", "session", "inspect", task.id, "repair-worker").session.nativeSessionId,
        originalSession.nativeSessionId);
      console.log("Original WorkItem conversation, stopped Host restoration and separately accepted repair passed.");
    }
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
    // Locate a new notification through the real CLI, then keep its exact
    // identity while polling fresh terminal events. Historical wake details
    // cannot establish completion of this new action and need not be reread.
    const beforeReopenWakes = new Set(listItems("task", "wake", "list", task.id).map(wake => wake.id));
    json("task", "reopen", task.id);
    json("task", "reopen", task.id);
    assert.equal(json("task", "show", task.id).task.completedAt, undefined);
    const terminalForWake = (wake, source) => source.some(event => {
      if (event.type !== "runtime.observation" || event.payload.kind !== "turn.completed") return false;
      const observation = JSON.parse(event.payload.observation);
      return observation.fence.receiptId?.startsWith(`notification:${task.id}/${wake.id}/`) === true;
    });
    let reopenedWake;
    await waitFor(() => {
      reopenedWake ??= wakes(beforeReopenWakes).find(w => w.reasons.includes("task-reopened"));
      return reopenedWake !== undefined && terminalForWake(reopenedWake, observeEvents());
    }, "Reopen notification did not finish through the existing Host.");
    assert.ok(terminalForWake(reopenedWake, events()));
    const request = ["operator", "submit", "Continue this same accepted result; local fixture only.",
      "--task", task.id, "--intent", "develop", "--request-id", "authorized-followup"];
    const beforeFollowupWakes = new Set(listItems("task", "wake", "list", task.id).map(wake => wake.id));
    runCli(cli, request, environment);
    runCli(cli, request, environment);
    const inputs = listItems("task", "message", "list", task.id)
      .map(entry => json("task", "message", "show", `${task.id}/${entry.ref.refId}`));
    const followups = inputs.filter(message => message?.submissionKey === "authorized-followup");
    assert.equal(followups.length, 1, "Matching Operator retries must retain one original Message.");
    const followup = followups[0];
    assert.equal(followup.submissionReceipt.routing.kind, "active-context");
    assert.equal(followup.submissionReceipt.feedback.delivery, "queued");
    let followupWake;
    await waitFor(() => {
      followupWake ??= wakes(beforeFollowupWakes).find(w =>
        w.refs?.some(ref => ref.type === "message" && ref.id === followup.id));
      return followupWake !== undefined && terminalForWake(followupWake, observeEvents());
    }, "The exact follow-up Message did not traverse CLI/Controller/Host/native terminal.");
    assert.ok(terminalForWake(followupWake, events()));
    const afterFollowup = events();
    assert.equal(afterFollowup.filter(event => event.type === "task.reopened").length, 1);
    assert.deepEqual(afterFollowup.find(event => event.id === originalCompletion.id), originalCompletion);
    acknowledgeWindows();
    json("task", "complete", task.id, "--summary", "The authorized follow-up is separately accepted.");
    assert.equal(json("task", "show", task.id).task.status, "completed");
    const afterCompletion = events();
    assert.equal(afterCompletion.filter(event => event.type === "task.completed").length, 2);
    assert.deepEqual(afterCompletion.find(event => event.id === originalCompletion.id), originalCompletion);
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
    const deliveredInputs = readFileSync(join(sandbox, "skill-inputs.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(deliveredInputs.some(row => {
      return row.additionalContext === undefined && row.input.length === 1 && row.input[0].type === "text"
        && row.input[0].text.startsWith("Yui Task notification:");
    }), "A later actual Host Turn begins with the original notification, without any Skill prefix or extra part.");
    phase("task/session/archive");

    if (profile === "full") {
      // The active Leader adds and uses its first Project within the same Turn.
      // Neither the Host nor Provider connection may be replaced or interrupted.
      const scopeTask = json("task", "create", "scope refresh fixture").task;
      const scopeTmuxSession = `yui-${tmuxServer.slice(4, 16)}-${scopeTask.id}`;
      const scopeHostPids = () => tmux("list-panes", "-t", `=${scopeTmuxSession}:`, "-F", "#{pane_pid}").trim();
      writeFileSync(join(sandbox, "scope-refresh.json"), JSON.stringify({
        taskId: scopeTask.id, projectId: scopeRefreshProject.id, cli, root,
        tmuxServer, tmuxSession: scopeTmuxSession
      }));
      // This contract attaches children of the captured Task-main root. A
      // separately adopted scratch/local cwd is not that execution boundary.
      json("task", "activation", "request", scopeTask.id, "--request-id", "scope-start", "--environment", "empty");
      const scopeEvents = () => observeFixture(store => store.listEvents(scopeTask.id));
      await waitFor(() => existsSync(join(sandbox, "scope-added.json")),
        "Active Leader did not return from its own project add.",
        () => JSON.stringify(scopeEvents().slice(-10)));
      const { inspectAgentHost: inspectScopeHost } =
        await import(pathToFileURL(join(root, "dist/runtime/agentHost.js")).href);
      const scopeOwner = { home: yuiHome, scope: "task", taskId: scopeTask.id, roleName: "leader" };
      const added = JSON.parse(readFileSync(join(sandbox, "scope-added.json"), "utf8"));
      const beforeScope = added.before;
      assert.equal(scopeHostPids(), added.hostPids, "Host PID must survive both self-issued configuration commands.");
      assert.equal(added.result.workspaceConfiguration.mode, "in-place");
      assert.equal(observeFixture(store =>
        store.getWorkMailbox({ kind: "role-runtime", taskId: scopeTask.id, roleName: "leader" })), null,
      "A project configuration change must not reserve Host lifecycle work.");
      const heldHost = await inspectScopeHost(scopeOwner);
      assert.equal(heldHost.processInstanceId, beforeScope.processInstanceId);
      assert.equal(heldHost.nativeSessionId, beforeScope.nativeSessionId);
      assert.equal(heldHost.nativeTurnId, added.turnId, "Configuration adoption must not interrupt the active Turn.");
      assert.deepEqual(observeFixture(store => {
        const set = store.getTaskRoleSessionSet(scopeTask.id, "leader");
        return set.sessions[set.activeAgentId].effective.writeProjectIds;
      }), [scopeRefreshProject.id], "New Project authority is immediately available in the same Turn.");
      const newProjectPath = added.result.workspaceConfiguration.sessions
        .find(session => session.roleName === "leader").workspace.entries
        .find(entry => entry.projectId === scopeRefreshProject.id).path;
      assert.equal(readFileSync(join(newProjectPath, "hot-config-proof.txt"), "utf8"),
        `${beforeScope.nativeSessionId}/${added.turnId}`);
      rmSync(join(newProjectPath, "hot-config-proof.txt"));
      assert.ok(scopeEvents().some(event => event.type === "runtime.workspace-scope-adopted"
        && event.payload.hostPreserved === "true"));
      writeFileSync(join(sandbox, "scope-yield"), "yield");
      await waitFor(() => observeFixture(store => {
        const set = store.getTaskRoleSessionSet(scopeTask.id, "leader");
        return set?.sessions[set.activeAgentId]?.effective.writeProjectIds.includes(scopeRefreshProject.id)
          && !store.getWorkMailbox({ kind: "role-runtime", taskId: scopeTask.id, roleName: "leader" })?.pending;
      }), "Task-main configuration was not adopted in place.",
      () => JSON.stringify({ projects: json("task", "project", "list", scopeTask.id),
        hosts: runCli(cli, ["update", "--hosts-status"], environment), events: scopeEvents().slice(-12) }));
      const afterScope = await inspectScopeHost(scopeOwner);
      assert.equal(afterScope.nativeSessionId, beforeScope.nativeSessionId);
      assert.equal(afterScope.processInstanceId, beforeScope.processInstanceId);
      let continuation;
      await waitFor(() => observeFixture(store => {
        continuation ??= store.listTaskWakes(scopeTask.id).find(wake => wake.id !== added.wakeId
          && wake.reasons.includes("task-project-added"));
        return continuation && store.getTaskWake(scopeTask.id, added.wakeId).inbox?.ack
          && store.getTaskWake(scopeTask.id, continuation.id).inbox?.ack
          && store.listEvents(scopeTask.id).some(event => {
            if (event.type !== "runtime.observation" || event.payload.kind !== "turn.completed") return false;
            const fence = JSON.parse(event.payload.observation).fence;
            return fence.nativeSessionId === beforeScope.nativeSessionId
              && fence.receiptId?.startsWith(`notification:${scopeTask.id}/${continuation.id}/`);
          });
      }), "Self-add did not ACK and automatically continue the same conversation.");
      const handled = readFileSync(join(sandbox, "scope-handled.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(handled.filter(row => row.wakeId === added.wakeId).length, 1);
      assert.equal(handled.filter(row => row.wakeId === continuation.id).length, 1);
      assert.ok(handled.every(row => row.threadId === beforeScope.nativeSessionId));
      assert.equal((await inspectScopeHost(scopeOwner)).processInstanceId, beforeScope.processInstanceId);
      const listing = json("task", "project", "list", scopeTask.id);
      const updatedBinding = json("task", "project", "update", scopeTask.id, scopeRefreshProject.id,
        "--base", "main", "--if-current", listing.writeGuard);
      assert.equal(updatedBinding.change, "reference-only");
      assert.equal(updatedBinding.workspaceMigrated, false);
      assert.equal((await inspectScopeHost(scopeOwner)).processInstanceId, afterScope.processInstanceId);
      const scopeInput = json("task", "message", "queue", scopeTask.id, "One post-refresh input.",
        "--request-id", "scope-input");
      let scopeWake;
      await waitFor(() => observeFixture(store => {
        scopeWake ??= store.listTaskWakes(scopeTask.id).find(wake =>
          wake.refs.some(ref => ref.type === "message" && ref.id === scopeInput.message.id));
        return scopeWake && store.listEvents(scopeTask.id).some(event => {
          if (event.type !== "runtime.observation" || event.payload.kind !== "turn.completed") return false;
          const fence = JSON.parse(event.payload.observation).fence;
          return fence.nativeSessionId === beforeScope.nativeSessionId
            && fence.receiptId?.startsWith(`notification:${scopeTask.id}/${scopeWake.id}/`);
        });
      }),
      "Original conversation did not handle post-refresh input.");
      const finalScopeHost = await inspectScopeHost(scopeOwner);
      assert.equal(finalScopeHost.nativeSessionId, beforeScope.nativeSessionId);
      assert.equal(finalScopeHost.processInstanceId, beforeScope.processInstanceId);
      assert.equal(scopeHostPids(), added.hostPids);
      assert.ok(json("task", "wake", "show", scopeTask.id, scopeWake.id).wake.refs
        .some(ref => ref.id === scopeInput.message.id));
      const nativeInputs = readFileSync(join(sandbox, "skill-inputs.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(nativeInputs.filter(row => JSON.stringify(row.input)
        .includes(`task=${scopeTask.id} wake=${scopeWake.id}.`)).length, 1);
      json("task", "cancel", scopeTask.id, "--summary", "Disposable scope-refresh fixture verified.");
      json("task", "archive", scopeTask.id, "--abandon", "--force");
      assert.equal(json("task", "show", scopeTask.id).task.status, "archived");
      phase("task/project/scope-refresh");
    }

    const updateStarted = performance.now();
    // Keep a real Host alive across the updater's Controller replacement. Only
    // the external Provider is fake; its direct notifications represent Desktop
    // input, not another managed turn/start or a fabricated durable terminal.
    const directPort = join(sandbox, "direct.port");
    writeFileSync(join(fakeBin, "codex"),
      `#!${process.execPath}\nprocess.env.YUI_FAKE_DIRECT_PORT_FILE = ${JSON.stringify(directPort)};\n`
      + `process.env.YUI_FAKE_TURN_HANDLER = ${JSON.stringify(new URL("../test/fixtures/inbox-smoke-handler.mjs", import.meta.url).href)};\n`
      + `process.env.YUI_FAKE_UNIQUE_THREADS = "1";\n`
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
    // Only one unsent engineering notice is allowed. Earlier fixture facts may
    // already own it; the new cancellation then coalesces in the mailbox rather
    // than rewriting that original. Preserve whichever exact notice is queued.
    const isEngineeringNotice = message => message.id !== queued.id
      && message.inputControl?.requestId?.startsWith("operator-notice:");
    let queuedBefore = [];
    await waitFor(() => {
      queuedBefore = pending().map(message => json("role", "message", "show", "operator", message.id));
      return queuedBefore.some(isEngineeringNotice);
    },
      "No pending engineering notice was queued.",
      () => JSON.stringify(queuedBefore));
    assert.equal(queuedBefore.filter(isEngineeringNotice).length, 1,
      "Handover must preserve the one original engineering notice alongside the queued user input.");
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
    // Handover drains several serial turns (user input, engineering notices and
    // the deliberately missing-ACK reminder). Observe backlog and terminal from
    // one Controller snapshot, not separate CLI startups on each poll. Slow
    // supported runners need a bounded multi-turn budget, not the single-event
    // default. Keep the exact input/Host/effect assertions below.
    let handoverContext;
    await waitFor(() => {
      handoverContext = context();
      return handoverContext.backlog.reason === "empty"
        && handoverContext.nativeTurn?.status === "completed";
    },
      "Replacement Controller did not consume the retained terminal and drain pending inputs.",
      () => JSON.stringify(handoverContext), 60_000);
    assert.equal(pending().length, 0, "Handover must drain the original delivery queue.");
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
    const { AGENT_HOST_IMPLEMENTATION } =
      await import(pathToFileURL(join(root, "dist/runtime/agentHostImplementation.js")).href);
    const upgradeStatus = await callFileTaskController(yuiHome, "runtime.upgrade-hosts",
      { generation: AGENT_HOST_IMPLEMENTATION.generation }, { environment, requestTimeoutMs: 15_000 });
    assert.ok(upgradeStatus.hosts.some(entry => entry.owner.scope === "global"
      && entry.owner.roleName === "operator" && entry.status === "current"
      && entry.nativeSessionId === hostBefore.nativeSessionId),
      "The real Controller verifies actual Host and Endpoint generations before reporting current.");
    assert.match(runCli(cli, ["update", "--hosts-status"], environment), /global\/operator.*current/);
    const { sendAgentHostUpgradeControl } =
      await import(pathToFileURL(join(root, "dist/runtime/agentHost.js")).href);
    const exactHost = await inspectAgentHost(target);
    const fence = { protocol: "yui-agent-host-control/v1", requestId: "fixture-idle-upgrade",
      nativeSessionId: exactHost.nativeSessionId, processInstanceId: exactHost.processInstanceId,
      hostGeneration: exactHost.hostImplementation.generation };
    const drained = await sendAgentHostUpgradeControl({ ...target, control: { ...fence, type: "prepare-upgrade" } });
    assert.equal(drained.snapshot.hostUpgrade.state, "drained");
    await sendAgentHostUpgradeControl({ ...target, control: { ...fence, type: "finish-upgrade" } });
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
    phase("update/host/inbox");
    // Agent Jobs reuse the same Role/Host/Provider transport, not a fixture-only
    // executor. The handler reads durable context and explicitly reports each Run.
    if (profile === "full") {
      const agentJobTask = json("task", "create", "Agent Job existing Task").task;
      json("task", "activation", "request", agentJobTask.id, "--request-id", "agent-job-task", "--environment", "scratch");
      await waitFor(() => observeFixture(store => store.getTask(agentJobTask.id)?.status === "active"),
        "Agent Job target Task was not activated.");
      assert.equal(json("task", "show", agentJobTask.id).task.status, "active");
      for (const [id, agentTarget] of [
        ["agent-own", { kind: "job", agentId: "codex" }],
        ["agent-operator", { kind: "operator" }],
        ["agent-task", { kind: "task", taskId: agentJobTask.id, roleName: "leader" }]
      ]) {
        json("job", "define", "--global", "--job", id, "--title", id, "--input", JSON.stringify({
          kind: "agent", target: agentTarget, input: "Deterministic Job Agent smoke."
        }));
        let priorNative;
        for (const key of agentTarget.kind === "job" ? ["first", "second"] : ["first"]) {
          const run = json("job", "run", "--global", "--job", id, "--request-id", key).run;
          const selector = ["--global", "--job", id, "--run", run.id];
          await waitFor(() => observeFixture(store => store.getAgentJobRun(run.id)?.status === "succeeded"),
            `Agent Job ${id}/${key} did not report its business result.`,
            () => JSON.stringify({ evidence: json("job", "run-evidence", ...selector),
              ...(agentTarget.kind === "job" ? { session: json("job", "session-inspect", "--global", "--job", id) } : {}),
              ...(agentTarget.kind === "task" ? { session: json("task", "role", "session", "inspect", agentTarget.taskId, "leader"),
                events: listItems("task", "event", "list", agentTarget.taskId).slice(-10) } : {}) }));
          const settled = json("job", "run-get", ...selector);
          assert.equal(settled.status, "succeeded");
          assert.equal(settled.businessResult.sourceRun.runId, run.id);
          const execution = settled.attempts.at(-1).execution;
          assert.ok(execution.nativeTurnId);
          if (priorNative) assert.equal(execution.nativeSessionId, priorNative);
          priorNative = execution.nativeSessionId;
        }
        if (agentTarget.kind === "job") {
          const inspect = () => json("job", "session-inspect", "--global", "--job", id);
          await waitFor(() => inspect().sessions.providerBinding.run.status === "completed",
            "Job-owned native Turn did not finish before Session replacement.");
          json("job", "session-stop", "--global", "--job", id, "--expected-session", priorNative);
          await waitFor(() => {
            const set = inspect().sessions;
            return set.sessions[set.activeAgentId]?.status === "ended";
          }, "Job-owned Session cleanup did not prove it ended.", () => JSON.stringify(inspect()));
          json("job", "session-new", "--global", "--job", id, "--expected-session", priorNative);
          const replacement = json("job", "run", "--global", "--job", id, "--request-id", "replacement").run;
          const selector = ["--global", "--job", id, "--run", replacement.id];
          await waitFor(() => observeFixture(store => store.getAgentJobRun(replacement.id)?.status === "succeeded"),
            "Replacement Job Session did not report.", () => JSON.stringify(json("job", "run-evidence", ...selector)));
          const replaced = json("job", "run-context", ...selector);
          assert.equal(replaced.status, "succeeded");
          assert.notEqual(replaced.attempts[0].execution.nativeSessionId, priorNative);
          assert.equal(replaced.history.filter(run => run.result?.outcome === "succeeded").length, 3);
        }
      }
      // Teardown live work before the Controller, not just a tmux server sweep.
      await waitFor(() => {
        const read = new SqliteTaskStore(yuiHome, { readonly: true });
        try {
          return [...read.listGlobalRoles().map(role => read.getGlobalRoleSessionSet(role.name)),
            read.getTaskRoleSessionSet(agentJobTask.id, "leader")].every(set =>
            !set?.providerBinding?.run || ["completed", "failed", "cancelled", "rejected"].includes(set.providerBinding.run.status));
        } finally { read.close(); }
      }, "Agent Job native Turns did not settle before fixture teardown.");
      phase("agent-jobs");
    }
    if (assembled) {
      // Exercise release activation, not only updater stop/restore. The second
      // immutable build has a different digest while keeping storage/protocol
      // unchanged; both preflights must run while the first release is active.
      // The earlier historical-session probe intentionally replaced hostPid.
      assert.equal(processExited(operatorHostPid), false);
      // An exiting Host cannot guarantee a post-exit signal. Exercise the
      // existing periodic fallback at an explicit fixture-only cadence.
      json("config", "runtime", "set", "reconciliation-interval-seconds", "5");
      const first = json("release", "install", root);
      assert.equal(first.outcome, "installed");
      assert.equal(json("release", "activate", first.releaseId).outcome, "activated");
      cli = join(first.releaseDir, "dist/cli.js");
      const currentHost = async (generation) => {
        try {
          const observed = await inspectAgentHost(target);
          return observed.hostImplementation?.generation === generation && observed.state === "idle" && observed;
        } catch { return false; } // The old socket disappears during a proven graceful drain.
      };
      await waitFor(() => currentHost(first.packageDigest), "First installed Controller did not converge its Host.");
      const activationHost = await inspectAgentHost(target);
      const operatorPane = `=yui-${tmuxServer.slice(4, 16)}-operator:=operator`;
      const activationHostPid = Number(tmux("display-message", "-p", "-t", operatorPane, "#{pane_pid}").trim());
      const nextSource = join(sandbox, "next-release");
      cpSync(root, nextSource, { recursive: true });
      writeFileSync(join(nextSource, "activation-fixture.txt"), "same code, distinct immutable build\n");
      const nextManifest = buildReleaseManifest(nextSource, { version: packageJson.version });
      writeFileSync(join(nextSource, "release-manifest.json"), JSON.stringify(nextManifest));
      const next = json("release", "install", nextSource);
      assert.equal(next.outcome, "installed");
      const nextCli = join(next.releaseDir, "dist/cli.js");
      assert.throws(() => runCli(nextCli, ["--json", "upgrade", "--update-preflight"], environment),
        /Refusing installed-release CLI access/, "inactive ordinary CLI remains fenced");
      const before = json("task", "message", "list", task.id);
      const activated = json("release", "activate", next.releaseId);
      assert.equal(activated.outcome, "activated");
      assert.equal(processExited(activated.oldPid), true);
      cli = nextCli;
      const { createUpdatePorts: activeUpdatePorts } = await import(
        pathToFileURL(join(next.releaseDir, "dist/cli/updatePorts.js")).href);
      updatePorts = activeUpdatePorts(environment, (command, args, options) =>
        spawnSync(command, args, { ...options, timeout: 15_000 }));
      const { callController } = await import(pathToFileURL(join(root, "dist/core/controllerClient.js")).href);
      const identity = await callController(yuiHome, "controller.identity", {});
      assert.equal(identity.buildId, next.buildId, "read back the promoted candidate, not the old owner");
      const pointer = JSON.parse(readFileSync(join(yuiHome, "runtime/active-release.json"), "utf8"));
      assert.equal(pointer.packageDigest, next.packageDigest);
      assert.deepEqual(json("task", "message", "list", task.id), before);
      const successor = await waitFor(() => currentHost(next.packageDigest),
        "Controller lifecycle checks did not automatically converge the old Host.", () =>
          runCli(cli, ["update", "--hosts-status"], environment), 30_000);
      assert.equal(successor.nativeSessionId, activationHost.nativeSessionId);
      assert.notEqual(successor.processInstanceId, activationHost.processInstanceId);
      assert.equal(processExited(activationHostPid), true);
      operatorHostPid = Number(tmux("display-message", "-p", "-t", operatorPane, "#{pane_pid}").trim());
      assert.ok(Number.isInteger(operatorHostPid) && operatorHostPid > 0);
      assert.deepEqual(json("task", "message", "list", task.id), before);
      assert.match(runCli(cli, ["update", "--hosts-status"], environment), /global\/operator.*current/);
      console.log("Installed release activation passed: candidate promotion, automatic Host convergence, same native Session and original inputs (no explicit update request).");
      phase("release-activation");
    }
    runCli(cli, ["session", "stop", "--all"], environment);
    await waitFor(() => processExited(operatorHostPid), "The fixture Operator Host did not exit.");
    assert.equal(updatePorts.controllerStatus(yuiHome).running, false,
      "Session maintenance must stop its Controller after releasing the Host.");
    process.stdout.write(`Update handover lifecycle smoke passed (${Math.round(performance.now() - updateStarted)} ms).\n`);
    phase("session-stop");
  }
} catch (error) {
  // Preserve the first failure even if teardown also fails after a partially
  // completed activation. A cleanup error must not hide the operation evidence.
  console.error("Runtime package smoke failed before cleanup:", error);
  throw error;
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
      // Activation can promote the candidate before its caller receives a
      // result. Resolve and verify this fixture's active artifact, never replay
      // activation or use the now-inactive CLI to clean up its successor.
      const { resolveActiveRelease } = await import(
        pathToFileURL(join(root, "dist/release/runtimeRelease.js")).href);
      const active = resolveActiveRelease(yuiHome);
      const cleanupCli = active === null ? cli : join(active.releaseDir, "dist/cli.js");
      runCli(cleanupCli, ["controller", "stop"], environment);
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
phase("cleanup");
console.log(`TIMING total: ${Math.round(performance.now() - started)} ms`);
process.stdout.write(`Runtime package smoke passed (${profile}).\n`);

function runCli(cli, args, env, input) {
  const started = performance.now();
  cliCalls++;
  try {
    return execFileSync(cli, args, { encoding: "utf8", env, input, timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] });
  } finally {
    cliElapsed += performance.now() - started;
  }
}

// Poll only this fixture's committed state, never simulate a transition or
// trigger Controller work. Each read opens/closes the package's read-only Store
// so restarts cannot leave a cached snapshot. Real CLI assertions follow waits;
// CLI authority, pagination and output-contract checks still use json()/runCli().
function observeFixture(read) {
  const store = new FixtureStore(yuiHome, { readonly: true });
  try { return read(store); }
  finally { store.close(); }
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

async function waitFor(check, message, diagnostics = () => "", timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
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
