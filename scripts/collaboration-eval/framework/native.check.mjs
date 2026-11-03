import assert from "node:assert/strict";
import test from "node:test";
import { gradeLoads, gradeReads, gradeRecoveryInspection, stageVerdict, subjectFailure, protocolApplicable, gradeDecisionChanges, gradeSkillBinding } from "./judge.mjs";
import * as native from "./native-evidence.mjs";
import { hash, groupStopFor } from "./common.mjs";
import { nativeEvidence, epochAt, selectTerminal, cliArguments, nativeCommandFailures, completeJsonLines, words } from "./native-evidence.mjs";
import { attributeNativeEvents, nativeDiagnostic, nativeControlObservation, rejectedNativeCleanup, recordedStopControls } from "./native-ownership.mjs";
import { tokenTotals } from "./judge.mjs";
test("broadcast notifications cannot borrow a connection Role, response id or owned Thread", () => {
  const binding = { roleName: "leader", taskId: "task-1", home: "/fixture/state" };
  const entry = (direction, message, second, extra = {}) => ({ direction, message, binding,
    at: `2026-10-24T00:00:0${second}Z`, sourceConnection: "one", ...extra });
  const records = [
    entry("host", { id: "s", method: "thread/start", params: { cwd: "/fixture/state/runtime/task-runtimes/planning/task-1" } }, 0),
    entry("native", { id: "s", result: { thread: { id: "owned" } } }, 1),
    entry("host", { id: "t", method: "turn/start", params: { threadId: "owned" } }, 2),
    entry("native", { id: "t", result: { turn: { id: "turn" } } }, 3),
    entry("native", { method: "thread/tokenUsage/updated", params: { threadId: "owned", turnId: "turn",
      tokenUsage: { total: { totalTokens: 10 } } } }, 4),
    entry("native", { method: "thread/tokenUsage/updated", params: { threadId: "foreign", turnId: "foreign-turn",
      tokenUsage: { total: { totalTokens: 999 } } } }, 4),
    entry("native", { method: "turn/completed", params: { threadId: "owned", turn: { id: "unsolicited", status: "completed" } } }, 4),
    entry("native", { id: "s", result: { thread: { id: "spoof" } } }, 5),
  ];
  assert.equal(tokenTotals(records).totalTokens, 1009);
  const bound = attributeNativeEvents(records);
  assert.equal(tokenTotals(bound.events).totalTokens, 10);
  assert.equal(bound.proofs[0].threadId, "owned");
  const rejection = entry("isolation-rejected", undefined, 6, {
    startup: { requestId: "s", method: "thread/start", threadId: "owned" }, error: "weak receipt" });
  assert.equal(rejectedNativeCleanup([...records, rejection]).unresolved[0].status, "created-unsettled");
  const foreign = { ...rejection, sourceConnection: "other" };
  assert.equal(rejectedNativeCleanup([...records, foreign]).unresolved[0].status, "unknown");
  assert.equal(rejectedNativeCleanup([...records, foreign]).automaticArchive, false);
  assert.equal(bound.rejected.length, 3);
  assert.equal(attributeNativeEvents(records.map(e => ({ ...e, sourceConnection: undefined }))).events.length, 0);
  assert.equal(tokenTotals(attributeNativeEvents(records.map(e => ({ ...e, binding: undefined }))).events).status, "unknown");
  const wrongCwd = records.map(e => e.direction === "host" && e.message.method === "thread/start"
    ? { ...e, message: { ...e.message, params: { cwd: "/foreign" } } } : e);
  assert.equal(tokenTotals(attributeNativeEvents(wrongCwd).events).status, "unknown");
  const wrongConnection = records.map(e => e.direction === "native" && e.message.id === "t"
    ? { ...e, sourceConnection: "other" } : e);
  assert.equal(tokenTotals(attributeNativeEvents(wrongConnection).events).status, "unknown");
  const invalidResume = records.map(e => e.direction === "host" && e.message.method === "thread/start"
    ? { ...e, message: { ...e.message, method: "thread/resume",
      params: { ...e.message.params, threadId: "different" } } } : e);
  assert.equal(tokenTotals(attributeNativeEvents(invalidResume).events).status, "unknown");
  const validResume = records.map(e => e.direction === "host" && e.message.method === "thread/start"
    ? { ...e, message: { ...e.message, method: "thread/resume",
      params: { ...e.message.params, threadId: "owned" } } } : e);
  assert.equal(tokenTotals(attributeNativeEvents(validResume).events).totalTokens, 10);
  const resumedRejection = { ...rejection, startup: { ...rejection.startup, method: "thread/resume" } };
  const resumedCleanup = rejectedNativeCleanup([...validResume, resumedRejection]);
  assert.equal(resumedCleanup.status, "unknown");
  assert.equal(resumedCleanup.unresolved[0].status, "unknown", "Resume never proves a newly created Thread");
  assert.equal(resumedCleanup.automaticArchive, false, "Cannot archive an arbitrary old resumed Thread");
  assert.equal(rejectedNativeCleanup([{ sourceConnection: "one", invalidFrame: { reason: "pending tail" } }]).status, "unknown");
  assert.equal(rejectedNativeCleanup(records).status, "no-rejected-startup");
  for (const change of [
    e => e.message.id === "s" && e.direction === "native" ? { ...e, message: { ...e.message, id: "wrong-id" } } : e,
    e => e.message.id === "s" && e.direction === "native" ? { ...e, message: { id: "s", error: { code: -1 } } } : e,
    e => e.message.id === "s" && e.direction === "native" ? { ...e, at: "2026-10-23T23:59:59Z" } : e,
    e => e.message.params?.tokenUsage ? { ...e, sourceConnection: "reconnected-without-handshake" } : e,
  ]) assert.equal(tokenTotals(attributeNativeEvents(records.map(change)).events).status, "unknown");
  const duplicate = { ...records[5], sourceConnection: "other", message: {
    method: "item/completed", params: { threadId: "owned", turnId: "turn", item: { id: "same-item", type: "commandExecution" } } } };
  assert.equal(attributeNativeEvents([...records, duplicate]).events.includes(duplicate), false);
  const premature = { ...records[4], at: "2026-10-23T23:59:59Z" };
  assert.equal(attributeNativeEvents([...records.slice(0, 4), premature]).events.includes(premature), false);
  const duplicateRequest = { ...records[0], at: "2026-10-24T00:00:00.500Z" };
  assert.equal(tokenTotals(attributeNativeEvents([...records, duplicateRequest]).events).status, "unknown");
});
const scope = { taskId: "task-1", roleName: "leader", threadId: "ld", turnId: "turn-2",
  epoch: 0, beforeAt: "2026-10-24T00:00:05Z" };
test("fresh recovery Thread cannot borrow predecessor originals, Skills or terminal", () => {
  const file = { path: "/product/SKILL.md", body: "FULL", bytes: 4, sha256: hash("FULL") };
  const original = { taskId: "task-1", id: "message-1", body: "exact original" };
  const old = { scope: { ...scope, threadId: "predecessor" }, complete: true,
    loads: [{ ...file, complete: true, at: "2026-10-24T00:00:01Z" }],
    trace: [{ at: "2026-10-24T00:00:01Z", code: 0,
      stdout: JSON.stringify({ ok: true, data: original }) }] };
  assert.equal(gradeLoads([old], [file], old.scope).status, "pass");
  assert.equal(gradeReads([old], [original], old.scope).status, "pass");
  assert.notEqual(gradeLoads([old], [file], scope).status, "pass");
  assert.notEqual(gradeReads([old], [original], scope, { reuse: true }).status, "pass");
  const oldTerminal = [
    { direction: "native", at: "2026-10-24T00:00:01Z", binding: { taskId: "task-1", roleName: "leader" },
      message: { method: "turn/started", params: { threadId: "predecessor", turn: { id: "old-turn" } } } },
    { direction: "native", at: "2026-10-24T00:00:02Z", binding: { taskId: "task-1", roleName: "leader" },
      message: { method: "turn/completed", params: { threadId: "predecessor", turn: { id: "old-turn", status: "completed" } } } },
  ];
  assert.equal(selectTerminal(oldTerminal, { since: "2026-10-24T00:00:00Z",
    taskId: "task-1", roleName: "leader", threadId: "ld" }), null);
  // Reconnection alone does not re-establish ownership of either Thread.
  assert.equal(attributeNativeEvents(oldTerminal.map(e => ({ ...e,
    binding: { ...e.binding, home: "/fixture/state" }, sourceConnection: "new-without-handshake" }))).events.length, 0);
});
test("OP body cannot satisfy LD load in another model context", () => {
  const file = { path: "/product/skills/yui-runtime/SKILL.md", kind: "core", body: "FULL",
    bytes: 4, sha256: hash("FULL") };
  const traces = [{ scope: { ...scope, roleName: "operator", threadId: "op" },
    loads: [{ ...file, at: "2026-10-24T00:00:01Z", complete: true }], trace: [], complete: true }];
  assert.notEqual(gradeLoads(traces, [file], scope).status, "pass");
});
const binding = { taskId: "task-1", roleName: "leader", home: "/fixture", product: "/product", cli: "/fixture/bin/yui", node: "/usr/bin/node" };
const event = (method, params, second = 1, b = binding) => ({
  at: `2026-10-24T00:00:0${second}.000Z`, direction: "native", binding: b, message: { method, params },
});
const item = (command, output, actions, second = 1) => event("item/completed", {
  threadId: "ld", turnId: "turn-2", item: { id: `tool-${second}`, type: "commandExecution",
    status: "completed", exitCode: 0, command, commandActions: actions, aggregatedOutput: output } }, second);
