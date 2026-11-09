import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import {
  applyConnectionConfig, ConnectionConfigError, planConnectionConfig, restoreConnectionConfig,
  type ConnectionConfigInput, type ConnectionConfigPlan, type ConnectionConfigResult,
} from "./connectionConfig.js";

const usage = `Standalone native model connection configuration (no Controller).
  preview --input /absolute/request.json
  apply --input /absolute/request.json --if-plan /absolute/preview.json --exclusive --receipt /absolute/new-receipt.json
  restore --from /absolute/receipt.json --exclusive --receipt /absolute/new-restore-receipt.json
All output is JSON. Preview writes nothing. Redirect preview stdout to a new private
file, then apply that exact plan. --exclusive attests exclusion of other writers.
Exit: 0 saved/unchanged/preview; 2 invalid input/preflight failure; 3 partial; 4 unknown.
See docs/model-connection-tools.md for typed input, ownership and recovery limits.`;

function invalid(): never { throw new ConnectionConfigError("INVALID_CLI_ARGUMENTS"); }
function readJson(path: string): unknown {
  if (!isAbsolute(path)) invalid();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) invalid();
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

/** Shared standalone entry; deliberately imports no Yui Store/Controller modules. */
export function runConnectionConfigCli(args: string[], environment: NodeJS.ProcessEnv = process.env): number {
  let receiptFd: number | undefined;
  let outcome: ConnectionConfigResult | undefined;
  try {
    if (args.length === 0 || (args.length === 1 && ["--help", "help"].includes(args[0]))) {
      process.stdout.write(`${JSON.stringify({ usage })}\n`);
      return 0;
    }
    const [command, ...rest] = args;
    if (!["preview", "apply", "restore"].includes(command)) invalid();
    const flags = new Map<string, string | true>();
    const allowed = command === "preview" ? ["--input"] : command === "apply"
      ? ["--input", "--if-plan", "--exclusive", "--receipt"] : ["--from", "--exclusive", "--receipt"];
    for (let i = 0; i < rest.length; i++) {
      const key = rest[i];
      if (!allowed.includes(key) || flags.has(key)) invalid();
      if (key === "--exclusive") flags.set(key, true);
      else {
        const value = rest[++i];
        if (!value || value.startsWith("--") || !isAbsolute(value)) invalid();
        flags.set(key, value);
      }
    }
    const required = (key: string): string => {
      const value = flags.get(key);
      if (typeof value !== "string") invalid();
      return value;
    };
    let plan: ConnectionConfigPlan | undefined;
    if (command !== "restore") plan = planConnectionConfig(readJson(required("--input")) as ConnectionConfigInput, environment);
    if (command === "preview") {
      process.stdout.write(`${JSON.stringify(plan)}\n`);
      return 0;
    }
    if (flags.get("--exclusive") !== true) throw new ConnectionConfigError("EXCLUSIVE_WRITER_REQUIRED");
    if (command === "apply") {
      const expected = readJson(required("--if-plan")) as ConnectionConfigPlan;
      if (expected?.schemaVersion !== 1 || expected.status !== "preview"
        || JSON.stringify(expected.files) !== JSON.stringify(plan!.files)) throw new ConnectionConfigError("PREVIEW_REVISION_CONFLICT");
    }
    const sourceReceipt = command === "restore" ? readJson(required("--from")) as ConnectionConfigResult : undefined;
    // Reserve the receipt before modifying native files. Never overwrite a prior
    // receipt. An empty reservation after interruption is not a success receipt.
    const destination = required("--receipt");
    const parent = dirname(resolve(destination));
    const stat = lstatSync(parent);
    if (realpathSync(parent) !== parent || !stat.isDirectory() || (stat.mode & 0o022)
      || (process.getuid && stat.uid !== process.getuid())) throw new ConnectionConfigError("UNSAFE_RECEIPT_DIRECTORY");
    if ((plan?.files ?? sourceReceipt?.files ?? []).some(file => file.path === resolve(destination))) invalid();
    receiptFd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    outcome = command === "apply" ? applyConnectionConfig(plan!, { exclusive: true })
      : restoreConnectionConfig(sourceReceipt!, { exclusive: true });
    writeFileSync(receiptFd, `${JSON.stringify(outcome)}\n`);
    fsyncSync(receiptFd);
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return outcome.status === "unknown" ? 4 : outcome.status === "partial" ? 3 : outcome.status === "failed" ? 2 : 0;
  } catch (error) {
    const code = error instanceof ConnectionConfigError ? error.code : "CONNECTION_CONFIG_FAILED";
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: outcome ? "unknown" : "failed", code,
      ...(outcome ? { receiptPersisted: false, result: outcome } : {}) })}\n`);
    return outcome ? 4 : 2;
  } finally { if (receiptFd !== undefined) closeSync(receiptFd); }
}
