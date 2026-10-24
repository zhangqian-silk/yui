import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createModelManagement } from "../../dist/models/modelManagement.js";
import { runModelMaintenance } from "../../dist/models/modelMaintenanceRunner.js";

test("native connection tool is preview-pinned, Job-owned, replay-safe and refuses Task authority", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-maintenance-service-"));
  let store;
  t.after(() => { store?.close(); rmSync(root, { recursive: true, force: true }); });
  store = new SqliteTaskStore(join(root, "home"));
  const service = createModelManagement(store);
  const configPath = join(root, "config.toml");
  writeFileSync(configPath, '# retained\nmodel = "native"\n', { mode: 0o600 });
  const input = { codex: { configPath, provider: { id: "fixture", name: "Fixture",
    baseUrl: "http://127.0.0.1:19000/v1", auth: { type: "none" } } } };
  const { planDigest, plan } = service.connectionPreview({ input });
  assert.equal(readFileSync(configPath, "utf8"), '# retained\nmodel = "native"\n');
  const request = { input, planDigest, requestId: "add-fixture", exclusiveWriter: true };
  assert.throws(() => service.connectionApply(request, { scope: "task", taskId: "task-1", role: "leader" }), /authority/);
  assert.throws(() => service.connectionApply({ ...request, planDigest: "a".repeat(64) }, { scope: "user" }), /preview/);
  const admitted = service.connectionApply(request, { scope: "user" });
  assert.equal(admitted.created, true);
  assert.equal(service.connectionApply(request, { scope: "user" }).run.id, admitted.run.id);
  assert.throws(() => service.connectionApply({ ...request, requestId: "another" }, { scope: "user" }), /active or unknown/);
  // Exercise the real controlled executable after the supervisor's spawn fence,
  // without starting a Controller or a model/service.
  const active = { ...admitted.run, operation: { ...admitted.run.operation, effect: "possible" } };
  store.saveGlobalJobRun(active);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(store.rootDirectory(), active.artifactsLocator), { recursive: true, mode: 0o700 });
  await runModelMaintenance(store.rootDirectory(), active.id);
  const result = JSON.parse(readFileSync(join(store.rootDirectory(), active.artifactsLocator, "business-result.json"), "utf8"));
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.data.applied, "files-only");
  assert.equal(result.data.restarted, false);
  assert.match(readFileSync(configPath, "utf8"), /# retained/);
  assert.doesNotMatch(readFileSync(configPath, "utf8"), /^model_provider/m);
  assert.ok(result.data.files.some(f => f.backupPath));
  assert.ok(plan.files.every(f => !("raw" in f)));
  const saved = readFileSync(configPath, "utf8");
  const revision = store.getJobDefinition({ kind: "global" }, "model-connection").revision;
  const recovered = service.connectionApply(request, { scope: "user" });
  assert.equal(recovered.created, false, "recover the admitted request after its file effect");
  assert.equal(recovered.run.id, admitted.run.id);
  assert.equal(store.getJobDefinition({ kind: "global" }, "model-connection").revision, revision);
  assert.equal(readFileSync(configPath, "utf8"), saved, "recovery does not apply again");
  assert.throws(() => service.connectionApply({ ...request, planDigest: "c".repeat(64) }, { scope: "user" }), /different maintenance parameters/);
  assert.throws(() => service.connectionApply(request, { scope: "task", taskId: "task-1", role: "leader" }), /authority/);
});
