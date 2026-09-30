import { accessSync, constants, statSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import type { DoctorCheck } from "./doctor.js";
import type { IPty } from "node-pty";

const require = createRequire(import.meta.url);
const entry = process.argv[2];
const timeoutMs = Number(process.argv[3]);
const report = (check: DoctorCheck) => writeSync(1, `${JSON.stringify(check)}\n`);
const errorDetail = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);

async function probe(): Promise<void> {
  let pty: typeof import("node-pty");
  try {
    pty = require(entry);
    if (typeof pty.spawn !== "function") throw new Error("node-pty does not expose spawn");
    report({ name: "node-pty", status: "ok", detail: "native module loaded" });
  } catch (error) {
    report({
      name: "node-pty", status: "invalid",
      detail: `native load failed: ${errorDetail(error)}. If installation reported blocked lifecycle scripts, review npm allow-scripts separately; no install files were changed.`
    });
    return;
  }
  if (process.platform === "darwin") {
    // The pinned node-pty selects build/Release, build/Debug or prebuilds.
    // Inspect the module it actually loaded, not the first helper that exists.
    const native = Object.keys(require.cache).find(path => basename(path) === "pty.node");
    if (!native) {
      report({ name: "pty helper", status: "invalid", detail: "Cannot identify the loaded pty.node; helper path is unverified." });
      return;
    }
    const helper = join(dirname(native), "spawn-helper");
    let mode = "unknown";
    try {
      mode = (statSync(helper).mode & 0o7777).toString(8).padStart(4, "0");
      accessSync(helper, constants.X_OK);
      report({ name: "pty helper", status: "ok", detail: `helper=${helper}; mode=${mode}; executable by current user` });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      report({
        name: "pty helper", status: code === "ENOENT" ? "missing" : "invalid",
        detail: `helper=${helper}; mode=${mode}; ${code === "EACCES" ? "permission denied for current user" : "helper check failed"}: ${errorDetail(error)}`
      });
      return;
    }
  }
  await new Promise<void>(resolve => {
    const marker = "yui-pty-probe-ok";
    let terminal: IPty | undefined;
    let output = "";
    let finished = false;
    const finish = (status: "ok" | "invalid", detail: string, kill = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (kill && terminal) {
        try { terminal.kill("SIGKILL"); }
        catch (error) { detail += `; cleanup: ${errorDetail(error)}`; }
      }
      report({ name: "pty spawn", status, detail });
      resolve();
    };
    const timer = setTimeout(() => finish("invalid", `timeout after ${timeoutMs}ms waiting for output and normal exit`, true), timeoutMs);
    try {
      // Absolute, fixed executable; no shell, Node preloads, Agent or account access.
      terminal = pty.spawn("/bin/echo", [marker], {
        name: "xterm", cols: 80, rows: 24, cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "C" }
      });
      terminal.onData(data => { output = (output + data).slice(-4096); });
      terminal.onExit(({ exitCode, signal }) => {
        const ok = exitCode === 0 && !signal && output.replace(/\r/g, "").trim() === marker;
        finish(ok ? "ok" : "invalid",
          `${ok ? "expected output and normal exit confirmed (PTY dependency only; Web Terminal and Provider protocols unverified)" : "unexpected output or exit"}; exit=${exitCode}; signal=${signal ?? 0}; output=${JSON.stringify(output)}`);
      });
    } catch (error) {
      finish("invalid", `spawn failed: ${errorDetail(error)}`, true);
    }
  });
}

await probe();
// node-pty's native watcher can retain handles; the fixed child has exited, or
// was explicitly killed on failure. The parent also bounds native hangs/aborts.
process.exit(0);
