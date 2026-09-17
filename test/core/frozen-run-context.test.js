import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRun, failRun, runInputEnvelope, validateRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput, serializeRunInputEnvelope } from "../../dist/context/runInputContract.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { contextContentDigest, contextSnapshotRef, createContextSnapshot } from "../../dist/context/contextSnapshot.js";
import { buildRunContextPack, buildRunContextDelta, expandRunContextRef } from "../../dist/context/runContextPack.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";
import { createFixtureRun } from "../helpers/runFixture.mjs";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { processActiveRoleRunDeliveries } from "../../dist/scheduler/activeRoleRunDelivery.js";
import { findCommandNode } from "../../dist/cli/commandCatalog.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";

test("Run Context uses only its exact frozen evidence and explicit store/refId", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-frozen-context-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-09-17T00:00:00Z");
  const task = activateTask(createTask("task-1", "Frozen intent", now), now);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "worker", [binding], binding.agentId, home, now);
  store.saveRole(task.id, role);
  const resources = [
    ["task", task.id, task],
    ["task-brief", task.id, { objective: "The original objective" }],
    ["source-run", "run-source", { result: { output: "Exact selected Producer result" } }]
  ].map(([refStore, refId, value]) => ({
    ref: { layer: "L3", store: refStore, refId, revision: "1", digest: contextContentDigest(value) },
    value
  }));
  const snapshot = createContextSnapshot({
    id: "snapshot-1", taskId: task.id, scope: "task", sequence: 1,
    refs: resources.map(({ ref }) => ref), resources, acceptRefs: [],
    frozenAt: now, frozenBy: "controller"
  });
  store.saveContextSnapshot(snapshot);
  const input = createRunInput({
    source: { type: "yui", channel: "workitem-dispatch" },
    contextSnapshotRef: contextSnapshotRef(snapshot), deltaRefIds: []
  });
  const context = {
    workItemId: "work-item-1", sourceExecutionGroupId: "group-1",
    effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  };
  const run = createRun("run-1", task.id, role.name, "new", input, now, context);
  store.saveRun(run);
  assert.equal(runTaskCommand(["run", "context", "expand", `${task.id}/${run.id}`, task.id,
    "--store", "task", "--mode", "full"], store, { environment: sanitizedTestEnv() }).data.context.value.title,
  task.title);
  // A synthesis snapshot remains readable even when live assignment/source
  // collection cannot be repeated. Only the live activity projection is fresh.
  for (const method of ["getTask", "getTaskBrief", "getRole", "getWorkItem", "getProject", "listMessages"]) {
    store[method] = () => assert.fail(`Frozen Context must not recollect ${method}`);
  }
  const pack = buildRunContextPack(store, task.id, run.id);
  assert.deepEqual(pack.snapshot, input.contextSnapshotRef);
  assert.deepEqual(pack.authority.writableProjectIds, []);
  assert.equal(expandRunContextRef(store, task.id, run.id, task.id, "task").value.title, "Frozen intent");
  assert.equal(expandRunContextRef(store, task.id, run.id, task.id, "task-brief").value.objective, "The original objective");
  assert.equal(expandRunContextRef(store, task.id, run.id, "run-source", "source-run").value.result.output,
    "Exact selected Producer result");
  assert.throws(() => expandRunContextRef(store, task.id, run.id, "run-source"), /store.*(required|invalid)/i);
  assert.throws(() => expandRunContextRef(store, task.id, run.id, task.id, "foreign"), /authorized/i);
  assert.deepEqual(buildRunContextDelta(store, task.id, run.id, pack.snapshot.digest).refs, []);
  assert.throws(() => buildRunContextDelta(store, task.id, run.id, "foreign"), /lineage/i);

  const originalGetSnapshot = store.getContextSnapshot.bind(store);
  store.getContextSnapshot = () => ({ ...snapshot, sequence: 2 });
  assert.throws(() => buildRunContextPack(store, task.id, run.id), /digest|drift/i);
  store.getContextSnapshot = () => ({ ...snapshot, id: "snapshot-other" });
  assert.throws(() => buildRunContextPack(store, task.id, run.id), /identity.*drift/i);
  store.getContextSnapshot = () => ({ ...snapshot,
    resources: snapshot.resources.map(entry => ({ ...entry, value: { changed: true } })) });
  assert.throws(() => expandRunContextRef(store, task.id, run.id, task.id, "task"), /resource.*ref/i);
  store.getContextSnapshot = originalGetSnapshot;

  const { contextSnapshotRef: _snapshot, ...missing } = input;
  assert.throws(() => createRun("run-2", task.id, role.name, "new", createRunInput(missing), now, context),
    /Context Snapshot.*required/i);
  const historical = { ...run, id: "run-2", inputs: [{ ...run.inputs[0], input: createRunInput(missing) }] };
  assert.equal(validateRun(historical), historical, "Historical records remain audit-readable without invented context.");
  store.saveRun(historical);
  assert.throws(() => buildRunContextPack(store, task.id, historical.id), /Context Snapshot.*required/i);
  assert.throws(() => runInputEnvelope(historical), /Context Snapshot.*required/i);
  assert.throws(() => serializeRunInputEnvelope({
    protocol: "yui-run/v1", runId: historical.id, roleName: role.name, purpose: "execution",
    subject: { taskId: task.id }, source: input.source, deltaRefIds: []
  }), /Context Snapshot.*required/i);
});

