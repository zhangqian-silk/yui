import test from "node:test";
import assert from "node:assert/strict";
import { compareEvidence } from "./compare.mjs";

function record(commit = "a") {
  return {
    schemaVersion: 1, mode: "offline", experiment: commit, caseSet: "fixed", seed: 89,
    freezeSha256: "freeze", policySha256: "policy", oracleSha256: "oracle",
    harnessSha256: { run: "runner" }, proxySha256: "proxy",
    version: { commit, worktreeStatus: "", node: "v24", platform: "linux",
      architecture: "x64", packageLockSha256: "lock" },
    cleanup: { status: "released" }, trace: [],
    conditions: [{ id: "O02", variant: "base", mode: "F", category: "operations", split: "dev",
      status: "partial-evidence", businessStatus: "scripted-pass",
      budget: { reads: 60 }, manifest: { sourceHashes: { "source/a": "fixed" } },
      traceRange: [0, 0], elapsedMs: 10, cleanup: { status: "released" },
      stages: { saved: true, discovered: true, understood: "unverified", acted: true },
      boundaries: { nativePermissions: "not-exercised" } }]
  };
}

test("saved pairs keep partial outcomes and never promote cheaper bytes to success", () => {
  const a = record(), b = record("b");
  b.conditions[0].elapsedMs = 5;
  const result = compareEvidence(a, b);
  assert.equal(result.comparable, true);
  assert.equal(result.plannedPairs, 1);
  assert.equal(result.pairs[0].costDelta.elapsedMs, -5);
  assert.equal(result.pairs[0].a.status, "partial-evidence");
  assert.equal(result.pairs[0].b.boundaries.nativePermissions, "not-exercised");
  assert.equal(result.optimizationBenefit, "not-established");
});

test("changed rules, budgets, material and toolchain refuse a fair comparison", () => {
  for (const mutate of [
    b => b.harnessSha256.run = "changed",
    b => b.seed++,
    b => b.oracleSha256 = "changed",
    b => b.version.node = "different",
    b => b.version.worktreeStatus = " M file",
    b => b.conditions[0].budget.reads++,
    b => b.conditions[0].manifest.sourceHashes["source/a"] = "changed"
  ]) {
    const b = record("b"); mutate(b);
    const result = compareEvidence(record(), b);
    assert.equal(result.comparable, false);
    assert.ok(result.mismatches.length);
    assert.equal(result.pairs[0].costDelta, null);
  }
});

test("missing, failed and pending-human cases stay visible; duplicates are invalid", () => {
  const a = record(), b = record("b");
  a.conditions[0].status = "environment-error";
  b.conditions[0].businessStatus = "pending-human";
  b.conditions.push({ ...b.conditions[0], id: "R02", status: "not-run" });
  const result = compareEvidence(a, b);
  assert.equal(result.comparable, false);
  assert.equal(result.plannedPairs, 2);
  assert.equal(result.pairs[0].a.status, "environment-error");
  assert.equal(result.pairs[0].b.businessStatus, "pending-human");
  assert.equal(result.pairs[1].a, null);
  assert.equal(result.pairs[1].b.status, "not-run");
  b.conditions.push(b.conditions[0]);
  assert.throws(() => compareEvidence(a, b), /Duplicate/);
});

test("unknown provenance and missing trace ranges cannot become zero-cost evidence", () => {
  const a = record(), b = record("b");
  delete a.seed; delete b.seed;
  assert.equal(compareEvidence(a, b).comparable, false);
  const c = record("c");
  delete c.conditions[0].traceRange;
  assert.equal(compareEvidence(record(), c).pairs[0].costDelta, null);
});
