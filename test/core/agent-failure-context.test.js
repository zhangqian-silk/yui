import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createRoleAgentBinding, updateRole } from "../../dist/role/role.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { bindTaskRoleProviderRuntime, createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { beginProviderTurn, createProviderRuntimeBinding } from "../../dist/runtime/providerRuntimeIdentity.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { resolveTaskAgentCapabilities as resolveCapabilities } from "../../dist/executor/taskAgentCapabilities.js";
import { parseTaskAgentCapabilityQuery } from "../../dist/commands/taskAgentCapabilities.js";
import { AgentConfigurationCatalogService } from "../../dist/executor/agentConfigurationCatalog.js";
import { configuredAgentFingerprint, readAgentFailureContext } from "../../dist/runtime/agentFailureContext.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { rebuildHistoricalFixture } from "../helpers/historicalHome.mjs";
import { capabilityReaderIdentity, readTaskAgentCapabilities } from "../../dist/controller/agentCapabilities.js";
import { recordTaskAgentError } from "../../dist/controller/taskAgentError.js";
import { standardAgentError } from "../../dist/runtime/agentError.js";

const at = new Date("2026-09-16T00:00:00Z");
const resolveTaskAgentCapabilities = (args, store, environment) =>
  resolveCapabilities(parseTaskAgentCapabilityQuery(args), store, environment);
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-failure-context-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const agent = createConfiguredAgent("claude", "claude", "false", [],
    [{ target: "ANTHROPIC_API_KEY", source: "process", sourceName: "FIXTURE_SECRET", required: true }], at);
  store.saveConfiguredAgent(agent);
  store.saveTask(activateTask(createTask("task-1", "Recovery facts", at, { cwd: workspace }), at));
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: "task-1" }, root: workspace, entries: [],
  }, at));
  const role = createRole("task-1", "leader", [createRoleAgentBinding(agent, {
    adapterId: "claude", model: "exact-request", effort: "low",
    settingsFile: join(home, "original-settings.json"), settingsSources: ["user", "local"],
    permission: { strategy: "bypass" },
  })], agent.id, workspace, at);
  store.saveRole("task-1", role);
  return { home, store, agent, role, workspace, scheduler: new FileSchedulerStoreAdapter(store) };
}

