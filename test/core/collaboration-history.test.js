import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { waitForFixtureReady } from "../../scripts/eval/context/fixture.mjs";
import { Client, hash, treeHashes } from "../../scripts/eval/context/common.mjs";
import { openEvidence } from "../../scripts/eval/core/evidence.mjs";
import { usageObservations } from "../../scripts/eval/adapters/codex/usage.mjs";
import { readSavedInvocation } from "../../scripts/eval/context/saved-evidence.mjs";
import { quantifyEvents, frozenSources } from "../../scripts/eval/context/quantify.mjs";
import { executionModules } from "../../scripts/eval/context/versions.mjs";
import { exportReviewCase, exportReadableReview, validateReview, diagnoseReview, compareReviews, verifyReviewPackage, subjectRunFacts, RUBRIC, RUBRIC_DIGEST } from "../../scripts/eval/context/semantic-review.mjs";
import { mergeVisibleStreams, readReviewPage, verifyViewMappings, privateReviewContent, directoryLines } from "../../scripts/eval/context/readable-review.mjs";
import * as reader from "../../scripts/eval/context/review-reader.mjs";

test("fixture startup reports early process exit instead of waiting for a readiness timeout", async () => {
  const failed = new EventEmitter();
  const rejected = assert.rejects(waitForFixtureReady(failed, "Provider owner"),
    /Provider owner exited before ready.*code=1/);
  failed.emit("exit", 1, null);
  await rejected;
  assert.equal(failed.listenerCount("message"), 0);
  const ready = new EventEmitter();
  const result = waitForFixtureReady(ready, "Collector");
  ready.emit("message", { ready: true });
  assert.deepEqual(await result, { ready: true });
  assert.equal(ready.listenerCount("exit"), 0);
  assert.equal(ready.listenerCount("error"), 0);
});

test("an expired evaluation phase never launches its next CLI mutation", () => {
  const client = new Client("/nonexistent-cli", {}, [], Date.now() - 1);
  let started = false;
  client.onStart = () => { started = true; };
  assert.throws(() => client.call(["operator", "submit", "must not run"]), /deadline exhausted before invocation/i);
  assert.equal(started, false);
  assert.equal(client.trace[0].disposition, "not-started");
});

test("bounded reading groups preserve exact text, continuation identity and independent failures", t => {
  const directory = mkdtempSync(join(tmpdir(), "yui-read-group-"));
  t.after(() => rmSync(directory, { recursive: true }));
  mkdirSync(join(directory, "view"));
  const texts = ["first complete original", "second 😀 original with continuation", "unrelated"];
  const index = texts.map((text, i) => {
    const id = `V00000${i + 1}`, file = `view/${id}.txt`;
    writeFileSync(join(directory, file), text);
    return { id, file, sha256: hash(text), utf8: Buffer.byteLength(text),
      title: "Original", readClass: "trajectory", role: i === 2 ? "operator" : "leader",
      at: "2026-11-01T00:00:00Z", fields: [] };
  });
  const view = JSON.stringify({ index });
  writeFileSync(join(directory, "view-index.json"), view);
  writeFileSync(join(directory, "package-seal.json"), JSON.stringify({
    "view-index.json": hash(view), ...Object.fromEntries(index.map(e => [e.file, e.sha256])),
  }));
  const catalog = reader.listReviewDocuments(directory, { role: "leader", limit: 1 });
  assert.equal(catalog.total, 2);
  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.items[0].excerpt.text, texts[0]);
  assert.equal(catalog.items[0].recordedAt, index[0].at);
  assert.equal(catalog.items[0].updatedAt, null, "Transport time is not source edit time");
  assert.equal(reader.listReviewDocuments(directory, catalog.next).items[0].id, index[1].id);
  assert.throws(() => reader.listReviewDocuments(directory, { ...catalog.next, indexSha256: "wrong" }), /changed/);
  const requests = index.slice(0, 2).map(e => ({ id: e.id, sha256: e.sha256 }));
  const first = reader.readReviewBatch(directory, requests, texts[0].length + 9);
  assert.equal(first.results[0].text, texts[0]);
  assert.equal(first.results[0].source.recordedAt, index[0].at);
  assert.equal(first.results[0].source.title, index[0].title, "Body reads also return selection metadata, avoiding a second directory read");
  assert.equal(first.results[0].complete, true);
  assert.equal(first.results[1].complete, false);
  assert.ok(first.textUtf16 <= first.budgetUtf16);
  const rest = reader.readReviewBatch(directory, first.next);
  assert.equal(first.results[1].text + rest.results[0].text, texts[1]);
  assert.equal(rest.next.length, 0);
  const mixed = reader.readReviewBatch(directory, [
    { id: index[0].id, sha256: "wrong" }, requests[1], { id: "missing" },
  ]);
  assert.equal(mixed.results[0].status, "error");
  assert.equal(mixed.results[1].text, texts[1]);
  assert.equal(mixed.results[2].status, "error");
  assert.throws(() => reader.readReviewBatch(directory, requests, 24001), /budget/);
  assert.throws(() => reader.readReviewBatch(directory, requests, 1), /budget/);
  const tiny = reader.readReviewBatch(directory, [
    { id: index[0].id, offset: texts[0].length - 1 }, { id: index[1].id, offset: 7 },
  ], 2);
  assert.equal(tiny.textUtf16, 1, "A surrogate pair must not exceed the whole batch budget");
  assert.equal(tiny.next[0].offset, 7);
  assert.equal(reader.readReviewBatch(directory, tiny.next, 2).results[0].text, "😀");
  writeFileSync(join(directory, index[0].file), "changed");
  assert.equal(reader.readReviewBatch(directory, requests).results[0].status, "error");
});

