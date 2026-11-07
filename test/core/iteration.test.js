import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openTaskArtifactRepository } from "../../dist/artifacts/taskArtifactRepository.js";
import { openIteration, validateKnowledge } from "../../dist/iteration/iteration.js";

test("experiment knowledge fixes evidence, preserves retries, and atomically selects current conclusions", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-iteration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = openTaskArtifactRepository(home, "task-1");
  await repo.ensure();
  const iteration = openIteration(repo);
  let head = await repo.head();
  let sequence = 0;
  const save = async record => {
    const result = await iteration.save({ requestId: `request-${++sequence}`, expectedHead: head, record });
    head = result.commit;
    return result;
  };
  const direction = id => ({ schemaVersion: 1, kind: "direction", id,
    title: id, problem: "latency", goal: "less time", metrics: ["p95"], constraints: ["same quality"],
    priority: "high", status: "active", next: "measure", unresolved: ["quota is not authorized"] });
  await save(direction("speed"));
  await save(direction("context"));
  const plan = await save({ schemaVersion: 1, kind: "plan", id: "paired", title: "paired evaluation",
    method: "paired observations; report variance", parameters: { samples: 10 }, document: "Keep inputs fixed." });
  const condition = commit => ({ repository: "project-1", commit, tree: "clean" });
  const experiment = await save({ schemaVersion: 1, kind: "experiment", id: "trial",
    title: "reduce context", directions: ["speed", "context"], hypothesis: "less input reduces latency",
    plan: plan.ref, parameters: { samples: 10 }, baseline: condition("a".repeat(40)),
    candidate: condition("b".repeat(40)), conditions: { dataset: "fixture-v1", model: "fake", build: "local" } });
  const revised = await save({ ...(await iteration.read(experiment.ref)), id: "trial-2",
    candidate: condition("c".repeat(40)), revises: experiment.ref });
  assert.equal((await iteration.read(revised.ref)).plan.commit, plan.commit);
  const execution = id => ({ schemaVersion: 1, kind: "execution", id, experiment: experiment.ref,
    sample: id, conditions: { model: "fake" }, observations: { latency: 12 }, evidence: [],
    outcome: "observed", limitations: ["synthetic data"] });
  const failed = await save({ ...execution("failed"), outcome: "failed", observations: {} });
  assert.throws(() => validateKnowledge({ ...execution("invalid"), retryOf: null }), /object/);
  const experimentRecord = await iteration.read(experiment.ref);
  assert.throws(() => validateKnowledge({ ...experimentRecord, revises: null }), /object/);
  const measured = await save({ ...execution("measured"), retryOf: failed.ref,
    experiment: { commit: experiment.ref.commit, id: experiment.ref.id,
      kind: experiment.ref.kind, taskId: experiment.ref.taskId } });
  const report = await save({ schemaVersion: 1, kind: "analysis", id: "analysis-1", title: "mixed result",
    inputs: [measured.ref], method: plan.ref, conclusion: "latency improved; quality unknown",
    limitations: ["synthetic"], evidence: [], relations: [], document: "No adoption without quality." });
  await save({ ...direction("speed"), currentExperiment: experiment.ref, currentConclusion: report.ref });
  const view = await iteration.overview();
  assert.equal(view.directions.length, 2);
  assert.equal(view.directions[1].currentConclusion?.id ?? view.directions[0].currentConclusion?.id, "analysis-1");
  assert.equal((await iteration.read(measured.ref)).retryOf.id, "failed");
  assert.equal((await iteration.read(failed.ref)).outcome, "failed");
  assert.equal((await iteration.read(experiment.ref)).plan.commit, plan.commit);
  const newMethod = await save({ ...(await iteration.read(plan.ref)), id: "robust", method: "paired median and confidence interval" });
  const reanalysis = await save({ ...(await iteration.read(report.ref)), id: "analysis-2", method: newMethod.ref,
    conclusion: "gain not established", relations: [{ relation: "refutes", report: report.ref }] });
  await save({ ...direction("speed"), currentExperiment: revised.ref, currentConclusion: reanalysis.ref });
  assert.equal((await iteration.read(report.ref)).conclusion, "latency improved; quality unknown");
  assert.equal((await iteration.overview()).directions.find(d => d.id === "speed").currentConclusion.id, "analysis-2");
  await assert.rejects(save({ ...execution("measured"), observations: { latency: 1 } }), /immutable/);
  const beforeConflict = await repo.head();
  await assert.rejects(iteration.save({ requestId: "stale", expectedHead: plan.commit,
    record: direction("third") }), /advanced|conflict/i);
  assert.equal(await repo.head(), beforeConflict);
  const request = { requestId: "repeat", expectedHead: head, record: direction("third") };
  const saved = await iteration.save(request);
  assert.deepEqual(await iteration.save(request), saved);
  await assert.rejects(iteration.save({ ...request, record: direction("different") }), /request.*different/i);
  await assert.rejects(iteration.save({ requestId: "bad-ref", expectedHead: saved.commit,
    record: { ...execution("missing"), experiment: { ...experiment.ref, id: "missing" } } }), /unavailable|identity/i);
  assert.equal((await iteration.overview()).directions.length, 3);
  head = saved.commit;
  for (let i = 0; i < 8; i++) await save(direction(`other-${i}`));
  const page = await iteration.overview();
  assert.equal(page.directions.length, 8);
  assert.equal((await iteration.overview(page.nextCursor)).directions.length, 3);
  assert.ok(JSON.stringify(page).length < 64 * 1024);
  writeFileSync(join(repo.repoPath, "iteration", "partial.json"), '{"unfinished":true}');
  await assert.rejects(save(direction("interrupted")), /Uncommitted/);
  assert.equal((await iteration.overview()).total, 11, "unfinished files do not become current knowledge");
});

