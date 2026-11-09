import { fork, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, readFileSync, rmSync, copyFileSync, lstatSync, realpathSync } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client, hash, save, now, ownedProcesses, alive, fixtureCliScript, completeJsonLines } from "./common.mjs";
import { readNativeTransports, rejectedNativeCleanup, recordedStopControls } from "./native-ownership.mjs";
import { CLI_AUDIT_NAME } from "./cli-receipt.mjs";
import { prepareFixtureShell, fixtureShellPolicy, fixtureShellEnvironment } from "./fixture-shell.mjs";
import { controllerSandboxPreflight } from "./controller-preflight.mjs";

export function waitForFixtureReady(child, label) {
  return new Promise((resolve, reject) => {
    const finish = (error, message) => {
      clearTimeout(timer);
      child.off("message", onMessage); child.off("error", onError); child.off("exit", onExit);
      if (error) reject(error); else resolve(message);
    };
    const onMessage = message => finish(null, message);
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(Error(`${label} exited before ready: code=${code}, signal=${signal}`));
    const timer = setTimeout(() => finish(Error(`${label} ready timeout`)), 10000);
    child.once("message", onMessage); child.once("error", onError); child.once("exit", onExit);
  });
}

export class FrameworkFixture {
  constructor(product, evidence, mode, scenario, providerBin, permissionMode = "workspace-write", cliEntryMode = "absolute", originalToolFiles) {
    this.root = mkdtempSync(join(tmpdir(), "yui-eval-fw-"));
    this.home = join(this.root, "state"); this.product = product; this.evidence = evidence;
    this.mode = mode; this.scenario = scenario; this.providerBin = providerBin;
    this.permissionMode = permissionMode;
    this.cliEntryMode = cliEntryMode;
    if (originalToolFiles) this.originalTool = { entry: join(this.root, "tools/original-tool.mjs"),
      cli: join(this.root, "bin/yui"), home: this.home, files: originalToolFiles };
    this.tmux = `yui-${hash(this.home).slice(0, 24)}`;
    this.configPath = join(this.root, "provider.json");
    this.environment = { PATH: `${join(this.root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: join(this.root, "user"), CODEX_HOME: join(this.root, "user/.codex"), YUI_HOME: this.home,
      TMPDIR: join(this.root, "tmp"), COLLAB_EVAL_CONFIG: this.configPath, NO_COLOR: "1" };
    // Real mode uses only the normal auth entry from the invoking user, never
    // copies/reads credentials. No identity fields of the managed developer.
    if (mode === "real") {
      this.environment.HOME = process.env.HOME;
      if (process.env.CODEX_HOME) this.environment.CODEX_HOME = process.env.CODEX_HOME;
      else delete this.environment.CODEX_HOME;
    }
    this.cli = join(product, "output/dev/bin/yui");
    this.client = new Client(this.cli, this.environment);
    // Teardown exists BEFORE setup, owner process, collector or first CLI call.
    this.cleanup = { status: "registered", root: this.root, registeredAt: now() };
    save(join(evidence, "ownership.json"), { root: this.root, home: this.home, tmux: this.tmux,
      mode, scenario, cleanupRegisteredAt: this.cleanup.registeredAt });
  }
  async prepare() {
    for (const p of ["state", "bin", "user", "tmp"]) mkdirSync(join(this.root, p));
    prepareFixtureShell(this.root);
    if (this.originalTool) {
      mkdirSync(join(this.root, "tools"));
      for (const [name, digest] of Object.entries(this.originalTool.files)) {
        const source = new URL(name, import.meta.url);
        if (hash(readFileSync(source)) !== digest) throw Error("Frozen original tool changed");
        const destination = join(this.root, "tools", name);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(source, destination);
      }
    }
    const config = { mode: this.mode, scenario: this.scenario, evidence: this.evidence,
      product: this.product, providerBin: this.providerBin, permissionMode: this.permissionMode, cliEntryMode: this.cliEntryMode,
      originalTool: this.originalTool, subjectShell: fixtureShellPolicy };
    if (this.mode === "fake") {
      save(this.configPath, config);
      this.owner = fork(new URL("./fake-provider.mjs", import.meta.url), [this.configPath],
        { cwd: this.root, env: this.environment, stdio: ["ignore", "ignore", "inherit", "ipc"] });
      this.ownerExit = new Promise(resolve => this.owner.once("exit", (code, signal) => resolve({ code, signal })));
      config.endpoint = await waitForFixtureReady(this.owner, "Provider owner");
      // A descriptor is configuration, never a mutable runtime truth store.
      writeFileSync(this.configPath, JSON.stringify(config));
    } else save(this.configPath, config);
    writeFileSync(join(this.root, "bin/codex"), `#!${process.execPath}\nimport(${JSON.stringify(new URL("./provider.mjs", import.meta.url).href)});\n`,
      { mode: 0o755 });
    symlinkSync(process.execPath, join(this.root, "bin/node"));
    // Absolute subject entry also pins Node/PATH after a login shell has
    // replaced PATH. It delegates to the selected product's normal launcher.
    writeFileSync(join(this.root, "bin/yui"),
      fixtureCliScript(this.cli, process.execPath, join(this.root, "bin"), {
        module: fileURLToPath(new URL("./cli-receipt.mjs", import.meta.url)),
        auditInCwd: true, product: this.product, home: this.home,
        launcherSha256: hash(readFileSync(this.cli))
      }), { mode: 0o755 });
    // Refuse a broken command binding before any Subject/model launch.
    const preflight = spawnSync("/bin/sh", ["-c", "yui version"], {
      cwd: this.root, env: { ...this.environment, ...fixtureShellEnvironment(this.root) },
      encoding: "utf8", timeout: 10000
    });
    save(join(this.evidence, "shell-preflight.json"), {
      policy: fixtureShellPolicy, status: preflight.status, error: preflight.error?.message,
      stdout: preflight.stdout, stderr: preflight.stderr
    });
    if (preflight.error || preflight.status !== 0) throw Error("Fixture shell/CLI binding preflight failed");
    this.collector = fork(new URL("./support/shared-collector.mjs", import.meta.url),
      [this.product, this.root, join(this.evidence, "collector.json.gz")],
      { env: this.environment, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    this.collectorExit = new Promise(resolve => this.collector.once("exit", (code, signal) => resolve({ code, signal })));
    await waitForFixtureReady(this.collector, "Collector");
    if (this.scenario === "partial-setup") throw Error("Injected partial setup failure before CLI");
    this.environment.YUI_SETUP_INTERACTIVE = "1";
    this.client.call(["setup"], "setup", { json: false, input: "codex\n" });
    delete this.environment.YUI_SETUP_INTERACTIVE;
    this.client.call(["config", "agent", "update", "codex", "--env", "COLLAB_EVAL_CONFIG=COLLAB_EVAL_CONFIG"], "setup");
    if (this.permissionMode === "workspace-write" && (this.mode === "real" || process.platform === "linux")) {
      this.client.call(["controller", "start"], "setup");
      this.client.call(["controller", "live-identity"], "setup");
      if (process.platform === "linux") {
        const { readControllerDiscovery } = await import(pathToFileURL(join(this.product, "dist/core/controllerClient.js")).href);
        const discovery = await readControllerDiscovery(this.home);
        const directory = join(this.root, ".controller-bridge");
        mkdirSync(directory, { mode: 0o700 });
        this.controllerBridge = { directory, home: this.home, socketPath: discovery.socketPath,
          module: new URL("./controller-bridge-client.mjs", import.meta.url).href };
        this.bridge = fork(new URL("./controller-bridge.mjs", import.meta.url), [JSON.stringify({
          directory, socketPath: discovery.socketPath, homeId: discovery.homeId,
          homeFilesystemId: discovery.homeFilesystemId
        })], { cwd: this.root, env: { PATH: this.environment.PATH },
          stdio: ["ignore", "ignore", "inherit", "ipc"] });
        this.bridgeExit = new Promise(resolve => this.bridge.once("exit", (code, signal) => resolve({ code, signal })));
        this.bridge.on("message", message => { if (message.finished) this.bridgeStats = message.finished; });
        await waitForFixtureReady(this.bridge, "Controller bridge");
        config.controllerBridge = this.controllerBridge;
        writeFileSync(this.configPath, JSON.stringify(config));
        writeFileSync(join(this.root, "bin/yui"), fixtureCliScript(this.cli, process.execPath, join(this.root, "bin"), {
          module: fileURLToPath(new URL("./cli-receipt.mjs", import.meta.url)),
          auditInCwd: true, product: this.product, home: this.home,
          launcherSha256: hash(readFileSync(this.cli)), controllerBridge: this.controllerBridge
        }), { mode: 0o755 });
      }
      if (this.mode === "real") {
        const result = await controllerSandboxPreflight({ providerBin: this.providerBin,
          product: this.product, root: this.root, home: this.home, controllerBridge: this.controllerBridge });
        save(join(this.evidence, "controller-sandbox-preflight.json"), result);
        if (result.status !== "reachable") {
          throw Error("Controller/CLI sandbox preflight failed; no model started. See controller-sandbox-preflight.json. No permission fallback was attempted.");
        }
      }
    }
  }
  collectCliReceipts() {
    const raw = readNativeTransports(this.evidence);
    const directories = new Set([this.root, ...raw.filter(e => e.binding?.home === this.home && e.binding.cwd)
      .flatMap(e => [e.binding.cwd, ...(e.nativeContent === "owned-full"
        && e.message?.params?.item?.type === "commandExecution" && e.message.params.item.cwd
        ? [e.message.params.item.cwd] : [])])]);
    const receipts = [], gaps = [];
    for (const directory of directories) {
      const path = join(directory, CLI_AUDIT_NAME);
      if (!existsSync(path)) continue;
      const child = relative(realpathSync(this.root), realpathSync(path)), stat = lstatSync(path);
      if (child === ".." || child.startsWith("../") || isAbsolute(child) || !stat.isFile() || stat.isSymbolicLink()
        || stat.size > 32 * 1024 * 1024) throw Error("Unowned or oversized fixture CLI audit; retain evidence.");
      const { records, tail } = completeJsonLines(readFileSync(path, "utf8"));
      receipts.push(...records);
      if (tail) gaps.push({ path, tail });
    }
    receipts.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    writeFileSync(join(this.evidence, "cli-process-receipts.jsonl"), receipts.map(r => JSON.stringify(r) + "\n").join(""));
    // This is a refreshed collection snapshot, not an immutable run receipt.
    writeFileSync(join(this.evidence, "cli-receipts-coverage.json"), JSON.stringify({ gaps, complete: !gaps.length }, null, 2));
    return { receipts, incomplete: Boolean(gaps.length) };
  }
  async close() {
    const requestedAt = now(), captured = ownedProcesses(this.root, this.tmux), failures = [],
      controls = recordedStopControls(this.client.trace);
    this.client.deadline = Date.now() + 25000;
    if (existsSync(join(this.home, "yui.db"))) {
      // session stop --all is explicitly an IDLE-session maintenance API,
      // not a cancellation request. Fence/stop exact owned Tasks first.
      for (const task of this.ownedTasks ?? []) {
        const args = ["task", "execution", "stop", task, "--force", "--reason", "Owned framework fixture teardown"];
        const startedAt = now();
        try { controls.push({ args, result: this.client.call(args, "cleanup"), startedAt, at: now() }); }
        catch (e) { failures.push(String(e)); controls.push({ args, error: String(e), startedAt, at: now() }); }
      }
      for (const args of [["session", "stop", "--all"], ["controller", "stop"]]) {
        const startedAt = now();
        try { controls.push({ args, result: this.client.call(args, "cleanup"), startedAt, at: now() }); }
        catch (e) { failures.push(String(e)); controls.push({ args, error: String(e), startedAt, at: now() }); }
      }
    }
    const tmux = spawnSync("tmux", ["-L", this.tmux, "kill-server"], { env: this.environment, encoding: "utf8", timeout: 5000 });
    if (tmux.status !== 0 && !/no server running|No such file/.test(tmux.stderr ?? "")) failures.push(`tmux:${tmux.stderr}`);
    if (this.owner?.connected) this.owner.send("finish");
    if (this.ownerExit) {
      const terminal = await Promise.race([this.ownerExit, delay(10000).then(() => ({ status: "unknown" }))]);
      if (terminal.code !== 0) failures.push(`Provider owner terminal ${JSON.stringify(terminal)}`);
    }
    if (this.bridge?.connected) this.bridge.send("finish");
    if (this.bridgeExit) {
      const terminal = await Promise.race([this.bridgeExit, delay(7000).then(() => ({ status: "unknown" }))]);
      if (terminal.code !== 0 || !this.bridgeStats?.stopped) failures.push(`Controller bridge terminal ${JSON.stringify(terminal)}`);
    }
    // Collector stays alive through native/controller cleanup and is separately
    // finalized. It is not mistaken for an unknown business writer.
    if (this.collector?.connected) this.collector.send("finish");
    let collectorTerminal;
    if (this.collectorExit) {
      const terminal = await Promise.race([this.collectorExit, delay(10000).then(() => ({ status: "unknown" }))]);
      collectorTerminal = terminal;
      if (terminal.status === "unknown") failures.push(`Collector terminal ${JSON.stringify(terminal)}`);
    }
    const until = Date.now() + 10000;
    while (captured.some(alive) && Date.now() < until) await delay(100);
    const remaining = captured.filter(alive);
    const late = ownedProcesses(this.root, this.tmux).filter(alive);
    if (remaining.length || late.length) failures.push("Physical exact PID/start ownership remains; retain Home");
    try {
      if (this.collectCliReceipts().incomplete) failures.push("Incomplete fixture CLI audit; retain Home");
    } catch (error) { failures.push(`CLI audit collection failed: ${String(error)}`); }
    // Read after owned writers stop, before release. Host binding can be absent
    // precisely because the proxy rejected a successfully created native Thread.
    let nativeCleanup;
    try {
      const raw = readNativeTransports(this.evidence);
      const custody = raw.filter(e => e.direction === "custody" && e.child).map(e => ({
        connection: e.sourceConnection, child: e.child, alive: alive(e.child) }));
      nativeCleanup = rejectedNativeCleanup(raw, { controls, custody });
      if (nativeCleanup.status === "unknown") failures.push("Native rejection/observation has unsettled effects; retain Home");
    } catch (error) {
      nativeCleanup = { status: "unknown", error: String(error) };
      failures.push("Native cleanup evidence unreadable; retain Home");
    }
    const result = { status: failures.length ? "retained" : "released", requestedAt, finishedAt: now(),
      root: this.root, controls, captured, remaining, late, failures, collectorTerminal, nativeCleanup,
      controllerBridge: this.bridgeStats,
      tmux: { code: tmux.status, stderr: tmux.stderr },
      nativeTerminalProof: "reported separately in condition native events; a stop request is not a terminal" };
    // Archive BEFORE release. Even failure/partial setup keeps complete owned
    // state. Archive error retains Home; never delete the only evidence copy.
    const archived = spawnSync("tar", ["-czf", join(this.evidence, "owned-home.tar.gz"), "-C", this.root, "."],
      { encoding: "utf8", timeout: 10000 });
    if (archived.status !== 0) { result.status = "retained"; result.failures.push(`archive:${archived.stderr}`); }
    else result.archiveSha256 = hash(readFileSync(join(this.evidence, "owned-home.tar.gz")));
    if (result.status === "released") rmSync(this.root, { recursive: true });
    result.rootAbsent = !existsSync(this.root);
    save(join(this.evidence, "cleanup.json"), result); return result;
  }
}
