import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { addProjectKnowledge, createProject, knowledgeProposalFingerprint } from "../../dist/repository/project.js";
import { createTask } from "../../dist/task/task.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { readTaskContext, inspectTaskContext } from "../../dist/context/taskContext.js";
import { createWebTaskSurface } from "../../dist/web/webTaskSurface.js";
import { applySqliteMinorUpgrades, inspectSqliteSchema, storageMinorUpgradePlan } from "../../dist/storage/sqliteSchema.js";
import { contextContentDigest, createContextSnapshot } from "../../dist/context/contextSnapshot.js";
import { createTaskMessage } from "../../dist/message/message.js";

const at = new Date("2026-10-09T00:00:00Z");

test("knowledge applicability changes survive approval, versioning, current Context and Web reads", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-knowledge-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  store.saveProject(createProject("project-1", "Example", join(home, "project"),
    { stable: "main", development: "main" }, at));
  store.saveTask(createTask("task-1", "Evidence", at, {
    projectBindings: [{ projectId: "project-1", directory: "project", baseRef: "main",
      baseCommit: "a".repeat(40), currentCommit: "a".repeat(40) }]
  }));
  const command = args => runProjectCommand(["knowledge", ...args], store, { now: () => at, environment: {} });
  const propose = (scope, expiry = "When the protocol changes") => command([
    "propose", "project-1", "--task", "task-1", "--title", "Protocol",
    "--body", "Read current facts.", "--scope", scope, "--expires-when", expiry
  ]);
  await propose("Task leaders");
  await propose("Task leaders");
  assert.equal(store.getProject("project-1").knowledgeProposals.length, 1);
  await command(["accept", "project-1", "proposal-1"]);
  await propose("Task leaders and reviewers");
  assert.equal(store.getProject("project-1").knowledgeProposals.length, 2,
    "a scope-only change must not reuse the accepted proposal");
  await assert.rejects(command(["accept", "project-1", "proposal-2"]), /same title/);
  await command(["accept", "project-1", "proposal-2", "--update", "knowledge-1"]);
  await propose("Task leaders and reviewers", "After an Agent explicitly retires this rule");
  await command(["accept", "project-1", "proposal-3", "--update", "knowledge-1"]);
  await command(["accept", "project-1", "proposal-3", "--update", "knowledge-1"]);
  await propose("Task leaders and reviewers", "After an Agent explicitly retires this rule");
  const entry = store.getProject("project-1").knowledge[0];
  assert.equal(entry.version, 3);
  assert.equal(entry.scope, "Task leaders and reviewers");
  assert.equal(entry.expiresWhen, "After an Agent explicitly retires this rule");
  assert.equal(entry.provenance.proposalId, "proposal-3");
  assert.deepEqual(entry.history.map(item => [item.version, item.scope, item.provenance.proposalId]),
    [[1, "Task leaders", "proposal-1"], [2, "Task leaders and reviewers", "proposal-2"]]);
  const shown = await command(["show", "project-1", "knowledge-1"]);
  assert.match(shown.output, /Version: 3/);
  assert.match(shown.output, /Task leaders and reviewers/);
  const core = readTaskContext(store, "task-1");
  const ref = core.records.find(item => item.ref.store === "project-knowledge").ref;
  assert.deepEqual(inspectTaskContext(store, "task-1", ref).value.history, entry.history);
  const web = createWebTaskSurface(store);
  assert.equal((await web.inspect("task-1", ref)).value.expiresWhen, entry.expiresWhen);
  const page = await command(["proposals", "list", "project-1", "--all", "--limit", "1"]);
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.total, 3);
  assert.equal(page.data.items[0].body, undefined);
  assert.equal((await command(["proposals", "list", "project-1", "--all", "--limit", "1",
    "--cursor", page.data.nextCursor])).data.items[0].id, "proposal-2");
  // Omitted optional fields on an accepted replacement clear their current
  // values, while preserving the last explicitly stated conditions in history.
  await command(["propose", "project-1", "--task", "task-1", "--title", "Protocol", "--body", "Read current facts."]);
  await command(["accept", "project-1", "proposal-4", "--update", "knowledge-1"]);
  assert.equal(store.getProject("project-1").knowledge[0].scope, undefined);
  assert.equal(store.getProject("project-1").knowledge[0].expiresWhen, undefined);
  assert.equal(store.getProject("project-1").knowledge[0].history.at(-1).expiresWhen, entry.expiresWhen);
  const agent = { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1", YUI_ROLE: "leader" };
  await assert.rejects(runProjectCommand(["knowledge", "retire", "project-1", "knowledge-1"], store,
    { environment: agent }), /Operator|operator/i);
  await command(["retire", "project-1", "knowledge-1"]);
  assert.equal(readTaskContext(store, "task-1").records.some(item => item.ref.store === "project-knowledge"), false);
  const retired = store.getProject("project-1").knowledge[0];
  assert.equal(retired.version, 5);
  assert.equal(retired.history.at(-1).status, "active");
  await command(["retire", "project-1", "knowledge-1"]);
  assert.equal(store.getProject("project-1").knowledge[0].version, 5, "repeated retirement is idempotent");
  store.saveProject(addProjectKnowledge(createProject("project-2", "Other", join(home, "other"),
    { stable: "main", development: "main" }, at), "knowledge-1", "Private", "Other project", at));
  assert.throws(() => inspectTaskContext(store, "task-1",
    { store: "project-knowledge", refId: "project-2:knowledge-1" }), /scope/);
});

