import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Fixture } from "./fixture.mjs";
import { digest, createEvidenceWriter } from "./evidence.mjs";
import { recoverNotification } from "./participant.mjs";
import { judgeNotification } from "./oracle.mjs";
import { NotificationSimulator } from "./notification-simulator.mjs";
import { persistTaskFacts, readTaskFacts } from "./readback.mjs";

const args = process.argv.slice(2);
const value = flag => {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${flag}`);
  return args[index + 1];
};
if (args.length !== 6 || !args.every((arg, index) => index % 2 || ["--version", "--case", "--out"].includes(arg))) {
  throw new Error("Usage: node scripts/collaboration-eval/run.mjs --version <checkout> --case O02 --out <new-directory>");
}
const checkout = resolve(value("--version"));
const output = resolve(value("--out"));
if (existsSync(output)) throw new Error("Output already exists; refusing to overwrite evidence.");
if (value("--case") !== "O02") throw new Error("Only O02/F is implemented in this first vertical slice.");
const trace = [];
const evidence = {
  schemaVersion: 1, mode: "offline", experiment: randomUUID(), createdAt: new Date().toISOString(),
  version: {
    checkout, commit: execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    cliSha256: digest(readFileSync(join(checkout, "dist/cli.js"))),
    node: process.version, platform: process.platform, architecture: process.arch,
    packageLockSha256: digest(readFileSync(join(checkout, "package-lock.json"))),
    worktreeStatus: execFileSync("git", ["-C", checkout, "status", "--porcelain"], { encoding: "utf8" })
  },
  caseSet: "unified-v3-O02-readback-v1", seed: 89,
  policySha256: digest(readFileSync(new URL("./participant.mjs", import.meta.url))),
  oracleSha256: digest(readFileSync(new URL("./oracle.mjs", import.meta.url))),
  harnessSha256: Object.fromEntries(["run", "fixture", "evidence", "notification-simulator", "readback"]
    .map(name => [name, digest(readFileSync(new URL(`./${name}.mjs`, import.meta.url)))])),
  trace, conditions: [{ id: "O02", category: "operations", split: "dev", mode: "F", status: "not-run" }]
};
// Reserve the output before setup so a collision cannot discard collected evidence.
const save = createEvidenceWriter(output);
const fixture = new Fixture(checkout, trace);
try {
  fixture.prepare();
  evidence.runtime = fixture.call(["controller", "status"], "prepare").identity;
  const created = fixture.call(["task", "create", "Synthetic notification reconciliation"], "prepare");
  const task = created.task.id;
  // Local stateful external-system substitute. Initial send takes effect but its response is lost.
  const simulator = new NotificationSimulator(join(fixture.root, "notification-effects.jsonl"));
  simulator.send({ key: "notice-17", recipient: "local-inbox", body: "Build ready" }, { dropResponse: true });
  const operation = { key: "operation", source: "synthetic-notification", revision: 1,
    body: { kind: "pending-notification", status: "unknown", key: "notice-17",
      recipient: "local-inbox", body: "Build ready" } };
  persistTaskFacts(fixture, task, [{ ...operation, digest: digest(JSON.stringify(operation)) }]);
  fixture.call(["controller", "restart"], "prepare");
  evidence.context = fixture.call(["task", "context", task]);
  evidence.readback = readTaskFacts(fixture, task);
  const original = evidence.readback.records.find(record => record.value.key === "operation")?.value.body;
  if (!original) throw new Error("Original unknown operation is not discoverable.");
  const queries = [];
  const receipt = recoverNotification(original, key => {
    const found = simulator.lookup(key);
    queries.push({ key, found: found !== undefined });
    return found;
  });
  fixture.call(["task", "message", "send", task, JSON.stringify({ kind: "effect-receipt", ...receipt }),
    "--intent", "record", "--request-id", "reconciliation"], "write");
  const persisted = fixture.messages(task).some(message => {
    try {
      const body = JSON.parse(message.body);
      return body.kind === "effect-receipt" && body.key === receipt.key && body.effectId === receipt.effectId;
    } catch { return false; }
  });
  evidence.observation = { ledger: simulator.ledger(), queries, receipt, persistedReceipt: persisted, discoveredOriginal: true };
  Object.assign(evidence.conditions[0], judgeNotification(evidence.observation));
} catch (error) {
  Object.assign(evidence.conditions[0], { status: String(error).includes("budget-exceeded")
    ? "budget-exceeded" : "environment-error", error: String(error), attribution: "unknown" });
} finally {
  evidence.cleanup = await fixture.close();
  save(evidence);
}
console.log(JSON.stringify({ output, result: evidence.conditions, cleanup: evidence.cleanup }, null, 2));
if (evidence.conditions.some(item => item.status !== "scripted-pass") || evidence.cleanup.status !== "released") {
  process.exitCode = 1;
}
