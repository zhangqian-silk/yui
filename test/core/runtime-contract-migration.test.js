import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask } from "../../dist/task/task.js";
import { createProject, addProjectKnowledge } from "../../dist/repository/project.js";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { resolveProjectVerificationPlan } from "../../dist/verification/verificationPlan.js";
import { rebuildHistoricalFixture } from "../helpers/historicalHome.mjs";

const at = new Date("2026-09-16T00:00:00Z");
const oldPlan = { schemaVersion: 1, kind: "verification-plan", id: "checks", version: "1",
  bootstrap: [], l1: { categories: [{ id: "old-checks", paths: ["src/"],
    checks: [{ name: "retired", argv: ["false"] }] }] },
  l2: { steps: [{ name: "current", argv: ["true"] }] } };

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-runtime-contract-migration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  const project = addProjectKnowledge(createProject("project-1", "Fixture", join(home, "repo"),
    { stable: "main", development: "main" }, at), "knowledge-1", "Checks", JSON.stringify(oldPlan), at);
  try {
    store.saveTask(createTask("task-1", "Retained history", at));
    store.saveProject(project);
  } finally { store.close(); }
  rebuildHistoricalFixture(home, 34);
  return { home, project };
}

test("34 to 35 archives old verification bytes and retires historical Integration identity without reuse", async t => {
  const { home } = fixture(t);
  const db = new Database(join(home, "yui.db"));
  const key = "7c580c7609ffabc281a85c6ba6f4b817552b00e409d7c698c4dd38b6503ed581";
  const log = Buffer.from([0, 1, 255, 65, 66]);
  const artifact = { schemaVersion: 1, key, projectId: "project-1", level: "L1", commit: "a".repeat(40),
    planId: "checks", planVersion: "1", planDigest: "b".repeat(64), toolchainDigest: "c".repeat(64),
    steps: [{ name: "old-check", command: "true", outcome: "passed", exitCode: 0, signal: null,
      timedOut: false, durationMs: 1, logPath: "old.log",
      logDigest: createHash("sha256").update(log).digest("hex"), logBytes: log.length }],
    generator: "yui", status: "complete", outcome: "succeeded", reuseCount: 0,
    createdAt: at.toISOString(), completedAt: at.toISOString(), lastUsedAt: at.toISOString() };
  const historical = { schemaVersion: 6, id: "integration-9", taskId: "task-1", projectId: "project-1",
    targetRef: "main", beforeCommit: "a".repeat(40), source: { kind: "historical-change-sets", changeSetIds: ["change-set-1"] },
    checkCommands: [], rerunChecks: false, status: "failed", createdAt: at.toISOString(),
    updatedAt: at.toISOString(), endedAt: at.toISOString() };
  let projectBytes, ledger;
  try {
    db.prepare(`INSERT INTO gate_artifacts
      (key,project_id,level,commit_sha,plan_digest,toolchain_digest,status,outcome,payload,created_at,last_used_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(key, artifact.projectId, artifact.level, artifact.commit,
      artifact.planDigest, artifact.toolchainDigest, artifact.status, artifact.outcome,
      JSON.stringify(artifact), artifact.createdAt, artifact.lastUsedAt);
    db.prepare("INSERT INTO gate_artifact_logs VALUES(?,?,?,?,?)")
      .run(key, "old-check", log, artifact.steps[0].logDigest, log.length);
    db.prepare("INSERT INTO integration_attempts VALUES(?,?,?,?,?)")
      .run(historical.taskId, historical.id, historical.status, JSON.stringify(historical), historical.updatedAt);
    db.exec("INSERT INTO id_sequences(task_id,kind,high_water) VALUES('task-1','event',80)");
    projectBytes = db.prepare("SELECT payload FROM projects WHERE id='project-1'").get().payload;
    ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  } finally { db.close(); }
  const upgrade = await runStorageUpgrade({ home, mode: "execute" });
  assert.equal(upgrade.outcome, "upgraded", JSON.stringify(upgrade));
  const current = new SqliteTaskStore(home);
  const audit = new Database(join(home, "yui.db"), { readonly: true });
  try {
    const plan = resolveProjectVerificationPlan(current.getProject("project-1"));
    assert.equal(plan.schemaVersion, 2);
    assert.equal(Object.hasOwn(plan, "l1"), false);
    assert.deepEqual(plan.l2, oldPlan.l2);
    assert.equal(audit.prepare("SELECT payload FROM storage_migration_archive WHERE family='project'").get().payload, projectBytes);
    assert.equal(audit.prepare("SELECT payload FROM storage_migration_archive WHERE family='gate-artifact'").get().payload, JSON.stringify(artifact));
    assert.deepEqual(audit.prepare("SELECT content FROM storage_migration_archive WHERE family='gate-artifact-log'").get().content, log);
    assert.equal(current.getGateArtifact("project-1", key), null);
    assert.throws(() => current.saveGateArtifact(artifact, new Map([["old-check", log]])), /level/i);
    assert.equal(current.getIntegrationAttempt("task-1", historical.id), null);
    const event = current.listEvents("task-1").find(event => event.type === "integration.source-retired");
    assert.equal(event.id, "event-81");
    assert.equal(event.payload.record, JSON.stringify(historical));
    assert.equal(current.nextIntegrationAttemptId("task-1"), "integration-10");
    assert.deepEqual(audit.prepare("SELECT * FROM schema_migrations WHERE version<=34 ORDER BY version").all(), ledger);
    current.validateCurrentRecords();
  } finally { audit.close(); current.close(); }
});

test("runtime cutover refuses unsettled gates and legacy custody; malformed conversion rolls back", async t => {
  const { home, project } = fixture(t);
  const db = new Database(join(home, "yui.db"));
  const attempt = { schemaVersion: 6, id: "integration-1", taskId: "task-1", projectId: "project-1",
    targetRef: "main", beforeCommit: "a".repeat(40), source: { kind: "work-item", workItemId: "work-item-1",
      startCommit: "a".repeat(40), resultCommit: "b".repeat(40), strategy: "ff" },
    checkCommands: [], rerunChecks: false, status: "running", gatePlanDigest: "c".repeat(64),
    createdAt: at.toISOString(), updatedAt: at.toISOString() };
  try {
    db.prepare("INSERT INTO integration_attempts VALUES(?,?,?,?,?)")
      .run(attempt.taskId, attempt.id, attempt.status, JSON.stringify(attempt), attempt.updatedAt);
    const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    for (const mode of ["dry-run", "update-preflight"]) {
      const result = await runStorageUpgrade({ home, mode });
      assert.equal(result.outcome, "blocked");
      assert.match(result.message, /admitted gate.*task-1\/integration-1/);
      assert.equal(result.sceneUnchanged, true);
    }
    assert.throws(() => migrateSqliteSchema(db, { mode: "apply" }), /admitted gate/);
    db.prepare("UPDATE integration_attempts SET status='failed',payload=?").run(JSON.stringify({
      ...attempt, status: "failed", endedAt: at.toISOString()
    }));
    db.prepare("UPDATE projects SET payload=?").run(JSON.stringify({ ...project, knowledge: [{
      ...project.knowledge[0], body: JSON.stringify({ ...oldPlan, schemaVersion: 99 })
    }] }));
    assert.throws(() => migrateSqliteSchema(db, { mode: "apply" }), /Invalid v34/);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), ledger);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='storage_migration_archive'").get(), undefined);
    db.prepare("UPDATE projects SET payload=?").run(JSON.stringify(project));
    const oldOwners = join(home, "runtime", "session-owners");
    mkdirSync(oldOwners, { recursive: true });
    const receipt = join(oldOwners, "original.json");
    writeFileSync(receipt, '{"retained":"original custody evidence"}');
    assert.equal((await runStorageUpgrade({ home, mode: "update-preflight" })).outcome, "blocked");
    assert.throws(() => migrateSqliteSchema(db, { mode: "apply" }), /file Session owners/);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), ledger);
    rmSync(receipt);
    migrateSqliteSchema(db, { mode: "apply" });
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version=35").get(),
      "The current-runtime cutover remains part of the complete migration chain.");
  } finally { db.close(); }
});
