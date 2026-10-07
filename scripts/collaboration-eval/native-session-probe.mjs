// Development calibration, not one of the 24 business cases or a P score.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Fixture } from "./fixture.mjs";
import { createEvidenceWriter, digest } from "./evidence.mjs";
import { NativeObserver } from "./native-session.mjs";

const [checkoutArg, outputArg] = process.argv.slice(2);
if (!checkoutArg || !outputArg) throw new Error("Expected checkout and new evidence directory");
const checkout = resolve(checkoutArg), output = resolve(outputArg);
const save = createEvidenceWriter(output);
const trace = [];
const fixture = new Fixture(checkout, trace, 90_000);
fixture.maxReads = 120;
const evidence = { schemaVersion: 1, mode: "offline", kind: "native-session-calibration",
  version: execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  worktreeStatus: execFileSync("git", ["-C", checkout, "status", "--porcelain"], { encoding: "utf8" }),
  cliSha256: digest(readFileSync(join(checkout, "dist/cli.js"))), node: process.version,
  sourceHashes: Object.fromEntries(["fixture", "native-turn", "native-fake-cli", "native-session-probe",
    "native-session", "native-business", "native-worker", "native-predecessor", "native-trace"]
    .map(name => [name, digest(readFileSync(new URL(`./${name}.mjs`, import.meta.url)))])),
  proxySha256: digest(readFileSync(new URL("../../test/fixtures/fake-codex-app-server-proxy.mjs", import.meta.url))),
  trace, status: "environment-error", modelCalls: 0 };
const abort = signal => { evidence.interrupted = signal; fixture.deadline = 0; };
process.on("SIGINT", abort); process.on("SIGTERM", abort);
let task;
try {
  fixture.prepare({ native: true });
  task = fixture.call(["task", "create", "Offline native handoff calibration"], "prepare").task.id;
  fixture.ownedRoles = [{ task, role: "leader" }];
  fixture.call(["task", "message", "send", task,
    "Artificial original requirement: preserve checkpoint across Session replacement.",
    "--intent", "record", "--request-id", "original"], "prepare");
  const observer = new NativeObserver(fixture, task, fixture.call(["task", "context", task]).coreCursor);
  evidence.events = observer.events;
  fixture.call(["task", "activation", "request", task,
    "--request-id", "native-calibration", "--environment", "scratch"], "prepare");
  evidence.predecessor = await observer.terminal("native-eval-observation");
  assert.equal(evidence.predecessor.result.previous.length, 0);
  evidence.before = fixture.call(["task", "role", "session", "inspect", task, "leader"]);
  evidence.replacement = fixture.call(["task", "role", "session", "new", task, "leader",
    "--reason", "Deliberate fresh Session for isolated calibration"], "write");
  evidence.successor = await observer.terminal("native-eval-observation",
    { excludeSession: evidence.predecessor.result.threadId });
  assert.notEqual(evidence.successor.result.threadId, evidence.predecessor.result.threadId);
  assert.deepEqual(evidence.successor.result.original, evidence.predecessor.result.original);
  assert.ok(evidence.successor.result.previous.some(c =>
    c.threadId === evidence.predecessor.result.threadId));
  evidence.after = fixture.call(["task", "role", "session", "inspect", task, "leader"]);
  // Reuse the actual predecessor's observed identity, not an invented Role or
  // a cleared identity. This must fail at the native stale-Session boundary.
  const forbidden = "Stale predecessor must not append this message.";
  assert.throws(() => fixture.call(["task", "message", "send", task, forbidden], "write", {
    environment: { ...fixture.environment, ...evidence.predecessor.result.identity }
  }), /no longer the current runtime|replaced|revoked/i);
  assert.equal(fixture.messages(task).some(m => m.body === forbidden), false);
  evidence.staleWriterRejected = true;
  evidence.status = "native-handoff-verified";
  evidence.limitations = ["Calibration only: business P effects and WorkItem permissions not established.",
    "Deterministic Provider is not evidence of model understanding."];
} catch (error) {
  evidence.error = String(error);
} finally {
  evidence.cleanup = await fixture.close();
  save(evidence);
  process.off("SIGINT", abort); process.off("SIGTERM", abort);
}
console.log(JSON.stringify({ status: evidence.status, error: evidence.error, output, cleanup: evidence.cleanup }));
if (evidence.status !== "native-handoff-verified" || evidence.cleanup.status !== "released") process.exitCode = 1;
