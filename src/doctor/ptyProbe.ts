import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { DoctorCheck } from "./doctor.js";

/** Native loading and spawn happen outside Doctor: a native abort cannot kill the CLI. */
export function inspectPty(options: {
  requireFrom?: string;
  timeoutMs?: number;
  probeTimeoutMs?: number;
} = {}): DoctorCheck[] {
  const started = Date.now();
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  if (![20, 22, 24].includes(major)) {
    checks.push({
      name: "pty Node runtime", status: "unsupported",
      detail: `Node ${process.versions.node} is outside Yui's supported Node 20/22/24 range; this is not evidence of a helper permission failure.`
    });
  }
  let entry: string;
  let identity: string;
  try {
    const require = createRequire(options.requireFrom ?? import.meta.url);
    entry = require.resolve("node-pty");
    const manifest = require.resolve("node-pty/package.json");
    const version = JSON.parse(readFileSync(manifest, "utf8")).version;
    identity = `node-pty ${version}; entry=${entry}; package=${manifest}`;
  } catch (error) {
    return [...checks, {
      name: "node-pty",
      status: (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" ? "missing" : "invalid",
      detail: `Dependency resolution failed: ${String(error)}`
    }];
  }
  const timeoutMs = options.timeoutMs ?? 1_500;
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("./ptyProbeChild.js", import.meta.url)),
    entry, String(options.probeTimeoutMs ?? 750)
  ], {
    // No NODE_OPTIONS, shell startup files, preload hooks or user configuration.
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    cwd: "/",
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024
  });
  for (const line of (result.stdout ?? "").split("\n").filter(Boolean)) {
    try {
      const check = JSON.parse(line) as DoctorCheck;
      if (["node-pty", "pty helper", "pty spawn"].includes(check.name)
          && ["ok", "missing", "invalid"].includes(check.status)
          && typeof check.detail === "string") {
        checks.push({ ...check, detail: `${identity}; ${check.detail}` });
      }
    } catch { /* Native diagnostics on stdout are retained below on failure. */ }
  }
  const completed = checks.some(check => check.name === "pty spawn")
    || checks.some(check => check.status !== "ok" && check.name !== "pty Node runtime");
  if (result.error || result.signal || result.status !== 0 || !completed) {
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    // A partial success line is not success if the isolated process failed to finish.
    for (let i = 0; i < checks.length; i += 1) {
      if (checks[i].name === "pty spawn" && checks[i].status === "ok") {
        checks[i] = { ...checks[i], status: "invalid", detail: `${checks[i].detail}; isolated probe did not finish successfully` };
      }
    }
    checks.push({
      name: "pty probe", status: "invalid",
      detail: `${identity}; ${timedOut ? `timeout after ${timeoutMs}ms` : "isolated probe failed"}; exit=${result.status} signal=${result.signal}; ${result.error?.message ?? ""} ${(result.stderr || result.stdout || "").trim()}`
    });
  }
  return checks.map(check => ({
    ...check, detail: `${check.detail}; elapsed=${Date.now() - started}ms`
  }));
}