test("failed capabilities use the captured Role context, preserve account-binding identity and explicitly refresh metadata", async t => {
  const { home, store, role, agent, workspace, scheduler } = fixture(t);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  const errorId = scheduler.recordAgentError({ taskId: "task-1", roleName: "leader",
    attemptId: "notification:failed", effective, source: "provider", phase: "session-start",
    message: "Invalid model", raw: "Invalid model", inputDisposition: "not-accepted" }, at);
  const error = store.listEventsByType("task-1", ["runtime.agent-error"])[0];
  assert.equal(error.id, errorId);
  assert.equal(error.payload.runId, undefined);
  const captured = readAgentFailureContext(error.payload.capabilityContext);
  assert.equal(captured.agentId, agent.id);
  assert.equal(captured.cwd, workspace);
  assert.equal(captured.config.settingsFile, join(home, "original-settings.json"));
  assert.equal(Object.hasOwn(captured, "effective"), false,
    "A metadata context must not depend on execution authority, Review, workspace entries or Session protocol.");
  const changed = updateRole(role, { agentBindings: {
    claude: createRoleAgentBinding(agent, { ...role.agentBindings.claude.config,
      model: "later-model", settingsFile: join(home, "later-settings.json") }),
  } }, at);
  store.saveRole("task-1", changed);
  const historical = resolveTaskAgentCapabilities(["task-1", "leader", "--error", errorId], store);
  const desired = resolveTaskAgentCapabilities(["task-1", "leader"], store);
  assert.equal(historical.context.selection, "failed-launch");
  assert.equal(historical.input.cwd, workspace);
  assert.equal(historical.input.config.model, "exact-request");
  assert.equal(historical.input.config.settingsFile, join(home, "original-settings.json"));
  assert.deepEqual(historical.input.config.settingsSources, ["user", "local"]);
  assert.equal(desired.input.config.settingsFile, join(home, "later-settings.json"));
  let calls = 0, unavailable = false;
  const catalogs = new AgentConfigurationCatalogService(home, {
    environment: { FIXTURE_SECRET: "must-not-be-persisted", HOME: home },
    discover: async input => {
      calls++;
      assert.equal(input.environment.FIXTURE_SECRET, "must-not-be-persisted");
      assert.equal(input.config.settingsFile, historical.input.config.settingsFile);
      assert.equal(input.cwd, workspace);
      if (unavailable) throw new Error("Metadata unavailable api_key=must-not-be-persisted");
      return { schemaVersion: 1, agentId: "claude", adapterId: "claude",
        models: [{ value: "native-alias", resolvedModel: `exact-model-${calls}`, label: "Native model",
          isDefault: true, efforts: [] }], fields: [{ key: "model", choices: [], allowCustom: true }], warnings: [] };
    },
  });
  assert.equal((await catalogs.resolve(historical.input)).catalog.models[0].resolvedModel, "exact-model-1");
  const retained = await catalogs.resolve(historical.input);
  assert.equal(retained.source, "cache");
  assert.equal(retained.failure, undefined, "An ordinary memory-cache hit must not invent a failed request.");
  assert.equal(calls, 1);
  const refreshed = resolveTaskAgentCapabilities(["task-1", "leader", "--error", errorId, "--refresh"], store);
  const controllerResult = await readTaskAgentCapabilities(store, catalogs, {
    taskId: "task-1", roleName: "leader", errorId, refresh: true,
    reader: capabilityReaderIdentity({ FIXTURE_SECRET: "wrong-caller-environment" }),
  });
  assert.equal(controllerResult.catalog.models[0].resolvedModel, "exact-model-2");
  assert.equal(controllerResult.context.environmentSource, "controller");
  unavailable = true;
  const cached = await catalogs.resolve(refreshed.input);
  assert.equal(cached.source, "cache", "A failed refresh must never claim cached values are live.");
  assert.match(cached.failure.message, /Metadata unavailable/);
  assert.doesNotMatch(cached.failure.message, /must-not-be-persisted/);
  assert.doesNotMatch(JSON.stringify(error), /must-not-be-persisted/);
  store.saveConfiguredAgent({ ...agent, command: "different-agent" });
  assert.throws(() => resolveTaskAgentCapabilities(["task-1", "leader", "--error", errorId], store), /changed since/);
  assert.equal(calls, 3, "A changed executable must be diagnosed before native discovery.");
  store.saveConfiguredAgent(createConfiguredAgent("claude", "codex", "false", [], [], at));
  assert.throws(() => resolveTaskAgentCapabilities(["task-1", "leader"], store), /binding.*implementation/,
    "A desired-Role read must not silently probe another Provider implementation.");
});

