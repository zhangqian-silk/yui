import { fork, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client, hash, save, now, ownedProcesses, alive, fixtureCliScript } from "./common.mjs";
import { readNativeTransports, rejectedNativeCleanup, recordedStopControls } from "./native-ownership.mjs";

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
      originalTool: this.originalTool };
    if (this.mode === "fake") {
      save(this.configPath, config);
      this.owner = fork(new URL("./fake-provider.mjs", import.meta.url), [this.configPath],
        { env: this.environment, stdio: ["ignore", "ignore", "inherit", "ipc"] });
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
        audit: join(this.evidence, "cli-process-receipts.jsonl"), product: this.product
      }), { mode: 0o755 });
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
