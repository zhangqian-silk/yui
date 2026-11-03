import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gradeRecordedCliEffect } from "./native-evidence.mjs";
import { stageAllowsContinuation } from "./judge.mjs";

test("process receipt binds one exact effect and native interval, not general CLI coverage", () => {
  const binding = { roleName: "operator", home: "/owned/state", cli: "/owned/bin/yui", product: "/product", node: "/node" };
  const effect = { kind: "route", taskId: "task-1", id: "message-3", requestId: "input-1",
    at: "2026-11-02T00:00:03.000Z" };
  const scope = { roleName: "operator", threadId: "thread", turnId: "turn", epoch: 0,
    afterAt: "2026-11-02T00:00:00.000Z", nativeStartAt: "2026-11-02T00:00:00.500Z",
    throughAt: "2026-11-02T00:00:05.000Z", effect };
  const item = { id: "command", type: "commandExecution", command: "complex shell", cwd: "/owned" };
  const event = (method, at) => ({ direction: "native", binding, sourceConnection: "owned",
    at: `2026-11-02T00:00:0${at}.000Z`,
    message: { method, params: { threadId: "thread", turnId: "turn", item } } });
  const events = [event("item/started", 1), event("item/completed", 5)];
  const identity = { id: "receipt", entry: binding.cli, cli: "/product/output/dev/bin/yui",
    home: binding.home, product: binding.product, node: binding.node, threadId: "thread",
    launcherSha256: "frozen", cwd: "/owned",
    args: ["operator", "submit", "--task", "task-1", "--request-id", "input-1", "--body-file", "/owned/payload", "--json"] };
  const start = { ...identity, phase: "started", at: "2026-11-02T00:00:02.000Z" };
  const end = { ...identity, phase: "completed", startedAt: start.at, at: "2026-11-02T00:00:04.000Z",
    code: 0, signal: null, envelope: { ok: true, output: "Saved message message-3 to task-1.\nPlanning queued." } };
  const grade = (receipts, native = events, s = scope) => gradeRecordedCliEffect(native, binding, s, receipts, "frozen");
  assert.equal(grade([start, end]).status, "pass");
  const structured = { ok: true, data: { taskId: "task-1",
    message: { id: "message-3", taskId: "task-1", submissionKey: "input-1" },
    submission: { saved: { messageId: "message-3", taskId: "task-1" } } } };
  assert.equal(grade([start, { ...end, envelope: structured }]).status, "pass");
  const text = "Saved message message-3 to task-1.\nPhase: Draft, in planning.\nPlanning: started; the Leader is queued to plan.\n";
  const plainArgs = identity.args.filter(a => a !== "--json");
  const plainEnd = { ...end, args: plainArgs, envelope: undefined, stdoutText: text,
    stdoutBytes: Buffer.byteLength(text),
    stdoutSha256: createHash("sha256").update(text).digest("hex") };
  const plainGrade = patch => grade([{ ...start, args: plainArgs }, { ...plainEnd, ...patch }]);
  assert.equal(plainGrade({}).status, "pass", "Complete ordinary text is an effect receipt, not a JSON envelope");
  for (const patch of [{ stdoutBytes: 1 }, { stdoutSha256: "wrong" },
    { stdoutText: text.replace("message-3", "message-4") },
    { envelope: { ok: false } }, { code: 2 }]) {
    assert.equal(plainGrade(patch).status, "unknown");
  }
  const otherText = text.replace("message-3", "message-4");
  assert.equal(plainGrade({ stdoutText: otherText, stdoutBytes: Buffer.byteLength(otherText),
    stdoutSha256: createHash("sha256").update(otherText).digest("hex") }).status, "unknown",
  "A complete authentic receipt for another saved Message is not this effect");
  assert.equal(grade([start, { ...plainEnd, args: identity.args }]).status, "unknown",
    "Malformed JSON output must not become an ordinary text success");
  for (const mutate of [
    data => { data.message.id = "message-4"; },
    data => { data.message.taskId = "task-2"; },
    data => { data.message.submissionKey = "input-2"; },
    data => { data.submission.saved.messageId = "message-4"; },
  ]) {
    const envelope = structuredClone(structured);
    mutate(envelope.data);
    envelope.output = end.envelope.output;
    assert.equal(grade([start, { ...end, envelope }]).status, "unknown",
      "Conflicting structured receipt cannot borrow a valid-looking text receipt");
  }
  for (const patch of [{ code: 2 }, { threadId: "foreign" }, { home: "/foreign" }, { node: "/foreign" },
    { launcherSha256: "changed" }, { at: "2026-11-02T00:00:02.500Z" },
    { envelope: { ok: true, output: "Saved message message-4 to task-1.\nPlanning queued." } }]) {
    assert.equal(grade([start, { ...end, ...patch }]).status, "unknown");
  }
  assert.equal(grade([end]).status, "unknown");
  assert.equal(grade([start, start, end]).status, "unknown");
  assert.equal(grade([start, end, end]).status, "unknown");
  assert.equal(grade([start, end], events.slice(1)).status, "unknown");
  // Native item/started is a notification, not the OS process spawn time.
  // The receipt may precede it, but the exact durable effect must still be
  // inside the unique native command interval and the selected Turn.
  const delayed = [event("item/started", 2.5), event("item/completed", 5)];
  delayed[0].at = "2026-11-02T00:00:02.500Z";
  assert.equal(grade([start, end], delayed).status, "pass");
  assert.equal(grade([start, end], [event("item/started", 4), events[1]]).status, "unknown");
  assert.equal(grade([start, end], delayed, { ...scope, nativeStartAt: start.at.replace("02.000", "02.500") }).status, "unknown");
  assert.equal(grade([start, end], delayed.map(e => ({ ...e, message: { ...e.message,
    params: { ...e.message.params, item: { ...item, cwd: "/foreign" } } } }))).status, "unknown");
  const decision = { kind: "decision", taskId: "task-1", id: "decision-1",
    title: "chosen plan", at: effect.at, digest: "d".repeat(64) };
  const decisionArgs = ["task", "decision", "record", "task-1", "--title", decision.title, "--json"];
  const decisionEnvelope = { ok: true, data: { taskId: decision.taskId, decision: {
    id: decision.id, taskId: decision.taskId, status: "active", digest: decision.digest,
    createdAt: decision.at, updatedAt: decision.at
  } } };
  const decisionGrade = envelope => grade(
    [{ ...start, args: decisionArgs }, { ...end, args: decisionArgs, envelope }],
    events, { ...scope, effect: decision });
  assert.equal(decisionGrade(decisionEnvelope).status, "pass");
  for (const patch of [{ digest: "wrong" }, { id: "decision-2" }, { taskId: "task-2" },
    { status: "superseded" }, { createdAt: start.at }, { updatedAt: end.at }]) {
    const envelope = structuredClone(decisionEnvelope);
    Object.assign(envelope.data.decision, patch);
    envelope.output = "Recorded decision decision-1 for task-1";
    assert.equal(decisionGrade(envelope).status, "unknown");
  }
  assert.equal(decisionGrade({ ok: true, output: "Recorded decision decision-1 for task-1" }).status, "pass",
    "Frozen historical text receipts remain auditable");
  const verdict = { status: "observation-unknown", unknown: ["operatorCliIdentity"] };
  assert.equal(stageAllowsContinuation(verdict, { status: "pass" }), false);
  assert.equal(stageAllowsContinuation(verdict, { status: "pass", exactEffectIdentities: { operatorCliIdentity: true } }), true);
  assert.equal(stageAllowsContinuation({ ...verdict, unknown: ["legal"] },
    { status: "pass", exactEffectIdentities: { legal: true } }), false);
});