test("native rejection reuses one canonical error and capability queries enforce Task/Role ownership", async t => {
  const { store, agent, role, scheduler } = fixture(t);
  runTaskCommand(["message", "queue", "task-1", "Keep exact model", "--request-id", "original"], store,
    { environment: {}, now: () => at });
  const claim = scheduler.claimLeaderNotification("task-1", at);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  let sessions = recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "leader" }, agent.id, at), {
    agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: "leader-current",
    status: "active", policy: "fixed", effective,
  }, at);
  sessions = bindTaskRoleProviderRuntime(sessions, beginProviderTurn(createProviderRuntimeBinding({
    providerNamespace: "anthropic/claude-code", accountScope: agent.id,
    conversationId: "leader-current", startedAt: at.toISOString(),
  }), { attemptId: claim.attemptId, authorityEpoch: 1, submittedAt: at.toISOString() }), at);
  store.saveTaskRoleSessionSet(sessions);
  const input = { taskId: "task-1", roleName: "leader", attemptId: claim.attemptId,
    status: "rejected", reason: "Unknown model", raw: '{"error":"Unknown model"}', now: at };
  scheduler.resolveAgentHostProviderTurnSubmission(input);
  const eventId = store.listEventsByType("task-1", ["runtime.agent-error"])[0].id;
  scheduler.resolveAgentHostProviderTurnSubmission(input);
  scheduler.settleLeaderNotification("task-1", claim.attemptId, "rejected", at, input.reason,
    { effective, raw: input.raw, phase: "turn-submit" });
  assert.equal(store.listEventsByType("task-1", ["runtime.agent-error"]).length, 1);
  assert.equal(store.getWorkMailbox({ kind: "operator" }).pending.requestCount, 1);
  const shown = runTaskCommand(["wake", "show", "task-1", claim.wakeId], store, { environment: {} });
  assert.match(shown.output, new RegExp(`task role capabilities task-1 leader --error ${eventId}`));
  assert.equal(shown.data.deliveryEvents.at(-1).payload.errorEventId, eventId);
  const eventShown = runTaskCommand(["event", "show", "task-1", eventId], store, { environment: {} });
  assert.match(eventShown.data.diagnostics.capabilitiesCommand, /--error/);
  assert.match(eventShown.output, /task role capabilities task-1 leader/);
  const worker = createRole("task-1", "worker", [createRoleAgentBinding(agent)], agent.id, role.workspace, at);
  store.saveRole("task-1", worker);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "worker" }, agent.id, at), {
    agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: "worker-current",
    status: "active", policy: "fixed", effective: resolveEffectiveLaunch({ role: worker, purpose: "execution" }),
  }, at));
  const env = { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1", YUI_ROLE: "worker",
    YUI_NATIVE_SESSION_ID: "worker-current", YUI_WORKSPACE: worker.workspace };
  assert.equal(resolveTaskAgentCapabilities(["task-1", "worker"], store, env).context.roleName, "worker");
  assert.throws(() => resolveTaskAgentCapabilities(["task-1", "leader", "--error", eventId], store, env), /outside/);
  assert.throws(() => resolveTaskAgentCapabilities(["task-2", "worker"], store, env), /outside/);
  assert.throws(() => resolveTaskAgentCapabilities(["task-1", "worker", "--error", eventId], store), /not owned/);
  const forbiddenProbe = { resolve: () => assert.fail("Unauthorized metadata must not start a native process.") };
  await assert.rejects(readTaskAgentCapabilities(store, forbiddenProbe, {
    taskId: "task-1", roleName: "leader", errorId: eventId, reader: capabilityReaderIdentity(env)
  }), /outside/);
  await assert.rejects(readTaskAgentCapabilities(store, forbiddenProbe, {
    taskId: "task-1", roleName: "worker", reader: { ANTHROPIC_API_KEY: "do-not-forward" }
  }), /unsupported fields/);
  const normalized = standardAgentError({
    source: "provider", phase: "turn-execute", message: "Same native label", raw: "Same native body",
    inputDisposition: "accepted",
  });
  const ids = new Set();
  for (const [nativeSessionId, nativeTurnId] of [["session-a", "turn-1"], ["session-b", "turn-1"], ["session-b", "turn-2"]]) {
    const failure = { taskId: "task-1", roleName: "leader", sourceEventId: "provider-local-event-1",
      agentId: agent.id, adapterId: agent.adapterId, driverId: "anthropic/claude-code", error: normalized,
      effective, evidence: { nativeSessionId, nativeTurnId } };
    const recorded = recordTaskAgentError(store, failure, at);
    assert.equal(recorded.created, true, "A reused Provider event label cannot collapse another Session/Turn's error.");
    ids.add(recorded.event.id);
    assert.equal(recordTaskAgentError(store, failure, at).created, false);
  }
  assert.equal(ids.size, 3);
});

test("catalog memory retention is bounded without duplicating active probes or disabling explicit refresh", async t => {
  const { home, agent } = fixture(t);
  const calls = new Map();
  let release;
  let gate = new Promise(resolve => { release = resolve; });
  const service = new AgentConfigurationCatalogService(home, {
    memoryCacheLimit: 2,
    discover: async input => {
      calls.set(input.cwd, (calls.get(input.cwd) ?? 0) + 1);
      if (input.cwd.endsWith("/slow") && gate) await gate;
      return { schemaVersion: 1, agentId: agent.id, adapterId: agent.adapterId,
        models: [{ value: "model", label: "Model", isDefault: true, efforts: [] }],
        fields: [{ key: "model", choices: [], allowCustom: true }], warnings: [] };
    },
  });
  const request = (name, refresh = false) => ({ agent, cwd: join(home, name), refresh });
  await service.resolve(request("a"));
  await service.resolve(request("b"));
  await service.resolve(request("a"));
  await service.resolve(request("c"));
  await service.resolve(request("b"));
  assert.equal(calls.get(join(home, "a")), 1, "A recent entry is retained.");
  assert.equal(calls.get(join(home, "b")), 2, "The least-recently-used completed result is evicted.");
  const active = service.resolve(request("slow"));
  await service.resolve(request("d"));
  await service.resolve(request("e"));
  assert.equal(service.resolve(request("slow", true)), active,
    "Cache pressure and concurrent refresh must not duplicate an in-flight native probe.");
  release();
  await active;
  gate = null;
  await service.resolve(request("slow", true));
  assert.equal(calls.get(join(home, "slow")), 2, "After settlement an explicit refresh starts a fresh probe.");
});

