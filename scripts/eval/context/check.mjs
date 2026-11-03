import assert from "node:assert/strict";
import test from "node:test";
import "./original-reader.check.mjs";
import "./original-evidence.check.mjs";
import "./business.check.mjs";
import "./cli-receipt.check.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { gradeHandling, gradeBusiness, gradeLoads, gradeReads, instructionLoadCosts, outcome, comparable, forbiddenFileChanges, stageAllowsContinuation, stageVerdict, gradeRoutedInput } from "./judge.mjs";
import { tokenTotals } from "../adapters/codex/usage.mjs";
import { parseOptions, hash, treeHashes, currentPlanningContract, redactTransport, planningReferences, chainStages, routesStage } from "./common.mjs";
import { observedDimensions, compareObservedStages } from "./dimensions.mjs";
import * as dimensions from "./dimensions.mjs";
import * as judge from "./judge.mjs";
import { reportingCarrier, taskFactsAction, gradeInstructionObligations } from "./obligations.mjs";
import * as obligations from "./obligations.mjs";
import { instrumentedCliCosts } from "./quantify.mjs";
test("CLI cost counts owned process receipts, not shell words or native tool items", () => {
  const binding = { roleName: "leader", cli: "/f/bin/yui", product: "/p", home: "/f/state", node: "/node" };
  const owner = { ...binding, threadId: "thread-1" };
  const start = { id: "p1", phase: "started", entry: binding.cli, cli: "/p/output/dev/bin/yui",
    product: "/p", home: "/f/state", node: "/node", threadId: "thread-1", cwd: "/f",
    launcherSha256: "launcher", at: "2026-11-03T00:00:00.000Z", args: ["inbox", "show", "wake-1"] };
  const end = { ...start, phase: "completed", startedAt: start.at,
    at: "2026-11-03T00:00:00.100Z", code: 0, signal: null };
  const second = { ...start, id: "p2" }, failed = { ...end, id: "p2", code: 1 };
  const pending = { ...start, id: "p3" };
  const foreign = { ...start, id: "foreign", home: "/foreign" };
  const result = instrumentedCliCosts([start, end, end, second, failed, pending, foreign], [owner], "launcher");
  assert.equal(result.status, "partial");
  assert.deepEqual(result.threads, [{ role: "leader", threadId: "thread-1", started: 3, completed: 2, failed: 1, unclosed: 1 }]);
  assert.equal(result.unmatchedRecords, 1);
  const conflict = instrumentedCliCosts([start, end, { ...end, code: 1 }], [owner], "launcher");
  assert.equal(conflict.ambiguousIds, 1);
  assert.equal(conflict.threads[0].unclosed, 1);
  assert.equal(instrumentedCliCosts([start, { ...end, args: ["inbox", "ack", "wake-1"] }],
    [owner], "launcher").threads[0].completed, 0);
  assert.deepEqual(instrumentedCliCosts([start, end], [owner], "wrong-launcher").threads, []);
  assert.equal(instrumentedCliCosts([], [owner], "launcher").status, "partial", "Missing receipts do not prove no CLI calls");
});
test("initial planning dispatch is captured while routing is active, never guessed after it clears", () => {
  const run = { id: "run-1", taskId: "task-1", roleName: "leader", purpose: "planning", effective: { agentId: "codex" } };
  const dispatch = { owner: "planning:run-1", batchId: "turn:task-1/run-1",
    executionRef: { type: "run", taskId: "task-1", id: "run-1" },
    batch: { refs: [{ type: "message", taskId: "task-1", id: "message-3" }] } };
  const state = { turns: [{ payload: JSON.stringify(run) }], mailboxes: [{ processing: JSON.stringify(dispatch) }] };
  const select = s => judge.initialPlanningBinding(s, "task-1", "message-3");
  const captured = select(state);
  assert.deepEqual(captured, { dispatch, run });
  const ended = { ...state, mailboxes: [{ processing: null }] };
  assert.equal(select(ended), undefined, "A completed Run alone cannot reconstruct its old dispatch");
  assert.deepEqual(captured.dispatch, dispatch, "Retain the actual earlier observation while Operator finishes");
  for (const bad of [
    { ...state, mailboxes: [...state.mailboxes, ...state.mailboxes] },
    { ...state, turns: [{ payload: JSON.stringify({ ...run, taskId: "foreign" }) }] },
    { ...state, mailboxes: [{ processing: JSON.stringify({ ...dispatch, owner: "planning:foreign" }) }] },
    { ...state, mailboxes: [{ processing: JSON.stringify({ ...dispatch,
      batch: { refs: [{ type: "message", taskId: "foreign", id: "message-3" }] } }) }] },
  ]) assert.equal(select(bad), undefined);
});
test("owned accepted Host notices can establish metadata, never instruction bodies", () => {
  const expected = [{ id: "yui-runtime", path: "/product/skills/yui-runtime", version: "25", versionPath: "/product/skills/yui-runtime/VERSION" }];
  const manifestPath = "/owned/runtime/session-manifests/m.json";
  const home = "/owned", profileDigest = hash("profile");
  const profilePath = `${home}/runtime/role-profiles/${profileDigest}.json`;
  const manifestFile = (patch = {}) => {
    const body = JSON.stringify({ owner: { scope: "task", taskId: "task-1" }, roleKind: "leader",
      skills: expected, roleProfileRef: { path: profilePath, digest: profileDigest }, ...patch });
    return { path: manifestPath, body, bytes: Buffer.byteLength(body), sha256: hash(body), kind: "manifest" };
  };
  const sources = [manifestFile()];
  const line = "Yui Host checked current Skills; no Agent version-check call is needed for this input.";
  const reminder = "On compaction or missing/uncertain instructions, reload required instructions; unchanged versions do not prove memory.";
  const cold = `${line}\nYui Session Manifest: ${manifestPath}\nFirst input or recovered attachment: read its Role profile and fully load the current applicable instructions.\nCurrent Skill pointers: [{"id":"yui-runtime","path":"/product/skills/yui-runtime","version":"25"}]\nMetadata is not a loading receipt. Complete required files through EOF; follow only applicable references.\n${reminder}\n\nbusiness`;
  const pair = (text, turnId, at, sourceConnection = "owned") => [
    { at, sourceConnection, binding: { roleName: "leader", taskId: "task-1", manifestPath, home },
      direction: "host", message: { id: turnId, method: "turn/start", params: { threadId: "thread", input: [{ type: "text", text }] } } },
    { at, sourceConnection, direction: "native", message: { id: turnId, result: { turn: { id: turnId } } } },
  ];
  const scope = { ...proofScope, turnId: "warm" };
  const events = [...pair(cold, "cold", "2026-10-24T00:00:01Z"),
    ...pair(`${line}\n${reminder}\n\nnext`, "warm", "2026-10-24T00:00:02Z")];
  const grade = (e = events, s = scope, files = sources) => obligations.gradeHostSkillCheck?.(e, expected, s, files);
  assert.equal(grade()?.status, "pass");
  assert.equal(grade().mode, "unchanged");
  assert.ok(grade().prefixUtf8 < Buffer.byteLength(cold));
  assert.equal(judge.gradeSkillBinding([], expected, scope, grade()).status, "pass");
  assert.equal(gradeLoads([], [{ path: expected[0].path + "/SKILL.md", body: "body", sha256: hash("body"), bytes: 4 }], scope).status, "unknown");
  for (const bad of [events.slice(2), events.filter(e => !(e.message.id === "cold" && e.direction === "native")),
    events.map(e => e.direction === "host" && e.message.id === "cold"
      ? { ...e, message: { ...e.message, params: { ...e.message.params, input: [{ text: cold.replace('"25"', '"wrong"') }] } } } : e),
    [...pair(cold, "cold", "2026-10-24T00:00:01Z", "foreign"), ...events.slice(2)]])
    assert.notEqual(grade(bad)?.status, "pass");
  assert.equal(grade(events, { ...scope, beforeAt: "2026-10-24T00:00:02Z" }).status, "unknown");
  const newCold = cold.replace(
    "First input or recovered attachment: read its Role profile and fully load the current applicable instructions.",
    `First input or recovered attachment: before any Task/context read, read the exact Role profile at ${profilePath}, then the full current Runtime, Role and applicable references. A Task role-profile projection is not this profile.`);
  const fresh = [...pair(newCold, "cold", "2026-10-24T00:00:01Z"), ...events.slice(2)];
  assert.equal(grade(fresh, { ...scope, turnId: "cold" }).mode, "cold-or-recovery");
  assert.equal(grade(fresh).status, "pass", "New exact cold pointers must seed the accepted same-owner warm chain");
  assert.equal(gradeLoads([], [{ path: profilePath, body: "profile", sha256: profileDigest, bytes: 7 }],
    scope).status, "unknown", "Host profile metadata cannot supply body credit");
  const changedCold = text => [...pair(text, "cold", "2026-10-24T00:00:01Z"), ...events.slice(2)];
  for (const bad of [
    changedCold(newCold.replace(profilePath, "/foreign/profile.json")),
    changedCold(newCold.replace(manifestPath, "/foreign/manifest.json")),
    changedCold(newCold.replace("Current Skill pointers:", "Missing Skill pointers:")),
    changedCold(newCold.replace("/product/skills/yui-runtime", "/foreign/skills/yui-runtime")),
    changedCold(newCold.replace('"25"', '"wrong"')),
    fresh.filter(e => !(e.message.id === "cold" && e.direction === "native")),
    [...fresh, fresh[1]],
    [...fresh, { ...fresh[1], at: scope.beforeAt }].filter(e => e !== fresh[1]),
    [...pair(newCold, "cold", "2026-10-24T00:00:01Z", "foreign"), ...events.slice(2)],
    fresh.map(e => e.direction === "host" && e.message.id === "cold"
      ? { ...e, binding: { ...e.binding, taskId: "foreign" } } : e),
    fresh.map(e => e.direction === "host" && e.message.id === "cold"
      ? { ...e, binding: { ...e.binding, roleName: "operator" } } : e),
    fresh.map(e => e.direction === "host" && e.message.id === "cold"
      ? { ...e, binding: { ...e.binding, home: "/foreign" } } : e),
    fresh.map(e => e.direction === "host" && e.message.id === "cold"
      ? { ...e, message: { ...e.message, params: { ...e.message.params, threadId: "foreign" } } } : e),
  ]) assert.equal(grade(bad).status, "unknown");
  for (const files of [[], [manifestFile({ owner: { scope: "task", taskId: "foreign" } })],
    [manifestFile({ roleKind: "operator" })], [manifestFile({ skills: [] })],
    [manifestFile({ roleProfileRef: { path: "/foreign/profile.json", digest: profileDigest } })],
    [{ ...sources[0], sha256: "wrong" }], [sources[0], sources[0]]])
    assert.equal(grade(fresh, scope, files).status, "unknown");
  // Main 72e1dd5b checks ordinary inputs without reprinting a recovery rule.
  const shortLine = "Yui Host checked current Skills; no Agent check needed.";
  const workingSetCold = `${shortLine}\nYui Session Manifest: ${manifestPath}\nFirst input or recovered attachment: read the exact Role profile at ${profilePath} and the full current listed Skill entry points. Follow references only for the action you are taking, not to restore every previously used procedure. A Task role-profile projection is not this profile.\nCurrent Skill pointers: [{"id":"yui-runtime","path":"/product/skills/yui-runtime","version":"25"}]\nMetadata is not a loading receipt. Read each required file through EOF; if output is truncated, finish the missing ranges. Recover missing instructions for the current task, not the whole manual.\n\nbusiness`;
  const workingSet = [...pair(workingSetCold, "cold", "2026-10-24T00:00:01Z"),
    ...pair(`${shortLine}\n\nnext`, "warm", "2026-10-24T00:00:02Z")];
  assert.equal(grade(workingSet).status, "pass");
  assert.equal(grade(workingSet, { ...scope, turnId: "cold" }).mode, "cold-or-recovery");
  assert.ok(grade(workingSet).prefixUtf8 < grade(fresh).prefixUtf8);
  for (const bad of [
    workingSet.slice(2),
    [...pair(workingSetCold.replace(profilePath, "/foreign/profile.json"), "cold", "2026-10-24T00:00:01Z"), ...workingSet.slice(2)],
    [...pair(workingSetCold, "cold", "2026-10-24T00:00:01Z", "foreign"), ...workingSet.slice(2)],
    [...workingSet.slice(0, 2), ...pair(`${shortLine}\nextra unbound marker\n\nnext`, "warm", "2026-10-24T00:00:02Z")],
  ]) assert.equal(grade(bad).status, "unknown");
  assert.equal(gradeLoads([], [{ path: profilePath, body: "profile", sha256: profileDigest, bytes: 7 }],
    scope).status, "unknown", "The shorter marker still gives metadata, never load credit");
});
const proofScope = { taskId: "task-1", roleName: "leader", threadId: "thread", turnId: "turn",
  epoch: 0, beforeAt: "2026-10-24T00:00:05Z" };
