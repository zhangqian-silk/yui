import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { analyze, readEvidence, saveEvidence, digest } from "./evidence.mjs";
import { judgeNotification } from "./oracle.mjs";
import { recoverNotification } from "./participant.mjs";
import { NotificationSimulator } from "./notification-simulator.mjs";
import { Fixture } from "./fixture.mjs";
import { readTaskFacts, persistTaskFacts } from "./readback.mjs";

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

test("paged original reads reject a changed source instead of joining two versions", () => {
  let calls = 0;
  const fixture = { call: () => ({
    contentPage: {
      source: "task/message-1", digest: calls ? "new-version" : "original-version",
      encoding: "json", offset: calls ? 8 : 0, text: calls++ ? '"mixed"}' : '{"body":',
      complete: calls === 2, nextCursor: calls === 1 ? "page-two" : null
    }
  }) };
  assert.throws(() => Fixture.prototype.detail.call(fixture, ["task", "message", "show", "task/message-1"]),
    /changed|invalid page/);
});

test("all discovery pages and Unicode original pages retain exact record provenance", () => {
  const message = { taskId: "task-1", id: "message-2", body: "末页✅".repeat(3000) };
  const original = { ref: { store: "task-message", refId: "message-2", digest: digest(JSON.stringify(message)) },
    value: message };
  const text = JSON.stringify(original);
  const split = 4000;
  const chunks = [text.slice(0, split), text.slice(split)];
  const detailPages = chunks.map((chunk, index) => ({ contentPage: {
    source: "context/task-1/message-2", digest: digest(text), encoding: "json",
    offset: index ? split : 0, text: chunk, totalCharacters: text.length,
    complete: index === 1, nextCursor: index ? null : "original-page-2"
  } }));
  const calls = [];
  const fixture = {
    detail: Fixture.prototype.detail,
    call: args => {
      calls.push(args);
      if (args[2] === "list") {
        if (args.includes("discovery-page-2")) return { items: [{ ref: original.ref }], complete: true, nextCursor: null };
        return { items: [], complete: false, nextCursor: "discovery-page-2" };
      }
      assert.ok(args.includes(original.ref.digest));
      return detailPages[args.includes("original-page-2") ? 1 : 0];
    }
  };
  assert.deepEqual(Fixture.prototype.messageRecords.call(fixture, "task-1"), [original]);
  assert.equal(calls.length, 4);
});

test("readback separates business digests from Yui record digests and rejects damaged originals", () => {
  const unsigned = { key: "decision", source: "synthetic", revision: 2, body: { allowed: false } };
  const fact = { ...unsigned, digest: digest(JSON.stringify(unsigned)) };
  const ref = { store: "task-message", refId: "message-9", digest: "enclosing-yui-record-digest" };
  const original = { ref, value: { taskId: "task-1",
    body: JSON.stringify({ kind: "collaboration-eval-fact", value: fact }) } };
  let writes = 0;
  const fixture = { call: () => { writes++; }, messageRecords: () => [original] };
  persistTaskFacts(fixture, "task-1", [fact]);
  assert.equal(writes, 1);
  assert.deepEqual(readTaskFacts(fixture, "task-1"), {
    origin: "yui-cli", records: [{ ref, digest: fact.digest, sourceDigest: ref.digest, value: fact }]
  });
  assert.equal(writes, 1, "reading must never write or re-seed a missing fact");
  assert.throws(() => persistTaskFacts(fixture, "task-1", [fact, fact]), /Duplicate/);
  assert.equal(writes, 1, "invalid material must fail before partial writes");
  original.value.body = original.value.body.replace('"allowed":false', '"allowed":true');
  assert.throws(() => readTaskFacts(fixture, "task-1"), /digest mismatch/);
});
