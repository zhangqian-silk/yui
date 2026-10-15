import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cases } from "../../scripts/review-eval/cases.mjs";
import { verifyCases } from "../../scripts/review-eval/verify.mjs";
import { makePlan, summarize, participantFiles, exportParticipant } from "../../scripts/review-eval/evaluate.mjs";

const protocol = {
  model: "deterministic-test-only", effort: "fixed", tools: "local read", environment: "fixture",
  budget: "fixture", seed: "reproducible", repeats: 1,
  baseline: { "SKILL.md": "Baseline test instructions" }, improved: { "SKILL.md": "Improved test instructions" }
};

test("original review corpus exposes each constructed violation and passing repair/control", async () => {
  const result = await verifyCases();
  assert.equal(result.evidence.length, 16);
  assert.equal(result.evidence.filter(e => e.variant === "candidate")
    .reduce((sum, e) => sum + e.failedRoots.length, 0), 7);
});

test("participant export projects source/contracts only, preserves producer wiring and refuses overwrite", async t => {
  const root = await mkdtemp(join(tmpdir(), "yui-review-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "participant");
  const receipt = await exportParticipant("E03", "basic", target);
  assert.deepEqual((await readdir(target)).sort(), ["REQUIREMENTS.md", "main.mjs", "page.mjs"]);
  assert.equal(receipt.isolation, "export-only; not an OS sandbox or an unknown holdout");
  const { collect } = await import(join(target, "main.mjs"));
  const { fetchPage } = await import(join(target, "page.mjs"));
  await assert.rejects(collect(fetchPage), /Unknown cursor/);
  await assert.rejects(exportParticipant("E01", "basic", target), /EEXIST/);
  assert.equal(await readFile(join(target, "page.mjs"), "utf8"), cases[2].files["page.mjs"]);
  for (const c of cases) {
    const basic = participantFiles(c.id, "basic");
    const indexed = participantFiles(c.id, "indexed");
    assert.equal(indexed["REQUIREMENTS.md"], basic["REQUIREMENTS.md"]);
    for (const name of Object.keys(basic)) assert.equal(indexed[name], basic[name]);
    assert.deepEqual(Object.keys(indexed).filter(k => !(k in basic)), ["INDEX.md"]);
  }
});

test("2x2 scoring keeps semantic adjudication, missing trials, duplicates and uncertain outcomes distinct", () => {
  const plan = makePlan(protocol);
  assert.deepEqual(makePlan(protocol), plan);
  assert.equal(plan.runs.length, 32);
  const record = (id, findings, extra = {}) => ({
    ...plan.runs.find(r => r.id === id), planDigest: plan.digest, status: "completed",
    rawOutput: "Original fixture review", evidenceRef: "fixture://not-a-model-run",
    findings, ...extra
  });
  const valid = { id: "f1", claim: "End row included", verdict: "valid", root: "upper-bound",
    reason: "Contradicts half-open interval", evidence: "End record is returned" };
  const rows = [
    record("E01-A-1", [valid, { ...valid, id: "f2" },
      { ...valid, id: "f3", root: "novel:separate", reason: "Separately adjudicated new root" },
      { id: "f4", claim: "Needs investigation", verdict: "pending" }], { metrics: { wallMs: 12 } }),
    record("E07-A-1", [{ ...valid, verdict: "invalid", root: "pure-read",
      claim: "get must not change order", reason: "LRU explicitly changes order" }]),
    record("E02-B-1", [], { status: "infra-failed", rawOutput: "", reason: "Fixture failure", metrics: { wallMs: 8 } }),
    record("E03-C-1", [valid], { status: "timeout", reason: "Budget exhausted", metrics: { wallMs: 5 } }),
    record("E08-D-1", [])
  ];
  const result = summarize(plan, rows);
  assert.equal(result.groups.A.hits, 1);
  assert.equal(result.groups.A.recall, 1);
  assert.equal(result.groups.A.plannedDiscoveryYield, 1 / 7);
  assert.equal(result.groups.A.precision, 2 / 3);
  assert.equal(result.groups.A.duplicates, 1);
  assert.equal(result.groups.A.pending, 1);
  assert.equal(result.groups.A.novel, 1);
  assert.equal(result.groups.A.correctControlFalsePositiveRate, 1);
  assert.equal(result.groups.A.metrics.wallMs.observedTotal, 12);
  assert.equal(result.groups.A.metrics.wallMs.missing, 7);
  assert.equal(result.groups.B.statuses["infra-failed"], 1);
  assert.equal(result.groups.B.recall, null);
  assert.equal(result.groups.C.hits, 0);
  assert.equal(result.groups.D.precision, null);
  assert.equal(result.groups.D.recall, null);
  assert.equal(result.groups.D.statuses["not-run"], 7);
  assert.equal(result.recallContrasts.skillBasic, null);
  assert.throws(() => summarize(plan, [rows[0], rows[0]]), /duplicated/);
  assert.throws(() => summarize(plan, [{ ...rows[0], skillDigest: "different" }]), /skillDigest/);
  assert.throws(() => summarize(plan, [{ ...rows[0], configDigest: "different-model" }]), /configDigest/);
  assert.notEqual(summarize(plan, []).recordsDigest, result.recordsDigest);
  assert.throws(() => summarize(plan, [record("E01-A-1", [{ ...valid, root: "unknown" }])]), /Unknown gold/);
  assert.throws(() => summarize({ ...plan, runs: plan.runs.slice(1) }, []), /Plan drift/);
});