test("static file bytes preceding a uniquely consumed failure retain output credit, never an atom exit claim", () => {
  const file = { path: "/product/entry.md", body: "one\ntwo\n", bytes: 8, sha256: hash("one\ntwo\n"), kind: "core" };
  const make = (command, output, code = 2) => {
    const e = item(command, output, []); e.message.params.item.cwd = "/fixture";
    e.message.params.item.exitCode = code; return e;
  };
  const command = "cat /product/entry.md && sed -n '1,9p' /missing.md";
  const diagnostic = "sed: can't read /missing.md: No such file or directory\n";
  const failed = make(command, file.body + diagnostic);
  failed.message.params.item.status = "failed"; // Actual native nonzero terminal shape.
  const evidence = nativeEvidence([failed], [file]);
  assert.equal(evidence[0].loads.length, 1);
  assert.equal(evidence[0].loads[0].body, file.body);
  assert.equal(evidence[0].loads[0].compound.parentExitCode, 2);
  assert.equal(evidence[0].loads[0].compound.atomExitStatus, "not-observed");
  assert.equal(evidence[0].complete, false, "A known failed suffix does not certify a complete successful inventory");
  const failure = JSON.stringify({ ok: false, code: "USAGE_ERROR", message: "Invalid option",
    details: { diagnostic: { home: binding.home, cli: "/product/dist/cli.js", operation: "yui task run context" } } }) + "\n";
  const cli = make("cat /product/entry.md && /fixture/bin/yui task run context task-1/run-1 --store bad --json", file.body + failure);
  cli.message.params.item.status = "failed";
  assert.equal(nativeEvidence([cli], [file])[0].loads.length, 1);
  for (const bad of [
    make(command, "noise" + file.body + diagnostic),
    make(command, file.body.slice(0, -1) + diagnostic),
    make(command, file.body + diagnostic + "extra"),
    make(command.replace("/product/entry.md", "/unfrozen.md"), file.body + diagnostic),
    make("echo 'one\ntwo\n' && sed -n '1,9p' /missing.md", file.body + diagnostic),
    make("cat /product/entry.md && echo error", file.body + diagnostic),
    make("cat /product/entry.md && cat /product/entry.md", file.body + file.body),
    make(command, file.body + diagnostic, 0),
    { ...failed, binding: { ...binding, taskId: "foreign" } },
  ]) {
    const b = nativeEvidence([bad], [file]);
    if (bad.binding.taskId === "foreign") assert.notEqual(gradeLoads(b, [file], scope).status, "pass");
    else assert.equal(b[0].loads.length, 0);
  }
  assert.equal(nativeEvidence([failed], [{ ...file, sha256: "wrong" }])[0].loads.length, 0);
  const wrongCwd = make("cat entry.md && sed -n '1,9p' /missing.md", file.body + diagnostic);
  wrongCwd.message.params.item.cwd = "/different";
  assert.equal(nativeEvidence([wrongCwd], [file])[0].loads.length, 0);
});
test("semicolon file and CLI pages require complete positional output and verifiable plain-page metadata", () => {
  const file = { path: "/product/entry.md", body: "fixed\n", sha256: hash("fixed\n"), kind: "core" };
  const text = JSON.stringify({ taskId: "task-1", id: "message-1", body: "original" });
  const page = { source: "task:task-1/message/message-1", digest: hash(text), encoding: "json",
    offset: 0, totalCharacters: text.length, text, complete: true, nextCursor: null };
  const make = (p, command = "cat /product/entry.md; /fixture/bin/yui task message show task-1/message-1") => {
    const e = item(command, file.body + JSON.stringify({ contentPage: p }) + "\n", []);
    e.message.params.item.cwd = "/fixture"; return e;
  };
  const good = nativeEvidence([make(page)], [file]);
  assert.equal(good[0].loads.length, 1);
  assert.equal(gradeReads(good, [{ taskId: "task-1", id: "message-1", body: "original" }], scope).status, "pass");
  for (const p of [{ ...page, source: "task:foreign/message/message-1" }, { ...page, offset: 1 },
    { ...page, totalCharacters: page.totalCharacters + 1 }, { ...page, digest: "wrong" },
    { ...page, digest: hash("not the returned document") }, { ...page, totalBytes: 1 },
    { ...page, nextCursor: "unexpected" }, { ...page, complete: false, nextCursor: null }]) {
    const bad = nativeEvidence([make(p)], [file]);
    assert.equal(bad[0].loads.length, 0, "A malformed compound page cannot lend positional output credit");
    assert.notEqual(gradeReads(bad, [{ taskId: "task-1", id: "message-1", body: "original" }], scope).status, "pass");
  }
});
test("reporting loads use the exact report/action start, never the Decision or terminal deadline", () => {
  const core = { path: "/product/SKILL.md", body: "CORE", bytes: 4, sha256: hash("CORE") };
  const reporting = { path: "/product/yui-runtime/references/reporting.md", body: "REPORT", bytes: 6, sha256: hash("REPORT") };
  const terminal = { ...scope, binding, startedAt: "2026-10-24T00:00:00Z",
    at: "2026-10-24T00:00:09Z", turn: { items: [{ type: "agentMessage", id: "final", text: "managed result" }] } };
  const report = event("item/started", { threadId: "ld", turnId: "turn-2",
    item: { type: "agentMessage", id: "final", text: "" } }, 7);
  const action = native.reportingAction([report], terminal);
  assert.equal(action.status, "observed");
  assert.equal(action.at, report.at);
  const load = (f, sec) => ({ ...f, at: `2026-10-24T00:00:0${sec}Z`, complete: true });
  const traces = [{ scope, trace: [], complete: true, loads: [load(core, 1), load(reporting, 6)] }];
  const actions = { business: { status: "observed", at: scope.beforeAt }, reporting: action };
  const grade = (ts = traces, ac = actions, sc = scope) =>
    gradeLoads(ts, [core, reporting], { ...sc, loadActions: ac });
  assert.equal(grade().status, "pass", "Decision at 5, reporting read at 6, report begins at 7");
  assert.equal(grade([{ ...traces[0], loads: [load(core, 6), load(reporting, 6)] }]).status, "fail",
    "Business-critical reads retain their earlier deadline");
  assert.equal(grade([{ ...traces[0], loads: [load(core, 1), load(reporting, 8)] }]).status, "fail");
  assert.equal(grade([{ ...traces[0], loads: [load(core, 1), load(reporting, 7)] }]).status, "unknown",
    "Identical timestamps do not establish cross-stream order");
  for (const bad of [
    [], [{ ...report, binding: { ...binding, taskId: "foreign" } }],
    [{ ...report, message: { ...report.message, params: { ...report.message.params, threadId: "other" } } }],
    [{ ...report, message: { ...report.message, params: { ...report.message.params, turnId: "other" } } }],
    [report, { ...report, at: "2026-10-24T00:00:08Z" }],
  ]) {
    const uncertain = native.reportingAction(bad, terminal);
    assert.equal(uncertain.status, "unknown");
    assert.equal(grade(traces, { ...actions, reporting: uncertain }).status, "unknown");
  }
  const compact = event("item/completed", { threadId: "ld", turnId: "turn-2",
    item: { type: "contextCompaction", id: "compact" } }, 6);
  assert.equal(grade(traces, { ...actions, reporting: native.reportingAction([compact, report], terminal) }).status, "unknown");
  assert.notEqual(grade([{ ...traces[0], scope: { ...scope, threadId: "other" } }]).status, "pass");
  const send = item("yui task message send task-1 hello --to leader --json",
    JSON.stringify({ ok: true, data: { message: { id: "message-9" } } }), [], 4);
  const start = event("item/started", { threadId: "ld", turnId: "turn-2",
    item: { ...send.message.params.item, aggregatedOutput: undefined } }, 3);
  const early = native.reportingAction([start, send, report], terminal);
  assert.equal(early.at, start.at, "Earlier durable Message takes precedence over final report");
  assert.equal(grade(traces, { ...actions, reporting: early }).status, "fail");
  assert.equal(native.reportingAction([send, report], terminal).status, "unknown",
    "Missing durable-action start cannot be repaired by the later report or terminal");
});
test("literal compound reads prove only exact frozen output, including relative identity jq and trailing separators", () => {
  const file = (path, body) => ({ path, body, sha256: hash(body), kind: "core" });
  const files = [file("/product/SKILL.md", "one\ntwo\nthree\n"),
    file("/state/runtime/role-profiles/p.json", '{\n  "role": "operator"\n}\n')];
  const b = { ...binding, taskId: undefined, roleName: "operator", home: "/state" };
  const command = `/bin/zsh -c "sed -n '1,2p' /product/SKILL.md; sed -n '3,9p' /product/SKILL.md; jq . state/runtime/role-profiles/p.json;"`;
  const output = files.map(f => f.body).join("");
  const tool = item(command, output, [{ type: "unknown", command }]);
  tool.binding = b;
  tool.message.params.item.cwd = "/";
  const evidence = nativeEvidence([tool], files);
  assert.equal(evidence[0].loads.length, 3);
  assert.equal(evidence[0].loads.map(l => l.body).join(""), output);
  const trailing = item("/bin/zsh -c \"sed -n '1,9p' /product/SKILL.md;\"", files[0].body,
    [{ type: "read", path: files[0].path, command: "sed -n '1,9p' '/product/SKILL.md;'" }]);
  assert.equal(nativeEvidence([trailing], files)[0].loads.length, 1);
  for (const [cmd, out] of [
    [command, output.slice(0, -1)], [command, output + "extra"], [command, files[1].body + files[0].body],
    [command.replace("jq .", "jq '{role}'"), output],
    [command.replace("/product/SKILL.md", "/wrong/SKILL.md"), output],
    [command.replace("; jq", " | jq"), output], [command.replace("; jq", "; echo hidden; jq"), output],
  ]) {
    const invalid = item(cmd, out, []); invalid.binding = b;
    assert.equal(nativeEvidence([invalid], files)[0].loads.length, 0);
  }
  const failed = structuredClone(tool); failed.message.params.item.exitCode = 1;
  assert.equal(nativeEvidence([failed], files)[0].loads.length, 0);
});
test("relative read identity uses each native command cwd, never the Role default or matching content", () => {
  const body = '{\n  "role": "operator"\n}\n';
  const files = ["/fixture/state/runtime/p.json", "/changed/state/runtime/p.json"].map(path =>
    ({ path, body, sha256: hash(body), bytes: Buffer.byteLength(body), kind: "profile" }));
  const b = { ...binding, taskId: undefined, roleName: "operator", home: "/fixture/state" };
  const read = (cwd, path = "state/runtime/p.json") => {
    const e = item(`jq . ${path}`, body, []);
    e.binding = b; e.message.params.item.cwd = cwd;
    return nativeEvidence([e], files)[0].loads;
  };
  assert.equal(read("/fixture")[0]?.path, files[0].path);
  assert.equal(read("/changed")[0]?.path, files[1].path, "Identical bytes do not prove the default path identity");
  for (const cwd of [undefined, null, "", "relative", "/unobserved"])
    assert.equal(read(cwd).length, 0, "Absent/invalid/other cwd cannot borrow the default Role directory");
  for (const cwd of [undefined, "/changed"])
    assert.equal(read(cwd, files[0].path)[0]?.path, files[0].path, "Absolute exact paths need no cwd inference");
});
test("short owned CLI paths require their actual command cwd even when JSON output is identical", () => {
  const original = { taskId: "task-1", id: "message-1", body: "same complete original" };
  const command = "bin/yui task message show task-1/message-1 --json";
  const read = (cwd, cmd = command) => {
    const e = item(cmd, JSON.stringify({ ok: true, data: original }), []);
    e.message.params.item.cwd = cwd;
    return gradeReads(nativeEvidence([e]), [original], scope).status;
  };
  assert.equal(read("/fixture"), "pass");
  for (const cwd of ["/changed", undefined, null, "relative"]) assert.notEqual(read(cwd), "pass");
  assert.equal(read("/changed", "../fixture/" + command), "pass");
  assert.equal(read(undefined, "/fixture/" + command), "pass");
});
test("focused wake originals need exact own output, complete value and matching digest", () => {
  const original = { taskId: "task-1", id: "message-1", body: "完整 ordinary original" };
  const detail = { id: original.id, contentOmitted: false,
    ref: { store: "task-message", refId: original.id, digest: hash(JSON.stringify(original)) },
    value: original };
  const data = { taskId: "task-1", wake: { id: "wake-1", taskId: "task-1" },
    view: "focus", messages: [detail] };
  const read = (d = data, command = "/fixture/bin/yui task wake show task-1 wake-1 --json") =>
    gradeReads(nativeEvidence([item(command, JSON.stringify({ ok: true, data: d }), [])]),
      [original], scope).status;
  assert.equal(read(), "pass");
  for (const change of [
    { contentOmitted: true }, { value: undefined },
    { value: { ...original, body: "summary" } },
    { ref: { ...detail.ref, digest: "0".repeat(64) } },
    { ref: { ...detail.ref, refId: "message-2" } }
  ]) assert.notEqual(read({ ...data, messages: [{ ...detail, ...change }] }), "pass");
  assert.notEqual(read({ ...data, view: "history" }), "pass");
  assert.notEqual(read(data, "/foreign/yui task wake show task-1 wake-1 --json"), "pass");
  assert.notEqual(read(data, "/fixture/bin/yui task wake show task-1 wake-2 --json"), "pass");
  const inbox = { ...data.wake, fromCursor: "2026-01-01T00:00:00Z",
    toCursor: "2026-01-01T00:01:00Z",
    originalContext: { taskId: "task-1", view: "focus", messages: [detail] } };
  const inboxCommand = "/fixture/bin/yui inbox show wake-1 --json";
  assert.equal(read(inbox, inboxCommand), "pass", "Own inbox exposes the same complete focused original");
  assert.equal(read(inbox, "/fixture/bin/yui --json inbox show wake-1"), "pass",
    "Global JSON flag position does not hide complete originals");
  assert.equal(read(data, "/fixture/bin/yui --json task wake show task-1 wake-1"), "pass");
  for (const altered of [
    { ...inbox, taskId: "other-task" },
    { ...inbox, id: "wake-2" },
    { ...inbox, originalContext: { ...inbox.originalContext, taskId: "other-task" } },
    { ...inbox, originalContext: { ...inbox.originalContext, messages: [{ ...detail, contentOmitted: true }] } },
    { ...inbox, originalContext: { ...inbox.originalContext, messages: [{ ...detail,
      value: { ...original, body: "summary" } }] } }
  ]) assert.notEqual(read(altered, inboxCommand), "pass");
  const text = JSON.stringify(inbox), source = "inbox:task:task-1:leader/wake-1";
  const cursor = Buffer.from(JSON.stringify({ source, digest: hash(text), offset: 40 })).toString("base64url");
  const page = (offset, end) => ({ source, digest: hash(text), encoding: "json", offset,
    totalCharacters: text.length, totalBytes: Buffer.byteLength(text), text: text.slice(offset, end),
    complete: end === text.length, nextCursor: end === text.length ? null : cursor });
  const first = item(inboxCommand, JSON.stringify({ ok: true, data: { contentPage: page(0, 40) } }), [], 1);
  const last = item(`${inboxCommand} --cursor ${cursor}`,
    JSON.stringify({ ok: true, data: { contentPage: page(40, text.length) } }), [], 2);
  assert.equal(gradeReads(nativeEvidence([first, last]), [original], scope).status, "pass");
  assert.notEqual(gradeReads(nativeEvidence([first]), [original], scope).status, "pass");
  const foreignPage = structuredClone(last);
  foreignPage.message.params.item.aggregatedOutput = JSON.stringify({ ok: true,
    data: { contentPage: { ...page(40, text.length), source: "inbox:task:other:leader/wake-1" } } });
  assert.notEqual(gradeReads(nativeEvidence([first, foreignPage]), [original], scope).status, "pass");
});
test("plain CLI content pages retain actual JSON bytes and require the full same-Turn digest", () => {
  const original = { taskId: "task-1", id: "message-1", body: "完整\noriginal" };
  const text = JSON.stringify({ ref: { store: "task-message", refId: original.id }, value: original });
  const cursor = Buffer.from(JSON.stringify({ source: "task:task-1/task-message/message-1",
    digest: hash(text), offset: 40 })).toString("base64url");
  const page = (offset, end) => ({ source: "task:task-1/task-message/message-1", digest: hash(text),
    encoding: "json", offset, totalCharacters: text.length, totalBytes: Buffer.byteLength(text),
    text: text.slice(offset, end), complete: end === text.length, nextCursor: end === text.length ? null : cursor });
  const first = item("yui task context inspect task-1 --store task-message --ref message-1",
    JSON.stringify({ contentPage: page(0, 40) }), [], 1);
  const last = item(`yui task context inspect task-1 --store task-message --ref message-1 --cursor ${cursor} --json`,
    JSON.stringify({ ok: true, data: { contentPage: page(40, text.length) } }), [], 2);
  const traces = nativeEvidence([first, last]);
  assert.equal(traces[0].trace[0].stdout, first.message.params.item.aggregatedOutput);
  assert.equal(gradeReads(traces, [original], scope).status, "pass");
  for (const events of [[last], [first], [last, { ...first, at: "2026-10-24T00:00:03Z" }],
    [first, first, last]]) {
    // Duplicate tool IDs are ignored, not double-counted as page bytes.
    if (events.length === 3) assert.equal(gradeReads(nativeEvidence(events), [original], scope).status, "pass");
    else assert.notEqual(gradeReads(nativeEvidence(events), [original], scope).status, "pass");
  }
  const wrong = structuredClone(last);
  wrong.message.params.item.aggregatedOutput = JSON.stringify({ contentPage: { ...page(40, text.length), digest: "wrong" } });
  assert.notEqual(gradeReads(nativeEvidence([first, wrong]), [original], scope).status, "pass");
  const projected = structuredClone(last);
  const expansion = structuredClone(first);
  expansion.message.params.item.command = "yui task run context expand task-1/run-1 message-1 --store task-message --mode full --json";
  projected.message.params.item.command = `/bin/zsh -c "yui task run context expand task-1/run-1 message-1 --store task-message --mode full --cursor ${cursor} --json | jq -r '.data.context.contentPage | {offset,totalCharacters,complete,nextCursor,text}'"`;
  const { offset, totalCharacters, complete, nextCursor, text: tail } = page(40, text.length);
  projected.message.params.item.aggregatedOutput = JSON.stringify({ offset, totalCharacters, complete, nextCursor, text: tail });
  assert.equal(gradeReads(nativeEvidence([expansion, projected]), [original], scope).status, "pass");
  const tamperedSidecar = nativeEvidence([expansion, projected]);
  const tailTrace = tamperedSidecar[0].trace[1];
  tailTrace.stdout = JSON.stringify({ offset, totalCharacters, complete, nextCursor, text: tail.slice(1) });
  assert.notEqual(gradeReads(tamperedSidecar, [original], scope).status, "pass",
    "Attribution sidecar cannot supply text missing from the actual stdout");
  for (const change of [
    i => { i.command = i.command.replace(`--cursor ${cursor}`, "--cursor other"); },
    i => { i.command = i.command.replace("message-1", "message-9"); },
    i => { i.aggregatedOutput = JSON.stringify({ offset, totalCharacters, complete, nextCursor }); },
    i => { i.aggregatedOutput = JSON.stringify({ offset, totalCharacters, complete, nextCursor, text: tail.slice(1) }); },
  ]) {
    const invalid = structuredClone(projected); change(invalid.message.params.item);
    assert.notEqual(gradeReads(nativeEvidence([expansion, invalid]), [original], scope).status, "pass");
  }
  const foreign = structuredClone(projected); foreign.message.params.turnId = "other-turn";
  assert.notEqual(gradeReads(nativeEvidence([expansion, foreign]), [original], scope).status, "pass");
  const duplicate = structuredClone(expansion);
  duplicate.message.params.item.id = "different-tool-same-page";
  duplicate.at = "2026-10-24T00:00:01.500Z";
  assert.notEqual(gradeReads(nativeEvidence([expansion, duplicate, projected]), [original], scope).status, "pass");
  assert.notEqual(gradeReads(nativeEvidence([expansion, projected]), [original],
    { ...scope, beforeAt: first.at }).status, "pass");
});
test("pre-response minimized command remains an owned failure with explicit observation gaps", () => {
  const b = { ...binding, home: "/fixture/state" };
  const record = (direction, message, second) => ({ ...event(undefined, undefined, second, b),
    direction, message, sourceConnection: "one" });
  const early = item("yui task decision record task-1 --bad-option",
    '{"ok":false,"code":"USAGE_ERROR"}', []);
  Object.assign(early.message.params.item, { status: "failed", exitCode: 2 });
  const records = [
    record("host", { id: "s", method: "thread/start", params: { cwd: "/fixture/state/runtime/task-runtimes/planning/task-1" } }, 0),
    record("native", { id: "s", result: { thread: { id: "ld" } } }, 1),
    record("host", { id: "t", method: "turn/start", params: { threadId: "ld" } }, 2),
    { ...record("native", nativeDiagnostic(early.message), 3), nativeContent: "unattributed-metadata" },
    record("native", { id: "t", result: { turn: { id: "turn-2" } } }, 4),
    record("native", { method: "turn/started", params: { threadId: "ld", turn: { id: "turn-2" } } }, 4),
    record("native", { method: "turn/completed", params: { threadId: "ld",
      turn: { id: "turn-2", status: "failed", error: { code: "original-failure" } } } }, 5),
  ];
  const owned = attributeNativeEvents(records).events;
  assert(owned.includes(records[3]), "Retrospective ownership must not invent omitted content");
  const target = { ...b, threadId: "ld", turnId: "turn-2", since: records[0].at };
  const failures = nativeCommandFailures(owned, target);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 2);
  assert.equal(failures[0].nativeStatus, "failed");
  assert.deepEqual(failures[0].observation.missing, ["command", "aggregatedOutput"]);
  const result = subjectFailure(failures);
  assert.equal(result.status, "infrastructure-failed", "Missing CLI bytes cannot prove subject USAGE_ERROR");
  assert.equal(result.observation.status, "unknown");
  assert.equal(result.nativeFailures[0].nativeItemId, "tool-1");
  assert.equal(selectTerminal(owned, target).turn.error.code, "original-failure");
  assert.equal(nativeEvidence(owned)[0].complete, false);
  for (const command of [undefined, null, 42, {}, ["yui"]]) {
    assert.equal(words(command), null);
    assert.equal(cliArguments(command, binding), null);
    const missing = item(command, "FULL", []);
    assert.equal(nativeEvidence([missing])[0].complete, false);
    assert.equal(nativeEvidence([missing])[0].trace.length, 0);
    assert.equal(nativeCommandFailures([missing], target).length, 1);
  }
  const noOutput = item("yui task context task-1", undefined, []);
  noOutput.message.params.item.exitCode = 2;
  assert.equal(subjectFailure(nativeCommandFailures([noOutput], target)).observation.status, "unknown");
  const absentExit = item("yui task context task-1", undefined, []);
  delete absentExit.message.params.item.exitCode;
  const unknownExit = subjectFailure(nativeCommandFailures([absentExit], target));
  assert.equal(unknownExit.observation.status, "unknown");
  assert.equal(unknownExit.nativeFailures.length, 0, "Unknown exit is not an observed nonzero exit");
  const actual = structuredClone(early);
  const withRejection = subjectFailure(nativeCommandFailures([...owned, actual], target));
  assert.equal(withRejection.status, "quality-fail", "Known CLI rejection survives another item's gap");
  assert.equal(withRejection.observation.status, "unknown");
  const notCli = structuredClone(actual);
  notCli.message.params.item.command = "printf synthetic";
  assert.equal(subjectFailure(nativeCommandFailures([notCli], target)).status, "infrastructure-failed");
  for (const actions of [{}, [null], [{ command: 42 }]]) {
    const malformed = item("cat /missing", "FULL", actions);
    assert.equal(nativeEvidence([malformed])[0].complete, false);
  }
  // Valid JSON null is not a product rejection and must not throw either.
  assert.equal(subjectFailure([{ code: 2, stdout: "null" }]).status, "infrastructure-failed");
});
test("native completed CLI output and exact cat bytes use the same judges", () => {
  const source = { taskId: "task-1", id: "message-1", body: "FULL" };
  const file = { path: "/product/skills/runtime/SKILL.md", body: "SKILL\n", kind: "core", bytes: 6, sha256: hash("SKILL\n") };
  const events = [item("yui --json task context inspect task-1 --store task-message --ref message-1",
    JSON.stringify({ data: { ref: { store: "task-message", refId: "message-1" }, value: source } }), []),
  item(`cat '${file.path}'`, file.body, [{ type: "read", command: `cat '${file.path}'`, path: file.path }], 2)];
  const traces = nativeEvidence(events, [file]);
  assert.equal(gradeReads(traces, [source], scope).status, "pass");
  assert.equal(gradeLoads(traces, [file], scope).status, "pass");
  for (const bad of [
    { ...events[1], message: { method: "item/completed", params: { ...events[1].message.params,
      item: { ...events[1].message.params.item, aggregatedOutput: "SKI" } } } },
    { ...events[1], message: { method: "item/completed", params: { ...events[1].message.params,
      item: { ...events[1].message.params.item, status: "inProgress" } } } },
  ]) assert.equal(gradeLoads(nativeEvidence([bad], [file]), [file], scope).status, "unknown");
  // No terminal does not turn a complete positive read into full chain success.
  assert.equal(traces[0].complete, false);
});
test("literal terminal projection completes three Unicode pages only in its exact cursor window", () => {
  const original = { taskId: "task-1", id: "message-1", body: "完整🧭\n原文".repeat(40) };
  const text = JSON.stringify({ ref: { store: "task-message", refId: original.id }, value: original });
  const source = "run:task-1/run-1/task-message/message-1", digest = hash(text);
  const cursor = offset => Buffer.from(JSON.stringify({ source, digest, offset })).toString("base64url");
  const cuts = [0, 100, 200, text.length];
  for (const n of cuts) assert(!/[\uD800-\uDBFF]/.test(text[n - 1] ?? ""), "UTF-16 cuts do not split surrogate pairs");
  const base = `${binding.cli} task run context expand task-1/run-1 message-1 --store task-message --mode full`;
  const pages = cuts.slice(0, -1).map((offset, n) => ({
    source, digest, encoding: "json", offset, totalCharacters: text.length, totalBytes: Buffer.byteLength(text),
    text: text.slice(offset, cuts[n + 1]), complete: n === 2, nextCursor: n === 2 ? null : cursor(cuts[n + 1]),
  }));
  const events = pages.map((page, n) => {
    const command = `${base}${n ? ` --cursor ${cursor(page.offset)}` : ""} --json`;
    const output = JSON.stringify({ ok: true, data: { context: { contentPage: page } } });
    const e = item(command, output, [], n + 1); e.message.params.item.cwd = "/fixture"; return e;
  });
  const last = events[2].message.params.item;
  last.command += " | jq -r '.data.context.contentPage | {complete, nextCursor, text}'";
  last.aggregatedOutput = JSON.stringify({ complete: true, nextCursor: null, text: pages[2].text });
  const grade = es => gradeReads(nativeEvidence(es), [original], scope);
  assert.equal(grade(events).status, "pass");
  assert.equal(nativeEvidence(events)[0].trace[2].stdout, last.aggregatedOutput);
  for (const changed of [
    es => es.splice(1, 1),
    es => { es[1].message.params.item.command = es[1].message.params.item.command.replace(cursor(100), cursor(99)); },
    es => { const d = JSON.parse(es[0].message.params.item.aggregatedOutput);
      d.data.context.contentPage.nextCursor = cursor(99);
      es[0].message.params.item.aggregatedOutput = JSON.stringify(d); },
    es => { es[2].message.params.item.command = last.command.replace(cursor(200), cursor(100)); },
    es => { es[2].message.params.item.command = last.command.replace("message-1", "message-9"); },
    es => { es[2].message.params.item.command = last.command.replace(binding.cli, "/foreign/yui"); },
    es => { es[2].message.params.threadId = "foreign"; },
    es => { es[2].message.params.turnId = "foreign"; },
    es => { es[2].binding = { ...binding, roleName: "operator" }; },
    es => { es[2].binding = { ...binding, taskId: "foreign" }; },
    es => { es[2].at = "2026-10-24T00:00:06Z"; },
    es => { const d = JSON.parse(es[1].message.params.item.aggregatedOutput);
      d.data.context.contentPage.source = "run:foreign/run-1/task-message/message-1";
      es[1].message.params.item.aggregatedOutput = JSON.stringify(d); },
    es => { es[2].message.params.item.aggregatedOutput = JSON.stringify({ complete: true, nextCursor: null, text: "summary" }); },
    es => { es[2].message.params.item.aggregatedOutput = JSON.stringify({ complete: true, nextCursor: null }); },
    es => { es[2].message.params.item.aggregatedOutput = JSON.stringify({ complete: false, nextCursor: cursor(250), text: pages[2].text }); },
    es => { es[2].message.params.item.command = `sh -c '$CLI read ${cursor(200)}'`; },
    es => { es[2].message.params.item.exitCode = 1; },
  ]) {
    const es = structuredClone(events); changed(es);
    assert.notEqual(grade(es).status, "pass");
  }
  const compact = event("item/completed", { threadId: "ld", turnId: "turn-2",
    item: { type: "contextCompaction", id: "compacted" } }, 2);
  compact.at = "2026-10-24T00:00:02.500Z";
  assert.notEqual(grade([...events, compact]).status, "pass");
  const bundles = nativeEvidence(events);
  const warm = { ...scope, turnId: "later", beforeAt: "2026-10-24T00:00:09Z" };
  assert.equal(gradeReads(bundles, [original], warm, { reuse: true }).status, "pass");
  assert.notEqual(gradeReads(bundles, [{ ...original, body: "new source" }], warm, { reuse: true }).status, "pass");
  assert.notEqual(gradeReads(bundles, [original], warm).status, "pass", "Current input may not borrow an old Turn");
});
test("native original pages reassemble only in the same request context before decision", () => {
  const source = { taskId: "task-1", id: "message-1", body: "FULL" };
  const text = JSON.stringify({ ref: { store: "task-message", refId: "message-1" }, value: source });
  const pages = [text.slice(0, 30), text.slice(30)];
  const es = pages.map((textPart, i) => item("yui --json task context inspect task-1 --ref message-1", JSON.stringify({
    data: { contentPage: { source: "original:task-1/message-1", digest: hash(text), encoding: "json",
      text: textPart, offset: i ? 30 : 0, totalCharacters: text.length, complete: i === 1 } },
  }), [], i + 1));
  assert.equal(gradeReads(nativeEvidence(es), [source], scope).status, "pass");
  const nested = es.map(e => ({ ...e, message: { ...e.message, params: { ...e.message.params,
    item: { ...e.message.params.item, aggregatedOutput: JSON.stringify({
      data: { context: JSON.parse(e.message.params.item.aggregatedOutput).data },
    }) },
  } } }));
  assert.equal(gradeReads(nativeEvidence(nested), [source], scope).status, "pass");
  assert.equal(gradeReads(nativeEvidence(es.slice(0, 1)), [source], scope).status, "unknown");
  const end = event("turn/completed", { threadId: "ld", turn: { id: "turn-2", status: "completed" } }, 4);
  assert.equal(gradeReads(nativeEvidence([...es.slice(0, 1), end]), [source], scope).status, "unknown");
  assert.equal(gradeReads(nativeEvidence([item("yui task context task-1", '{"data":'), end]), [source], scope).status, "unknown");
  assert.notEqual(gradeReads(nativeEvidence(es), [source], { ...scope, beforeAt: es[0].at }).status, "pass");
});
test("successor, compaction and changed source bytes invalidate old load coverage", () => {
  const f = { path: "/a", kind: "core", body: "FULL", bytes: 4, sha256: hash("FULL") };
  const t = [{ scope, loads: [{ ...f, at: "2026-10-24T00:00:01Z" }], complete: true }];
  for (const boundary of [{ threadId: "successor" }, { epoch: 1 }, { taskId: "task-2" }, { roleName: "operator" }])
    assert.notEqual(gradeLoads(t, [f], { ...scope, ...boundary }).status, "pass");
  assert.notEqual(gradeLoads(t, [{ ...f, body: "NEXT", sha256: hash("NEXT") }], scope).status, "pass");
  const compact = event("item/completed", { threadId: "ld", turnId: "compact", item: { type: "contextCompaction", id: "compact-1" } }, 3);
  assert.equal(epochAt([compact, compact], "ld", scope.beforeAt), 1);
});
test("native terminal needs exact owner, started Turn, request interval and optional Run binding", () => {
  const start = event("turn/started", { threadId: "ld", turn: { id: "turn-2" } }, 1);
  const end = event("turn/completed", { threadId: "ld", turn: { id: "turn-2", status: "completed" } }, 4);
  const target = { since: start.at, ...binding, containsAt: "2026-10-24T00:00:03Z" };
  assert(selectTerminal([start, end], target));
  assert.equal(selectTerminal([end], target), null);
  assert.equal(selectTerminal([start, end], { ...target, roleName: "operator" }), null);
  assert.equal(selectTerminal([start, end], { ...target, turnId: "other" }), null);
  assert.equal(selectTerminal([start, end], { ...target, containsAt: "2026-10-24T00:00:05Z" }), null);
});
test("recovery reads accept product inbox/Decision shapes and complete pages without borrowing context", () => {
  const effect = { taskId: "task-1", id: "decision-1", title: "one", rationale: "EXACT" };
  const claim = { requestId: "retained", at: "2026-10-24T00:00:00Z",
    actor: { scope: "task", taskId: "task-1", roleName: "leader", nativeSessionId: "old" } };
  const wake = { taskId: "task-1", id: "wake-1", refs: [{ type: "message", taskId: "task-1", id: "message-1" }],
    inbox: { claim } };
  const end = event("turn/completed", { threadId: "ld", turn: { id: "turn-2", status: "completed" } }, 4);
  const decision = item("yui task decision show task-1 decision-1 --json", JSON.stringify({ ok: true,
    data: { taskId: "task-1", decision: effect } }), []);
  const inbox = item("yui inbox show wake-1 --json", JSON.stringify({ ok: true, data: wake }), [], 2);
  const grade = events => gradeRecoveryInspection(nativeEvidence([...events, end]), { effect, wake }, scope);
  assert.equal(grade([decision, inbox]).status, "pass");
  assert.equal(grade([decision, item("yui task wake show task-1 wake-1 --json",
    JSON.stringify({ data: { wake } }), [], 2)]).status, "pass");
  // The real CLI may paginate either full document. No prefix or partial claim credit.
  const paged = (command, value, source) => {
    const text = JSON.stringify(value), cut = Math.floor(text.length / 2);
    return [text.slice(0, cut), text.slice(cut)].map((part, i) => item(command, JSON.stringify({
      data: { contentPage: { source, digest: hash(text), encoding: "json", offset: i ? cut : 0,
        text: part, totalCharacters: text.length, complete: i === 1 } },
    }), [], i + 1));
  };
  const dp = paged("yui task decision show task-1 decision-1", { taskId: "task-1", decision: effect }, "decision");
  const wp = paged("yui inbox show wake-1", wake, "wake");
  // Distinct native tool ids are essential when multiple calls share timestamps.
  wp.forEach((e, i) => { e.message.params.item.id = `wake-page-${i}`; });
  assert.equal(grade([...dp, ...wp]).status, "pass");
  for (const events of [[decision], [inbox], [dp[0], ...wp], [...dp, wp[0]]])
    assert.equal(grade(events).status, "unknown", "Missing full evidence is not a subject violation");
  for (const mutate of [
    e => { e.message.params.item.aggregatedOutput = JSON.stringify({ data: { ...wake,
      inbox: { claim: { ...claim, requestId: "wrong-claim" } } } }); },
    e => { e.message.params.item.aggregatedOutput = JSON.stringify({ data: { ...wake, id: "other-wake" } }); },
    e => { e.message.params.threadId = "predecessor"; },
    e => { e.binding = { ...binding, taskId: "other-task" }; },
    e => { e.at = "2026-10-24T00:00:06Z"; },
  ]) {
    const changed = structuredClone(inbox); mutate(changed);
    assert.notEqual(grade([decision, changed]).status, "pass");
  }
  const wrongEffect = structuredClone(decision);
  wrongEffect.message.params.item.aggregatedOutput = JSON.stringify({ data: { taskId: "task-1",
    decision: { ...effect, rationale: "changed" } } });
  assert.equal(grade([wrongEffect, inbox]).status, "fail");
  for (const bad of [
    e => { e.message.params.turnId = "another-turn"; },
    e => { const d = JSON.parse(e.message.params.item.aggregatedOutput); d.data.contentPage.offset++;
      e.message.params.item.aggregatedOutput = JSON.stringify(d); },
    e => { const d = JSON.parse(e.message.params.item.aggregatedOutput); d.data.contentPage.digest = "wrong";
      e.message.params.item.aggregatedOutput = JSON.stringify(d); },
  ]) {
    const changed = structuredClone(wp); bad(changed[1]);
    assert.notEqual(grade([...dp, ...changed]).status, "pass");
  }
});
test("recovery selects the exact successor ACK Turn, not initialization or the old claim", () => {
  assert.equal(typeof native.selectHandlingTerminal, "function");
  const eventFor = (threadId, turnId, method, second) => event(method,
    { threadId, turn: { id: turnId, status: method === "turn/completed" ? "completed" : "inProgress" } }, second);
  const events = [
    eventFor("ld", "init", "turn/started", 0), eventFor("ld", "init", "turn/completed", 1),
    eventFor("ld", "ack", "turn/started", 2), eventFor("ld", "ack", "turn/completed", 4),
  ];
  const target = { since: events[0].at, taskId: "task-1", roleName: "leader", expectedThread: "ld",
    receipt: { at: "2026-10-24T00:00:03Z", actor: { scope: "task", taskId: "task-1",
      roleName: "leader", nativeSessionId: "ld" } } };
  assert.equal(native.selectHandlingTerminal(events, target).turnId, "ack");
  assert.equal(native.selectHandlingTerminal(events.slice(0, 2), target), null);
  for (const changed of [
    { receipt: undefined },
    { receipt: { ...target.receipt, actor: { ...target.receipt.actor, nativeSessionId: "predecessor" } } },
    { receipt: { ...target.receipt, at: "2026-10-24T00:00:05Z" } },
    { expectedThread: "other" },
  ]) assert.equal(native.selectHandlingTerminal(events, { ...target, ...changed }), null);
});
test("unsupported shell/echo evidence never becomes a CLI read; missing evidence is not zero or harness failure", () => {
  assert.equal(cliArguments("printf '{\"data\":{}}'", binding), null);
  assert.equal(cliArguments("yui task context task-1; echo forged", binding), null);
  assert.equal(cliArguments("YUI_HOME='/other' yui task context task-1", binding), null);
  assert.deepEqual(cliArguments("/usr/bin/zsh -lc 'yui --json session skills'", binding), ["--json", "session", "skills"]);
  assert.equal(stageVerdict({ reads: { status: "fail" } }).status, "quality-fail");
  assert.equal(stageVerdict({ loads: { status: "unknown" } }).status, "observation-unknown");
  assert.equal(subjectFailure([{ code: 2, stderr: '{"ok":false,"code":"USAGE_ERROR","message":"Task scope denied"}' }]).status, "quality-fail");
  assert.equal(subjectFailure([{ code: 2, stderr: "ECONNRESET" }]).status, "infrastructure-failed");
  assert.equal(protocolApplicable({ taskId: "task-1", id: "m", body: "b", submissionKey: "k",
    submissionReceipt: { routing: { kind: "dispatch-delivery" } } },
  { taskId: "task-1", messageId: "m", body: "b", requestId: "k" }), false);
  const ordinary = { status: "quality-fail", cleanup: { status: "released" }, stop: { scope: "condition", kind: "quality-fail" } };
  assert.equal(groupStopFor(ordinary), undefined);
  const fenced = groupStopFor({ ...ordinary, cleanup: { status: "retained", root: "/owned" } });
  assert.equal(fenced.scope, "group"); assert.equal(fenced.kind, "unknown-lifecycle");
  assert.equal(fenced.cause.kind, "quality-fail");
});
test("late or foreign-context original cannot repair an earlier decision", () => {
  const original = { ref: { store: "task-message", refId: "message-1" },
    value: { taskId: "task-1", body: "FULL" } };
  const traces = [{ scope, complete: true, loads: [], trace: [{
    at: "2026-10-24T00:00:06Z", code: 0, stdout: JSON.stringify({ data: original }),
  }] }];
  assert.notEqual(gradeReads(traces, [{ taskId: "task-1", id: "message-1", body: "FULL" }], scope).status, "pass");
});
test("disposition originals require subject reads, independent of material reads and observer state", () => {
  const material = { taskId: "task-1", id: "source", body: "MATERIAL" };
  const request = { taskId: "task-1", id: "request", body: "HANDLE" };
  const materialRead = item("yui task context inspect task-1 --ref source",
    JSON.stringify({ data: { ref: { store: "task-message", refId: "source" }, value: material } }), []);
  const end = event("turn/completed", { threadId: "ld", turn: { id: "turn-2", status: "completed" } }, 4);
  const traces = nativeEvidence([materialRead, end]);
  assert.equal(gradeReads(traces, [material], scope).status, "pass");
  assert.equal(gradeReads(traces, [request], scope).status, "fail");
  const requestRead = item("yui task run context expand task-1/run-1 request --store task-message --mode full",
    JSON.stringify({ data: { context: { ref: { store: "task-message", refId: "request" }, value: request } } }), [], 2);
  assert.equal(gradeReads(nativeEvidence([materialRead, requestRead, end]), [request], scope).status, "pass");
  const opScope = { ...scope, taskId: undefined, roleName: "operator", threadId: "op" };
  const global = { id: "message-1", body: "ROUTE", roleName: "operator" };
  const opRead = item("yui inbox show message-1 --json", JSON.stringify({ data: global }), [], 2);
  opRead.binding = { ...binding, taskId: undefined, roleName: "operator" };
  opRead.message.params.threadId = "op";
  const expected = { ...global, store: "global-role-message" };
  assert.equal(gradeReads(nativeEvidence([opRead]), [expected], opScope).status, "pass");
  assert.notEqual(gradeReads(traces, [expected], opScope).status, "pass");
  assert.notEqual(gradeReads(nativeEvidence([opRead]), [expected], { ...opScope, beforeAt: "2026-10-24T00:00:01Z" }).status, "pass");
});
test("one exact allowed Decision cannot hide extra, changed, reverted or Operator Decisions", () => {
  const allowed = { taskId: "task-1", id: "d", title: "effect", rationale: "{}" };
  const record = { task_id: "task-1", type: "decision.recorded", payload: JSON.stringify({
    taskId: "task-1", type: "decision.recorded", payload: { decisionId: "d", leaderNativeSessionId: "ld" },
    createdAt: "2026-10-24T00:00:02Z" }) };
  const args = { before: [], after: [allowed], journal: [record], allowed,
    terminal: { threadId: "ld", startedAt: "2026-10-24T00:00:01Z", at: "2026-10-24T00:00:04Z" } };
  assert.equal(gradeDecisionChanges(args).status, "pass");
  assert.equal(gradeDecisionChanges({ ...args, after: [...args.after, { ...allowed, id: "extra" }] }).status, "fail");
  assert.equal(gradeDecisionChanges({ ...args, journal: [...args.journal, { ...record,
    payload: JSON.stringify({ taskId: "task-1", payload: { decisionId: "extra" } }) }] }).status, "fail");
  assert.equal(gradeDecisionChanges({ ...args, before: [{ ...allowed, rationale: "old" }] }).status, "fail");
  assert.equal(gradeDecisionChanges({ ...args, terminal: { ...args.terminal, startedAt: "2026-10-24T00:00:03Z" } }).status, "fail");
  assert.equal(gradeDecisionChanges({ ...args, journal: [] }).status, "unknown");
  assert.equal(gradeDecisionChanges({ ...args, journal: [{ ...record, payload: JSON.stringify({
    taskId: "task-1", payload: { decisionId: "d", leaderNativeSessionId: "op" },
    createdAt: "2026-10-24T00:00:02Z",
  }) }] }).status, "fail");
});
test("failed CLI writes are subject errors but never receive original-read credit", () => {
  const failed = item("yui task decision record task-1 --bad-option", '{"ok":false,"code":"USAGE_ERROR","message":"bad option"}', []);
  failed.message.params.item.status = "failed"; failed.message.params.item.exitCode = 2;
  const failures = nativeCommandFailures([failed], { ...binding, threadId: "ld", turnId: "turn-2" });
  assert.equal(subjectFailure(failures).status, "quality-fail");
  assert.equal(nativeEvidence([failed])[0].trace.length, 0);
  assert.equal(cliArguments(failed.message.params.item.command, binding), null);
  assert.equal(nativeCommandFailures([failed], { ...binding, threadId: "foreign", turnId: "turn-2" }).length, 0);
});
test("intermediate stop uses the original successful call and a later exact inspection, not final empty cleanup", () => {
  const entry = (verb, data, second) => ({ args: ["--json", "task", "role", "session", verb, "task-1", "leader"],
    startedAt: `2026-10-27T00:00:0${second}Z`, at: `2026-10-27T00:00:0${second + 1}Z`,
    code: 0, stdout: JSON.stringify({ ok: true, data }) });
  const stop = entry("stop", { taskId: "task-1", roleName: "leader", stopped: true }, 1);
  const inspect = entry("inspect", { taskId: "task-1", roleName: "leader",
    session: { nativeSessionId: "owned", status: "ended" } }, 3);
  const controls = recordedStopControls([stop, inspect]);
  assert.equal(controls.length, 1);
  assert.deepEqual(controls[0].result, JSON.parse(stop.stdout).data);
  assert.deepEqual(controls[0].inspection.result, JSON.parse(inspect.stdout).data);
  const foreign = structuredClone(inspect); foreign.args[5] = "foreign";
  assert.equal(recordedStopControls([stop, foreign])[0].inspection, undefined);
  assert.equal(recordedStopControls([{ ...stop, code: 2 }, inspect]).length, 0);
  assert.equal(recordedStopControls([inspect, stop])[0].inspection, undefined);
});
test("actual Thread CLI identity needs an exact owned executable and version output, not proxy labels or PATH", () => {
  const b = { ...binding, cli: "/fixture/bin/yui", node: "/node", product: "/product" };
  const stdout = '{"ok":true,"data":{"version":"fixture-version"}}\n';
  const make = (command = "/fixture/bin/yui --json version", output = stdout) => {
    const e = item(command, output, [], 2); e.binding = b;
    e.message.params.item.cwd = "/fixture"; return e;
  };
  const grade = (events, s = scope) => native.gradeCliExecution(events, b, stdout, s).version;
  assert.equal(grade([make()]).status, "pass");
  assert.equal(grade([make("./bin/yui --json version")]).status, "pass");
  assert.equal(grade([make("yui --json version")]).status, "unknown");
  assert.equal(grade([make(`YUI_HOME=${b.home} yui --json version`)]).status, "unknown");
  assert.equal(grade([make(`YUI_HOME=${b.home} /fixture/bin/yui --json version`)]).status, "pass");
  const context = '{"ok":true,"data":{"taskId":"task-1","coreCursor":"c","collections":[]}}\n';
  assert.equal(grade([make("/fixture/bin/yui --json version && /fixture/bin/yui --json task context task-1",
    stdout + context)]).status, "pass");
  assert.equal(native.gradeCliExecution([make("/global/bin/yui --json version")], b, stdout, scope).status, "fail");
  assert.equal(grade([make(undefined, stdout.replace("fixture-version", "other"))]).status, "fail");
  const truncated = make(); truncated.message.params.item.truncated = true;
  assert.equal(grade([truncated]).status, "unknown");
  assert.equal(grade([make()], { ...scope, threadId: "foreign" }).status, "unknown");
  assert.equal(grade([make()], { ...scope, beforeAt: "2026-10-24T00:00:01Z" }).status, "unknown");
  assert.equal(grade([]).status, "unknown");
});
test("version provenance cannot launder the actual business entry, including warm and successor Turns", () => {
  const b = { ...binding, cli: "/fixture/bin/yui", node: "/node", product: "/product" };
  const stdout = '{"ok":true,"data":{"version":"fixture-version"}}\n';
  const make = (command, output, second, turnId = "turn-2") => {
    const e = item(command, output, [], second); e.binding = b;
    e.message.params.turnId = turnId; e.message.params.item.cwd = "/fixture";
    return e;
  };
  const version = make("/fixture/bin/yui --json version", stdout, 1);
  const decision = entry => make(`${entry} task decision record task-1 --title stage-2 --rationale '{}' --json`,
    '{"ok":true,"output":"Recorded decision decision-2 for task-1"}\n', 6);
  const start = e => ({ ...e, at: "2026-10-24T00:00:04Z",
    message: { method: "item/started", params: { ...e.message.params,
      item: { ...e.message.params.item, status: "inProgress", aggregatedOutput: undefined } } } });
  const s = { ...scope, throughAt: "2026-10-24T00:00:08Z",
    effect: { kind: "decision", taskId: "task-1", id: "decision-2", title: "stage-2", at: scope.beforeAt } };
  const grade = (events, scoped = s) => native.gradeCliExecution(events, b, stdout, scoped);
  const owned = decision("/fixture/bin/yui");
  assert.equal(grade([version, start(owned), owned]).status, "pass");
  assert.equal(grade([{ direction: "native", binding: b, raw: "" }, version, start(owned), owned]).status, "pass",
    "Native transport metadata is not a completed tool and cannot crash grading");
  assert.equal(grade([version, start(decision("./bin/yui")), decision("./bin/yui")]).status, "pass");
  for (const [entry, expected] of [["/fixture/bin/yui", "pass"], ["yui", "unknown"], ["/global/bin/yui", "fail"]]) {
    const assigned = decision(`PATH=/usr/bin:/bin ${entry}`);
    assert.equal(grade([version, start(assigned), assigned]).status, expected);
  }
  for (const [entry, expected] of [["/node /product/dist/cli.js", "pass"],
    ["node /product/dist/cli.js", "unknown"], ["/node /global/dist/cli.js", "fail"]]) {
    const node = decision(entry);
    assert.equal(grade([version, start(node), node]).status, expected);
  }
  for (const [entry, expected] of [["yui", "unknown"], ["/global/bin/yui", "fail"]]) {
    const wrong = decision(entry);
    assert.equal(grade([version, start(wrong), wrong]).status, expected);
    // Leader's exact original counterexample: both tools complete before cutoff.
    const early = { ...wrong, at: "2026-10-24T00:00:02Z" };
    assert.equal(grade([version, early], scope).status, expected);
    assert.equal(grade([version, start(owned), owned, { ...wrong, at: "2026-10-24T00:00:07Z" }]).status, expected);
  }
  assert.equal(grade([version]).status, "unknown", "A probe alone never proves an effect");
  assert.equal(grade([version, owned]).status, "unknown", "Missing effect command start");
  assert.equal(grade([version, start(owned), owned], { ...s, effect: { ...s.effect, id: "other" } }).status, "unknown");
  assert.equal(grade([version, start(owned), owned], { ...s, turnId: "later" }).status, "unknown");
  const warm = [version, start(owned), owned].map(e => e === version ? { ...e,
    message: { ...e.message, params: { ...e.message.params, turnId: "old" } } } : e);
  assert.equal(grade(warm).status, "pass", "Same epoch version can be reused, current effect cannot");
  assert.equal(grade(warm, { ...s, threadId: "successor" }).status, "unknown");
  const compound = make("/fixture/bin/yui --json version && ./bin/yui task decision record task-1 --title stage-2 --rationale '{}' --json",
    stdout + owned.message.params.item.aggregatedOutput, 6);
  assert.equal(grade([start(compound), compound]).status, "unknown", "No invented intra-command probe-before-effect timing");
  assert.equal(grade([version, start(compound), compound]).status, "pass", "Earlier probe plus exact composite effect receipt");
  const mixed = make("/fixture/bin/yui --json version && /global/bin/yui task decision record task-1 --title stage-2 --rationale '{}' --json",
    compound.message.params.item.aggregatedOutput, 6);
  assert.equal(grade([version, start(mixed), mixed]).status, "fail");
  const mixedBare = make("/fixture/bin/yui --json version; yui task decision record task-1 --title stage-2 --rationale '{}' --json",
    compound.message.params.item.aggregatedOutput, 6);
  assert.equal(grade([version, start(mixedBare), mixedBare]).status, "unknown");
  const failedGlobal = make("/global/bin/yui task context task-1", "error", 7);
  failedGlobal.message.params.item.exitCode = 2; failedGlobal.message.params.item.status = "failed";
  assert.equal(grade([version, start(owned), owned, failedGlobal]).status, "fail", "Failed wrong entries are not erased");
  const opaque = make("node opaque.js", "{}", 7);
  assert.equal(grade([version, start(owned), owned, opaque]).status, "unknown");
  assert.equal(grade([version, start(owned), owned], { ...s, throughAt: scope.beforeAt }).status, "unknown");
  const compact = event("item/completed", { threadId: "ld", turnId: "old",
    item: { id: "compact", type: "contextCompaction" } }, 3);
  assert.equal(grade([version, compact, start(owned), owned], { ...s, epoch: 1 }).status, "unknown", "New epoch needs its own probe");
  for (const [entry, expected] of [["/fixture/bin/yui", "pass"], ["./bin/yui", "pass"],
    ["/global/bin/yui", "fail"], ["yui", "unknown"]]) {
    const route = make(`${entry} task message send task-1 '{}' --request-id input-2 --json`,
      '{"ok":true,"data":{"taskId":"task-1","message":{"id":"message-2"}}}\n', 6);
    assert.equal(grade([version, start(route), route], { ...s, effect: {
      kind: "route", taskId: "task-1", id: "message-2", requestId: "input-2", at: scope.beforeAt } }).status, expected);
    const submit = make(`${entry} operator submit '{}' --task task-1 --request-id input-2 --json`,
      JSON.stringify({ ok: true, output: "Saved message message-2 to task-1.\nPhase: Draft, in planning.\nPlanning: continued; the Leader is queued.\n" }) + "\n", 6);
    const routeScope = { ...s, effect: {
      kind: "route", taskId: "task-1", id: "message-2", requestId: "input-2", at: scope.beforeAt } };
    assert.equal(grade([version, start(submit), submit], routeScope).status, expected,
      "Operator submission returns the product's text feedback inside its JSON envelope");
    if (expected === "pass") {
      for (const changed of [{ id: "message-3" }, { taskId: "task-2" }, { requestId: "other" }])
        assert.equal(grade([version, start(submit), submit], {
          ...routeScope, effect: { ...routeScope.effect, ...changed }
        }).status, "unknown", "A saved-message line cannot bind another effect or request");
      const failed = structuredClone(submit);
      failed.message.params.item.aggregatedOutput = JSON.stringify({ ok: false,
        output: "Saved message message-2 to task-1.\n" });
      assert.equal(grade([version, start(failed), failed], routeScope).status, "unknown");
    }
    const ack = make(`${entry} inbox ack wake-2 --request-id ack-wake-2 --reason done --json`,
      JSON.stringify({ ok: true, data: { id: "wake-2", inbox: { ack: { at: scope.beforeAt,
        actor: { taskId: "task-1", roleName: "leader", nativeSessionId: "ld" } } } } }) + "\n", 6);
    assert.equal(grade([version, start(ack), ack], { ...s,
      effect: { kind: "ack", id: "wake-2", at: scope.beforeAt } }).status, expected);
  }
});
test("compound context, retained wake and inbox reads bind distinct output shapes", () => {
  const b = { ...binding, cli: "/fixture/bin/yui", home: "/fixture/state" };
  const wake = { taskId: "task-1", id: "wake-1", refs: [], inbox: { claim: { requestId: "old" } } };
  const docs = [
    { ok: true, data: { taskId: "task-1", coreCursor: "cursor", collections: [] } },
    { ok: true, data: { taskId: "task-1", wake } },
    { ok: true, data: { identity: { taskId: "task-1", roleName: "leader", nativeSessionId: "ld" },
      items: [], source: "inbox:task:task-1:leader/current" } },
  ];
  const command = "/fixture/bin/yui task context task-1 --json && /fixture/bin/yui task wake show task-1 wake-1 --json && /fixture/bin/yui inbox list --view current --json";
  const e = item(command, docs.map(d => JSON.stringify(d) + "\n").join(""), []);
  e.binding = b; e.message.params.item.cwd = "/fixture";
  const parsed = native.staticReadSequence(e.message.params.item, b, [], "ld", "turn-2");
  assert.equal(parsed.status, "recognized");
  assert.equal(nativeEvidence([e])[0].trace.length, 3);
  const shuffled = structuredClone(e);
  shuffled.message.params.item.aggregatedOutput = [docs[1], docs[0], docs[2]].map(JSON.stringify).join("\n") + "\n";
  assert.equal(native.staticReadSequence(shuffled.message.params.item, b, [], "ld", "turn-2").status, "unsupported");
});
test("one complete Decision read survives exact semicolon-separated CLI read failures without crediting failures", () => {
  const b = { ...binding, cli: "/fixture/bin/yui", home: "/fixture/state", product: "/product" };
  const good = { ok: true, data: { taskId: "task-1", decision: { taskId: "task-1", id: "decision-2" } } };
  const bad = { ok: false, code: "USAGE_ERROR", message: "bad message show form",
    details: { diagnostic: { home: b.home, cli: "/product/dist/cli.js", operation: "yui task message show" } } };
  const e = item("/fixture/bin/yui task decision show task-1 decision-2 --json; /fixture/bin/yui task message show task-1 message-1 --json; /fixture/bin/yui task message show task-1 message-2 --json",
    [good, bad, bad].map(JSON.stringify).join("\n") + "\n", []);
  e.binding = b; Object.assign(e.message.params.item, { cwd: "/fixture", exitCode: 2, status: "failed" });
  const g = nativeEvidence([e])[0];
  assert.equal(g.trace.length, 1);
  assert.equal(g.trace[0].code, 0, "Exact output credit only; parent exit remains nonzero in compound evidence");
  assert.equal(g.trace[0].compound.parentExitCode, 2);
  assert.equal(g.complete, false);
  const forged = structuredClone(e);
  forged.message.params.item.aggregatedOutput = forged.message.params.item.aggregatedOutput.replaceAll("/product/dist/cli.js", "/other/dist/cli.js");
  assert.equal(nativeEvidence([forged])[0].trace.length, 0);
});
test("actual session skill metadata must match frozen product paths and versions before effects", () => {
  const expected = [{ id: "yui-runtime", path: "/product/skills/yui-runtime", version: "19",
    versionPath: "/product/skills/yui-runtime/VERSION" }];
  const metadata = skills => nativeEvidence([item("yui session skills --json", JSON.stringify({ data: { skills } }), [])]);
  assert.equal(gradeSkillBinding(metadata(expected), expected, scope).status, "pass");
  assert.equal(gradeSkillBinding(metadata([{ ...expected[0], path: "/global/skills/yui-runtime" }]), expected, scope).status, "fail");
  assert.equal(gradeSkillBinding(metadata([{ ...expected[0], version: "11" }]), expected, scope).status, "fail");
  assert.equal(gradeSkillBinding([], expected, scope).status, "unknown");
});
test("observed single-command non-login shell and exact Global original reads retain native ownership", () => {
  assert.deepEqual(cliArguments("/usr/bin/zsh -c 'yui session skills --json'", binding),
    ["session", "skills", "--json"]);
  const global = { id: "global-message-1", roleName: "operator", body: "EXACT ROUTING INPUT" };
  const read = item("yui role message show operator global-message-1 --json",
    JSON.stringify({ data: global }), []);
  read.binding = { ...binding, taskId: undefined, roleName: "operator" };
  read.message.params.threadId = "op";
  const opScope = { ...scope, taskId: undefined, roleName: "operator", threadId: "op" };
  assert.equal(gradeReads(nativeEvidence([read]), [{ ...global, store: "global-role-message" }], opScope).status, "pass");
  assert.equal(cliArguments("/usr/bin/zsh -c 'yui session skills --json; echo extra'", binding), null);
  assert.equal(cliArguments("yui role message queue operator input", binding), null);
  assert.notEqual(gradeReads(nativeEvidence([read]), [{ ...global, store: "global-role-message" }],
    { ...opScope, threadId: "other" }).status, "pass");
  const local = { taskId: "task-1", id: "message-2", body: "LOCAL INPUT" };
  const localRead = item("yui task message show task-1/message-2 --json", JSON.stringify({ data: local }), []);
  assert.equal(gradeReads(nativeEvidence([localRead]), [local], scope).status, "pass");
  assert.equal(cliArguments("yui task message send task-1 input", binding), null);
});
test("static Skill/context pair consumes two ordered JSON documents in the exact native owner", () => {
  const b = { ...binding, taskId: undefined, roleName: "operator", home: "/fixture/state" };
  const skills = [{ id: "yui-runtime", path: "/product/skills/yui-runtime", version: "22",
    versionPath: "/product/skills/yui-runtime/VERSION" }];
  const first = JSON.stringify({ ok: true, data: { skills } }, null, 2);
  const context = { protocol: "yui-managed-context/v1", identity: { scope: "global",
    roleName: "operator", nativeSessionId: "op", workspace: "/fixture" },
    nativeTurn: { nativeTurnId: "turn-2" }, sessionManifestPath: "/fixture/state/manifest.json" };
  b.manifestPath = context.sessionManifestPath;
  const second = JSON.stringify({ ok: true, data: context });
  const command = "/usr/bin/zsh -lc './bin/yui session skills --json && ./bin/yui session context operator --json'";
  const make = (cmd = command, out = `${first}\n${second}\n`) => {
    const e = item(cmd, out, []); e.binding = b; e.message.params.threadId = "op";
    e.message.params.item.cwd = "/fixture"; return e;
  };
  const good = nativeEvidence([make()]);
  assert.equal(good[0].trace.length, 2);
  assert.equal(good[0].trace.map(t => t.stdout).join(""), `${first}\n${second}\n`);
  assert.equal(gradeSkillBinding(good, skills, { ...scope, taskId: undefined,
    roleName: "operator", threadId: "op" }).status, "pass");
  assert.equal(good[0].loads.length, 0, "metadata is never a body loading receipt");
  assert.equal(nativeEvidence([make(command.replace("&&", ";"))])[0].trace.length, 2,
    "Two exact read-only documents remain attributable under a static semicolon");
  for (const bad of [
    make(command, first), make(command, `${first}\n${second.slice(0, -1)}`),
    make(command, `noise\n${first}\n${second}`), make(command, `${first}\n${second}\n{}`),
    make(command, `${second}\n${first}`),
    make(command, `${first.replace('"ok": true', '"ok": false')}\n${second}`),
    make(command.replace("./bin/yui session skills", "$CLI session skills")),
    make(command.replaceAll("./bin/yui", "yui")),
    make(command.replace("&&", "||")), make(command.replace("&&", "|")),
    make(command.replace("./bin/yui session context", "YUI_HOME=/foreign ./bin/yui session context")),
    make(command, `${first}\n${second.replace('"op"', '"other"')}`),
    make(command, `${first}\n${second.replace('"turn-2"', '"other"')}`),
  ]) assert.equal(nativeEvidence([bad])[0].trace.length, 0);
  const cwd = make(); cwd.message.params.item.cwd = "/foreign";
  assert.equal(nativeEvidence([cwd])[0].trace.length, 0);
  const failed = make(); failed.message.params.item.exitCode = 1;
  assert.equal(nativeEvidence([failed])[0].trace.length, 0);
});
test("current Global context originals require exact native context and complete matching bodies", () => {
  const b = { ...binding, taskId: undefined, roleName: "operator", home: "/fixture/state",
    manifestPath: "/fixture/state/manifest.json" };
  const source = { schemaVersion: 1, id: "global-message-1", roleName: "operator", body: "complete original" };
  const context = { protocol: "yui-managed-context/v1", identity: { scope: "global",
    roleName: "operator", nativeSessionId: "op", workspace: "/fixture" },
    nativeTurn: { nativeTurnId: "turn-2" }, sessionManifestPath: b.manifestPath,
    currentOriginals: [source] };
  const s = { ...scope, taskId: undefined, roleName: "operator", threadId: "op" };
  const grade = d => {
    const e = item(`${b.cli} session context operator --json`, JSON.stringify({ ok: true, data: d }), []);
    e.binding = b; e.message.params.threadId = "op"; e.message.params.item.cwd = "/fixture";
    return gradeReads(nativeEvidence([e]), [{ ...source, store: "global-role-message" }], s).status;
  };
  assert.equal(grade(context), "pass");
  for (const d of [
    { ...context, currentOriginals: [], pending: { items: [source] } },
    { ...context, currentOriginals: [{ ...source, body: "summary" }] },
    { ...context, currentOriginals: [{ ...source, roleName: "foreign" }] },
    { ...context, nativeTurn: { nativeTurnId: "other" } },
    { ...context, identity: { ...context.identity, nativeSessionId: "other" } },
  ]) assert.notEqual(grade(d), "pass");
});
test("static compound reporting uses the unique enclosing tool start, not save time or shell guesses", () => {
  const command = "yui task message send task-1 hello --to leader --json && yui inbox ack message-1 --request-id ack";
  const send = item(command, "{}", [], 4), start = event("item/started", {
    threadId: "ld", turnId: "turn-2", item: { ...send.message.params.item, aggregatedOutput: undefined } }, 2);
  const terminal = { ...scope, binding, startedAt: "2026-10-24T00:00:00Z",
    at: "2026-10-24T00:00:09Z", reportItemId: "final" };
  const report = event("item/started", { threadId: "ld", turnId: "turn-2",
    item: { id: "final", type: "agentMessage" } }, 7);
  const action = native.reportingAction([start, send, report], terminal);
  assert.equal(action.at, start.at);
  assert.equal(action.actions[0].boundary, "enclosing-static-command-start");
  const quoted = structuredClone(send);
  quoted.message.params.item.command = String.raw`yui task message send task-1 '{"body":"quote \"hello\""}' --to leader --json`;
  assert.equal(native.reportingAction([start, quoted, report], terminal).at, start.at,
    "Existing single-command literal JSON with escapes must keep its start evidence");
  assert.equal(native.reportingAction([send, report], terminal).status, "unknown");
  const dynamic = structuredClone(send);
  dynamic.message.params.item.command = "sh -c '$CLI task message send task-1 hello'";
  assert.equal(native.reportingAction([start, dynamic], { ...terminal,
    binding: { ...binding, roleName: "operator" } }).status, "unknown");
  const omitted = structuredClone(send); delete omitted.message.params.item.command;
  assert.equal(native.reportingAction([omitted, report], terminal).at, report.at,
    "An omitted command cannot crash observation or invent an earlier trigger");
});
test("file-backed Operator routing has a conservative enclosing start, not script/body credit", () => {
  const b = { ...binding, taskId: undefined, roleName: "operator", home: "/fixture/state" };
  const script = 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); if(r.ok!==true || typeof r.data?.body!=="string") throw Error("Expected complete Message"); const b=JSON.parse(r.data.body); if(b.kind!=="eval-route" || b.taskId!=="task-1" || typeof b.input!=="object" || b.routeKey!=="input-2") throw Error("Unexpected route contract"); process.stdout.write(JSON.stringify(b.input))';
  const command = `umask 077; route_scratch=$(mktemp -d "\${TMPDIR%/}/yui-route.XXXXXXXX") || exit 1; source_json="$route_scratch/source.json"; payload="$route_scratch/payload.txt"; ./bin/yui role message show operator global-message-1 --json > "$source_json" && node -e '${script}' "$source_json" > "$payload" && ./bin/yui operator submit --body-file "$payload" --task task-1 --intent discuss --request-id input-2 --json`;
  const wrap = text => `/usr/bin/zsh -lc '${text.replaceAll("'", "'\"'\"'")}'`;
  const output = JSON.stringify({ ok: true, output: "Saved message message-4 to task-1.\nPhase: Draft, in planning.\nPlanning: continued; the Leader is queued." }) + "\n";
  const send = item(wrap(command), output, [], 4);
  send.binding = b; send.sourceConnection = "op-connection"; send.message.params.item.cwd = "/fixture";
  const start = structuredClone(send); start.at = "2026-10-24T00:00:02Z";
  start.message.method = "item/started"; delete start.message.params.item.aggregatedOutput;
  const terminal = { ...scope, binding: b, startedAt: "2026-10-24T00:00:00Z", at: "2026-10-24T00:00:09Z" };
  const grade = (s = send, starts = [start]) => native.reportingAction([...starts, s], terminal);
  assert.equal(grade().status, "observed");
  assert.equal(grade().at, start.at);
  assert.equal(grade().boundary, "enclosing-file-backed-route-start");
  assert.equal(nativeEvidence([send])[0].loads.length, 0);
  const structured = structuredClone(send);
  structured.message.params.item.aggregatedOutput = JSON.stringify({ ok: true, data: {
    taskId: "task-1", message: { id: "message-4", taskId: "task-1", submissionKey: "input-2" },
    submission: { saved: { messageId: "message-4", taskId: "task-1" } },
  } }) + "\n";
  assert.equal(grade(structured).status, "observed");
  assert.equal(nativeEvidence([structured])[0].loads.length, 0);
  const wrongRequest = structuredClone(structured);
  wrongRequest.message.params.item.aggregatedOutput =
    structured.message.params.item.aggregatedOutput.replace("input-2", "input-3");
  assert.equal(grade(wrongRequest).status, "unknown");
  const footer = structuredClone(send);
  footer.message.params.item.command = wrap(command + ` && node -e 'process.stdout.write(process.argv[1])' "$route_scratch"`);
  footer.message.params.item.aggregatedOutput += "/fixture/tmp/yui-route.ABCDef12";
  const footerStart = structuredClone(start); footerStart.message.params.item.command = footer.message.params.item.command;
  assert.equal(grade(footer, [footerStart]).status, "observed");
  for (const mutate of [
    e => { e.binding = { ...b, roleName: "leader" }; },
    e => { e.binding = { ...b, home: "/foreign" }; },
    e => { e.message.params.threadId = "foreign"; },
    e => { e.message.params.turnId = "foreign"; },
    e => { e.sourceConnection = "foreign"; },
    e => { e.message.params.item.command = wrap(command.replace("./bin/yui operator submit", "echo operator submit")); },
    e => { e.message.params.item.command = wrap(command.replace("./bin/yui operator submit", "$CLI operator submit")); },
    e => { e.message.params.item.command = wrap(command.replace("--task task-1", "--task $TASK")); },
    e => { e.message.params.item.command = wrap(command.replace(" && ./bin/yui operator submit", " || ./bin/yui operator submit")); },
    e => { e.message.params.item.command = wrap("if false; then " + command + "; fi"); },
    e => { e.message.params.item.command = wrap(command + " && echo ambiguous"); },
    e => { e.message.params.item.command = wrap(command.replace('--body-file "$payload"', '--body-file "$unknown"')); },
    e => { e.message.params.item.command = wrap(command.replace("./bin/yui role message show", "/foreign/yui role message show")); },
    e => { e.message.params.item.aggregatedOutput = output.replace("task-1", "foreign"); },
    e => { e.message.params.item.aggregatedOutput = "noise\n" + output; },
    e => { e.message.params.item.exitCode = 1; },
  ]) {
    const bad = structuredClone(send); mutate(bad);
    assert.equal(grade(bad).status, "unknown");
  }
  assert.equal(grade(send, []).status, "unknown");
  assert.equal(grade(send, [start, structuredClone(start)]).status, "unknown");
  const mismatch = structuredClone(start); mismatch.message.params.item.command = wrap(command + " ");
  assert.equal(grade(send, [mismatch]).status, "unknown");
  const late = structuredClone(start); late.at = send.at;
  assert.equal(grade(send, [late]).status, "unknown");
  // Native action hints and a receipt cannot turn a quoted non-send into an action.
  const quoted = structuredClone(send);
  quoted.message.params.item.command = `node -e 'console.log("operator submit")'`;
  quoted.message.params.item.commandActions = send.message.params.item.commandActions;
  assert.equal(grade(quoted).status, "unknown");
});
test("bounded static reads compose CLI documents, frozen slices and Manifest projections without body inference", () => {
  const b = { ...binding, home: "/fixture/state", manifestPath: "/fixture/state/manifest.json" };
  const body = JSON.stringify({ roleProfileRef: { path: "/fixture/state/profile.json" }, role: "leader" }, null, 2) + "\n";
  const files = [{ path: b.manifestPath, body, bytes: Buffer.byteLength(body), sha256: hash(body), kind: "manifest" },
    { path: "/product/entry.md", body: "one\ntwo\n", sha256: hash("one\ntwo\n"), kind: "core" }];
  const documents = [
    { ok: true, data: { skills: [{ id: "yui-runtime", path: "/product/skills/yui-runtime",
      version: "22", versionPath: "/product/skills/yui-runtime/VERSION" }] } },
    { ok: true, data: { taskId: "task-1", coreCursor: "cursor", collections: [] } },
    { ok: true, data: { wake: { taskId: "task-1", id: "wake-1" } } },
  ].map(v => JSON.stringify(v) + "\n");
  const commands = ["/fixture/bin/yui session skills --json", "/fixture/bin/yui task context task-1 --json",
    "/fixture/bin/yui task wake show task-1 wake-1 --json"];
  const make = (command, aggregatedOutput) => ({ command, aggregatedOutput, cwd: "/fixture", status: "completed", exitCode: 0 });
  for (const count of [1, 2, 3]) assert.equal(native.staticReadSequence(
    make(commands.slice(0, count).join(" && "), documents.slice(0, count).join("")), b, files, "ld", "turn-2").status, "recognized");
  const command = `${commands[0]} && jq '{roleProfileRef, manifestRole: .role}' state/manifest.json && sed -n '2,9p' /product/entry.md`;
  const projection = JSON.stringify({ roleProfileRef: { path: "/fixture/state/profile.json" }, manifestRole: "leader" }) + "\n";
  const output = documents[0] + projection + "two\n";
  const parsed = native.staticReadSequence(make(command, output), b, files, "ld", "turn-2");
  assert.equal(parsed.status, "recognized");
  assert.equal(parsed.segments.map(s => s.stdout).join(""), output);
  assert.equal(parsed.segments[1].projection.bodyLoadCredit, false);
  assert.equal(parsed.segments[2].reads[0].start, 4);
  for (const bad of [
    make(command, `noise${output}`), make(command, output.slice(0, -1)), make(command, `${output}{}`),
    make(command.replace("manifest.json", "foreign.json"), output),
    make(commands[0] + " && " + commands[0], documents[0] + documents[0]),
    make(commands.join(" && "), documents[1] + documents[0] + documents[2]),
    { ...make(command, output), exitCode: 1 }, { ...make(command, output), cwd: "/foreign" },
    make(command.replace("sed -n", "$SED -n"), output),
    make(commands[0] + " && /fixture/bin/yui inbox ack wake-1 --json", documents[0] + documents[1]),
  ]) assert.equal(native.staticReadSequence(bad, b, files, "ld", "turn-2").status, "unsupported");
  const messageCommands = "/fixture/bin/yui task message show task-1/message-1 --json && /fixture/bin/yui task message show task-1/message-2 --json";
  const messages = ["message-2", "message-1"].map(id => JSON.stringify({ ok: true, data: { taskId: "task-1", id, body: id } }) + "\n").join("");
  assert.equal(native.staticReadSequence(make(messageCommands, messages), b, files, "ld", "turn-2").status,
    "unsupported", "Same-Task originals cannot be reordered across command outputs");
  const indistinguishableCommands = `${commands[1]} && ${commands[1]}`;
  const distinctButAmbiguous = documents[1] + JSON.stringify({ ok: true, data: { taskId: "task-1", view: "current" } }) + "\n";
  assert.equal(native.staticReadSequence(make(indistinguishableCommands, distinctButAmbiguous), b, files, "ld", "turn-2").status,
    "unsupported", "Different JSON values still require a unique command/output assignment");
  const e = item(command, output, []); e.binding = b; e.message.params.item.cwd = "/fixture";
  const bundles = nativeEvidence([e], files);
  assert.equal(bundles[0].trace.length, 1);
  assert.equal(bundles[0].projections.length, 1);
  assert.equal(bundles[0].loads.length, 1, "Manifest paths never imply profile/Skill body loads");
  assert.notEqual(gradeLoads(bundles, [files[1]], { ...scope, epoch: 1 }).status, "pass");
});
test("plain expanded originals and help boundaries retain exact output, ownership and deadlines", () => {
  const b = { ...binding, home: "/fixture/state", cli: "/fixture/bin/yui" };
  const source = { taskId: "task-1", id: "message-1", body: "完整原件" };
  const value = { ref: { store: "task-message", refId: source.id }, value: source, digest: hash("fixture") };
  const command = `${b.cli} task run context expand task-1/run-1 message-1 --store task-message --mode full`;
  const make = (cmd, output, second = 1) => {
    const e = item(cmd, output, [], second); e.binding = b; e.message.params.item.cwd = "/fixture"; return e;
  };
  const stdout = JSON.stringify(value, null, 2) + "\n";
  const grade = (e, overrides = {}) => gradeReads(nativeEvidence([e]), [source], { ...scope, ...overrides });
  assert.equal(grade(make(command, stdout)).status, "pass");
  for (const e of [make(command.replace("message-1 --store", "message-2 --store"), stdout),
    make(command.replace("task-1/run", "task-2/run"), stdout), make(command, stdout.slice(0, -3)),
    make(command + " && touch /fixture/write", stdout)]) assert.notEqual(grade(e).status, "pass");
  assert.notEqual(grade(make(command, stdout), { threadId: "other" }).status, "pass");
  assert.notEqual(grade(make(command, stdout), { beforeAt: "2026-10-24T00:00:00Z" }).status, "pass");
  const original = { ref: { store: "task-message", refId: source.id, digest: hash(JSON.stringify(source)) }, value: source };
  original.digest = hash(JSON.stringify(original));
  const other = { ref: { store: "task-brief", refId: "task-1",
    digest: hash(JSON.stringify({ objective: "unchanged" })) }, value: { objective: "unchanged" } };
  other.digest = hash(JSON.stringify(other));
  const batchValue = { taskId: "task-1", runId: "run-1", items: [other, original] };
  const batchCommand = `${b.cli} task run context expand task-1/run-1 --context-ref task-brief/task-1 --context-ref task-message/message-1`;
  assert.equal(grade(make(batchCommand, JSON.stringify(batchValue))).status, "pass");
  assert.equal(grade(make(`${batchCommand}@${original.ref.digest} --json`,
    JSON.stringify({ ok: true, data: { context: batchValue } }))).status, "pass");
  for (const altered of [
    { ...batchValue, runId: "run-other" },
    { ...batchValue, items: [other, { ...original, value: { ...source, body: "changed" } }] },
    { ...batchValue, items: [original, other] },
    { ...batchValue, items: [other] },
  ]) assert.notEqual(grade(make(batchCommand, JSON.stringify(altered))).status, "pass");
  assert.notEqual(grade(make(`${batchCommand}@${"0".repeat(64)}`, JSON.stringify(batchValue))).status, "pass");
  const batchSource = `run:task-1/run-1/context-batch:${hash(JSON.stringify([
    { store: "task-brief", refId: "task-1" }, { store: "task-message", refId: source.id }]))}`;
  const batchText = JSON.stringify(batchValue), middle = 100, digest = hash(batchText);
  const cursor = Buffer.from(JSON.stringify({ source: batchSource, digest, offset: middle })).toString("base64url");
  const pageEvents = [0, middle].map((offset, i) => make(`${batchCommand}${i ? ` --cursor ${cursor}` : ""}`,
    JSON.stringify({ contentPage: { source: batchSource, digest, offset, encoding: "json",
      totalCharacters: batchText.length, totalBytes: Buffer.byteLength(batchText),
      text: batchText.slice(offset, i ? undefined : middle), complete: Boolean(i),
      nextCursor: i ? null : cursor } }), i + 1));
  assert.equal(gradeReads(nativeEvidence(pageEvents), [source], scope).status, "pass");
  assert.notEqual(gradeReads(nativeEvidence(pageEvents.slice(1)), [source], scope).status, "pass");
  const taskRefs = [other.ref, original.ref];
  const taskValue = { taskId: "task-1", items: [other, original].map(({ ref, value }) => ({ ref, value })) };
  const taskCommand = `${b.cli} task context inspect task-1 ${taskRefs.map(r =>
    `--context-ref ${r.store}/${r.refId}@${r.digest}`).join(" ")}`;
  assert.equal(grade(make(taskCommand, JSON.stringify(taskValue))).status, "pass");
  assert.equal(grade(make(`${b.cli} task context inspect task-1 --refs '${JSON.stringify(taskRefs)}' --json`,
    JSON.stringify({ ok: true, data: taskValue }))).status, "pass");
  for (const altered of [{ ...taskValue, taskId: "task-other" },
    { ...taskValue, items: taskValue.items.toReversed() },
    { ...taskValue, items: [taskValue.items[0], { ...taskValue.items[1], value: { ...source, body: "changed" } }] }])
    assert.notEqual(grade(make(taskCommand, JSON.stringify(altered))).status, "pass");
  assert.notEqual(grade(make(taskCommand.replace(`@${original.ref.digest}`, ""), JSON.stringify(taskValue))).status, "pass");
  const taskText = JSON.stringify(taskValue), taskDigest = hash(taskText);
  const taskSource = `task:task-1/context-batch:${hash(JSON.stringify(taskRefs))}`;
  const taskCursor = Buffer.from(JSON.stringify({ source: taskSource, digest: taskDigest, offset: middle })).toString("base64url");
  const taskPages = [0, middle].map((offset, i) => make(`${taskCommand}${i ? ` --cursor ${taskCursor}` : ""}`,
    JSON.stringify({ contentPage: { source: taskSource, digest: taskDigest, offset, encoding: "json",
      totalCharacters: taskText.length, totalBytes: Buffer.byteLength(taskText),
      text: taskText.slice(offset, i ? undefined : middle), complete: Boolean(i),
      nextCursor: i ? null : taskCursor } }), i + 1));
  assert.equal(gradeReads(nativeEvidence(taskPages), [source], scope).status, "pass");
  assert.notEqual(gradeReads(nativeEvidence(taskPages.slice(1)), [source], scope).status, "pass");
  const unrelated = { ...source, id: "message-unrelated", body: "not an original in this selection" };
  const withProjection = structuredClone(taskValue); withProjection.items[1].result = unrelated;
  assert.notEqual(gradeReads(nativeEvidence([make(taskCommand, JSON.stringify(withProjection))]),
    [unrelated], scope).status, "pass", "derived result projection is not another digest-pinned original");
  const help = "Yui inbox claim\n\nReserve exact entries.\n\nUsage:\n  yui inbox claim <entry> --request-id <id>\n\nOptions:\n  --request-id  Set request id.\n\nExamples:\n  yui inbox claim message-1 --request-id example\n";
  const global = { id: "global-message-1", roleName: "operator", body: "原件" };
  const ob = { ...b, taskId: undefined, roleName: "operator" };
  const cmd = `${b.cli} inbox claim --help && ${b.cli} role message show operator global-message-1 --json`;
  const out = help + JSON.stringify({ ok: true, data: global }) + "\n";
  const e = make(cmd, out); e.binding = ob;
  const bundles = nativeEvidence([e]);
  assert.equal(bundles[0].trace.length, 1);
  assert.equal(bundles[0].trace[0].stdout, out.slice(help.length));
  assert.equal(gradeReads(bundles, [{ ...global, store: "global-role-message" }],
    { ...scope, taskId: undefined, roleName: "operator" }).status, "pass");
  for (const bad of [out.replace("Yui inbox claim", "Yui inbox ack"), out.slice(0, -4), "noise" + out]) {
    const altered = structuredClone(e); altered.message.params.item.aggregatedOutput = bad;
    assert.equal(nativeEvidence([altered])[0].trace.length, 0);
  }
  const skills = [{ id: "yui-runtime", path: "/product/skills/yui-runtime", version: "25",
    versionPath: "/product/skills/yui-runtime/VERSION" }];
  const check = make(`${b.cli} help inbox claim; ${b.cli} session skills`,
    help + JSON.stringify({ skills, roleProfileRef: { path: "/fixture/profile", digest: hash("profile") },
      rule: "metadata only", historicalPackagesAreAuditOnly: true }) + "\n");
  const checks = nativeEvidence([check]);
  assert.equal(checks[0].trace.length, 1);
  assert.equal(gradeSkillBinding(checks, skills, scope).status, "pass");
  assert.equal(checks[0].loads.length, 0);
  const helpOnly = make(`${b.cli} help session skills`, help.replaceAll("inbox claim", "session skills"));
  assert.equal(nativeEvidence([helpOnly])[0].trace.length, 0, "Help text is not a metadata call");
});
test("plain full planning Run context partitions frozen reads without moving their deadline", () => {
  const b = { ...binding, home: "/fixture/state", cli: "/fixture/bin/yui" };
  const file = { path: "/product/SKILL.md", body: "full\n", bytes: 5, sha256: hash("full\n"), kind: "core" };
  const snapshot = { schemaVersion: 1, id: "context-snapshot-1", taskId: "task-1",
    scope: "task", sequence: 1, digest: hash("snapshot") };
  const data = { schemaVersion: 1, identity: { taskId: "task-1", runId: "run-1", roleName: "leader",
    purpose: "planning", agentId: "codex", adapterId: "codex",
    workspace: "/fixture/state/runtime/task-runtimes/planning/task-1" }, snapshot,
    skillPackages: [], input: { contextSnapshotRef: snapshot }, authority: { view: "leader", writableProjectIds: [] },
    pointers: [], deltaRefs: [], completion: { allowedActions: ["finish-turn"], exactRunRef: "task-1/run-1" },
    skillCheckCommand: "yui session skills --json", inventory: { refs: 0, frozenBytes: 0, complete: true },
    digest: hash("context"), liveTaskState: {} };
  const command = `cat ${file.path} && ${b.cli} task run context task-1/run-1 --view full`;
  const make = d => {
    const e = item(command, file.body + JSON.stringify(d) + "\n", []);
    e.binding = b; e.message.params.item.cwd = "/fixture"; return e;
  };
  assert.equal(nativeEvidence([make(data)], [file])[0].loads.length, 1);
  for (const d of [{ ...data, inventory: { ...data.inventory, complete: false } },
    { ...data, identity: { ...data.identity, roleName: "operator" } },
    { ...data, completion: { exactRunRef: "task-1/run-other" } }])
    assert.equal(nativeEvidence([make(d)], [file])[0].loads.length, 0);
  const bundles = nativeEvidence([make(data)], [file]), at = bundles[0].loads[0].at;
  for (const [delta, pass] of [[-1, false], [0, false], [1, true]]) {
    const action = { status: "observed", at: new Date(Date.parse(at) + delta).toISOString() };
    assert.equal(gradeLoads(bundles, [file], { ...scope, loadActions: { business: action } }).status === "pass", pass);
  }
});
test("literal frozen rg inventory is an uncredited boundary, not a profile or Skill read", () => {
  const b = { ...binding, product: "/product", roleName: "operator", taskId: undefined };
  const files = [{ path: "/fixture/profile.json", body: "{}\n", sha256: hash("{}\n"), kind: "profile" },
    { path: "/product/skills/yui-runtime/SKILL.md", body: "runtime\n", sha256: hash("runtime\n"), kind: "core" },
    { path: "/product/skills/yui-runtime/VERSION", sha256: hash("26\n"), kind: "inventory-only" },
    { path: "/product/skills/yui-operator/SKILL.md", body: "operator\n", sha256: hash("operator\n"), kind: "core" }];
  const inventory = files.slice(1).map(f => f.path).reverse().join("\n") + "\n";
  const command = "cat /fixture/profile.json && rg --files /product/skills/yui-runtime /product/skills/yui-operator";
  const make = (cmd = command, out = files[0].body + inventory) => {
    const e = item(cmd, out, []); e.binding = b; e.message.params.item.cwd = "/fixture"; return e;
  };
  const good = nativeEvidence([make()], files)[0];
  assert.equal(good.loads.length, 1);
  assert.equal(good.inventories.length, 1);
  assert.equal(good.trace.length, 0);
  const withCwd = nativeEvidence([make(`pwd && ${command}`, `/fixture\n${files[0].body}${inventory}`)], files)[0];
  assert.equal(withCwd.loads.length, 1);
  assert.equal(withCwd.inventories.length, 1);
  for (const e of [make(command + " && touch /write"), make(command, files[0].body + inventory.slice(0, -2)),
    make(command, files[0].body + inventory + "noise\n"), make(command.replace("--files", "--files --hidden")),
    make(command.replace("yui-operator", "yui-leader")), make(command, files[0].body + inventory + files[1].path + "\n")])
    assert.equal(nativeEvidence([e], files)[0].loads.length, 0);
  assert.equal(nativeEvidence([make(command.slice(command.indexOf("rg ")), inventory)], files)[0].loads.length, 0);
});
test("static file bytes survive a bound claim tail without certifying its effect or ordering", () => {
  const b = { ...binding, home: "/fixture/state" };
  const file = { path: "/product/reference.md", body: "complete 原文\n", kind: "topic",
    sha256: hash("complete 原文\n"), bytes: Buffer.byteLength("complete 原文\n") };
  const claim = "/fixture/bin/yui inbox claim message-1 --request-id claim-1 --json";
  const receipt = JSON.stringify({ ok: true, data: { id: "message-1", inbox: { claim: {
    requestId: "claim-1", actor: { scope: "task", taskId: "task-1", roleName: "leader",
      nativeSessionId: "ld" }, at: "2026-10-24T00:00:03Z" } } } }) + "\n";
  const make = (command = `cat ${file.path} && ${claim}`, output = file.body + receipt) => ({
    command, aggregatedOutput: output, cwd: "/fixture", status: "completed", exitCode: 0 });
  const parsed = native.staticReadSequence(make(), b, [file], "ld", "turn-2");
  assert.equal(parsed.status, "recognized");
  assert.equal(parsed.segments[0].reads[0].body, file.body);
  assert.equal(parsed.segments[1].kind, "uncredited-suffix");
  const e = item(make().command, make().aggregatedOutput, [], 4);
  e.binding = b; e.message.params.item.cwd = "/fixture";
  const bundles = nativeEvidence([e], [file]);
  assert.equal(bundles[0].loads.length, 1);
  assert.equal(bundles[0].trace.length, 0, "No write/read trace or successful effect inferred from claim tail");
  assert.equal(bundles[0].loads[0].compound.atomExitStatus, "not-observed");
  const required = [file];
  assert.equal(gradeLoads(bundles, required, scope).status, "pass");
  for (const changed of [{ ...scope, threadId: "other" }, { ...scope, roleName: "operator" },
    { ...scope, taskId: "foreign" }, { ...scope, epoch: 1 },
    { ...scope, beforeAt: "2026-10-24T00:00:03Z" }])
    assert.notEqual(gradeLoads(bundles, required, changed).status, "pass");
  const diagnostic = JSON.stringify({ ok: false, code: "DENIED", message: "fixture failure",
    details: { diagnostic: { home: b.home, cli: "/product/dist/cli.js", operation: "yui inbox claim" } } }) + "\n";
  const failed = { ...make(undefined, file.body + diagnostic), exitCode: 1, status: "failed" };
  assert.equal(native.staticReadSequence(failed, b, [file], "ld", "turn-2").status, "recognized");
  const failedEvent = structuredClone(e);
  Object.assign(failedEvent.message.params.item, failed);
  const failedBundles = nativeEvidence([failedEvent], [file]);
  assert.equal(failedBundles[0].loads.length, 1);
  assert.equal(failedBundles[0].loads[0].compound.parentExitCode, 1);
  assert.equal(failedBundles[0].loads[0].compound.parentStatus, "failed");
  assert.equal(failedBundles[0].complete, false);
  assert.equal(failedBundles[0].trace.length, 0);
  for (const bad of [
    make(undefined, file.body.slice(0, -2) + receipt), make(undefined, "noise" + file.body + receipt),
    make(`printf 'complete 原文\\n' && ${claim}`), make(`cat foreign.md && ${claim}`),
    make(undefined, file.body + receipt.replace('"ld"', '"foreign"')),
    make(undefined, file.body + receipt.replace('"claim-1"', '"other"')),
    make(undefined, file.body + receipt + "{}"), make(`cat ${file.path} && unknown-mutation`, file.body),
    make(`cat ${file.path} && ${claim} && cat ${file.path}`, file.body + receipt + file.body),
    make(`cat ${file.path} && $CLI inbox claim message-1`, file.body + receipt),
    { ...failed, aggregatedOutput: file.body + "arbitrary failure\n" },
  ]) assert.equal(native.staticReadSequence(bad, b, [file], "ld", "turn-2").status, "unsupported");
  assert.equal(native.staticReadSequence(make(), b, [{ ...file, sha256: "wrong" }], "ld", "turn-2").status, "unsupported");
  const refs = { ok: true, data: { context: { source: `run:task-1/run-1/refs/${"a".repeat(64)}`,
    digest: "b".repeat(64), items: [], total: 0, complete: true, nextCursor: null } } };
  const refsCmd = "/fixture/bin/yui task run context task-1/run-1 --view refs --json";
  const mixed = make(`${refsCmd} && cat ${file.path}`, JSON.stringify(refs) + "\n" + file.body);
  assert.equal(native.staticReadSequence(mixed, b, [file], "ld", "turn-2").status, "recognized");
  assert.equal(native.staticReadSequence({ ...mixed,
    aggregatedOutput: mixed.aggregatedOutput.replace("run:task-1/", "run:foreign/") },
  b, [file], "ld", "turn-2").status, "unsupported");
});
test("static originals survive a bound claim between exact inbox and wake reads", () => {
  const b = { ...binding, home: "/fixture/state" }, cli = "/fixture/bin/yui";
  const original = { taskId: "task-1", id: "message-6", body: "complete exact 原文" };
  const receipt = { ok: true, data: { id: "wake-3", inbox: { claim: {
    requestId: "claim-3", actor: { scope: "task", taskId: "task-1", roleName: "leader",
      nativeSessionId: "ld" }, at: "2026-10-24T00:00:03Z" } } } };
  const doc = v => JSON.stringify(v) + "\n";
  const command = `${cli} inbox show wake-3 --json && ${cli} inbox claim wake-3 --request-id claim-3 --json && ${cli} task wake show task-1 wake-3 --json && ${cli} task message show task-1/message-6 --json`;
  const output = doc({ ok: true, data: { taskId: "task-1", id: "wake-3" } }) + doc(receipt)
    + doc({ ok: true, data: { taskId: "task-1", wake: { taskId: "task-1", id: "wake-3" } } })
    + doc({ ok: true, data: original });
  const make = (cmd = command, out = output) => {
    const e = item(cmd, out, [], 4); e.binding = b; e.message.params.item.cwd = "/fixture"; return e;
  };
  const grade = (e = make(), s = scope) => gradeReads(nativeEvidence([e]), [original], s);
  assert.equal(grade().status, "pass");
  const bundle = nativeEvidence([make()])[0];
  assert.equal(bundle.trace.length, 3, "Claim output is boundary evidence only, never a successful read/effect");
  assert.equal(bundle.trace.every(t => t.compound.atomExitStatus === "not-observed"), true);
  for (const bad of [
    make(undefined, output.slice(0, -2)), make(undefined, output + "{}"),
    make(undefined, output.replace('"nativeSessionId":"ld"', '"nativeSessionId":"foreign"')),
    make(undefined, output.replace('"requestId":"claim-3"', '"requestId":"other"')),
    make(undefined, output.replace('"id":"message-6"', '"id":"other"')),
    make(command.replace("inbox claim", "inbox ack")),
    make(command.replace(`${cli} inbox claim`, "$CLI inbox claim")),
  ]) assert.notEqual(grade(bad).status, "pass");
  for (const s of [{ ...scope, threadId: "other" }, { ...scope, taskId: "other" },
    { ...scope, epoch: 1 }, { ...scope, beforeAt: "2026-10-24T00:00:03Z" }])
    assert.notEqual(grade(undefined, s).status, "pass");
});
test("continuation requires exact native operation endpoints even when only read observability is unknown", () => {
  const b = { roleName: "operator", home: "/fixture/state", cli: "/fixture/bin/yui", product: "/product" };
  const r = (direction, message, n) => ({ direction, message, binding: b, sourceConnection: "owned",
    at: `2026-10-24T00:00:0${n}Z` });
  const raw = [
    r("host", { id: "s", method: "thread/start", params: { cwd: "/fixture" } }, 0),
    r("native", { id: "s", result: { thread: { id: "op" } } }, 1),
    r("host", { id: "t", method: "turn/start", params: { threadId: "op" } }, 1),
    r("native", { id: "t", result: { turn: { id: "turn" } } }, 2),
    r("native", { method: "turn/started", params: { threadId: "op", turn: { id: "turn" } } }, 2),
    r("native", { method: "item/started", params: { threadId: "op", turnId: "turn",
      item: { id: "tool", type: "commandExecution" } } }, 3),
    r("native", { method: "item/completed", params: { threadId: "op", turnId: "turn",
      item: { id: "tool", type: "commandExecution", status: "completed", exitCode: 0 } } }, 4),
    r("native", { method: "turn/completed", params: { threadId: "op", turn: { id: "turn", status: "completed" } } }, 5),
  ];
  const terminal = { binding: b, threadId: "op", turnId: "turn", status: "completed", startedAt: raw[4].at, at: raw[7].at };
  assert.equal(native.nativeContinuationProof(raw, terminal).status, "pass");
  // A result notice may start another owned Turn just after the business
  // terminal. Wait for its real endpoint, never credit the older terminal.
  const withNotice = [...raw,
    r("host", { id: "notice", method: "turn/start", params: { threadId: "op" } }, 6),
    r("native", { id: "notice", result: { turn: { id: "notice-turn" } } }, 6),
    r("native", { method: "turn/started", params: { threadId: "op", turn: { id: "notice-turn" } } }, 6)];
  assert.equal(native.nativeContinuationProof(withNotice, terminal).pending, true);
  assert.equal(native.nativeContinuationProof([...withNotice,
    r("native", { method: "turn/completed", params: { threadId: "foreign",
      turn: { id: "notice-turn", status: "completed" } } }, 7)], terminal).status, "unknown");
  assert.equal(native.nativeContinuationProof([...withNotice,
    r("native", { method: "turn/completed", params: { threadId: "op",
      turn: { id: "notice-turn", status: "completed" } } }, 7)], terminal).status, "pass");
  for (const records of [
    raw.filter(e => e.message?.method !== "item/completed"),
    [...raw, r("host", { id: "pending", method: "thread/read", params: { threadId: "op" } }, 4)],
    [...raw, { sourceConnection: "owned", invalidFrame: true }],
    raw.map(e => ({ ...e, binding: { ...b, home: "/foreign" } })),
  ]) {
    const proof = native.nativeContinuationProof(records, terminal);
    assert.equal(proof.status, "unknown");
    assert.notEqual(proof.pending, true, "Identity/RPC/tool gaps are not merely an active Turn");
  }
});
test("planned transport close needs custody, successful control, terminal and empty native background proof", () => {
  const b = { roleName: "operator", home: "/fixture/state" };
  const r = (direction, message, second, extra = {}) => ({ direction, message, binding: b,
    at: `2026-10-24T00:00:0${second}Z`, sourceConnection: "managed", ...extra });
  const child = { pid: 123, start: "456" };
  const raw = [
    r("custody", undefined, 0, { child }),
    r("host", { id: "s", method: "thread/start", params: { cwd: "/fixture" } }, 0),
    r("native", { id: "s", result: { thread: { id: "op" } } }, 1),
    r("host", { id: "t", method: "turn/start", params: { threadId: "op" } }, 1),
    r("native", { id: "t", result: { turn: { id: "turn" } } }, 2),
    r("native", { method: "turn/completed", params: { threadId: "op", turn: { id: "turn", status: "completed" } } }, 3),
    r("stop-signal", undefined, 6, { signal: "SIGTERM", child }),
    r("exit", undefined, 7, { protocol: "app-server-ws", signal: "SIGTERM", code: null }),
  ];
  const control = { args: ["session", "stop", "--all"], startedAt: "2026-10-24T00:00:04Z",
    at: "2026-10-24T00:00:08Z", result: { stopped: [{ nativeSessionId: "op" }], blocked: [] } };
  const snapshot = ["thread/read", "thread/backgroundTerminals/clean", "thread/backgroundTerminals/list"].flatMap((method, i) =>
    [{ sourceConnection: "control", direction: "host", at: `2026-10-24T00:00:04.${i}00Z`,
      message: { id: i, method, params: { threadId: "op" } } },
    { sourceConnection: "control", direction: "native", at: `2026-10-24T00:00:05.${i}00Z`, message: { id: i },
      controlObservation: { requestId: i, method, threadId: "op", success: true,
        ...(i === 0 ? { status: "idle", noActiveTurn: true } : i === 2 ? { backgroundEmpty: true } : {}) } }]);
  const teardown = { controls: [control], custody: [{ connection: "managed", child, alive: false }] };
  assert.equal(rejectedNativeCleanup([...raw, ...snapshot], teardown).plannedCloses.length, 1);
  assert.equal(rejectedNativeCleanup([...raw, ...snapshot], teardown).status, "no-rejected-startup");
  const leader = { ...b, roleName: "leader", taskId: "task-1" };
  const checkpointRaw = raw.map(e => ({ ...e, binding: leader,
    ...(e.message?.method === "thread/start" ? { message: { ...e.message, params: {
      cwd: "/fixture/state/runtime/task-runtimes/planning/task-1" } } } : {}) }));
  const checkpointControl = { args: ["task", "role", "session", "stop", "task-1", "leader"],
    startedAt: control.startedAt, at: control.at,
    result: { taskId: "task-1", roleName: "leader", stopped: true },
    inspection: { at: "2026-10-24T00:00:09Z", result: { taskId: "task-1", roleName: "leader",
      session: { nativeSessionId: "op", status: "ended" } } } };
  assert.equal(rejectedNativeCleanup([...checkpointRaw, ...snapshot], {
    ...teardown, controls: [checkpointControl] }).plannedCloses.length, 1,
  "The actual earlier checkpoint stop, not a later empty --all result, owns this transport close");
  for (const inspection of [undefined, { ...checkpointControl.inspection,
    result: { ...checkpointControl.inspection.result, session: { nativeSessionId: "other", status: "ended" } } }])
    assert.equal(rejectedNativeCleanup([...checkpointRaw, ...snapshot], {
      ...teardown, controls: [{ ...checkpointControl, inspection }] }).status, "unknown");
  const repeated = [...raw.slice(0, -1), { ...raw.at(-2) }, raw.at(-1)];
  const sameMillisecond = snapshot.map(e => ({ ...e, at: "2026-10-24T00:00:05Z" }));
  const coalesced = rejectedNativeCleanup([...repeated, ...sameMillisecond], teardown);
  assert.equal(coalesced.plannedCloses.length, 1,
    "Repeated same-child stop signals and ordered same-ms RPCs preserve exact quiescence evidence");
  assert.equal(coalesced.plannedCloses[0].signalAts.length, 2);
  for (const records of [
    [sameMillisecond[1], sameMillisecond[0], ...sameMillisecond.slice(2)],
    [...sameMillisecond.slice(2, 4), ...sameMillisecond.slice(0, 2), ...sameMillisecond.slice(4)],
  ]) assert.equal(rejectedNativeCleanup([...repeated, ...records], teardown).status, "unknown",
    "A shared timestamp never supplies missing append order");
  assert.equal(rejectedNativeCleanup([...repeated, ...sameMillisecond], { ...teardown,
    controls: [{ ...control, startedAt: "2026-10-24T00:00:06.500Z" }] }).status, "unknown");
  assert.equal(rejectedNativeCleanup(raw, teardown).status, "unknown", "SIGTERM alone proves no settlement");
  for (const records of [
    [...raw.filter(e => e.message?.method !== "turn/completed"), ...snapshot],
    [...raw.filter(e => e.direction !== "stop-signal"), ...snapshot],
    [...raw, ...snapshot.map(e => ({ ...e, controlObservation: { ...e.controlObservation, threadId: "foreign" } }))],
    [...raw, ...snapshot, r("host", { id: "pending", method: "thread/read", params: { threadId: "op" } }, 5)],
    [...raw, ...snapshot, { sourceConnection: "managed", invalidFrame: true }],
  ]) assert.equal(rejectedNativeCleanup(records, teardown).status, "unknown");
  assert.equal(rejectedNativeCleanup([...raw, ...snapshot], { ...teardown,
    custody: [{ connection: "managed", child: { ...child, start: "reused" }, alive: false }] }).status, "unknown");
});
test("native cleanup projection retains only exact response status, never Thread bodies or credentials", () => {
  const q = { id: 7, method: "thread/read", params: { threadId: "owned" } };
  const response = { id: 7, result: { thread: { id: "owned", status: { type: "idle" },
    turns: [{ status: "completed", text: "private-body" }] }, secret: "private-secret" } };
  assert.deepEqual(nativeControlObservation(q, response), {
    requestId: 7, method: "thread/read", threadId: "owned", success: true, status: "idle", noActiveTurn: true });
  assert.equal(nativeControlObservation(q, { ...response, id: 8 }), undefined);
  assert.equal(nativeControlObservation(q, { id: 7, error: { code: -1 } }).success, false);
  assert.equal(nativeControlObservation(q, { id: 7, result: { thread: { id: "foreign", status: "idle" } } }).status, undefined);
  assert.equal(nativeControlObservation(q, { id: 7, result: { thread: {
    id: "owned", status: "idle", turns: [{ id: "other", status: "inProgress" }] } } }).noActiveTurn, false);
  const list = { ...q, method: "thread/backgroundTerminals/list" };
  assert.equal(nativeControlObservation(list, { id: 7, result: { data: [], nextCursor: null } }).backgroundEmpty, true);
  for (const result of [{ data: [{}] }, { data: [], nextCursor: "more" }, {}])
    assert.equal(nativeControlObservation(list, { id: 7, result }).backgroundEmpty, false);
});
test("append-only transport waits for newline without swallowing corrupt complete records", () => {
  const first = JSON.stringify(event("turn/started", { threadId: "ld", turn: { id: "t" } }, 1));
  const second = JSON.stringify(event("turn/completed", { threadId: "ld", turn: { id: "t", status: "completed" } }, 2));
  const prefix = `${first}\n${second.slice(0, 50)}`;
  const pending = completeJsonLines(prefix);
  assert.equal(pending.records.length, 1);
  assert.equal(pending.tail.bytes, Buffer.byteLength(second.slice(0, 50)));
  const target = { since: "2026-10-24T00:00:00Z", roleName: "leader", taskId: "task-1" };
  assert.equal(selectTerminal(pending.records, target), null);
  const complete = completeJsonLines(`${first}\n${second}\n`);
  assert.equal(complete.records.length, 2);
  assert.equal(complete.tail, undefined);
  assert.equal(selectTerminal(complete.records, target).status, "completed");
  assert.equal(nativeEvidence([...complete.records, { invalidFrame: pending.tail }])[0].complete, false);
  assert.throws(() => completeJsonLines(`${first}\n{bad}\n`), SyntaxError);
});
test("exact segmented instruction output joins only frozen bytes in the same context", () => {
  const f = { path: "/product/skills/runtime/SKILL.md", body: "one\ntwo\nthree\n", kind: "core",
    bytes: 14, sha256: hash("one\ntwo\nthree\n") };
  const aux = { path: "/product/skills/runtime/references/r.md", body: "AUX\n", bytes: 4, sha256: hash("AUX\n") };
  const first = item("sed -n '1,2p' /product/skills/runtime/SKILL.md && cat /product/skills/runtime/references/r.md",
    "one\ntwo\nAUX\n", [
      { type: "read", command: `sed -n '1,2p' ${f.path}`, path: f.path },
      { type: "read", command: `cat ${aux.path}`, path: aux.path },
    ]);
  first.message.params.turnId = "turn-1";
  const last = item(`sed -n '3,9p' ${f.path}`, "three\n",
    [{ type: "read", command: `sed -n '3,9p' ${f.path}`, path: f.path }], 3);
  const events = [first, last], files = [f, aux];
  const grade = gradeLoads(nativeEvidence(events, files), [f], { ...scope, afterAt: last.at });
  assert.equal(grade.status, "pass");
  assert.equal(grade.coverage[0].coveredBytes, f.bytes);
  assert.equal(grade.contextAvailability, "unknown");
  for (const bad of [
    { ...scope, threadId: "successor" }, { ...scope, epoch: 1 }, { ...scope, beforeAt: first.at },
  ]) assert.notEqual(gradeLoads(nativeEvidence(events, files), [f], bad).status, "pass");
  const truncated = structuredClone(last);
  truncated.message.params.item.aggregatedOutput = "thre";
  assert.notEqual(gradeLoads(nativeEvidence([first, truncated], files), [f], scope).status, "pass");
  assert.notEqual(gradeLoads(nativeEvidence(events, files), [{ ...f, sha256: hash("changed") }], scope).status, "pass");
});
test("immutable material reads may reuse exact prior-Turn output; new disposition originals cannot", () => {
  const source = { taskId: "task-1", id: "source", body: "ORIGINAL" };
  const prior = item("yui task message show task-1/source --json", JSON.stringify({ data: source }), []);
  prior.message.params.turnId = "turn-1";
  const traces = nativeEvidence([prior]), warm = { ...scope, afterAt: "2026-10-24T00:00:02Z" };
  assert.notEqual(gradeReads(traces, [source], warm).status, "pass");
  const retained = gradeReads(traces, [source], warm, { reuse: true });
  assert.equal(retained.status, "pass");
  assert.equal(retained.contextAvailability, "unknown");
  assert.equal(retained.reused.length, 1);
  assert.notEqual(gradeReads(traces, [{ ...source, body: "UPDATED" }], warm, { reuse: true }).status, "pass");
  for (const changed of [{ epoch: 1 }, { threadId: "successor" }, { roleName: "operator" }])
    assert.notEqual(gradeReads(traces, [source], { ...warm, ...changed }, { reuse: true }).status, "pass");
});
test("single multi-file cat expands only frozen direct md entries and verifies the whole output", () => {
  const file = (path, body) => ({ path, body, bytes: Buffer.byteLength(body), sha256: hash(body) });
  const files = [file("/product/skills/runtime/SKILL.md", "CORE\n"),
    file("/product/skills/runtime/references/b.md", "B\n"), file("/product/skills/runtime/references/a.md", "A\n"),
    file("/product/skills/runtime/references/nested/c.md", "NOT DIRECT\n")];
  const command = "/usr/bin/zsh -c 'cat /product/skills/runtime/SKILL.md /product/skills/runtime/references/*.md'";
  const read = item(command, "CORE\nA\nB\n", [{ type: "unknown", command }]);
  assert.equal(gradeLoads(nativeEvidence([read], files), files.slice(0, 3), scope).status, "pass");
  for (const text of ["CORE\nB\nA\n", "CORE\nA\n", "CORE\nA\nB\nextra"]) {
    const bad = structuredClone(read); bad.message.params.item.aggregatedOutput = text;
    assert.notEqual(gradeLoads(nativeEvidence([bad], files), files.slice(0, 3), scope).status, "pass");
  }
  const compound = structuredClone(read);
  compound.message.params.item.command = `${command} && echo extra`;
  assert.notEqual(gradeLoads(nativeEvidence([compound], files), files.slice(0, 3), scope).status, "pass");
  assert.notEqual(gradeLoads(nativeEvidence([read], files), [files[3]], scope).status, "pass");
});
