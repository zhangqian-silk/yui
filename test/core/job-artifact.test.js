import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createJobDefinitionControl } from "../../dist/controller/jobDefinitionControl.js";
import { startDurableJob, completeDurableJob } from "../../dist/job/durableJob.js";
import { openJobArtifactRepository } from "../../dist/artifacts/jobArtifact.js";
import { openTaskArtifactRepository } from "../../dist/artifacts/taskArtifactRepository.js";
import { saveArtifactCapability, readArtifactCapability } from "../../dist/artifacts/artifactCapability.js";
import { applySqliteMinorUpgrades } from "../../dist/storage/sqliteSchema.js";
import Database from "../../dist/sqlite/driver.js";
import { runDurableJobCommand } from "../../dist/commands/durableJobCommands.js";
import { usePre118Layout } from "../helpers/pre19Storage.mjs";

test("Job artifacts: Task-free saves pin history, isolate Runs, and derive latest/success independently", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-job-artifact-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const control = createJobDefinitionControl(store, home);
  const base = { scope: { kind: "global" }, caller: { scope: "user" }, id: "reports" };
  const call = (op, input = {}) => control({ ...base, op, ...input }, new Date());
  call("define", { title: "Reports", configuration: { kind: "builtin", action: "system.noop", input: {} } });
  const first = call("run", { trigger: { source: "manual", key: "one" } }).run;
  const published = await call("artifact-save", { runId: first.id,
    artifact: { relativePath: "report.md", content: "first result" } });
  assert.equal(published.status, "registered");
  const saved = published.reference;
  assert.equal(saved.owner.kind, "job");
  assert.deepEqual(saved.owner.scope, { kind: "global" });
  assert.equal(saved.owner.jobId, "reports");
  assert.equal(saved.sourceRun.runId, first.id);
  assert.match(saved.version, /^[a-f0-9]{40}$/);
  const updated = (await call("artifact-save", { runId: first.id,
    artifact: { relativePath: "report.md", content: "revised result", expectedHead: saved.version } })).reference;
  await assert.rejects(async () => call("artifact-save", { runId: first.id,
    artifact: { relativePath: "report.md", content: "lost update", expectedHead: saved.version } }), /advanced|conflict/i);
  assert.equal((await call("artifact-read", { runId: first.id, reference: saved })).content, "first result");
  assert.equal((await call("artifact-read", { runId: first.id, reference: updated })).content, "revised result");
  const finish = (id, outcome) => {
    const run = store.getGlobalJobRun(id);
    const running = startDurableJob(run, { pid: 123, startIdentity: "fixture" }, new Date());
    store.saveGlobalJobRun(running);
    store.saveGlobalJobRun(completeDurableJob(running, {
      outcome, exitCode: outcome === "succeeded" ? 0 : 1, signal: null, steps: []
    }, new Date()));
  };
  finish(first.id, "succeeded");
  const second = call("run", { trigger: { source: "manual", key: "two" } }).run;
  const failed = (await call("artifact-save", { runId: second.id,
    artifact: { relativePath: "report.md", content: "failed attempt" } })).reference;
  finish(second.id, "failed");
  assert.equal((await call("artifact-read", { runId: first.id, reference: saved })).content, "first result");
  await assert.rejects(async () => call("artifact-read", { runId: second.id, reference: saved }), /Run|reference|registered/i);
  const view = call("show");
  assert.equal(view.results.latest.runId, second.id);
  assert.equal(view.results.latestSuccessful.runId, first.id);
  assert.deepEqual(call("run-result", { runId: second.id }).artifacts, [failed]);
  assert.equal(store.listTasks().length, 0);
  assert.equal(store.getGlobalRoleSessionSet("operator"), null);
  assert.throws(() => store.saveGlobalJobRun({ ...store.getGlobalJobRun(first.id), artifacts: [updated] }), /transition/);
});