test("manual reports with missing inputs remain inspectable as artifacts but cannot become current knowledge", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-iteration-manual-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = openTaskArtifactRepository(home, "task-1");
  await repo.ensure();
  const knowledge = openIteration(repo);
  const plan = await knowledge.save({ requestId: "method", expectedHead: await repo.head(),
    record: { schemaVersion: 1, kind: "plan", id: "method", title: "Method",
      method: "paired", parameters: {}, document: "Use actual observations." } });
  const report = { schemaVersion: 1, kind: "analysis", id: "unsupported", title: "Unsupported",
    inputs: [{ ...plan.ref, kind: "execution", id: "missing" }], method: plan.ref,
    conclusion: "Improved", limitations: [], evidence: [], relations: [], document: "Missing input." };
  const saved = await repo.save({ expectedHead: plan.commit, message: "Manual report",
    files: [{ relativePath: "iteration/analysis/unsupported.json", bytes: Buffer.from(JSON.stringify(report)) }] });
  const reference = { taskId: "task-1", kind: "analysis", id: "unsupported", commit: saved.commit };
  const direction = { schemaVersion: 1, kind: "direction", id: "latency", title: "Latency", problem: "Slow",
    goal: "Faster", metrics: [], constraints: [], priority: "high", status: "active",
    next: "Inspect missing evidence", unresolved: [], currentConclusion: reference };
  await repo.save({ expectedHead: saved.commit, message: "Manual selection", files: [
    { relativePath: "iteration/direction/latency.json", bytes: Buffer.from(JSON.stringify(direction)) },
    { relativePath: "iteration/index.json", bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, directions: ["latency"] })) }
  ] });
  assert.equal(JSON.parse((await repo.read("iteration/analysis/unsupported.json")).bytes).conclusion, "Improved");
  await assert.rejects(knowledge.read(reference), /unavailable|missing/i);
  await assert.rejects(knowledge.overview(), /unavailable|missing/i);
});

test("direction navigation remains bounded beyond one hundred retained directions", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-iteration-index-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = openTaskArtifactRepository(home, "task-1");
  await repo.ensure();
  const directions = Array.from({ length: 101 }, (_, i) => `direction-${i}`);
  const files = directions.map(id => ({
    relativePath: `iteration/direction/${id}.json`,
    bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "direction", id, title: id,
      problem: "problem", goal: "goal", metrics: [], constraints: [], priority: "low",
      status: "closed", next: "retain evidence", unresolved: [] }))
  }));
  files.push({ relativePath: "iteration/index.json",
    bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, directions })) });
  const saved = await repo.save({ files, expectedHead: await repo.head(), message: "retained directions fixture" });
  const knowledge = openIteration(repo);
  assert.equal((await knowledge.overview()).directions.length, 8);
  const last = await knowledge.overview(`${saved.commit}:100`);
  assert.equal(last.total, 101);
  assert.equal(last.directions.length, 1);
  assert.equal(last.nextCursor, null);
});