test("review stream replacement requires exact ordered successful terminal coverage, retaining every ambiguous stream", () => {
  assert.equal(privateReviewContent({ message: { result: { turn: { items: [{ type: "reasoning" }] } } } }), true);
  assert.equal(privateReviewContent({ nested: { encrypted_content: "private" } }), true);
  assert.equal(privateReviewContent({ reasoningOutputTokens: 12, message: { params: { item: { type: "agentMessage", text: "visible" } } } }), false);
  const frame = (method, params, n) => ({ ordinal: n, evidenceIds: [`E${n}`],
    event: { sourceConnection: "C", direction: "native", at: new Date(1700000000000 + n).toISOString(),
      binding: { roleName: "leader" }, message: { method, params: { threadId: "T", turnId: "t", ...params } } } });
  const delta = (text, n) => frame("item/commandExecution/outputDelta", { itemId: "i", delta: text }, n);
  const terminal = (output, n, extra = {}) => frame("item/completed", { item: { id: "i", type: "commandExecution",
    status: "completed", exitCode: 0, aggregatedOutput: output, ...extra } }, n);
  const good = [delta("字\n", 1), delta("last", 2), terminal("字\nlast", 3)];
  const result = mergeVisibleStreams(good);
  assert.equal(result.merges.length, 1);
  assert.deepEqual(result.retained.map(x => x.ordinal), [3]);
  assert.deepEqual(result.merges[0].deltas, [1, 2]);
  assert.equal(result.merges[0].sha256, hash("字\nlast"));
  for (const frames of [
    [delta("long output", 1), terminal("long", 2)], // truncated
    [delta("x", 1), terminal("x", 2, { truncated: true })],
    [delta("x", 1), terminal("x", 2, { status: "failed", exitCode: 1 })],
    [delta("x", 1)], // partial/no terminal
    [terminal("x", 1), delta("x", 2)], // late delta
    [delta("B", 1), delta("A", 2), terminal("AB", 3)], // reordered/different
    [delta("x", 1), terminal("y", 2)],
    [delta("x", 2), terminal("x", 1)], // timestamp reversal
    [delta("x", 1), terminal("x", 2), terminal("different", 3)],
  ]) {
    const checked = mergeVisibleStreams(frames);
    assert.equal(checked.merges.length, 0);
    assert.deepEqual(checked.retained, frames);
    assert.ok(checked.gaps.length);
  }
  const other = structuredClone(good);
  other[1].event.sourceConnection = "foreign";
  assert.equal(mergeVisibleStreams(other).merges.length, 0);
});