test("Job artifacts: failed registration retains evidence, explicit registration never executes work, preview is bounded", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-job-artifact-failure-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const control = createJobDefinitionControl(store, home);
  const base = { scope: { kind: "global" }, caller: { scope: "user" }, id: "reports" };
  const call = (op, input = {}) => control({ ...base, op, ...input }, new Date());
  call("define", { title: "Reports", configuration: { kind: "builtin", action: "system.noop", input: {} } });
  const run = call("run", { trigger: { source: "manual", key: "one" } }).run;
  const originalSave = store.saveGlobalJobRun.bind(store);
  store.saveGlobalJobRun = () => { throw new Error("fixture publication fault"); };
  const receipt = await call("artifact-save", { runId: run.id,
    artifact: { relativePath: "report.md", content: "saved evidence" } });
  assert.equal(receipt.status, "saved-unregistered");
  assert.match(receipt.error, /publication fault/);
  const ref = receipt.reference;
  store.saveGlobalJobRun = originalSave;
  assert.equal(store.getGlobalJobRun(run.id).artifacts, undefined);
  const listing = await call("artifact-list", { runId: run.id });
  assert.deepEqual(listing.artifacts, []);
  assert.deepEqual(listing.repository.saved, [ref]);
  await call("artifact-register", { runId: run.id, reference: ref });
  await call("artifact-register", { runId: run.id, reference: ref });
  assert.equal(store.getGlobalJobRun(run.id).artifacts.length, 1);
  assert.equal(store.getGlobalJobRun(run.id).status, "queued");
  assert.equal(store.listGlobalJobRuns().length, 1);
  assert.equal((await call("artifact-preview", { runId: run.id, reference: ref })).kind, "markdown");
  await assert.rejects(async () => call("artifact-register", { runId: run.id, reference: { ...ref, digest: "0".repeat(64) } }), /digest/);
  await assert.rejects(async () => call("artifact-register", { runId: run.id,
    reference: { ...ref, owner: { kind: "task", taskId: "task-1" } } }), /Leader|Operator/);
  const save = async artifact => (await call("artifact-save", { runId: run.id, artifact })).reference;
  const nearLimitBody = "m".repeat(262000);
  const nearLimit = await save({ relativePath: "near-limit.md", content: nearLimitBody });
  assert.equal((await call("artifact-read", { runId: run.id, reference: nearLimit })).content, nearLimitBody);
  assert.equal((await call("artifact-preview", { runId: run.id, reference: nearLimit })).content, nearLimitBody);
  await assert.rejects(save({ relativePath: "../escape", content: "no" }), /forbidden|relative/);
  await assert.rejects(save({ relativePath: "big.txt", content: "a".repeat(256 * 1024) }), /encoded JSON/);
  await assert.rejects(save({ relativePath: "escaped.txt", content: "\u0001".repeat(50_000) }), /encoded JSON/);
  await assert.rejects(runDurableJobCommand(["artifact-save", "--global", "--job", "reports", "--run", run.id,
    "--artifact", JSON.stringify({ relativePath: "oversized.txt", content: "a".repeat(2 * 1024 * 1024) })],
  { home, environment: {} }), /encoded JSON/, "CLI must reject before the 1 MiB RPC frame or any Controller startup");
  await assert.rejects(save({ relativePath: "fake.png", encoding: "base64", content: Buffer.from("<script/>").toString("base64") }), /image/i);
  const text = await save({ relativePath: "report.txt", content: "a".repeat(12001) });
  const page = await call("artifact-preview", { runId: run.id, reference: text });
  assert.equal(page.nextOffset, 12000);
  assert.equal((await call("artifact-preview", { runId: run.id, reference: text, offset: page.nextOffset })).content, "a");
  // A producer may save larger material through the shared repository; transport
  // is separately bounded even when registration itself is a small exact ref.
  const repo = openJobArtifactRepository(home, ref.owner, ref.sourceRun);
  const large = await repo.save({ message: "large producer output", files: [
    { relativePath: "large.md", bytes: Buffer.from("a".repeat(256 * 1024 + 1)) },
    { relativePath: "large.txt", bytes: Buffer.from("a".repeat(2 * 1024 * 1024)) }
  ] });
  const largeRef = async relativePath => {
    const content = await repo.read(relativePath, large.commit);
    const reference = { ...ref, relativePath, version: large.commit, digest: content.digest };
    await call("artifact-register", { runId: run.id, reference });
    return reference;
  };
  const hugeMd = await largeRef("large.md");
  await assert.rejects(async () => call("artifact-preview", { runId: run.id, reference: hugeMd }), /256 KiB/);
  const largeText = await largeRef("large.txt");
  await assert.rejects(async () => call("artifact-read", { runId: run.id, reference: largeText }), /encoded JSON/);
  assert.equal((await call("artifact-preview", { runId: run.id, reference: largeText })).nextOffset, 12000);
  const png = await save({ relativePath: "image.png", encoding: "base64",
    content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" });
  assert.equal((await call("artifact-preview", { runId: run.id, reference: png })).mime, "image/png");
  const outside = join(home, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(repo.repoPath, "escape"));
  await assert.rejects(save({ relativePath: "escape/report.md", content: "no" }), /symbolic/);
});

test("scoped repositories serialize initial creation and preserve Task Git references across 1.16 migration", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-artifact-migration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  const control = createJobDefinitionControl(store, home);
  const base = { scope: { kind: "global" }, caller: { scope: "user" }, id: "same" };
  control({ ...base, op: "define", title: "Same", configuration: { kind: "builtin", action: "system.noop", input: {} } }, new Date());
  const run = control({ ...base, op: "run", trigger: { source: "manual", key: "one" } }, new Date()).run;
  const frozen = await saveArtifactCapability(home, "task-1", { relativePath: "old.md", content: "frozen Task evidence" });
  store.close();
  const db = new Database(join(home, "yui.db"));
  const before = db.prepare("SELECT payload FROM global_job_runs").get().payload;
  try {
    usePre118Layout(db);
    db.prepare("UPDATE storage_schema SET minor=16").run();
    applySqliteMinorUpgrades(db, home);
    assert.equal(db.prepare("SELECT minor FROM storage_schema").get().minor, 18);
    assert.equal(db.prepare("SELECT payload FROM global_job_runs").get().payload, before);
  } finally { db.close(); }
  await saveArtifactCapability(home, "task-1", { relativePath: "old.md", content: "new Task evidence" });
  assert.equal((await readArtifactCapability(home, "task-1", frozen)).content, "frozen Task evidence");
  const scopes = [{ kind: "global" }, { kind: "task", taskId: "task-1" }, { kind: "task", taskId: "task-2" }];
  const repos = scopes.map(scope => openJobArtifactRepository(home,
    { kind: "job", scope, jobId: "same" }, { scope, runId: run.id }));
  assert.equal(new Set(repos.map(repo => repo.repoPath)).size, 3);
  const saved = await Promise.all(repos.map((repo, i) => repo.save({
    message: "isolated", files: [{ relativePath: "same.md", bytes: Buffer.from(String(i)) }]
  })));
  for (let i = 0; i < repos.length; i++) assert.equal((await repos[i].read("same.md", saved[i].commit)).bytes.toString(), String(i));
  const fresh = openTaskArtifactRepository(home, "task-9");
  await Promise.all(["one.md", "two.md"].map(path => fresh.save({
    message: path, files: [{ relativePath: path, bytes: Buffer.from(path) }]
  })));
  assert.equal((await fresh.list()).length, 2, "first-save initialization and commits must share the fence");
  const head = await fresh.head();
  const results = await Promise.allSettled(["one", "two"].map(text => fresh.save({
    message: text, expectedHead: head, files: [{ relativePath: "same.md", bytes: Buffer.from(text) }]
  })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  writeFileSync(join(fresh.repoPath, "dirty.md"), "uncommitted");
  assert.ok((await fresh.workingChanges()).includes("dirty.md"));
});
