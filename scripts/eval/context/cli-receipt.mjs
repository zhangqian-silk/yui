// Evaluator-owned process telemetry. Never grants read/load credit: redirected
// output can be captured here without ever reaching the Subject's context.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync, openSync, closeSync, unlinkSync, readSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join, relative, isAbsolute } from "node:path";

export const CLI_AUDIT_NAME = ".yui-eval-cli-receipts.jsonl";
export async function runRecordedCli({ cli, audit, entry, product, node, args, home, launcherSha256, auditInCwd, controllerBridge }, env = process.env) {
  const id = randomUUID(), startedAt = new Date().toISOString();
  const digest = value => createHash("sha256").update(value).digest("hex");
  const identity = { id, entry, cli, product, home: env.YUI_HOME,
    threadId: env.CODEX_THREAD_ID, cwd: process.cwd(),
    launcherSha256: digest(readFileSync(cli)), node };
  if (home && (env.YUI_HOME !== home || identity.launcherSha256 !== launcherSha256)) {
    throw Error("Fixture CLI/Home/build binding mismatch; refusing before execution.");
  }
  if (auditInCwd) {
    if (!home) throw Error("Fixture cwd audit requires a fixed Home.");
    const child = relative(realpathSync(dirname(home)), realpathSync(process.cwd()));
    if (child === ".." || child.startsWith("../") || isAbsolute(child)) {
      throw Error("Fixture CLI cwd is outside its owned root.");
    }
    // Subject writes only inside its already-authorized cwd. The evaluator
    // copies these receipts outside the sandbox after observing the launch.
    audit = join(process.cwd(), CLI_AUDIT_NAME);
  }
  const record = value => appendFileSync(audit, JSON.stringify(value) + "\n");
  record({ ...identity, phase: "started", at: startedAt, args });
  if (controllerBridge) {
    if (controllerBridge.home !== home) throw Error("Fixture Controller bridge Home mismatch");
    env = { ...env, NODE_OPTIONS: `--import=${controllerBridge.module}`,
      YUI_EVAL_CONTROLLER_BRIDGE: JSON.stringify(controllerBridge) };
  }
  // Node's child stdout "pipe" is a Unix socketpair on Linux. Restricted native
  // networking can break its use in the child despite a zero CLI exit status.
  // A private regular file keeps capture/replay inside the same sandbox.
  const outputPath = join(process.cwd(), `.yui-eval-stdout-${id}`);
  const outputFd = openSync(outputPath, "wx+", 0o600);
  const child = spawn(cli, args, { env, stdio: ["inherit", outputFd, "inherit"] });
  const outputHash = createHash("sha256");
  let bytes = 0, chunks = [], error;
  child.once("error", e => { error = String(e); });
  // Forward only the signal delivered to this owned invocation, not a sweep.
  const onTerm = () => child.kill("SIGTERM"), onInt = () => child.kill("SIGINT");
  process.on("SIGTERM", onTerm); process.on("SIGINT", onInt);
  const terminal = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  process.off("SIGTERM", onTerm); process.off("SIGINT", onInt);
  try {
    const buffer = Buffer.alloc(65536);
    let position = 0, length;
    while ((length = readSync(outputFd, buffer, 0, buffer.length, position)) > 0) {
      const chunk = Buffer.from(buffer.subarray(0, length));
      position += length; outputHash.update(chunk); bytes += length;
      if (bytes <= 32768) chunks.push(chunk); else chunks = [];
      if (!process.stdout.write(chunk)) await new Promise(resolve => process.stdout.once("drain", resolve));
    }
  } finally { closeSync(outputFd); unlinkSync(outputPath); }
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
