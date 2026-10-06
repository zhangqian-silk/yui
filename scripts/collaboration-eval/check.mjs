import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { analyze, readEvidence, saveEvidence } from "./evidence.mjs";
import { judgeNotification } from "./oracle.mjs";
import { recoverNotification } from "./participant.mjs";
import { NotificationSimulator } from "./notification-simulator.mjs";

test("unknown effects are reconciled, not resent; oracle detects duplicate effects", () => {
  const effect = { key: "notice-17", recipient: "local-inbox", body: "Build ready",
    effectId: "effect-1", status: "confirmed" };
  const receipt = recoverNotification({ ...effect, status: "unknown" }, key => {
    assert.equal(key, "notice-17");
    return effect;
  });
  const observation = { receipt, ledger: [effect], persistedReceipt: true, discoveredOriginal: true };
  assert.equal(judgeNotification(observation).status, "scripted-pass");
  assert.equal(judgeNotification({ ...observation, ledger: [effect, { ...effect, key: "new-key" }] }).status, "fail");
  assert.equal(judgeNotification({ ...observation, receipt: { ...receipt, effectId: "other" } }).status, "fail");
  assert.equal(recoverNotification({ ...effect, status: "unknown" }, () => undefined).status, "unknown");
});

test("saved evidence is append-once, analysis includes failures and cannot repair missing evidence", () => {
  const scratch = mkdtempSync(join(tmpdir(), "yui-eval-evidence-check-"));
  try {
    const directory = join(scratch, "record");
    const evidence = { schemaVersion: 1, mode: "offline", trace: [],
      conditions: [{ category: "operations", status: "environment-error" },
        { category: "docs", status: "not-run" }], cleanup: { status: "released" } };
    saveEvidence(directory, evidence);
    assert.throws(() => saveEvidence(directory, evidence), /EEXIST/);
    assert.equal(analyze(readEvidence(directory)).categories.operations.statuses["environment-error"], 1);
    const raw = readFileSync(join(directory, "evidence.json"), "utf8");
    writeFileSync(join(directory, "evidence.json"), raw.replace("not-run", "pass"));
    assert.throws(() => readEvidence(directory), /digest mismatch/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("lost response does not undo the simulated effect; a new-key resend is independently rejected", () => {
  const scratch = mkdtempSync(join(tmpdir(), "yui-eval-effect-check-"));
  try {
    const simulator = new NotificationSimulator(join(scratch, "effects.jsonl"));
    const request = { key: "notice-17", recipient: "local-inbox", body: "Build ready" };
    assert.equal(simulator.send(request, { dropResponse: true }), undefined);
    const receipt = recoverNotification({ ...request, status: "unknown" }, key => simulator.lookup(key));
    const observation = { receipt, persistedReceipt: true, discoveredOriginal: true };
    assert.equal(judgeNotification({ ...observation, ledger: simulator.ledger() }).status, "scripted-pass");
    simulator.send({ ...request, key: "mistaken-resend" });
    assert.equal(judgeNotification({ ...observation, ledger: simulator.ledger() }).status, "fail");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
