import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

export class Fixture {
  constructor(checkout, trace, budgetMs = 90_000) {
    this.root = mkdtempSync(join(tmpdir(), "yui-collaboration-eval-"));
    this.home = join(this.root, "state");
    this.cli = join(resolve(checkout), "output/dev/bin/yui");
    this.trace = trace;
    this.deadline = performance.now() + budgetMs;
    this.reads = 0;
    this.bytes = 0;
    // Cleanup is available before setup, which can start a Controller.
    this.cleanup = { status: "not-started", root: this.root };
  }

  prepare() {
    const bin = join(this.root, "bin");
    mkdirSync(bin);
    mkdirSync(this.home);
    mkdirSync(join(this.root, "user"));
    mkdirSync(join(this.root, "tmp"));
    const fake = new URL("../../test/fixtures/fake-codex-cli.mjs", import.meta.url);
    writeFileSync(join(bin, "codex"),
      `#!${process.execPath}\nimport(${JSON.stringify(fake.href)});\n`, { mode: 0o755 });
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(this.cli, join(bin, "yui"));
    this.environment = {
      HOME: join(this.root, "user"),
      CODEX_HOME: join(this.root, "user", ".codex"),
      YUI_HOME: this.home,
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: join(this.root, "tmp"),
      NO_COLOR: "1"
    };
    this.tmux = `yui-${createHash("sha256").update(realpathSync(this.home)).digest("hex").slice(0, 24)}`;
    this.call(["setup"], "prepare", { json: false, input: "codex\n",
      environment: { ...this.environment, YUI_SETUP_INTERACTIVE: "1" } });
  }

  call(args, phase = "query", options = {}) {
    if (phase !== "cleanup" && performance.now() >= this.deadline) throw new Error("budget-exceeded");
    if (phase === "query" && (this.reads >= 60 || this.bytes >= 2 * 1024 * 1024)) {
      throw new Error("budget-exceeded");
    }
    const started = performance.now();
    const command = [...(options.json === false ? [] : ["--json"]), ...args];
    const result = spawnSync(this.cli, command, {
      env: options.environment ?? this.environment, encoding: "utf8", input: options.input,
      timeout: phase === "cleanup" ? 20_000 : Math.max(1, Math.min(20_000, this.deadline - started)),
      maxBuffer: 8 * 1024 * 1024
    });
    const entry = { phase, args: command, exitCode: result.status, signal: result.signal,
      stdout: result.stdout ?? "", stderr: result.stderr ?? "", elapsedMs: performance.now() - started };
    entry.stdoutBytes = Buffer.byteLength(entry.stdout);
    entry.stderrBytes = Buffer.byteLength(entry.stderr);
    this.trace.push(entry);
    if (phase === "query") { this.reads++; this.bytes += entry.stdoutBytes + entry.stderrBytes; }
    if (result.status !== 0 || result.error) {
      throw new Error(`CLI ${args.join(" ")}: ${result.error?.message ?? entry.stderr ?? entry.stdout}`);
    }
    if (phase === "query" && this.bytes > 2 * 1024 * 1024) throw new Error("budget-exceeded");
    if (options.json === false) return entry.stdout;
    const envelope = JSON.parse(entry.stdout);
    if (envelope.ok === false) throw new Error(JSON.stringify(envelope));
    return envelope.data ?? envelope;
  }

  // Complete originals, including bounded long-content responses.
  detail(args) {
    let value = this.call(args);
    if (!value.contentPage) return value;
    let text = "";
    for (;;) {
      text += value.contentPage.text;
      if (value.contentPage.complete) return JSON.parse(text);
      value = this.call([...args, "--cursor", value.contentPage.nextCursor]);
    }
  }

  messages(task) {
    const messages = [];
    let cursor;
    do {
      const page = this.call(["task", "context", "list", task, "--store", "task-message",
        ...(cursor ? ["--cursor", cursor] : [])]);
      for (const item of page.items) {
        messages.push(this.detail(["task", "message", "show", `${task}/${item.ref.refId}`]));
      }
      cursor = page.nextCursor;
      if (!page.complete && !cursor) throw new Error("Incomplete message discovery without continuation");
    } while (cursor);
    return messages;
  }

  async close() {
    const failures = [];
    if (this.environment && (existsSync(join(this.home, "yui.db"))
      || existsSync(join(this.home, "runtime/controller.json")))) {
      try { this.call(["controller", "stop"], "cleanup"); }
      catch (error) { failures.push(String(error)); }
    }
    if (this.tmux && this.environment) {
      const stopped = spawnSync("tmux", ["-L", this.tmux, "kill-server"],
        { env: this.environment, encoding: "utf8", timeout: 5000 });
      if (stopped.status !== 0 && !/no server running|No such file/.test(stopped.stderr ?? "")) {
        failures.push(`tmux: ${stopped.error?.message ?? stopped.stderr}`);
      }
    }
    if (!failures.length) {
      for (let attempt = 0; attempt < 10; attempt++) {
        try { rmSync(this.root, { recursive: true, force: true }); break; }
        catch (error) {
          if (attempt === 9) failures.push(String(error));
          else await delay(100);
        }
      }
    }
    this.cleanup = { status: failures.length ? "retained" : "released", root: this.root, failures };
    return this.cleanup;
  }
}