test("context manual applicability follows owned expansion, not ordinary reads or warm turns", () => {
  const scope = { ...proofScope, loadActions: { business: { status: "observed", at: proofScope.beforeAt } } };
  const trace = args => [{ scope, trace: [{ args, nativeItemId: "cmd" }] }];
  const events = [{ at: "2026-10-24T00:00:02Z", message: { method: "item/started",
    params: { threadId: "thread", turnId: "turn", item: { id: "cmd" } } } }];
  const grade = args => obligations.contextExpansionAction(trace(args), events, scope);
  for (const args of [
    ["task", "run", "context", "expand", "task-1/run-1", "message-1", "--store", "task-message"],
    ["task", "run", "context", "task-1/run-1", "--view", "full"],
    ["task", "context", "list", "task-1", "--store", "task-message"],
    ["task", "message", "show", "task-1/message-1", "--cursor", "next"],
  ]) assert.equal(grade(args).status, "observed");
  for (const args of [
    ["task", "context", "task-1"], ["task", "message", "show", "task-1/message-1"],
    ["session", "skills"], ["inbox", "ack", "wake-1", "--reason", "done"],
  ]) assert.equal(grade(args).status, "not-observed");
  const args = ["task", "context", "inspect", "task-1"];
  assert.equal(obligations.contextExpansionAction(trace(args), [], scope).status, "unknown");
  assert.equal(obligations.contextExpansionAction(trace(args), events, { ...scope, threadId: "other" }).status, "not-observed");
  const action = grade(args), body = "complete manual";
  const file = { path: "/skills/context-reads.md", body, bytes: body.length, sha256: hash(body), kind: "topic", action };
  const load = at => [{ scope, loads: [{ ...file, complete: true, at }], trace: [] }];
  assert.equal(gradeLoads(load("2026-10-24T00:00:01Z"), [file], scope).status, "pass");
  assert.notEqual(gradeLoads(load("2026-10-24T00:00:03Z"), [file], scope).status, "pass");
});
test("reporting carrier migration preserves action-timed full-byte obligation and unknown versions", () => {
  for (const [version, sha256] of [
    ["20", "ce8967bb8d0cbfabf42204ffa93889989c13834eec75d17199ba0e08e615379a"],
    ["25", "b963043bd70639164437203e544dd7614548782fdf48643c596adbe3c3e91c26"],
    ["26", "7cf7eb698a9152bab012fe1f6904e0ffcd28f333918471135156db68da9bdd0b"],
    ["29", "35689259fc083b3c79f24a27385aef5722ea9ec433008b20aedf810d5a24a2e5"],
  ]) {
    const inventory = { "yui-runtime/VERSION": { sha256: hash(version + "\n") },
      "yui-runtime/SKILL.md": { sha256 } };
    assert.equal(reportingCarrier(inventory).kind, `reviewed-inline-runtime${version}`);
    assert.equal(obligations.taskFactsCarrier(inventory).path, "yui-runtime/SKILL.md");
    assert.equal(obligations.taskFactsCarrier({ ...inventory, "yui-runtime/SKILL.md": { sha256: "wrong" } }).status, "unknown");
    assert.equal(reportingCarrier({ ...inventory, "yui-runtime/VERSION": { sha256: hash("999\n") } }).status, "unknown");
    assert.equal(reportingCarrier({ ...inventory, "yui-runtime/references/reporting.md": { sha256: "unreviewed" } }).status, "unknown");
  }
  const otherRuntime29 = { "yui-runtime/VERSION": { sha256: hash("29\n") },
    "yui-runtime/SKILL.md": { sha256: "4c5268ceda379644df3be41191daac8d4eace3a43f64f8d30a5240007ed2c94d" } };
  assert.equal(reportingCarrier(otherRuntime29).status, "unknown", "Same VERSION, different body is not this reviewed carrier");
  assert.equal(obligations.taskFactsCarrier(otherRuntime29).status, "unknown");
  const old = { "yui-runtime/references/reporting.md": {
    sha256: "a70bf140464d883a58208018d7f743455fe9ea1ea2569ebf4b9bcf5cb73fb8f4" },
    "yui-runtime/VERSION": { sha256: hash("22\n") }, "yui-runtime/SKILL.md": {
      sha256: "edc7752aca413ae3b3937f004d35a3ca5bb0b174d823c246eb06947f7b3c81b9" } };
  assert.equal(reportingCarrier(old).path, "yui-runtime/references/reporting.md");
  assert.equal(reportingCarrier({ ...old, "yui-runtime/references/reporting.md": { sha256: "wrong" } }).status, "unknown");
  const inline = { "yui-runtime/VERSION": { sha256: hash("23\n") }, "yui-runtime/SKILL.md": {
    sha256: "0a40049f834fccf7ebd08150500379a0032ff1ff2ee203746cb78e33db4b1bcf" } };
  assert.equal(reportingCarrier(inline).kind, "reviewed-inline-runtime23");
  assert.equal(reportingCarrier({ ...inline, "yui-runtime/VERSION": { sha256: hash("24\n") } }).status, "unknown");
  assert.equal(reportingCarrier({ ...inline, "yui-runtime/SKILL.md": { sha256: "wrong" } }).status, "unknown");
  const pagination = { "yui-runtime/VERSION": { sha256: hash("24\n") }, "yui-runtime/SKILL.md": {
    sha256: "1dbac0c50b767ec8b374d138ce2fe63b1e8e4ac353dcf2cfc9993ea21518c35a" } };
  assert.equal(reportingCarrier(pagination).kind, "reviewed-inline-runtime24");
  assert.equal(reportingCarrier({ ...pagination, "yui-runtime/VERSION": { sha256: hash("25\n") } }).status, "unknown");
  const body = "main\ninline reporting and retention\n", path = "/product/skills/yui-runtime/SKILL.md";
  const file = { path, body, bytes: Buffer.byteLength(body), sha256: hash(body), kind: "core" };
  const scope = { ...proofScope, loadActions: { business: { status: "observed", at: proofScope.beforeAt },
    reporting: { status: "observed", at: "2026-10-24T00:00:04Z" } } };
  const carrier = { status: "observed", path: "yui-runtime/SKILL.md", sha256: file.sha256 };
  const load = { ...file, at: "2026-10-24T00:00:02Z", startByte: 0, endByte: file.bytes,
    sourceSha256: file.sha256, complete: true };
  const grade = (l, c = carrier, s = scope) => gradeInstructionObligations(
    [{ scope: proofScope, trace: [], loads: l, complete: false }],
    [{ ...file, action: { status: "observed", at: proofScope.beforeAt } }], s, c);
  assert.equal(grade([load]).status, "pass");
  for (const changed of [[], [{ ...load, at: "2026-10-24T00:00:04Z" }],
    [{ ...load, at: "2026-10-24T00:00:04.500Z" }],
    [{ ...load, body: "main\n", bytes: 5, endByte: 5, sha256: hash("main\n"), complete: false }],
    [{ ...load, sourceSha256: "wrong" }]])
    assert.equal(grade(changed).status, "unknown");
  assert.equal(grade([load], { ...carrier, sha256: "wrong" }).status, "unknown");
  assert.equal(grade([load], carrier, { ...scope, loadActions: {
    ...scope.loadActions, reporting: { status: "unknown" } } }).status, "unknown");
  for (const changed of [{ roleName: "operator" }, { threadId: "foreign" }, { epoch: 1 }])
    assert.equal(gradeInstructionObligations(
      [{ scope: { ...proofScope, ...changed }, trace: [], loads: [load], complete: false }],
      [file], scope, carrier).status, "unknown");
});
test("actual Task-fact reads trigger task-context before command start, not every warm Turn", () => {
  const scope = { ...proofScope, roleName: "operator", taskId: undefined };
  const trace = { args: ["task", "context", "task-1", "--json"], nativeItemId: "read",
    at: "2026-10-24T00:00:04Z" };
  const bundles = [{ scope, trace: [trace], loads: [] }];
  const start = { at: "2026-10-24T00:00:03Z", message: { method: "item/started",
    params: { threadId: scope.threadId, turnId: scope.turnId, item: { id: "read" } } } };
  const action = taskFactsAction(bundles, [start], scope);
  assert.equal(action.status, "observed"); assert.equal(action.at, start.at);
  assert.equal(taskFactsAction(bundles, [], scope).status, "unknown");
  assert.equal(taskFactsAction([{ ...bundles[0], trace: [{ ...trace,
    args: ["role", "message", "show", "operator", "global-message-1"] }] }], [], scope).status, "not-observed");
  assert.equal(taskFactsAction(bundles, [start], { ...scope, turnId: "foreign" }).status, "not-observed");
  const body = "task facts instructions\n", file = { path: "/product/skills/yui-runtime/references/task-context.md",
    body, bytes: Buffer.byteLength(body), sha256: hash(body), kind: "topic", action };
  const load = { ...file, at: "2026-10-24T00:00:02Z", startByte: 0, endByte: file.bytes,
    sourceSha256: file.sha256 };
  const grade = l => gradeLoads([{ scope, loads: [l], trace: [], complete: false }], [file],
    { ...scope, loadActions: { business: { status: "observed", at: scope.beforeAt } } });
  assert.equal(grade(load).status, "pass");
  assert.equal(grade({ ...load, at: "2026-10-24T00:00:03.500Z" }).status, "unknown",
    "Read after Task-fact command start is late, even before eventual routing effect");
});
test("invocation completion and nonpassing grading remain separate from execution exceptions", () => {
  const complete = { plannedStages: 1, completedStages: 1, stages: [{ stage: 1,
    terminal: { status: "completed" } }], routes: [], status: "observation-unknown",
    executionChecks: "observation-unknown", cleanup: { status: "released" },
    processTerminal: { code: 0, signal: null } };
  const before = JSON.stringify(complete);
  const view = dimensions.invocationCompletion?.([complete]);
  assert.equal(view?.execution, "completed");
  assert.equal(view?.grading, "observation-unknown");
  assert.equal(view?.exitCode, 1);
  assert.equal(JSON.stringify(complete), before);
  assert.equal(dimensions.invocationCompletion?.([{ ...complete, executionChecks: "pass" }])?.exitCode, 0);
  for (const change of [{ error: "exception" }, { processTerminal: { code: 2 } },
    { processTerminal: { code: null, signal: "SIGTERM" } }])
    assert.equal(dimensions.invocationCompletion?.([{ ...complete, ...change }])?.execution, "failed");
  for (const change of [{ completedStages: 0 }, { stages: [] }, { stages: [
    { stage: 1, terminal: { status: "failed" } }] }, { status: "not-run" }])
    assert.equal(dimensions.invocationCompletion?.([{ ...complete, ...change }])?.execution, "incomplete");
  assert.equal(dimensions.invocationCompletion?.([])?.execution, "incomplete");
  assert.equal(dimensions.invocationCompletion?.([{ status: "not-run" }])?.execution, "incomplete");
  assert.equal(dimensions.invocationCompletion?.([{ ...complete, executionChecks: "pass",
    cleanup: { status: "unknown" } }])?.exitCode, 1);
  const warm = { ...complete, scenario: "normal-warm", plannedStages: 4, completedStages: 4,
    stages: [1, 2, 3, 4].map(stage => ({ stage, terminal: { status: "completed" } })),
    routes: [2, 3, 4].map(stage => ({ stage, terminal: { status: "completed" } })) };
  assert.equal(dimensions.invocationCompletion?.([warm])?.execution, "completed");
  assert.equal(dimensions.invocationCompletion?.([{ ...warm, routes: warm.routes.slice(0, 2) }])?.execution, "incomplete");
  const failedGrade = dimensions.invocationCompletion?.([{ ...complete, executionChecks: "quality-fail",
    status: "quality-fail" }]);
  assert.equal(failedGrade?.execution, "completed");
  assert.equal(failedGrade?.grading, "quality-fail");
  assert.equal(failedGrade?.exitCode, 1);
});
test("saved warm coverage exposes all Operator routes and planned counts without regrading", () => {
  const routes = [2, 3, 4].map(stage => ({ stage, terminal: { threadId: "op", turnId: `t${stage}` },
    evidenceScope: { roleName: "operator", threadId: "op", epoch: 0 },
    grade: { status: "pass" }, input: { status: "pass" }, reads: { status: "unknown" },
    loads: { status: "unknown" }, binding: { status: "pass" } }));
  const result = { plannedStages: 4, completedStages: 4, routes, route: routes[0], status: "observation-unknown" };
  const before = JSON.stringify(result);
  const view = dimensions.resultCoverage?.(result);
  assert.equal(view?.plannedStages, 4);
  assert.equal(view?.completedStages, 4);
  assert.deepEqual(view?.routes.map(r => r.stage), [2, 3, 4]);
  assert.deepEqual(view?.routes.map(r => r.reads.status), ["unknown", "unknown", "unknown"]);
  assert.equal(JSON.stringify(result), before);
  assert.equal(dimensions.resultCoverage?.({ route: routes[0] })?.routes.length, 1);
  const full = { status: "valid-pass", completedStages: 4, plannedStages: 4,
    inputIdentity: "input", harnessIdentity: "harness", configurationIdentity: "config" };
  assert.equal(comparable(full, full), true);
  assert.equal(comparable({ ...full, status: "observation-unknown" }, full), false);
  assert.equal(comparable({ ...full, completedStages: 3 }, full), false);
  assert.equal(comparable({ ...full, plannedStages: 3 }, full), false);
  assert.equal(comparable({ ...full, plannedStages: 0, completedStages: 0 }, full), false);
});
test("agent-analysis completion reports recorded quality without turning it into an execution exit", () => {
  const complete = { decisionPolicy: "agent-analysis", plannedStages: 1, completedStages: 1,
    stages: [{ stage: 1, terminal: { status: "completed" } }], routes: [],
    status: "quality-fail", executionChecks: "quality-fail", cleanup: { status: "released" },
    processTerminal: { code: 0, signal: null } };
  const before = JSON.stringify(complete);
  const view = dimensions.invocationCompletion([complete]);
  assert.equal(view.execution, "completed");
  assert.equal(view.grading, "quality-fail");
  assert.equal(view.exitCode, 0);
  assert.equal(view.analysis.owner, "agent");
  assert.equal(view.analysis.status, "not-assessed");
  assert.equal(JSON.stringify(complete), before);
  for (const change of [{ error: "unsafe" }, { completedStages: 0 },
    { cleanup: { status: "unknown" } }, { processTerminal: { code: 1 } },
    { decisionPolicy: undefined }])
    assert.equal(dimensions.invocationCompletion([{ ...complete, ...change }]).exitCode, 1);
});
test("safe business observation retains reading failures for Agent analysis, never weakens effect fences", () => {
  const safe = { protocol: { status: "pass" }, legal: { status: "pass" }, business: { status: "pass" } };
  const verdict = stageVerdict({ ...safe, reads: { status: "fail" }, loads: { status: "fail" } });
  const before = JSON.stringify(verdict);
  const safety = { status: "pass", analyzeReadingFailures: true };
  assert.equal(stageAllowsContinuation(verdict, safety), true);
  assert.equal(JSON.stringify(verdict), before);
  assert.equal(stageAllowsContinuation(verdict, { status: "pass" }), false);
  assert.equal(stageAllowsContinuation(verdict, { ...safety, status: "unknown" }), false);
  for (const check of ["protocol", "legal", "route", "routedInput", "binding", "cliIdentity", "recoveryInspection"])
    assert.equal(stageAllowsContinuation(stageVerdict({ ...safe, reads: { status: "fail" },
      [check]: { status: "fail" } }), safety), false, check);
  assert.equal(stageAllowsContinuation(stageVerdict({ ...safe, business: { status: "unknown" } }), safety), false);
});
test("typed unsent Controller access failure is infrastructure, not absent business quality", () => {
  const diagnostic = { operation: "yui session skills", controller: {
    code: "CONTROLLER_ACCESS_DENIED", delivery: "not-sent",
    method: "controller.status", requestId: "request-1", socketPath: "/fixture/controller.sock",
  } };
  const entry = { code: 5, nativeItemId: "owned-item", observation: { cli: "observed" },
    stdout: JSON.stringify({ ok: false, code: "RUNTIME_ERROR", details: { diagnostic } }) };
  assert.equal(judge.controllerAccessFailure?.([entry])?.status, "infrastructure-failed");
  assert.equal(judge.controllerAccessFailure?.([{ ...entry, observation: { cli: "unknown" } }]), undefined);
  assert.equal(judge.controllerAccessFailure?.([{ ...entry, code: 0 }]), undefined);
  const changed = delivery => ({ ...entry, stdout: JSON.stringify({ ok: false, code: "RUNTIME_ERROR",
    details: { diagnostic: { ...diagnostic, controller: { ...diagnostic.controller, delivery } } } }) });
  assert.equal(judge.controllerAccessFailure?.([changed("unknown")]), undefined);
  assert.equal(judge.controllerAccessFailure?.([{ ...entry, stdout: "EPERM not-sent" }]), undefined);
  assert.equal(judge.controllerAccessFailure?.([{ ...entry,
    stdout: JSON.stringify({ ok: false, code: "USAGE_ERROR", message: "not allowed" }) }]), undefined);
});
test("normal warm chain includes three ordered Operator inputs and unchanged later business truth", () => {
  assert.equal(chainStages("normal"), 3);
  assert.equal(chainStages("normal-warm"), 4);
  assert.deepEqual([1, 2, 3, 4].filter(n => routesStage("normal-warm", n)), [2, 3, 4]);
  assert.deepEqual([1, 2, 3].filter(n => routesStage("normal", n)), [2]);
  assert.equal(gradeBusiness([{ title: "fourth", rationale: JSON.stringify({
    count: 4, total: 29, unknown: "unknown",
  }) }], "fourth", 4).status, "pass");
  assert.equal(parseOptions(["--mode", "real", "--product", "/p", "--out", "/o",
    "--scenarios", "normal-warm", "--provider-bin", "/provider", "--authorization", "explicit"])
    .scenarios[0], "normal-warm");
});
test("extracted route and reporting obligations stay in the applicable load oracle", () => {
  const inventory = Object.fromEntries(["task-context", "global-context", "reporting"]
    .map(name => [`yui-runtime/references/${name}.md`, {}]));
  for (const [role, route, excluded] of [
    ["leader", "task-context", "global-context"], ["operator", "global-context", "task-context"],
  ]) {
    const expected = planningReferences(role, inventory);
    assert.ok(expected.includes(`yui-runtime/references/${route}.md`));
    assert.ok(expected.includes("yui-runtime/references/reporting.md"));
    assert.ok(!expected.includes(`yui-runtime/references/${excluded}.md`));
    assert.deepEqual(expected.filter(p => !(p in inventory)), planningReferences(role));
    assert.ok(!expected.includes("yui-runtime/references/context-ordering.md"), "Warm input alone is no handoff/maintenance trigger");
    assert.ok(planningReferences(role, inventory, true).includes("yui-runtime/references/context-ordering.md"));
    assert.ok(!planningReferences(role, inventory, false, { businessStage: 1 })
      .includes("yui-runtime/references/context-ordering.md"), "Cold business input is not a changed requirement");
    assert.equal(planningReferences(role, inventory, false, { businessStage: 2 })
      .includes("yui-runtime/references/context-ordering.md"), role === "leader",
      "Frozen business revisions require Leader reconciliation; Operator only routes the unchanged original");
  }
});
test("reviewed lifecycle candidate selects action manuals, not a file-existence bundle", () => {
  const inventory = Object.fromEntries([
    ["yui-runtime", "29", "35689259fc083b3c79f24a27385aef5722ea9ec433008b20aedf810d5a24a2e5"],
    ["yui-leader", "13", "01b26d6524e1915e630e1ee9d59a65651ed66c376edabd125398588a4adbaf21"],
    ["yui-operator", "15", "accb629840f94acafa9f8a99404c647d7bba4c6af80c1cb292cc76839bf4f466"],
  ].flatMap(([role, version, sha256]) => [[`${role}/VERSION`, { sha256: hash(version + "\n") }],
    [`${role}/SKILL.md`, { sha256 }]]));
  inventory["yui-runtime/references/global-context.md"] = {};
  assert.deepEqual(planningReferences("operator", inventory), [
    "yui-operator/references/submission.md", "yui-operator/references/body-transport.md",
  ]);
  assert.ok(planningReferences("leader", inventory).includes("yui-leader/references/task-progress.md"));
  assert.ok(!planningReferences("leader", inventory, true, { inspectExisting: true })
    .includes("yui-leader/references/task-progress.md"), "Successor ACK does not record another Decision");
  for (const role of ["yui-runtime", "yui-leader", "yui-operator"])
    for (const file of ["SKILL.md", "VERSION"]) {
      const changed = { ...inventory, [`${role}/${file}`]: { sha256: "unreviewed" } };
      assert.ok(planningReferences("operator", changed).includes("yui-runtime/references/global-context.md"));
    }
  assert.equal(reportingCarrier(inventory).kind, "reviewed-inline-runtime29",
    "Reviewed action core carries reporting; selected action manuals remain independent obligations");
  assert.equal(reportingCarrier({ ...inventory, "yui-runtime/SKILL.md": { sha256: "unreviewed" } }).status, "unknown");
  // Reviewed source inventory at 75f86747, independent of the product checkout
  // hosting this framework. New/unreviewed product trees must stay unmapped.
  const current = Object.fromEntries(Object.entries(JSON.parse(readFileSync(
    new URL("./fixtures/planning-skill-inventory.json", import.meta.url), "utf8")))
    .map(([path, sha256]) => [path, { sha256 }]));
  assert.equal(currentPlanningContract(current)?.id, "action-working-set-2026-11-01");
  assert.equal(currentPlanningContract(current)?.decisionInCore, true);
  assert.ok(!planningReferences("leader", current).includes("yui-leader/references/task-progress.md"),
    "Reviewed Leader15 carries the Decision rules in its required core; no Brief update occurs in this scenario");
  for (const path of ["yui-runtime/VERSION", "yui-runtime/SKILL.md", "yui-runtime/references/context-reads.md",
    "yui-leader/VERSION", "yui-leader/SKILL.md", "yui-leader/references/task-progress.md"]) {
    assert.equal(currentPlanningContract({ ...current, [path]: { sha256: hash("unreviewed change") } }), undefined,
      "An unreviewed body or version must not inherit the current obligation mapping");
  }
});
test("product preparation never shares mutable dependency installation with its source", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-product-isolation-"));
  try {
    const source = join(root, "source"), target = join(root, "product");
    for (const path of ["src", "skills", "node_modules"]) mkdirSync(join(source, path), { recursive: true });
    writeFileSync(join(source, "src/unit.ts"), "export {}");
    writeFileSync(join(source, "skills/SKILL.md"), "fixture");
    writeFileSync(join(source, "node_modules/sentinel"), "source dependency");
    writeFileSync(join(source, "Makefile"), "install-local:\n\ttest ! -L node_modules\n");
    const git = args => execFileSync("git", ["-C", source, ...args], { stdio: "pipe" });
    git(["init", "-q"]);
    git(["add", "src", "skills", "Makefile"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    execFileSync(process.execPath, ["scripts/eval/context/prepare-product.mjs", source, "HEAD", target],
      { stdio: "pipe" });
    assert.equal(readFileSync(join(source, "node_modules/sentinel"), "utf8"), "source dependency");
    assert.equal(JSON.parse(readFileSync(join(target, ".eval-source.json"))).kind, "git-archive");
  } finally { rmSync(root, { recursive: true }); }
});
test("observed behavior remains reportable without memory proof; known failures remain failures", () => {
  const stage = { stage: 1, terminal: { threadId: "t", turnId: "u" },
    business: { status: "pass" }, protocol: { status: "pass" }, legal: { status: "pass" },
    loads: { status: "unknown" }, reuseAvailability: { status: "unknown" } };
  const dimensions = observedDimensions(stage);
  assert.equal(dimensions.business.status, "pass");
  assert.equal(dimensions.instructionOutputCoverage.status, "unknown");
  assert.equal(dimensions.reuseAvailability.status, "unknown");
  assert.equal(observedDimensions({ ...stage, reuseAvailability: { status: "pass" } }).reuseAvailability.status, "unknown");
  assert.equal(observedDimensions({ ...stage, legal: { status: "fail" } }).observedConstraints.status, "fail");
  assert.equal(observedDimensions({ ...stage, terminal: undefined }).business.status, "unknown");
  assert.equal(observedDimensions({ ...stage, business: { status: "valid-pass" } }).business.status, "unknown");
});
test("partial stage comparisons require matching freezes, never full-quality or savings acceptance", () => {
  const plan = { inputIdentity: "i", harnessIdentity: "h", configurationIdentity: "c" };
  const stage = { stage: 1, terminal: { threadId: "t", turnId: "u" },
    business: { status: "pass" }, loads: { status: "unknown" }, reuseAvailability: { status: "unknown" } };
  const side = { plan, result: { scenario: "normal", status: "quality-fail", stages: [stage] } };
  const result = compareObservedStages(side, side);
  assert.equal(result.stages[0].dimensions.business.comparable, true);
  assert.equal(result.stages[0].dimensions.reuseAvailability.comparable, false);
  assert.deepEqual(result.analysis, { owner: "agent", status: "not-assessed" });
  assert.equal(Object.hasOwn(result, "savingsEstablished"), false);
  assert.equal(compareObservedStages(side, { ...side, plan: { ...plan, harnessIdentity: "other" } }).sameFreeze, false);
  assert.equal(compareObservedStages({ ...side, plan: {} }, { ...side, plan: {} }).sameFreeze, false);
  assert.equal(compareObservedStages(side, { ...side, result: { ...side.result, scenario: "recovery" } }).stages.length, 0);
  assert.throws(() => compareObservedStages(side, { ...side, result: { ...side.result, stages: [stage, stage] } }),
    /Duplicate/);
  const failed = { ...stage, business: { status: "fail" } };
  const comparison = compareObservedStages(side, { ...side, result: { ...side.result, stages: [failed] } });
  assert.equal(comparison.stages[0].dimensions.business.B, "fail");
  assert.equal(comparison.stages[0].dimensions.business.comparable, true);
});
test("initial planning uses exact original/Run/native terminal, not nonexistent wake", () => {
  const taskId = "task-1", messageId = "message-1", runId = "run-1", at = "2026-10-24T00:00:01Z";
  const original = { taskId, id: messageId, body: "discuss", submissionKey: "input-1",
    submissionReceipt: { target: { kind: "task", taskId }, routing: { kind: "enter-planning" },
      feedback: { saved: { taskId, messageId } } } };
  const args = { original, expected: { taskId, messageId, body: "discuss", requestId: "input-1",
    runId, agentId: "codex", threadId: "thread", turnId: "turn" }, wakes: [],
  dispatch: { owner: `planning:${runId}`, batchId: `turn:${taskId}/${runId}`,
    executionRef: { type: "run", taskId, id: runId }, batch: { refs: [{ type: "message", taskId, id: messageId }] } },
  run: { taskId, id: runId, roleName: "leader", purpose: "planning", effective: { agentId: "codex" },
    status: "completed", createdAt: "2026-10-24T00:00:00Z",
    result: { completedAt: "2026-10-24T00:00:02Z", provider: { status: "completed", conversationId: "thread", nativeTurnId: "turn" } } },
  effect: { status: "confirmed", at } };
  // Historical bug reproduction: wake-only assertion rejects a legitimate path.
  assert.equal(args.wakes.some(w => w.inbox?.ack), false);
  assert.equal(gradeHandling(args).status, "pass");
  for (const change of [{ expected: { ...args.expected, taskId: "task-9" } },
    { effect: { status: "unknown" } }, { run: { ...args.run, status: "active" } },
    { original: { ...original, body: "other" } }]) assert.notEqual(gradeHandling({ ...args, ...change }).status, "pass");
});
test("later receipt requires exact claim/effect/ACK; unknown is not completion", () => {
  const actor = { scope: "task", taskId: "task-1", roleName: "leader", agentId: "codex", nativeSessionId: "thread" };
  const expected = { taskId: "task-1", messageId: "message-1", requestId: "input", body: "body",
    wakeId: "wake-1", agentId: "codex", threadId: "thread" };
  const original = { taskId: expected.taskId, id: expected.messageId, submissionKey: "input", body: "body",
    submissionReceipt: { target: { kind: "task", taskId: expected.taskId }, routing: { kind: "continue-planning" },
      feedback: { saved: { taskId: expected.taskId, messageId: expected.messageId } } } };
  const wake = { taskId: expected.taskId, id: "wake-1",
    refs: [{ type: "message", taskId: expected.taskId, id: expected.messageId }],
    inbox: { claim: { requestId: "claim", actor, at: "2026-10-24T00:00:00Z" },
      ack: { requestId: "ack", actor, reason: "handled", at: "2026-10-24T00:00:02Z" } } };
  const good = { original, expected, wakes: [wake], effect: { status: "confirmed", at: "2026-10-24T00:00:01Z" } };
  assert.equal(gradeHandling(good).status, "pass");
  assert.equal(gradeHandling({ ...good, wakes: [{ ...wake, inbox: { claim: wake.inbox.claim } }] }).status, "fail");
  assert.equal(gradeHandling({ ...good, effect: { status: "unknown" } }).status, "unknown");
});
test("independent business truth, exact full reads, full bodies not markers", () => {
  assert.equal(gradeBusiness([{ id: "decision-1", title: "key", rationale: '{"count":2,"total":11,"unknown":"unknown"}' }], "key", 1).status, "pass");
  assert.equal(gradeBusiness([{ title: "key", rationale: '{"count":2,"total":12,"unknown":"unknown"}' }], "key", 1).status, "fail");
  assert.equal(gradeReads([{ trace: [], scope: proofScope, complete: true }],
    [{ id: "message-1", taskId: "task-1", body: "FULL" }], proofScope).status, "fail");
  assert.equal(gradeReads([], [{ id: "message-1", taskId: "task-1", body: "FULL" }]).status, "unknown");
  const file = { path: "/fixture/SKILL.md", kind: "core", body: "FULL", bytes: 4, sha256: hash("FULL") };
  const bundle = loads => [{ scope: proofScope, complete: true, loads: loads.map(l => ({ ...l, at: "2026-10-24T00:00:01Z" })) }];
  assert.equal(gradeLoads(bundle([{ ...file, body: "FUL", sha256: hash("FUL"), bytes: 3 }]), [file], proofScope).status, "fail");
  assert.equal(gradeLoads(bundle([{ ...file, body: "FULL", complete: true }]), [file], proofScope).status, "pass");
});
test("source reuse preserves exact bytes, scope, deadline and current-input obligations", () => {
  const scope = { ...proofScope, turnId: "warm", afterAt: "2026-10-24T00:00:03Z" };
  const source = { taskId: scope.taskId, id: "source-1", body: "complete synthetic original" };
  const added = { ...source, id: "source-2", body: "new synthetic original" };
  const entry = (value, at = "2026-10-24T00:00:01Z") =>
    ({ at, code: 0, stdout: JSON.stringify({ ok: true, data: value }) });
  const cold = { scope: { ...scope, turnId: "cold" }, complete: true, trace: [entry(source)] };
  const grade = (bundles, sources = [source], reuse = true) => gradeReads(bundles, sources, scope, { reuse });
  assert.equal(grade([cold]).status, "pass");
  assert.equal(grade([cold]).contextAvailability, "unknown");
  assert.equal(grade([cold], [source, added]).status, "fail");
  assert.equal(grade([cold, { scope, complete: true,
    trace: [entry(added, "2026-10-24T00:00:04Z")] }], [source, added]).status, "pass");
  assert.equal(grade([cold], [{ ...source, body: "changed" }]).status, "fail");
  for (const changed of [{ taskId: "foreign" }, { roleName: "operator" }, { threadId: "foreign" }, { epoch: 1 }])
    assert.equal(grade([{ ...cold, scope: { ...cold.scope, ...changed } }]).status, "unknown");
  assert.equal(grade([{ ...cold, trace: [entry(source, "2026-10-24T00:00:06Z")] }]).status, "fail");
  assert.equal(grade([cold], [source], false).status, "unknown");
  const text = JSON.stringify(source);
  const partial = { ...cold, complete: false, trace: [entry({ contentPage: {
    source: "synthetic/source-1", digest: hash(text), encoding: "json",
    offset: 0, text: text.slice(0, 10), totalCharacters: text.length,
    complete: false, nextCursor: "synthetic-unconsumed" } })] };
  assert.equal(grade([partial]).status, "unknown");
  assert.equal(grade([]).status, "unknown");
});
test("warm Skill proof is reusable only for the same role, thread, epoch and current source", () => {
  const body = "Complete synthetic Skill instructions";
  const file = { path: "/fixture/SKILL.md", kind: "core", body,
    bytes: Buffer.byteLength(body), sha256: hash(body) };
  const cold = { scope: proofScope, complete: true,
    loads: [{ ...file, body, complete: true, at: "2026-10-24T00:00:01Z" }] };
  const warm = { ...proofScope, turnId: "later-turn",
    afterAt: "2026-10-24T00:00:06Z", beforeAt: "2026-10-24T00:00:09Z" };
  // The later Turn needs no duplicate body read: earlier complete evidence in
  // the unchanged context epoch remains eligible. This proves grading logic,
  // not that a real model still has the body in its current context.
  assert.equal(gradeLoads([cold], [file], warm).status, "pass");
  for (const changed of [{ roleName: "operator" }, { threadId: "successor" }, { epoch: 1 }]) {
    assert.notEqual(gradeLoads([cold], [file], { ...warm, ...changed }).status, "pass");
  }
  const revisedBody = `${body}\nUpdated instruction`;
  const revised = { ...file, body: revisedBody, bytes: Buffer.byteLength(revisedBody), sha256: hash(revisedBody) };
  assert.equal(gradeLoads([cold], [revised], warm).status, "fail");
  const metadataOnly = { scope: warm, complete: true, loads: [] };
  assert.equal(gradeLoads([metadataOnly], [file], warm).status, "fail");
  assert.equal(gradeLoads([], [file], warm).status, "unknown");
  const late = { ...cold, loads: cold.loads.map(l => ({ ...l, at: "2026-10-24T00:00:10Z" })) };
  assert.equal(gradeLoads([late], [file], warm).status, "fail");
  const reloaded = { scope: { ...warm, epoch: 1 }, complete: true,
    loads: [{ ...revised, body: revisedBody, complete: true, at: "2026-10-24T00:00:07Z" }] };
  assert.equal(gradeLoads([cold, reloaded], [revised], { ...warm, epoch: 1 }).status, "pass");
});
test("instruction cost separates same-context repeats from independent loads", () => {
  const load = { path: "/product/SKILL.md", sha256: hash("FULL"), body: "FULL",
    bytes: 4, complete: true };
  const trace = scope => ({ scope, loads: [load] });
  const traces = [
    trace({ ...proofScope, roleName: "operator", threadId: "op" }),
    trace(proofScope),
    trace({ ...proofScope, turnId: "next-turn" }),
    trace({ ...proofScope, epoch: 1 }),
    trace(undefined),
  ];
  const cost = instructionLoadCosts(traces);
  assert.equal(cost.repeatedFullBodyUtf8, 16, "Legacy cross-context raw repeat count stays comparable.");
  assert.deepEqual(cost.fullBodyContexts, {
    firstObservedUtf8: 12, repeatedUtf8: 4, unattributedUtf8: 4, reads: 5,
    firstObservedReads: 3, repeatedReads: 1, unattributedReads: 1,
  });
  // The first complete body is not a repeat merely because a fragment existed.
  assert.equal(instructionLoadCosts([
    { scope: proofScope, loads: [{ ...load, complete: false }] }, trace(proofScope),
  ]).fullBodyContexts.repeatedUtf8, 0);
  assert.equal(instructionLoadCosts([
    trace(proofScope), trace({ ...proofScope, taskId: "other-task" }),
    { scope: proofScope, loads: [{ ...load, sha256: hash("NEXT"), body: "NEXT" }] },
  ]).fullBodyContexts.repeatedUtf8, 0);
});
test("separate statuses, comparable full pairs only, cumulative subset-safe tokens", () => {
  assert.equal(outcome({ framework: "fail" }), "framework-invalid");
  assert.equal(outcome({ infrastructure: "failed" }), "infrastructure-failed");
  assert.equal(outcome({ interrupted: true }), "interrupted");
  assert.equal(outcome({ quality: "fail" }), "quality-fail");
  assert.equal(outcome({ observation: "unknown" }), "observation-unknown");
  assert.equal(outcome({ observation: "complete" }), "valid-pass");
  assert.equal(comparable({ status: "valid-pass", completedStages: 1 }, { status: "valid-pass", completedStages: 3 }), false);
  const event = total => ({ message: { method: "thread/tokenUsage/updated", params: { threadId: "t", tokenUsage: { total } } } });
  const usage = tokenTotals([event({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 12 }),
    event({ inputTokens: 20, cachedInputTokens: 8, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 23 })]);
  assert.equal(usage.totalTokens, 23); assert.equal(usage.inputTokens, 20);
  assert.equal(tokenTotals([]).status, "unknown");
});
test("real is explicit; fake-only faults cannot leak to real and unknown options fail closed", () => {
  const local = ["--mode", "fake", "--product", ".", "--out", "new"];
  assert.equal(parseOptions(local)["cli-entry-mode"], "absolute");
  assert.equal(parseOptions(local)["source-contract"], "original");
  assert.equal(parseOptions([...local, "--source-contract", "conditional-reuse"])["source-contract"], "conditional-reuse");
  assert.throws(() => parseOptions([...local, "--source-contract", "/arbitrary/prompt"]));
  assert.equal(parseOptions([...local, "--cli-entry-mode", "owned-relative"])["cli-entry-mode"], "owned-relative");
  assert.throws(() => parseOptions([...local, "--cli-entry-mode", "global"]));
  assert.throws(() => parseOptions(["--mode", "real", "--product", ".", "--out", "new"]));
  assert.throws(() => parseOptions(["--mode", "fake", "--product", ".", "--out", "new", "--concurrency", "100"]));
  assert.throws(() => parseOptions(["--mode", "fake", "--product", ".", "--out", "new", "--retry", "true"]));
  assert.throws(() => parseOptions(["--mode", "fake", "--product", ".", "--out", "new", "--preflight", "maybe"]));
  assert.throws(() => parseOptions(["--mode", "real", "--product", ".", "--out", "new",
    "--provider-bin", "relative-codex", "--authorization", "ref"]));
});
test("Session replacement has an explicit real-capable entry, not fake fault fallback", () => {
  const base = ["--mode", "real", "--product", ".", "--out", "new",
    "--provider-bin", "/explicit/codex", "--authorization", "separate-future-freeze"];
  assert.deepEqual(parseOptions([...base, "--scenarios", "session-recovery"]).scenarios, ["session-recovery"]);
  for (const scenario of ["recovery", "native-normal", "session-recovery-stop-unknown"])
    assert.throws(() => parseOptions([...base, "--scenarios", scenario]));
});
test("recovery requires exact stopped predecessor, immutable claim/effect and a fresh owned successor", () => {
  const at = "2026-10-24T00:00:05Z", taskId = "task-1";
  const terminal = { threadId: "old", turnId: "old-turn", status: "completed", at,
    binding: { taskId, roleName: "leader" } };
  const stop = { taskId, roleName: "leader", stopped: true };
  const inspection = { taskId, roleName: "leader", session: { nativeSessionId: "old", status: "ended" } };
  const good = { taskId, terminal, stop, inspection };
  assert.equal(judge.gradeRecoveryStop(good).status, "pass");
  for (const change of [{ stop: { ...stop, stopped: "unknown" } },
    { inspection: { ...inspection, session: { ...inspection.session, status: "active" } } },
    { terminal: { ...terminal, status: "inProgress" } },
    { inspection: { ...inspection, session: { ...inspection.session, nativeSessionId: "other" } } }])
    assert.notEqual(judge.gradeRecoveryStop({ ...good, ...change }).status, "pass");
  const successor = { ...terminal, threadId: "new", turnId: "new-turn",
    startedAt: "2026-10-24T00:00:07Z", at: "2026-10-24T00:00:09Z" };
  const proof = (threadId, connection) => ({ threadId, connection, taskId, role: "leader",
    method: "thread/start", at: threadId === "old" ? at : "2026-10-24T00:00:06Z" });
  const fresh = { taskId, predecessor: terminal, successor, after: at,
    proofs: [proof("old", "old-connection"), proof("new", "new-connection")] };
  assert.equal(judge.gradeRecoverySuccessor(fresh).status, "pass");
  assert.notEqual(judge.gradeRecoverySuccessor({ ...fresh, successor: terminal }).status, "pass");
  assert.notEqual(judge.gradeRecoverySuccessor({ ...fresh, proofs: [fresh.proofs[0]] }).status, "pass");
  assert.notEqual(judge.gradeRecoverySuccessor({ ...fresh,
    proofs: [fresh.proofs[0], proof("new", "old-connection")] }).status, "pass");
  const claim = { requestId: "original-claim" }, original = { id: "message-1", body: "exact" };
  const effect = { taskId, id: "decision-1", rationale: "exact" };
  const retained = { before: { original, claim, effect }, after: { original, claim, effect } };
  assert.equal(judge.gradeRecoveryPreservation(retained).status, "pass");
  assert.equal(judge.gradeRecoveryPreservation({ ...retained, after: {
    ...retained.after, claim: { requestId: "reclaimed" } } }).status, "fail");
  assert.equal(judge.gradeRecoveryPreservation({ ...retained, after: {
    ...retained.after, effect: { ...effect, rationale: "rewritten" } } }).status, "fail");
  const wake = { taskId, id: "wake-1", refs: [{ type: "message", taskId, id: original.id }], inbox: { claim } };
  const scope = { taskId, roleName: "leader", threadId: "new", turnId: "new-turn", epoch: 0,
    beforeAt: "2026-10-24T00:00:09Z", afterAt: "2026-10-24T00:00:06Z" };
  const trace = [{ at: "2026-10-24T00:00:08Z", code: 0,
    stdout: JSON.stringify({ data: { ref: { store: "task-decision", refId: effect.id }, value: effect } }) },
    { at: "2026-10-24T00:00:08Z", code: 0, stdout: JSON.stringify({ data: { wake } }) }];
  const evidence = [{ scope, complete: true, trace }];
  assert.equal(judge.gradeRecoveryInspection(evidence, { effect, wake }, scope).status, "pass");
  assert.equal(judge.gradeRecoveryInspection(evidence, { effect, wake }, { ...scope, threadId: "other" }).status, "unknown");
  assert.equal(judge.gradeRecoveryInspection([{ ...evidence[0], trace: trace.slice(1) }],
    { effect, wake }, scope).status, "unknown", "Snapshot equality cannot substitute for missing subject effect read");
  const checkpoint = { taskId, original: { taskId, id: "message-1" },
    terminal: { ...terminal, startedAt: "2026-10-24T00:00:01Z" },
    effect: { ...effect, createdAt: "2026-10-24T00:00:03Z" },
    wake: { taskId, refs: [{ type: "message", taskId, id: "message-1" }], inbox: { claim: {
      requestId: "claim", at: "2026-10-24T00:00:02Z",
      actor: { scope: "task", taskId, roleName: "leader", agentId: "codex", nativeSessionId: "old" },
    } } } };
  assert.equal(judge.gradeRecoveryCheckpoint(checkpoint).status, "pass");
  assert.equal(judge.gradeRecoveryCheckpoint({ ...checkpoint,
    wake: { ...checkpoint.wake, inbox: { ...checkpoint.wake.inbox, ack: { requestId: "already-acked" } } } }).status, "fail");
});
test("endpoint artifact writes are detected without assuming a product event exists", () => {
  assert.deepEqual(forbiddenFileChanges({}, { "task-artifacts/task-1/data.json": { sha256: "new" } },
    path => path.startsWith("task-artifacts/")), ["task-artifacts/task-1/data.json"]);
});
test("native transport omits structured credentials and hashes account identifiers", () => {
  const r = redactTransport({ result: { access_token: "secret", nested: [{ authorization: "Bearer secret", email: "person" }] } });
  assert.equal(r.result.access_token, "[redacted]");
  assert.equal(r.result.nested[0].authorization, "[redacted]");
  assert.equal(r.result.nested[0].email, `sha256:${hash("person")}`);
});
test("missing observation permits the next bounded input without promoting its grade", () => {
  const safe = { protocol: { status: "pass" }, business: { status: "pass" }, legal: { status: "pass" } };
  const verdict = stageVerdict({ ...safe, reads: { status: "unknown" }, loads: { status: "unknown" } });
  assert.equal(stageAllowsContinuation(verdict, { status: "pass" }), true);
  assert.equal(verdict.status, "observation-unknown");
  for (const status of ["quality-fail", "framework-invalid", "infrastructure-failed", "interrupted"])
    assert.equal(stageAllowsContinuation({ status }, { status: "pass" }), false);
  for (const check of ["protocol", "business", "legal", "route"])
    assert.equal(stageAllowsContinuation(stageVerdict({ ...safe, [check]: { status: "unknown" } }), { status: "pass" }), false,
      `unknown ${check} must fence the chain`);
  const observationOnly = stageVerdict({ ...safe, binding: { status: "unknown" }, operatorBinding: { status: "unknown" } });
  assert.equal(stageAllowsContinuation(observationOnly, { status: "pass" }), true);
  assert.equal(observationOnly.status, "observation-unknown");
  assert.equal(stageAllowsContinuation(observationOnly, { status: "unknown" }), false);
  const answer = gradeBusiness([{ id: "decision-1", title: "plan-3",
    rationale: JSON.stringify({ allocations: [{ site: "Cedar", kits: 24 }], deferred: [],
      remainingKits: 10, carrierEta: "unknown", mode: "plan-only" }) }], "plan-3", 3,
    { allocations: [{ site: "Cedar", kits: 24 }], deferred: [{ site: "Maple", reason: "excluded" }],
      remainingKits: 10, carrierEta: "unknown", mode: "plan-only" });
  const answerFailure = stageVerdict({ ...safe, business: answer, reads: { status: "unknown" } });
  const planningSafety = { status: "pass", planningOnlyAnswer: true };
  assert.equal(stageAllowsContinuation(answerFailure, planningSafety), true,
    "A known single planning-answer mismatch need not censor later independent inputs");
  const answerAndReading = stageVerdict({ ...safe, business: answer, reads: { status: "fail" } });
  assert.equal(stageAllowsContinuation(answerAndReading,
    { ...planningSafety, analyzeReadingFailures: true }), true);
  assert.equal(answerAndReading.status, "quality-fail", "Neither objective finding is erased");
  assert.equal(answerFailure.status, "quality-fail", "Continuation never upgrades the failed answer");
  for (const actual of [{}, { ...answer.actual, mode: "execute" }, { ...answer.actual, allocations: [null] }]) {
    assert.equal(stageAllowsContinuation(stageVerdict({ ...safe, business: { ...answer, actual } }),
      planningSafety), false, "Incomplete/non-planning answer shapes still stop");
  }
  assert.equal(stageAllowsContinuation(answerFailure, { status: "pass" }), false);
  assert.equal(stageAllowsContinuation(answerFailure, { ...planningSafety, status: "unknown" }), false);
  const missing = stageVerdict({ ...safe, business: gradeBusiness([], "plan-3", 3) });
  assert.equal(stageAllowsContinuation(missing, planningSafety), false, "Missing/duplicate effect is not an answer-only error");
  for (const check of ["protocol", "legal", "route", "reads", "loads", "cliIdentity"])
    assert.equal(stageAllowsContinuation(stageVerdict({ ...safe, business: answer, [check]: { status: "fail" } }),
      planningSafety), false, `A ${check} failure still fences the chain`);
  for (const check of ["protocol", "legal", "route"])
    assert.equal(stageAllowsContinuation(stageVerdict({ ...safe, business: answer, [check]: { status: "unknown" } }),
      planningSafety), false, `Unknown ${check} cannot be hidden by an answer-only failure`);
});
test("Operator routed-input changes are subject failures; JSON formatting is not a content change", () => {
  const input = { kind: "input", stage: 2, contract: "literal string 'unknown'" };
  const expected = { taskId: "task-1", requestId: "input-2", input };
  const original = { taskId: "task-1", submissionKey: "input-2", intent: "discuss",
    body: JSON.stringify(input, null, 2) };
  assert.equal(gradeRoutedInput(original, expected).status, "pass");
  assert.equal(gradeRoutedInput({ ...original, body: JSON.stringify({
    contract: input.contract, stage: input.stage, kind: input.kind,
  }) }, expected).status, "pass");
  assert.equal(gradeRoutedInput({ ...original, body: JSON.stringify({ ...input,
    contract: "literal string unknown" }) }, expected).classification, "quality-fail");
  assert.equal(gradeRoutedInput({ ...original, body: "{bad" }, expected).status, "fail");
  assert.equal(gradeRoutedInput({ ...original, taskId: "foreign" }, expected).status, "fail");
  assert.equal(gradeRoutedInput({ ...original, submissionKey: "other" }, expected).status, "fail");
  assert.equal(gradeRoutedInput(undefined, expected).status, "unknown");
});
