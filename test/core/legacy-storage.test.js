import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "../../dist/sqlite/driver.js";
import { upgradeLegacy37Database, validateLegacy37Database } from "../../dist/storage/legacy/database37.js";
import { convertLegacy37Record } from "../../dist/storage/legacy/records37.js";
import { inspectSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { validateStoredRecord } from "../../dist/storage/recordValidation.js";
import { normalizeVerificationPlan } from "../../dist/verification/verificationPlan.js";

test("published integer-37 fixture converts atomically without replacing its active native Session", () => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/legacy-0.16.2.json", import.meta.url), "utf8"));
  const db = new Database(":memory:");
  try {
    for (const kind of ["table", "index", "view", "trigger"]) {
      for (const entry of fixture.schema.filter(entry => entry.type === kind)) db.exec(entry.sql);
    }
    const now = new Date("2026-10-01T00:00:00Z");
    for (const entry of fixture.ledger) {
      db.prepare("INSERT INTO schema_migrations(version,name,applied_at,checksum) VALUES(?,?,?,?)")
        .run(entry.version, entry.name, now.toISOString(), entry.checksum);
    }
    db.prepare("INSERT INTO global_roles(name,payload,updated_at) VALUES(?,?,?)")
      .run("operator", JSON.stringify(fixture.role), now.toISOString());
    db.prepare("INSERT INTO global_role_session_sets(name,payload,updated_at) VALUES(?,?,?)")
      .run("operator", JSON.stringify(fixture.sessions), now.toISOString());
    db.prepare("INSERT INTO projects(id,name,path,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(fixture.project.id, fixture.project.name, fixture.project.path,
        JSON.stringify(fixture.project), now.toISOString(), now.toISOString());
    validateLegacy37Database(db);
    const original = db.prepare("SELECT payload FROM global_role_session_sets").get().payload;
    assert.throws(() => db.transaction(() => {
      upgradeLegacy37Database(db, "/unused-empty-fixture", [], now);
      throw Error("injected interruption");
    })(), /injected interruption/);
    validateLegacy37Database(db);
    assert.equal(db.prepare("SELECT payload FROM global_role_session_sets").get().payload, original);
    db.transaction(() => {
      upgradeLegacy37Database(db, "/unused-empty-fixture", [], now);
    })();
    assert.equal(inspectSqliteSchema(db).currentVersion, "1.8");
    const migrated = JSON.parse(db.prepare("SELECT payload FROM global_role_session_sets").get().payload);
    validateStoredRecord("global_role_session_sets", migrated);
    validateStoredRecord("global_roles", JSON.parse(db.prepare("SELECT payload FROM global_roles").get().payload));
    assert.equal(migrated.sessions.fixture.nativeSessionId, "native-original");
    assert.equal(migrated.sessions.fixture.status, "active");
    assert.equal(db.prepare("SELECT payload FROM storage_migration_archive WHERE family='legacy:37/global_role_session_sets'")
      .get().payload, original);
    assert.equal(JSON.parse(db.prepare("SELECT payload FROM storage_migration_archive WHERE family='legacy:37/ledger'")
      .get().payload).length, 37);
    const project = JSON.parse(db.prepare("SELECT payload FROM projects").get().payload);
    validateStoredRecord("projects", project);
    const entry = project.knowledge[0], proposal = project.knowledgeProposals[0];
    assert.equal(entry.scope, "Only isolated runs");
    assert.equal(entry.expiresWhen, "When protocol changes");
    assert.equal(entry.provenance.fingerprint, proposal.fingerprint);
    assert.equal(proposal.body, fixture.project.knowledgeProposals[0].body, "Historical proposal stays byte-identical.");
    assert.equal(normalizeVerificationPlan(JSON.parse(entry.body)).schemaVersion, 1);
    assert.equal(db.prepare("SELECT payload FROM storage_migration_archive WHERE family='legacy:37/projects'")
      .get().payload, JSON.stringify(fixture.project));
  } finally { db.close(); }
});

test("legacy baseline conversion preserves native identities and opaque historical evidence", () => {
  // Envelope versions are the published 0.16.2 contract, not current records
  // with a substituted Home version. Opaque user/provider/context JSON is not
  // recursively rewritten by the baseline transition.
  const source = {
    schemaVersion: 5,
    owner: { scope: "global", roleName: "operator" },
    activeAgentId: "codex",
    sessions: {
      codex: {
        schemaVersion: 6, agentId: "codex", adapterId: "codex",
        nativeSessionId: "native-original", revision: 23, status: "active",
        effective: { schemaVersion: 4, config: { schemaVersion: 91 } }
      }
    },
    history: {},
    providerBinding: { schemaVersion: 5, epoch: 17, run: { status: "delivery-unknown" } }
  };
  const original = structuredClone(source);
  const result = convertLegacy37Record("global_role_session_sets", source);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.sessions.codex.schemaVersion, 1);
  assert.equal(result.sessions.codex.effective.schemaVersion, 1);
  assert.equal(result.providerBinding.schemaVersion, 1);
  assert.equal(result.sessions.codex.nativeSessionId, "native-original");
  assert.equal(result.sessions.codex.revision, 23);
  assert.equal(result.sessions.codex.status, "active");
  assert.equal(result.providerBinding.epoch, 17);
  assert.deepEqual(result.providerBinding.run, { status: "delivery-unknown" });
  assert.deepEqual(result.sessions.codex.effective.config, { schemaVersion: 91 });
  assert.deepEqual(source, original);
  const taskSource = { ...source, schemaVersion: 12,
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    history: [structuredClone({ ...source.sessions.codex, nativeSessionId: "older-native", status: "ended" })] };
  const task = convertLegacy37Record("role_session_sets", taskSource);
  assert.ok(Array.isArray(task.history));
  assert.equal(task.history[0].schemaVersion, 1);
  assert.equal(task.history[0].nativeSessionId, "older-native");
  assert.equal(task.history[0].status, "ended");
  assert.deepEqual(convertLegacy37Record("role_session_sets", { ...taskSource, history: [] }).history, []);
  assert.throws(() => convertLegacy37Record("global_role_session_sets", { ...source, schemaVersion: 99 }),
    /Unsupported legacy:37/);
  assert.throws(() => convertLegacy37Record("unknown", source), /Unknown legacy:37/);
});
