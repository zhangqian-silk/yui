// Separate calibration, not a business-case result or cross-Project OS sandbox.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Fixture } from "./fixture.mjs";
import { NativeObserver } from "./native-session.mjs";
import { createEvidenceWriter, digest } from "./evidence.mjs";

const [checkoutArg, outputArg] = process.argv.slice(2);
if (!checkoutArg || !outputArg) throw new Error("Expected checkout and new output directory");
const checkout = resolve(checkoutArg), output = resolve(outputArg), save = createEvidenceWriter(output);
const trace = [], fixture = new Fixture(checkout, trace, 90_000);
fixture.maxReads = 120;
const evidence = { schemaVersion: 1, kind: "native-worker-calibration", mode: "offline",
  version: execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  worktreeStatus: execFileSync("git", ["-C", checkout, "status", "--porcelain"], { encoding: "utf8" }),
  cliSha256: digest(readFileSync(join(checkout, "dist/cli.js"))), node: process.version,
  sourceHashes: Object.fromEntries(["fixture", "native-turn", "native-worker", "native-fake-cli",
    "native-session", "native-worker-probe"].map(n => [n, digest(readFileSync(new URL(`./${n}.mjs`, import.meta.url)))])),
  trace, status: "environment-error", modelCalls: 0 };
const abort = signal => { evidence.interrupted = signal; fixture.deadline = 0; };
process.on("SIGINT", abort); process.on("SIGTERM", abort);
try {
  fixture.prepare({ native: true });
  const task = fixture.call(["task", "create", "Offline native Worker boundaries"], "prepare").task.id;
  fixture.ownedRoles = [{ task, role: "leader" }];
  fixture.call(["task", "message", "send", task,
    "Artificial original requirement: preserve checkpoint across Session replacement.",
    "--intent", "record", "--request-id", "original"], "prepare");
  const observer = new NativeObserver(fixture, task, fixture.call(["task", "context", task]).coreCursor);
  evidence.events = observer.events;
  fixture.call(["task", "activation", "request", task, "--request-id", "worker-calibration",
    "--environment", "scratch"], "prepare");
  evidence.leader = await observer.terminal("native-eval-observation");
  fixture.call(["config", "profile", "add", "offline-reader", "--access", "read", "--agent", "codex"], "prepare");
  fixture.call(["task", "role", "add", task, "reader", "--profile", "offline-reader"], "prepare");
  evidence.profile = fixture.call(["config", "profile", "show", "offline-reader"]);
  evidence.role = fixture.call(["task", "role", "show", task, "reader"]);
  fixture.call(["task", "work", "create", task, "Inspect immutable artificial requirement",
    "--role", "reader", "--objective", "Report the frozen objective without accepting any result.",
    "--accept", "Exact original objective read; no self-acceptance; no writable Projects."], "prepare");
  const work = fixture.records(task, "work-item").map(r => r.value);
  assert.equal(work.length, 1);
  const ref = `${task}/${work[0].id}`;
  evidence.workBefore = work[0];
  fixture.ownedRoles.push({ task, role: "reader" });
  fixture.call(["task", "work", "dispatch", ref,
    "--input", "Read the frozen assigned WorkItem, report its objective, and test self-acceptance refusal. No filesystem writes."], "write");
  evidence.worker = await observer.terminal("native-business-worker-calibration");
  const result = evidence.worker.result;
  assert.equal(result.original.value.id, work[0].id);
  assert.equal(result.finding.objective, work[0].objective);
  assert.equal(result.finding.selfAcceptanceDenied, true);
  evidence.beforeAcceptance = fixture.records(task, "work-item").find(r => r.value.id === work[0].id).value;
  assert.notEqual(evidence.beforeAcceptance.status, "accepted");
  evidence.run = fixture.detail(["task", "run", "show", `${task}/${result.identity.runId}`]);
  // A completed native result must be the exact original, not a fabricated
  // Candidate body or a notification summary.
  const run = evidence.run.run ?? evidence.run;
  assert.equal(run.status, "completed");
  assert.deepEqual(JSON.parse(run.result.output), result);
  fixture.call(["task", "update", task,
    "--title", "Changed live title after the original frozen Assignment"], "write");
  evidence.frozenAfter = fixture.call(["task", "run", "context", `${task}/${result.identity.runId}`]).context;
  assert.deepEqual(evidence.frozenAfter.snapshot, result.pack.snapshot);
  assert.equal(evidence.frozenAfter.digest, result.pack.digest);
  const taskPointer = result.pack.pointers.find(p => p.store === "task");
  assert.ok(taskPointer);
  evidence.frozenTask = fixture.call(["task", "run", "context", "expand",
    `${task}/${result.identity.runId}`, taskPointer.refId, "--store", taskPointer.store, "--mode", "full"]).context;
  evidence.liveTask = fixture.records(task, "task")[0];
  assert.equal(evidence.frozenTask.value.title, "Offline native Worker boundaries");
  assert.equal(evidence.liveTask.value.title, "Changed live title after the original frozen Assignment");
  fixture.call(["task", "work", "update", ref, "done", "--summary", "Read-only native result inspected."], "write");
  evidence.candidate = fixture.records(task, "work-item").find(r => r.value.id === work[0].id).value;
  assert.notEqual(evidence.candidate.status, "accepted");
  assert.equal(evidence.candidate.candidates.length, 1);
  assert.deepEqual(evidence.candidate.candidates[0].source, { type: "run", runId: result.identity.runId });
  fixture.call(["task", "work", "accept", ref, "--summary",
    "Exact native original inspected; acceptance is separate from terminal."], "write");
  evidence.accepted = fixture.records(task, "work-item").find(r => r.value.id === work[0].id).value;
  assert.equal(evidence.accepted.status, "accepted");
  evidence.status = "native-worker-boundaries-verified";
  evidence.limitations = ["Read-only Gitless calibration only; no cross-Project filesystem boundary proved.",
    "No business-case acceptance score or model understanding is inferred."];
} catch (error) { evidence.error = String(error); }
finally {
  evidence.cleanup = await fixture.close();
  save(evidence);
  process.off("SIGINT", abort); process.off("SIGTERM", abort);
}
console.log(JSON.stringify({ output, status: evidence.status, error: evidence.error, cleanup: evidence.cleanup }));
if (evidence.status !== "native-worker-boundaries-verified" || evidence.cleanup.status !== "released") process.exitCode = 1;