test("35 to 36 preserves historical errors without inventing launch configuration or changing the old ledger", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-error-context-migration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  store.saveTask(createTask("task-1", "Original error", at));
  const old = createTaskEvent("event-1", "task-1", "runtime.agent-error",
    { roleName: "leader", message: "Original native cause", raw: "original bytes" }, at);
  store.saveEvent("task-1", old);
  store.close();
  rebuildHistoricalFixture(home, 35);
  const db = new Database(join(home, "yui.db"));
  try {
    const original = db.prepare("SELECT payload FROM events WHERE event_id='event-1'").get().payload;
    const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    migrateSqliteSchema(db, { mode: "apply" });
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version=36").get());
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version<=35 ORDER BY version").all(), ledger);
    assert.equal(db.prepare("SELECT payload FROM storage_migration_archive WHERE migration_version=36").get().payload, original);
    const updated = JSON.parse(db.prepare("SELECT payload FROM events WHERE event_id='event-1'").get().payload);
    const { capabilityContext, ...payload } = updated.payload;
    assert.deepEqual(payload, old.payload);
    assert.equal(readAgentFailureContext(capabilityContext).status, "unavailable");
  } finally { db.close(); }
  const current = new SqliteTaskStore(home);
  try {
    assert.throws(() => resolveTaskAgentCapabilities(["task-1", "leader", "--error", "event-1"], current),
      /No historical configuration was inferred/);
  } finally { current.close(); }
});

test("36 to 37 narrows metadata history without losing the original snapshot or revalidating execution protocols", t => {
  const { home, store, role, agent, workspace } = fixture(t);
  const old = JSON.stringify({ status: "recorded", effective: resolveEffectiveLaunch({ role, purpose: "execution" }),
    agentFingerprint: configuredAgentFingerprint(agent) });
  store.saveEvent("task-1", createTaskEvent("event-1", "task-1", "runtime.agent-error", {
    roleName: "leader", message: "Original cause", capabilityContext: old,
    runId: "", nativeSessionId: "", nativeTurnId: ""
  }, at));
  store.close();
  rebuildHistoricalFixture(home, 36);
  const db = new Database(join(home, "yui.db"));
  try {
    const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    migrateSqliteSchema(db, { mode: "apply" });
    const value = JSON.parse(db.prepare("SELECT payload FROM events WHERE event_id='event-1'").get().payload);
    const narrowed = readAgentFailureContext(value.payload.capabilityContext);
    assert.deepEqual(narrowed, {
      status: "recorded", agentId: agent.id, cwd: workspace,
      config: { adapterId: "claude", model: "exact-request", effort: "low",
        settingsFile: join(home, "original-settings.json"), settingsSources: ["user", "local"] },
      agentFingerprint: configuredAgentFingerprint(agent),
    });
    assert.equal(value.payload.message, "Original cause");
    assert.equal(db.prepare("SELECT payload FROM storage_migration_archive WHERE migration_version=37 AND family='agent-error-context'").get().payload, old);
    assert.deepEqual(JSON.parse(db.prepare("SELECT payload FROM storage_migration_archive WHERE migration_version=37 AND family='agent-error-empty-identities'").get().payload),
      { runId: "", nativeSessionId: "", nativeTurnId: "" });
    for (const field of ["runId", "nativeSessionId", "nativeTurnId"]) assert.equal(Object.hasOwn(value.payload, field), false);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version<=36 ORDER BY version").all(), ledger);
    assert.throws(() => readAgentFailureContext(old), /invalid|unsupported/i,
      "Only the centralized migration reads the old wide snapshot.");
  } finally { db.close(); }
});
