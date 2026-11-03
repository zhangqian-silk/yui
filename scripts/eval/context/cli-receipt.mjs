// Evaluator-owned process telemetry. Never grants read/load credit: redirected
// output can be captured here without ever reaching the Subject's context.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export async function runRecordedCli({ cli, audit, entry, product, node, args }, env = process.env) {
  const id = randomUUID(), startedAt = new Date().toISOString();
  const digest = value => createHash("sha256").update(value).digest("hex");
  const identity = { id, entry, cli, product, home: env.YUI_HOME,
    threadId: env.CODEX_THREAD_ID, cwd: process.cwd(),
    launcherSha256: digest(readFileSync(cli)), node };
  const record = value => appendFileSync(audit, JSON.stringify(value) + "\n");
  record({ ...identity, phase: "started", at: startedAt, args });
  const child = spawn(cli, args, { env, stdio: ["inherit", "pipe", "inherit"] });
  const outputHash = createHash("sha256");
  let bytes = 0, chunks = [], error;
  child.stdout.on("data", chunk => {
    outputHash.update(chunk); bytes += chunk.length;
    if (bytes <= 32768) chunks.push(chunk); else chunks = [];
    process.stdout.write(chunk);
  });
  child.once("error", e => { error = String(e); });
  // Forward only the signal delivered to this owned invocation, not a sweep.
  const onTerm = () => child.kill("SIGTERM"), onInt = () => child.kill("SIGINT");
  process.on("SIGTERM", onTerm); process.on("SIGINT", onInt);
  const terminal = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  process.off("SIGTERM", onTerm); process.off("SIGINT", onInt);
  let envelope, stdoutText;
  if (bytes <= 32768) {
    const text = Buffer.concat(chunks).toString("utf8");
    try { envelope = JSON.parse(text); }
    catch {
      // Ordinary CLI text is not a JSON success envelope. Retain exact bounded
      // bytes separately; effect matching still checks process/identity/scope.
      if (!args.includes("--json")) stdoutText = text;
    }
  }
  record({ ...identity, phase: "completed", startedAt, at: new Date().toISOString(), args,
    ...terminal, ...(error ? { error } : {}), stdoutBytes: bytes, stdoutSha256: outputHash.digest("hex"),
    ...(envelope !== undefined ? { envelope } : {}),
    ...(stdoutText !== undefined ? { stdoutText } : {}) });
  return terminal.code ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [config, ...args] = process.argv.slice(2);
  process.exitCode = await runRecordedCli({ ...JSON.parse(config), args });
}