test("long knowledge is read by exact continuation, not copied into summaries or mutation receipts", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-knowledge-pages-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  store.saveProject(createProject("project-1", "Example", join(home, "project"),
    { stable: "main", development: "main" }, at));
  const command = args => runProjectCommand(["knowledge", ...args], store, { now: () => at, environment: {} });
  const body = "事实😀\n".repeat(5000);
  const receipt = await command(["add", "project-1", "Long", "--body", body]);
  assert.deepEqual(receipt.data, { projectId: "project-1", knowledgeId: "knowledge-1" });
  const list = await command(["list", "project-1"]);
  assert.equal(list.data.items[0].body, undefined);
  let cursor;
  let text = "";
  do {
    const result = await command(["show", "project-1", "knowledge-1", ...(cursor ? ["--cursor", cursor] : [])]);
    text += result.data.contentPage.text;
    cursor = result.data.contentPage.nextCursor;
  } while (cursor);
  assert.equal(JSON.parse(text).knowledge.body, body.trim());
});

for (const minor of [0, 1, 2, 3]) {
test(`1.${minor} migration preserves knowledge, frozen Context and input intent through the complete chain`, async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-knowledge-migration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  const base = createProject("project-1", "Example", join(home, "project"),
    { stable: "main", development: "main" }, at);
  store.saveProject(base);
  store.saveTask(createTask("task-1", "Historical evidence", at));
  const message = createTaskMessage("message-1", "task-1", "Keep input intent", "user", { type: "user" }, at, {
    inputControl: { action: "queue", requestId: "historical-input",
      ...(minor >= 3 ? { expectedSessionId: "session-exact" } : {}) }
  });
  store.saveMessage("task-1", message);
  const stamp = at.toISOString();
  const fingerprint = createHash("sha256").update("project-1|task-1|||\u0000Rule\u0000Body").digest("hex");
  const proposal = {
    schemaVersion: 1, id: "proposal-1", projectId: "project-1", source: { taskId: "task-1" },
    title: "Rule", body: "Body", scope: "Only maintenance", expiresWhen: "After replacement",
    status: "accepted", fingerprint, proposedBy: "leader", proposedAt: stamp,
    decidedBy: "operator", decidedAt: stamp, knowledgeId: "knowledge-1", updatedAt: stamp
  };
  const legacy = {
    schemaVersion: 1, id: "knowledge-1", title: "Rule", body: "Body", status: "active",
    provenance: { taskId: "task-1", proposalId: "proposal-1", fingerprint,
      evidenceDigest: "b".repeat(64), promotedBy: "operator", promotedAt: stamp },
    createdAt: stamp, updatedAt: stamp
  };
  const ref = { layer: "L2", store: "project-knowledge", refId: "project-1:knowledge-1",
    revision: stamp, digest: contextContentDigest(legacy) };
  const frozen = createContextSnapshot({
    id: "snapshot-1", taskId: "task-1", scope: "task", sequence: 1,
    refs: [ref], resources: [{ ref, value: legacy }], acceptRefs: [], frozenAt: at, frozenBy: "leader"
  });
  store.saveContextSnapshot(frozen);
  store.close();
  const database = new Database(join(home, "yui.db"));
  try {
    database.prepare("UPDATE projects SET payload=? WHERE id=?").run(JSON.stringify({
      ...base, knowledge: [legacy, { ...legacy, id: "knowledge-2", provenance: undefined, status: "retired" }],
      knowledgeProposals: [proposal, { ...proposal, id: "proposal-2", status: "pending",
        scope: "Maintenance and review", decidedBy: undefined, decidedAt: undefined, knowledgeId: undefined }]
    }), base.id);
    database.prepare("UPDATE storage_schema SET minor=? WHERE id=1").run(minor);
    const expectedChain = [
      ["1.0", "1.1", "task-main-workspace"],
      ["1.1", "1.2", "task-authorization-source"],
      ["1.2", "1.3", "selected-session-input"],
      ["1.3", "1.4", "project-knowledge-applicability"],
      ["1.4", "1.5", "frozen-skill-packages"]
    ];
    assert.deepEqual(storageMinorUpgradePlan(`1.${minor}`).map(step =>
      [step.fromVersion, step.toVersion, step.name]), expectedChain.slice(minor));
    const snapshotBefore = database.prepare("SELECT payload,digest FROM context_snapshots").get();
    const inputBefore = database.prepare("SELECT payload FROM messages").get();
    assert.throws(() => new SqliteTaskStore(home), /current|upgrade|storage/i);
    applySqliteMinorUpgrades(database, home);
    assert.equal(inspectSqliteSchema(database).currentVersion, "1.5");
    assert.deepEqual(database.prepare("SELECT payload,digest FROM context_snapshots").get(), snapshotBefore);
    assert.deepEqual(database.prepare("SELECT payload FROM messages").get(), inputBefore);
  } finally { database.close(); }
  const current = new SqliteTaskStore(home);
  try {
    const project = current.getProject(base.id);
    assert.equal(project.knowledge[0].scope, proposal.scope);
    assert.equal(project.knowledge[0].expiresWhen, proposal.expiresWhen);
    assert.equal(project.knowledge[0].provenance.evidenceDigest, legacy.provenance.evidenceDigest);
    assert.equal(project.knowledge[0].version, 1);
    assert.deepEqual(project.knowledge[0].history, []);
    assert.equal(project.knowledge[1].scope, undefined, "never guess unrecorded applicability");
    assert.equal(project.knowledge[1].status, "retired");
    assert.equal(project.knowledgeProposals[0].decidedAt, stamp);
    assert.equal(project.knowledge[0].provenance.fingerprint, project.knowledgeProposals[0].fingerprint);
    assert.notEqual(project.knowledgeProposals[0].fingerprint, project.knowledgeProposals[1].fingerprint);
    const original = await runProjectCommand(["knowledge", "show", base.id, "knowledge-1"], current, { environment: {} });
    assert.match(original.output, /Only maintenance/);
    await runProjectCommand(["knowledge", "accept", base.id, "proposal-2", "--update", "knowledge-1"],
      current, { environment: {}, now: () => at });
    assert.equal(current.getProject(base.id).knowledge[0].scope, "Maintenance and review");
    assert.equal(current.getProject(base.id).knowledge[0].history[0].scope, "Only maintenance");
  } finally { current.close(); }
});
}

test("proposal identity trims edges only and includes applicability and replacement intent without delimiter collisions", () => {
  const input = { projectId: "project-1", source: { taskId: "task-1" }, title: "T", body: "B" };
  const fingerprint = extra => knowledgeProposalFingerprint({ ...input, ...extra });
  assert.equal(fingerprint({ scope: " Tasks " }), fingerprint({ scope: "Tasks" }));
  assert.notEqual(fingerprint({ scope: "Tasks" }), fingerprint({ scope: "tasks" }));
  assert.notEqual(fingerprint({ scope: "A  B" }), fingerprint({ scope: "A B" }));
  assert.notEqual(fingerprint({}), fingerprint({ expiresWhen: "Tomorrow" }));
  assert.notEqual(fingerprint({}), fingerprint({ supersedesKnowledgeId: "knowledge-1" }));
  assert.notEqual(fingerprint({ source: { taskId: "task-1|x", decisionId: "d" } }),
    fingerprint({ source: { taskId: "task-1", decisionId: "x|d" } }));
});