test("historical directory/archive reads enforce seals, identity and owned release without changing originals", t => {
  const root = mkdtempSync(join(tmpdir(), "yui-history-check-"));
  t.after(() => rmSync(root, { recursive: true }));
  const directory = join(root, "saved");
  mkdirSync(directory);
  const json = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value));
  json("preflight.json", { commit: "product", skills: {}, actualSource: {} });
  json("plan.json", { mode: "real", inputIdentity: "input", configurationIdentity: "config",
    harnessIdentity: "recorded-run-version", preflightIdentity: hash(readFileSync(join(directory, "preflight.json"))) });
  json("ledger.json", { results: [{ status: "quality-fail", completedStages: 1 }] });
  json("seal.json", treeHashes(directory));
  const before = treeHashes(directory);
  let store;
  t.after(() => store?.close());
  store = openEvidence(directory);
  const original = readSavedInvocation(store, "");
  assert.equal(original.ledger.results[0].status, "quality-fail");
  assert.equal(original.versions.run, "recorded-run-version");
  assert.throws(() => store.bytes("../outside"), /Unsafe/);
  store.close();
  const archive = join(root, "saved.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", root, "saved"]);
  store = openEvidence(archive);
  const archived = readSavedInvocation(store, "saved");
  assert.equal(archived.identity, original.identity, "Duplicate copies have one evidence identity");
  const temporary = store.temporaryRoot;
  store.close();
  assert.equal(store.released, true);
  assert.ok(temporary);
  assert.deepEqual(treeHashes(directory), before);
  const unsafe = join(root, "unsafe");
  mkdirSync(unsafe);
  symlinkSync(directory, join(unsafe, "link"));
  const linkedArchive = join(root, "linked.tar");
  execFileSync("tar", ["-cf", linkedArchive, "-C", root, "unsafe"]);
  assert.throws(() => openEvidence(linkedArchive), /Unsafe link/);
  const missing = frozenSources({ preflight: { skills: { "x/SKILL.md": { sha256: hash("missing") } } },
    plan: {}, ledger: {}, files: [] }, []);
  assert.equal(missing.files.length, 0, "Never borrow current installed Skills");
  assert.equal(missing.missing.length, 1);
  json("ledger.json", { results: [] });
  store = openEvidence(directory);
  assert.throws(() => readSavedInvocation(store, ""), /seal/i);
  json("seal.json", Object.fromEntries(Object.entries(treeHashes(directory)).filter(([p]) => p !== "seal.json")));
  json("plan.json", { preflightIdentity: "wrong" });
  json("seal.json", Object.fromEntries(Object.entries(treeHashes(directory)).filter(([p]) => p !== "seal.json")));
  store.close(); store = openEvidence(directory);
  assert.throws(() => readSavedInvocation(store, ""), /preflight identity/i);
});
test("supplemental counts include failed outputs, cumulative usage once and same-context repeats across Turns", () => {
  const binding = { taskId: "task-1", roleName: "leader", home: "/fixture", product: "/product" };
  const file = { path: "/product/entry.md", body: "字\n", bytes: 4, sha256: hash("字\n"), kind: "core" };
  const event = (method, params, n) => ({ direction: "native", binding,
    at: new Date(1700000000000 + n * 1000).toISOString(), message: { method, params } });
  const events = [1, 2].flatMap(n => [
    event("turn/started", { threadId: "T", turn: { id: `t${n}` } }, n * 3),
    event("item/completed", { threadId: "T", turnId: `t${n}`, item: { id: `i${n}`, type: "commandExecution",
      command: "cat /product/entry.md", cwd: "/fixture", exitCode: 0, status: "completed", aggregatedOutput: file.body } }, n * 3 + 1),
    event("thread/tokenUsage/updated", { threadId: "T", turnId: `t${n}`, tokenUsage: {
      last: { totalTokens: 3 }, total: { totalTokens: n * 10 } } }, n * 3 + 1),
    event("turn/completed", { threadId: "T", turn: { id: `t${n}`, status: "completed" } }, n * 3 + 2),
  ]);
  events.unshift({ direction: "native", sourceConnection: "owned", message: { id: "start", result: { thread: { id: "T" } } } },
    { direction: "host", sourceConnection: "owned", message: { id: "start", method: "thread/start" } });
  const failed = event("item/completed", { threadId: "T", turnId: "t2", item: { id: "failed", type: "commandExecution",
    command: "missing", status: "failed", exitCode: -1, aggregatedOutput: "error" } }, 7);
  events.push(failed, failed);
  const measured = quantifyEvents(events, [], [file]);
  assert.equal(measured.totals.observedTools, 3);
  assert.equal(measured.totals.observedFailedTools, 1);
  assert.equal(measured.totals.observedToolOutputLowerBoundUtf8, 13);
  assert.equal(measured.totals.tokens.totalTokens, 20);
  assert.equal(measured.rows[1].phase, "warm");
  assert.equal(measured.rows[1].recognizedBodies.fullBodyContexts.repeatedReads, 1);
  assert.equal(measured.rows[1].tokens.totalTokens, 10);
  assert.equal(measured.rows[0].totalContextUtf8, "unknown");
  assert.equal(measured.duplicates.length, 1);
  const version = { path: "/product/VERSION", body: "7\n", bytes: 2, sha256: hash("7\n"), kind: "inventory-only" };
  const metadata = event("item/completed", { threadId: "T", turnId: "t2", item: { id: "version", type: "commandExecution",
    command: "cat /product/VERSION", cwd: "/fixture", exitCode: 0, status: "completed", aggregatedOutput: version.body } }, 7);
  const withMetadata = quantifyEvents([...events, metadata], [], [file, version]);
  assert.equal(withMetadata.totals.recognizedBodies.fullBodyContexts.reads, 2, "VERSION metadata is not Skill body loading");
  assert.equal(withMetadata.totals.observedToolOutputLowerBoundUtf8, 15, "Metadata output still costs bytes");
  const modules = executionModules();
  assert.ok(modules["context/worker.mjs"]);
  assert.ok(modules["context/completion.mjs"]);
  assert.ok(!modules["context/semantic-review.mjs"]);
  assert.ok(!modules["context/readable-review.mjs"]);
  assert.ok(!modules["context/quantify.mjs"]);
  assert.ok(!modules["context/analyze.mjs"]);
  assert.ok(!modules["context/dimensions.mjs"]);
  assert.ok(modules["core/io.mjs"]);
  assert.ok(modules["adapters/codex/usage.mjs"]);
  // Every runtime static dependency must participate in the frozen identity,
  // including shared helpers moved outside the scenario directory.
  for (const [path, digest] of Object.entries(modules)) {
    const bytes = readFileSync(new URL(`../../scripts/eval/${path}`, import.meta.url));
    assert.equal(hash(bytes), digest);
    for (const [, dependency] of bytes.toString().matchAll(/from ["'](\.[^"']+\.mjs)["']/g)) {
      const member = posix.normalize(posix.join(posix.dirname(path), dependency));
      assert.ok(modules[member], `${path} has unfrozen dependency ${member}`);
    }
  }
});
test("usage totals expose missing owned Threads rather than treating partial costs as the whole chain", () => {
  const event = (method, params) => ({ direction: "native", binding: { roleName: "operator" },
    at: "2026-11-03T00:00:00.000Z", message: { method, params } });
  const events = [
    event("turn/started", { threadId: "OP", turnId: "op-1" }),
    event("thread/tokenUsage/updated", { threadId: "OP", turnId: "op-1",
      tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 20,
        outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 110 } } }),
  ];
  // The ledger may know an exact terminal even when that Thread's whole native
  // stream is missing. Do not rely only on Threads with usage notifications.
  const stages = [{ stage: 1, terminal: { threadId: "L", turnId: "leader-1" } }];
  const tokens = quantifyEvents(events, stages).totals.tokens;
  assert.equal(tokens.status, "partial");
  assert.equal(tokens.totalTokens, "unknown");
  assert.equal(tokens.inputTokens, "unknown");
  assert.equal(tokens.observedTotals.totalTokens, 110);
  assert.deepEqual(tokens.coverage.missingThreadIds, ["L"]);
  const noUsage = quantifyEvents([], stages).totals.tokens;
  assert.equal(noUsage.status, "unknown");
  assert.equal(noUsage.observedTotals.totalTokens, "unknown", "No observation is not zero");
  assert.deepEqual(noUsage.coverage.missingThreadIds, ["L"]);
  const complete = quantifyEvents([...events, event("thread/tokenUsage/updated", {
    threadId: "L", turnId: "leader-1", tokenUsage: { total: { inputTokens: 200,
      cachedInputTokens: 30, outputTokens: 20, reasoningOutputTokens: 3, totalTokens: 220 } },
  })], stages).totals.tokens;
  assert.equal(complete.status, "observed");
  assert.equal(complete.totalTokens, 330, "Cached/reasoning subsets are not added twice");
  assert.deepEqual(complete.coverage.missingThreadIds, []);
  const nativeOnly = quantifyEvents([...events,
    event("turn/started", { threadId: "L", turnId: "leader-1" })]).totals.tokens;
  assert.deepEqual(nativeOnly.coverage.missingThreadIds, ["L"]);
});
test("usage observations distinguish cumulative growth, duplicates and missing request coverage", () => {
  const sample = (input, last) => ({ at: String(input), message: { params: { tokenUsage: {
    total: { inputTokens: input }, last: { inputTokens: last },
  } } } });
  const profile = usageObservations([sample(100, 100), sample(100, 100), sample(240, 140), sample(540, 160)], { inputTokens: 0 });
  assert.equal(profile.uniqueUpdates, 3);
  assert.equal(profile.duplicateUpdates, 1);
  assert.deepEqual(profile.samples.map(s => s.inputDelta), [100, 140, 300]);
  assert.deepEqual(profile.samples.map(s => s.matchesLastInput), [true, true, false]);
  assert.equal(profile.observedLastInputSum, 400);
  assert.equal(profile.requestCount, "unknown");
  assert.equal(usageObservations([sample(100, 100)]).samples[0].inputDelta, "unknown");
  assert.equal(usageObservations([sample(80, 20)], { inputTokens: 100 }).samples[0].inputDelta, "unknown");
  const many = usageObservations(Array.from({ length: 100 }, (_, i) => sample(i + 1, 1)), { inputTokens: 0 });
  assert.equal(many.uniqueUpdates, 100);
  assert.equal(many.samples.length, 64);
  assert.equal(many.omittedSamples, 36);
  assert.equal(many.observedLastInputSum, 100);
});
test("independent review exports complete fragments and validates exact citations without converting declarations into proven independence", t => {
  const root = mkdtempSync(join(tmpdir(), "yui-review-check-"));
  t.after(() => rmSync(root, { recursive: true }));
  const invocation = { preflight: { product: "/product" }, plan: { materials: ['original task\n{"recordCount": 2, "unitsTotal": 11}\n🐈'],
    businessScenarios: { "business-route": { title: "request revision", contract: "planning only",
      irrelevant: "old archive", stages: [{ materials: ["signed venue original"], request: { kitsPerAttendee: 2 } }],
      expected: [{ evaluatorOnly: "DO-NOT-LEAK-ANSWER-CATALOG" }] } } },
    identity: "original", prefix: "", files: [], bytes: () => Buffer.from(""),
    store: { source: "/archive", bytes: () => Buffer.from("") } };
  const source = { path: "/product/skills/x/SKILL.md", body: "完整规则\n".repeat(4000), kind: "core" };
  const directory = join(root, "case");
  exportReviewCase(invocation, { files: [source], missing: [{ path: "missing" }] }, directory, "blind");
  const larger = join(root, "large-directory");
  const originals = Array.from({ length: 20 }, (_, i) => ({
    path: `/product/skills/topic-${i}.md`, body: `complete source ${i}`, kind: "core",
  }));
  exportReviewCase(invocation, { files: originals, missing: [] }, larger, "large");
  const largerView = verifyViewMappings(larger, verifyReviewPackage(larger).manifest);
  const guide = readFileSync(join(larger, "READING.md"), "utf8");
  const lastOriginal = largerView.index.find(e => readFileSync(join(larger, e.file), "utf8") === originals.at(-1).body);
  assert.ok(lastOriginal);
  assert.ok(guide.includes(`| ${lastOriginal.id} |`), "Compact directory must retain every source ID");
  const entries = [
    ...Array.from({ length: 50 }, (_, i) => ({ id: `V${i}`, role: "leader", threadId: "long-original-thread-identity", turnId: "long-original-turn-identity" })),
    { id: "V000003", role: "leader", threadId: "T2", turnId: "t1" },
    { id: "V000004", role: "leader", threadId: "long-original-thread-identity", turnId: "long-original-turn-identity" },
  ];
  const grouped = directoryLines(entries);
  assert.deepEqual(grouped.filter(s => s.startsWith("| V")).map(s => s.split(" | ")[0].slice(2)), entries.map(e => e.id));
  assert.equal(grouped.filter(s => s.startsWith("Source ")).length, 3, "Nonconsecutive identities cannot be reordered or merged");
  let selection = {}, found = [];
  do {
    const page = reader.listReviewDocuments(larger, selection);
    found.push(...page.items.map(e => e.id)); selection = page.next;
  } while (selection);
  assert.deepEqual(found, largerView.index.map(e => e.id), "Every original remains discoverable");
  assert.equal(reader.readReviewPage(larger, lastOriginal.id).text, originals.at(-1).body);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json")));
  const contract = manifest.index.filter(e => e.kind === "original-contract")
    .map(e => readFileSync(join(directory, e.file), "utf8")).join("");
  assert.ok(contract.includes("signed venue original"));
  assert.ok(contract.includes('"kitsPerAttendee": 2'));
  assert.ok(!contract.includes("DO-NOT-LEAK-ANSWER-CATALOG"));
  assert.ok(!contract.includes('"expected"'));
  assert.equal(manifest.subjectMode, "unknown");
  assert.equal(manifest.subjectRunFacts.mode, "unknown");
  for (const mode of ["real", "fake"]) {
    const pre = Buffer.from(JSON.stringify({ mode, product: "/secret/condition-B", grade: "pass" }));
    const plan = Buffer.from(JSON.stringify({ mode, preflightIdentity: hash(pre), grade: "pass", materials: ["mode fixture contract"] }));
    const frozen = { files: ["plan.json", "preflight.json"], plan: JSON.parse(plan), preflight: JSON.parse(pre),
      bytes: p => p === "plan.json" ? plan : pre };
    const facts = subjectRunFacts(frozen);
    assert.equal(facts.mode, mode);
    assert.equal(facts.sources.plan.sha256, hash(plan));
    assert.equal(facts.sources.preflight.sha256, hash(pre));
    assert.ok(!JSON.stringify(facts).includes("/secret/condition-B"));
    assert.ok(!JSON.stringify(facts).includes('"grade"'));
    const exported = join(root, `mode-${mode}`);
    exportReviewCase({ ...invocation, ...frozen }, { files: [], missing: [] }, exported, mode);
    assert.deepEqual(verifyReviewPackage(exported).manifest.subjectRunFacts, facts);
    const projected = join(root, `mode-${mode}-view`);
    exportReadableReview(exported, projected);
    assert.equal(verifyReviewPackage(projected).manifest.subjectMode, mode);
    assert.equal(subjectRunFacts({ ...frozen, plan: { mode: "real" } }).mode, "unknown");
    const other = Buffer.from(JSON.stringify({ mode: mode === "real" ? "fake" : "real" }));
    const conflictPlan = Buffer.from(JSON.stringify({ mode, preflightIdentity: hash(other) }));
    assert.equal(subjectRunFacts({ files: frozen.files, bytes: p => p === "plan.json" ? conflictPlan : other }).mode, "unknown");
    const unbound = Buffer.from(JSON.stringify({ mode, preflightIdentity: "wrong" }));
    assert.equal(subjectRunFacts({ files: frozen.files, bytes: p => p === "plan.json" ? unbound : pre }).mode, "unknown");
  }
  assert.equal(subjectRunFacts({ plan: { mode: "real" }, preflight: { mode: "real" }, files: [] }).mode, "unknown");
  const parts = manifest.index.filter(e => e.kind === "frozen-core");
  assert.ok(parts.length > 1);
  assert.equal(parts.map(e => readFileSync(join(directory, e.file), "utf8")).join(""), source.body);
  const evidence = manifest.index[0];
  const review = { caseId: "blind", rubricDigest: RUBRIC_DIGEST,
    reviewer: { model: "gpt-6-luna", effort: "medium", fresh: true, sessionId: "new-session" },
    criteria: RUBRIC.map(c => ({ id: c.id, applicability: "applicable", verdict: "followed", rationale: "visible",
      citations: [{ evidenceId: evidence.id, quote: "original task" }] })) };
  const checked = validateReview(directory, review, ["developer-session"]);
  const broken = structuredClone(review);
  broken.criteria[0].citations[0].quote = "not in this source";
  broken.criteria[1].citations[0].evidenceId = "missing-id";
  const diagnosed = diagnoseReview(directory, broken);
  assert.equal(diagnosed.status, "rejected");
  assert.deepEqual(diagnosed.criteria.filter(c => c.errors.length).map(c => c.id), RUBRIC.slice(0, 2).map(c => c.id));
  assert.equal(diagnosed.criteria.filter(c => c.status === "structurally-valid").length, RUBRIC.length - 2);
  const brokenFile = join(root, "broken-review.json");
  writeFileSync(brokenFile, JSON.stringify(broken));
  const diagnosticCli = spawnSync(process.execPath, ["scripts/eval/context/history.mjs",
    "diagnose", directory, brokenFile], { encoding: "utf8" });
  assert.equal(diagnosticCli.status, 1);
  assert.deepEqual(JSON.parse(diagnosticCli.stdout), diagnosed, "CLI reports all errors without writing an import");
  assert.throws(() => validateReview(directory, broken), /Invalid evidence citation/, "Diagnostics must not accept valid siblings as a complete review");
  const wrongCase = diagnoseReview(directory, { ...review, caseId: "other" });
  assert.equal(wrongCase.status, "rejected");
  assert.deepEqual(wrongCase.criteria, [], "Identity failure cannot credit criteria");
  assert.equal(diagnoseReview(directory, review).status, "structurally-valid");
  assert.match(checked.executionIndependence, /unknown/);
  const view = verifyViewMappings(directory, manifest);
  const material = view.index.find(e => e.title === "original-contract /materials");
  review.criteria[0].citations = [{ evidenceId: material.id, quote: "original task" }];
  assert.equal(validateReview(directory, review).review.criteria[0].citations[0].evidenceId, material.id);
  review.criteria[0].citations[0] = { evidenceId: evidence.id, quote: '"recordCount": 2, "unitsTotal": 11' };
  assert.throws(() => validateReview(directory, review), /citation/, "Decoded strings must not be accepted as raw JSON substrings");
  review.criteria[0].citations[0].evidenceId = material.id;
  validateReview(directory, review);
  review.criteria[0].citations[0].quote = '"recordCount": 2, ... "unitsTotal": 11';
  assert.throws(() => validateReview(directory, review), /citation/, "Never fuzzy-match omissions/stitched quotes");
  const fullMaterial = readFileSync(join(directory, material.file), "utf8");
  const mappedPage = readReviewPage(directory, material.id);
  assert.deepEqual(mappedPage.citationSpansUtf16, material.fields.map(f => [f.startUtf16, f.endUtf16]));
  const [start, end] = mappedPage.citationSpansUtf16[0];
  const quoted = mappedPage.text.slice(start - mappedPage.offsetUtf16, end - mappedPage.offsetUtf16);
  review.criteria[0].citations = [{ evidenceId: mappedPage.id, quote: quoted }];
  validateReview(directory, review);
  const partialPage = readReviewPage(directory, material.id, start, 3);
  assert.deepEqual(partialPage.citationSpansUtf16, [[start, partialPage.endUtf16]]);
  const tinyPages = []; let tinyOffset = 0;
  do {
    const page = readReviewPage(directory, material.id, tinyOffset, 1);
    tinyPages.push(page.text); tinyOffset = page.nextOffset;
  } while (tinyOffset !== null);
  assert.equal(tinyPages.join(""), fullMaterial, "No surrogate split, hidden truncation or skipped Unicode payload");
  const cliPage = execFileSync(process.execPath, ["scripts/eval/context/history.mjs",
    "read", directory, material.id, "0,12000"], { encoding: "utf8" });
  assert.equal(cliPage.slice(cliPage.indexOf("\n") + 1), fullMaterial, "CLI paging prints literal decoded payload, not re-escaped JSON");
  const localPage = execFileSync(process.execPath, ["./read.mjs", material.id, "0,12000"],
    { cwd: directory, encoding: "utf8" });
  assert.equal(localPage, cliPage, "Sealed case-local reader needs no repository or helper discovery");
  const localCatalog = JSON.parse(execFileSync(process.execPath, ["./read.mjs", "--catalog", '{"limit":2}'],
    { cwd: directory, encoding: "utf8" }));
  assert.equal(localCatalog.items.length, 2);
  const localBatch = execFileSync(process.execPath, ["./read.mjs", "--batch",
    JSON.stringify([{ id: material.id, sha256: material.sha256 }]), "24000"],
  { cwd: directory, encoding: "utf8" });
  assert.ok(localBatch.includes(fullMaterial), "Batch CLI prints literal original text too");
  assert.ok(verifyReviewPackage(directory).seal["read.mjs"]);
  review.criteria[0].citations[0].quote = "FIELD /materials";
  assert.throws(() => validateReview(directory, review), /original field|citation/);
  review.criteria[0].citations = [{ evidenceId: evidence.id, quote: "original task" }];
  const instruction = view.index.find(e => e.title === "frozen-core");
  let offset = 0, completeText = "";
  do {
    const page = readReviewPage(directory, instruction.id, offset, 8191);
    completeText += page.text; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(completeText, source.body, "Bounded reads preserve whole logical documents through EOF");
  const newDirectory = join(root, "case-v2");
  const before = treeHashes(directory);
  exportReadableReview(directory, newDirectory);
  assert.deepEqual(treeHashes(directory), before, "New projection never mutates old sealed raw/views");
  verifyReviewPackage(newDirectory);
  verifyViewMappings(newDirectory, JSON.parse(readFileSync(join(newDirectory, "manifest.json"))));
  assert.throws(() => exportReadableReview(directory, newDirectory), /exists/);
  const privateEffects = join(root, "private-effect-case");
  exportReviewCase({ ...invocation, files: ["effects.json"],
    bytes: () => Buffer.from('{"nested":{"type":"reasoning","text":"DO_NOT_EXPORT_PRIVATE"}}') },
  { files: [], missing: [] }, privateEffects, "private-filter");
  assert.ok(Object.keys(treeHashes(privateEffects)).every(file =>
    !readFileSync(join(privateEffects, file), "utf8").includes("DO_NOT_EXPORT_PRIVATE")));
  const rawReview = join(root, "raw-review.json"), launchFile = join(root, "launch.json"),
    transportFile = join(root, "transport.jsonl"), terminalFile = join(root, "terminal.json");
  review.reviewer = { model: "gpt-6-luna", effort: "medium", sessionId: null };
  writeFileSync(rawReview, JSON.stringify(review));
  writeFileSync(launchFile, JSON.stringify({ caseId: "blind", freshExec: true, resume: false, fork: false,
    args: ["exec", "-m", "gpt-6-luna", "-c", 'model_reasoning_effort="medium"', "-s", "read-only", "-o", rawReview] }));
  writeFileSync(transportFile, '{"type":"thread.started","thread_id":"receipt-session"}\n{"type":"turn.completed"}\n');
  writeFileSync(terminalFile, '{"code":0,"signal":null}');
  const receipts = { launchFile, transportFile, terminalFile, reviewFile: rawReview };
  const rawBefore = readFileSync(rawReview);
  const bound = validateReview(directory, review, [], receipts);
  assert.equal(bound.effectiveReviewerSessionId, "receipt-session");
  assert.equal(bound.review.reviewer.sessionId, null, "Model output stays unchanged; binding is a separate record");
  assert.deepEqual(readFileSync(rawReview), rawBefore);
  const goodLaunch = readFileSync(launchFile), goodTransport = readFileSync(transportFile);
  writeFileSync(terminalFile, '{"code":1,"signal":null}');
  assert.throws(() => validateReview(directory, review, [], receipts), /terminal binding/);
  writeFileSync(terminalFile, '{"code":0,"signal":null}');
  writeFileSync(transportFile, goodTransport.toString() + '{"type":"thread.started","thread_id":"other"}\n');
  assert.throws(() => validateReview(directory, review, [], receipts), /terminal binding/);
  writeFileSync(transportFile, goodTransport);
  const conflictingLaunch = JSON.parse(goodLaunch);
  conflictingLaunch.args.push("-m", "another-model");
  writeFileSync(launchFile, JSON.stringify(conflictingLaunch));
  assert.throws(() => validateReview(directory, review, [], receipts), /terminal binding/);
  writeFileSync(launchFile, goodLaunch);
  assert.throws(() => validateReview(directory, review, ["receipt-session"], receipts), /fresh/);
  review.reviewer.sessionId = "conflicting-session";
  assert.throws(() => validateReview(directory, review, [], receipts), /fresh|immutable/);
  review.reviewer = { model: "gpt-6-luna", effort: "medium", fresh: true, sessionId: "new-session" };
  review.criteria[0].citations[0].quote = "invented";
  assert.throws(() => validateReview(directory, review), /citation/);
  review.criteria[0].citations[0].quote = "original task";
  assert.throws(() => validateReview(directory, review, ["new-session"]), /fresh/);
  assert.throws(() => compareReviews(checked, checked), /independently/);
  assert.throws(() => exportReviewCase(invocation, { files: [], missing: [] }, directory), /exists/);
  writeFileSync(join(directory, evidence.file), "changed");
  assert.throws(() => validateReview(directory, review), /integrity/);
});
test("review navigation distinguishes actual producer input/effect observations from future catalog materials", t => {
  const root = mkdtempSync(join(tmpdir(), "yui-review-stages-"));
  t.after(() => rmSync(root, { recursive: true }));
  const scene = { title: "stages", contract: "plan only", stages: [
    { materials: ["first"], request: { revision: 1 } },
    { materials: ["second"], request: { revision: 2 } },
    { materials: ["FUTURE-NOT-SUBMITTED"], request: { revision: 3 } },
  ], expected: ["NEVER-EXPORT-EXPECTED-ANSWER"] };
  const entries = [1, 2].map(stage => ({ phase: "producer", at: `2026-10-27T16:26:0${stage}Z`,
    args: ["--json", "role", "message", "queue", "operator",
      JSON.stringify({ kind: "eval-route", input: { stage, effectKey: `framework-stage-${stage}` } }),
      "--request-id", `op-input-${stage}`], stdout: '{"ok":true,"data":{}}', stderr: "", code: 0, signal: null }));
  const files = { "business-recovery/cli-trace.json": JSON.stringify(entries),
    "business-recovery/observation-2.json": JSON.stringify({
      before: { at: "2026-10-27T16:26:00Z", state: {} }, after: {
        at: "2026-10-27T16:27:00Z", state: { decisions: [{ payload: '{"title":"framework-stage-2"}' }] } }, journal: [] }) };
  const invocation = { plan: { businessScenarios: { "business-recovery": scene } }, preflight: {},
    files: Object.keys(files), bytes: p => Buffer.from(files[p]), store: { source: "saved" } };
  const directory = join(root, "case");
  exportReviewCase(invocation, { files: [], missing: [] }, directory, "stages");
  const { manifest } = verifyReviewPackage(directory), view = verifyViewMappings(directory, manifest);
  const nav = view.stageNavigation;
  assert.equal(nav.length, 3);
  assert.equal(nav[1].inputCalls[0].requestId, "op-input-2");
  assert.equal(nav[1].inputCalls[0].at, entries[1].at);
  assert.ok(nav[1].inputCalls[0].documents.length);
  assert.ok(nav[1].effects[0].documents.length);
  assert.equal(nav[2].submission, "not-submitted-by-fixture-in-complete-saved-trace");
  assert.deepEqual(nav[2].effects, []);
  assert.ok(readFileSync(join(directory, "READING.md"), "utf8").includes("FUTURE/UNSUBMITTED"));
  assert.ok(Object.keys(treeHashes(directory)).every(file =>
    !readFileSync(join(directory, file), "utf8").includes("NEVER-EXPORT-EXPECTED-ANSWER")));
  const input = view.index.find(e => e.title === "recorded-producer /entries");
  const content = readReviewPage(directory, input.id).text;
  assert.ok(content.includes(entries[1].args[5]));
});
