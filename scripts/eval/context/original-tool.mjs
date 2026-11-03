// Fixture-only executable. This audit is evidence, never cache or read authority.
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "../core/io.mjs";
import { OriginalReadError, readOriginalPage } from "./original-reader.mjs";
const startedAt = new Date().toISOString(), calls = [], cwd = process.cwd();
const environment = Object.fromEntries(["YUI_HOME", "YUI_SESSION_SCOPE", "YUI_TASK_ID", "YUI_ROLE",
  "YUI_AGENT_ID", "CODEX_THREAD_ID", "YUI_NATIVE_SESSION_ID"].filter(k => process.env[k] !== undefined)
  .map(k => [k, process.env[k]]));
const directory = dirname(fileURLToPath(import.meta.url));
let request, stdout = "", code = 1, error, files, config;
try {
  if (process.argv.length !== 3 || Buffer.byteLength(process.argv[2]) > 16384) throw Error("Expected bounded request");
  request = JSON.parse(process.argv[2]);
  config = JSON.parse(readFileSync(join(directory, "../provider.json"), "utf8"));
  files = Object.fromEntries(["original-tool.mjs", "original-reader.mjs", "../core/io.mjs"]
    .map(name => [name, hash(readFileSync(join(directory, name)))]));
  const result = readOriginalPage(request, { binding: config.originalTool, transport: call => {
    const at = new Date().toISOString();
    const r = spawnSync(call.cli, call.args, { env: call.environment, timeout: call.timeoutMs,
      maxBuffer: call.maxBytes, shell: false });
    calls.push({ at, finishedAt: new Date().toISOString(), cli: call.cli, args: call.args,
      code: r.status, signal: r.signal, error: r.error ? r.error.code ?? "transport" : undefined,
      stdout: (r.stdout ?? Buffer.alloc(0)).toString("utf8"),
      stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8") });
    return { code: r.status, error: r.error, stdout: r.stdout, stderr: r.stderr };
  } });
  stdout = result.stdout; code = 0;
} catch (e) {
  error = e instanceof OriginalReadError ? e.code : "input-or-audit";
}
// Fail closed if the fixture-owned evidence destination is unavailable. No
// alternate log path, partial stdout, retry, daemon or credential environment.
try {
  config ??= JSON.parse(readFileSync(join(directory, "../provider.json"), "utf8"));
  appendFileSync(join(config.evidence, "original-tool-audit.jsonl"), JSON.stringify({
    request, environment, cwd, pid: process.pid, ppid: process.ppid, startedAt,
    finishedAt: new Date().toISOString(), files, calls, stdout, code, error,
  }) + "\n");
} catch { code = 1; stdout = ""; error = "audit-unavailable"; }
if (code === 0) process.stdout.write(stdout);
else process.stderr.write(JSON.stringify({ error: error ?? "original-read-failed", retry: false }) + "\n");
process.exitCode = code;