test("missing Snapshot stops Provider preparation and cannot be repaired by retry", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-missing-run-snapshot-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-09-17T00:00:00Z");
  const task = activateTask(createTask("task-1", "Keep original execution evidence", now), now);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "leader", [binding], binding.agentId, home, now);
  store.saveRole(task.id, role);
  const run = createFixtureRun(store, "run-1", task.id, role.name, "new", createRunInput({
    source: { type: "yui", channel: "task-dispatch" }, directive: "Original intent", deltaRefIds: []
  }), now, { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) });
  store.saveActiveRun(run);
  const adapter = new FileSchedulerStoreAdapter(store);
  store.getContextSnapshot = () => null;
  const outcomes = await processActiveRoleRunDeliveries(adapter, {
    prepareRoleSession: async () => assert.fail("Missing evidence must fail before Provider preparation")
  }, now);
  assert.equal(outcomes[0].status, "failed");
  assert.match(outcomes[0].error, /Context Snapshot is missing/i);
  assert.deepEqual(store.getRun(task.id, run.id).inputs, run.inputs);
  const options = { now: () => now, environment: sanitizedTestEnv() };
  const revision = store.getRevision();
  assert.throws(() => runTaskCommand(["run", "retry", `${task.id}/${run.id}`], store, options),
    /Context Snapshot is missing/i);
  assert.equal(store.getRevision(), revision, "Retry cannot synthesize absent original evidence.");
  runTaskCommand(["run", "retire", `${task.id}/${run.id}`, "--reason", "Evidence unavailable",
    "--expected-progress-at", now.toISOString()], store, options);
  assert.equal(store.listEvents(task.id).find(event => event.type === "run.retired").payload.expectedProgressAt,
    now.toISOString(), "The current retirement argument preserves the exact recorded fence.");
});

test("CLI rejects inferred Context stores and the retired progress flag before record lookup", () => {
  const store = new Proxy({}, { get: () => () => assert.fail("Invalid CLI contract must fail before reading records") });
  const options = { environment: sanitizedTestEnv() };
  assert.throws(() => runTaskCommand(["run", "context", "expand", "task-1/run-1", "message-1"], store, options),
    /--store.*required/i);
  assert.throws(() => runTaskCommand(["run", "retire", "task-1/run-1", "--reason", "obsolete",
    "--progress-at", "2026-09-17T00:00:00Z"], store, options), /Unsupported option.*--progress-at/i);
  const retire = findCommandNode(["task", "run", "retire"]);
  assert.ok(retire.options.includes("--expected-progress-at"));
  assert.equal(retire.options.includes("--progress-at"), false);
});

test("planning retry preserves absent delivery workspace after Task activation", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-planning-retry-snapshot-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-09-17T00:00:00Z");
  const task = activateTask(createTask("task-1", "Preserve planning authority", now), now);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "leader", [binding], binding.agentId, home, now);
  store.saveRole(task.id, role);
  const previous = createFixtureRun(store, store.nextRunId(task.id), task.id, role.name, "new", createRunInput({
    source: { type: "yui", channel: "task-dispatch" }, directive: "Plan only", deltaRefIds: []
  }), now, { purpose: "planning", effective: resolveEffectiveLaunch({ role, purpose: "planning" }) });
  store.saveRun(failRun(previous, "startup-failed", "Before delivery", now));
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id }, root: join(home, "new-delivery"), entries: []
  }, now));
  runTaskCommand(["run", "retry", `${task.id}/${previous.id}`], store,
    { now: () => now, environment: sanitizedTestEnv() });
  const retry = store.getActiveRun(task.id, role.name);
  assert.equal(retry.workspace, undefined);
  assert.equal(retry.effective.executionAuthority, "planning");
  assert.deepEqual(buildRunContextPack(store, task.id, retry.id).authority.writableProjectIds, []);
});
