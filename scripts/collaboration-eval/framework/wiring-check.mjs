// Explicit, opt-in real CLI/Controller/Host wiring. Not another default daemon
// matrix in npm test; permanent package smoke retains OS/package ownership.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { save, now, parseOptions } from "./common.mjs";
const args = process.argv.slice(2), profileAt = args.indexOf("--profile");
const profile = profileAt < 0 ? "full" : args.splice(profileAt, 2)[1];
if (!["full", "lifecycle", "recovery"].includes(profile)) throw Error("Wiring profile must be full|lifecycle|recovery");
const options = parseOptions(["--mode", "fake", ...args]);
if (args.some((v, i) => i % 2 === 0 && !["--product", "--out"].includes(v)))
  throw Error("Wiring accepts only --product, --out and --profile; use eval:collaboration for individual scenarios");
const output = resolve(options.out);
if (existsSync(output)) throw Error("New output directory required");
mkdirSync(output);
const runs = [];
async function run(name, scenarios, concurrency = 2, interrupt = false) {
  const directory = join(output, name), at = now();
  const child = fork(new URL("./run.mjs", import.meta.url), ["--mode", "fake", "--product", resolve(options.product),
    "--out", directory, "--scenarios", scenarios, "--concurrency", String(concurrency)], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const terminal = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  if (interrupt) {
    // Signal only this owned coordinator after an actual subject Turn starts.
    // This is fixture fault injection, not a real user interruption.
    const deadline = Date.now() + 40000;
    let signalled = false;
    while (child.exitCode === null && Date.now() < deadline) {
      const d = join(directory, "normal");
      if (existsSync(d) && readdirSync(d).filter(n => n.startsWith("transport-")).some(n =>
        readFileSync(join(d, n), "utf8").includes('"method":"turn/started"'))) {
        child.kill("SIGTERM"); signalled = true; break;
      }
      await delay(100);
    }
    assert(signalled, "Interrupt injection must reach real active fixture execution");
  }
  const exit = await terminal;
  const ledger = JSON.parse(readFileSync(join(directory, "ledger.json")));
  const result = { name, startedAt: at, finishedAt: now(), exit, ledger };
  runs.push(result); return result;
}
let error;
try {
  const first = await run("base", "normal", 1);
  assert.equal(first.exit.code, 0);
  assert.equal(first.ledger.results[0].completedStages, 3);
  assert.equal(first.ledger.results[0].executionChecks, "pass");
  assert.equal(first.ledger.results[0].status, "observation-unknown", "No invented lossless observation");
  if (profile === "recovery") {
    const recovery = await run("replacement", "session-recovery,session-recovery-stop-unknown", 2);
    const good = recovery.ledger.results.find(r => r.scenario === "session-recovery");
    const stopped = recovery.ledger.results.find(r => r.scenario === "session-recovery-stop-unknown");
    assert.equal(good.completedStages, 3);
    assert.equal(good.executionChecks, "pass");
    assert.equal(good.recovery.stop.status, "pass");
    assert.equal(good.recovery.ownership.status, "pass");
    assert.equal(good.recovery.preservation.status, "pass");
    assert.equal(good.recovery.predecessorVerdict.status, "pass");
    assert.equal(good.recovery.nativeCompaction, "not-covered");
    assert.equal(good.recovery.simulatedProvider, true);
    const row = good.stages[1];
    assert.equal(row.handlingPurpose, "inspect-existing-effect-before-successor-ACK");
    assert.equal(row.reads.status, "pass");
    assert.equal(row.inputReads.status, "pass");
    assert.equal(row.loads.status, "pass");
    assert.equal(row.recoveryInspection.status, "pass");
    assert.equal(good.recovery.initialization.threadId, row.terminal.threadId);
    assert.notEqual(good.recovery.initialization.turnId, row.terminal.turnId,
      "Lifecycle initialization cannot stand in for retained ACK handling");
    assert(Date.parse(good.recovery.initialization.at) < Date.parse(row.terminal.startedAt));
    assert(row.loads.coverage.every(f => f.coveredBytes === f.requiredBytes
      && f.proofs.every(p => [good.recovery.initialization.turnId, row.terminal.turnId].includes(p.turnId))),
    "Fresh successor may reuse its own initialization bytes, never predecessor coverage");
    const ownWake = JSON.parse(readFileSync(join(output, "replacement/session-recovery/recovery-successor.json")));
    assert.equal(ownWake.successor.turnId, row.terminal.turnId);
    const directory = join(output, "replacement/session-recovery");
    assert(!existsSync(join(directory, "participant")), "Native adapter must not borrow participant markers");
    assert.equal(stopped.completedStages, 1);
    assert.equal(stopped.recovery.stop.status, "unknown");
    assert.equal(stopped.recovery.replacementRequested, false);
    const trace = JSON.parse(readFileSync(join(output, "replacement/session-recovery-stop-unknown/cli-trace.json")));
    assert(trace.some(c => c.phase === "recovery-stop" && c.code !== 0), "Actual stop CLI must reject unknown native background state");
    assert(!trace.some(c => c.phase === "recovery"), "No session-new after unknown stop");
    assert(!trace.some(c => c.phase === "producer" && c.args.includes("input-3")), "No third business input");
    assert(existsSync(join(output, "replacement/session-recovery-stop-unknown/stop-unknown-injection.json")));
  }
  if (profile === "full") {
  const fault = await run("faults", "missing-ack,cross-task,unauthorized-write,partial-load,quality-fail,recovery,normal,collector-fail,partial-setup", 3);
  const get = name => fault.ledger.results.find(r => r.scenario === name);
  for (const name of ["missing-ack", "unauthorized-write", "partial-load"]) assert.equal(get(name).status, "quality-fail", name);
  assert.equal(get("cross-task").status, "quality-fail");
  assert.equal(get("cross-task").failureFacts.code, "USAGE_ERROR");
  assert.equal(get("quality-fail").status, "quality-fail");
  for (const name of ["recovery", "normal"]) {
    assert.equal(get(name).completedStages, 3, name);
    assert.equal(get(name).executionChecks, "pass", name);
  }
  assert.equal(get("collector-fail").completedStages, 0);
  assert.equal(get("collector-fail").collector.status, "unknown");
  assert.equal(get("partial-setup").completedStages, 0);
  }
  if (profile !== "recovery") {
  const unknown = await run("unknown", "unknown-lifecycle,normal", 1);
  assert.equal(unknown.ledger.results[0].completedStages, 0);
  assert.equal(unknown.ledger.results[1].status, "not-run", "Unknown lifecycle must fence subsequent launch");
  const interrupted = await run("interrupt", "normal", 1, true);
  assert.equal(interrupted.ledger.results[0].status, "interrupted");
  }
  for (const r of runs.flatMap(r => r.ledger.results).filter(r => r.processTerminal)) {
    assert.equal(r.cleanup.status, "released", r.scenario);
    assert.equal(r.cleanup.rootAbsent, true, r.scenario);
    assert.equal(r.actualModelCalls, 0);
  }
} catch (e) { error = { message: e.message, stack: e.stack }; process.exitCode = 1; }
save(join(output, "check.json"), { status: error ? "fail" : "pass", profile, error, runs,
  finishedAt: now(), scope: "Framework wiring only; no real model, lossless write journal or native compaction claimed" });
console.log(JSON.stringify({ wiring: error ? "fail" : "pass", error, output }));