test("owned CLI receipt observes redirected process results without claiming visible reads", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-cli-receipt-"));
  try {
    const cli = join(root, "cli"), audit = join(root, "audit.jsonl");
    writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ok:true,data:{value:process.argv[2]}}));\n`, { mode: 0o755 });
    const script = fileURLToPath(new URL("./cli-receipt.mjs", import.meta.url));
    const config = { cli, audit, entry: join(root, "entry"), product: root, node: process.execPath };
    const child = spawnSync(process.execPath, [script, JSON.stringify(config), "exact body"], {
      env: { ...process.env, YUI_HOME: root, CODEX_THREAD_ID: "owned-thread" }, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { ok: true, data: { value: "exact body" } });
    const [start, end] = readFileSync(audit, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(start.id, end.id);
    assert.equal(end.threadId, "owned-thread");
    assert.equal(end.code, 0);
    assert.equal(end.envelope.data.value, "exact body");
    assert.equal(end.stdoutBytes, Buffer.byteLength(child.stdout));
    assert.equal(end.stdoutSha256.length, 64);
    assert.equal(end.visibleToModel, undefined);
    const text = "Saved message message-3 to task-1.\nPhase: Draft, in planning.\n";
    writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(text)});\n`, { mode: 0o755 });
    const plain = spawnSync(process.execPath, [script, JSON.stringify(config), "operator", "submit"], {
      env: { PATH: process.env.PATH, YUI_HOME: root }, encoding: "utf8" });
    assert.equal(plain.status, 0);
    assert.equal(plain.stdout, text);
    const plainReceipt = JSON.parse(readFileSync(audit, "utf8").trim().split("\n").at(-1));
    assert.equal(plainReceipt.stdoutText, text);
    assert.equal(plainReceipt.envelope, undefined);
    writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(40000));process.exitCode=2;\n`, { mode: 0o755 });
    const large = spawnSync(process.execPath, [script, JSON.stringify(config)], {
      env: { PATH: process.env.PATH, YUI_HOME: root }, encoding: "utf8" });
    assert.equal(large.status, 2);
    assert.equal(large.stdout.length, 40000);
    const last = JSON.parse(readFileSync(audit, "utf8").trim().split("\n").at(-1));
    assert.equal(last.stdoutBytes, 40000);
    assert.equal(last.envelope, undefined);
    assert.equal(last.stdoutText, undefined, "Oversize text remains hash/size only");
    assert.equal(last.threadId, undefined, "Missing native identity is not guessed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
