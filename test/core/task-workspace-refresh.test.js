import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createProject } from "../../dist/repository/project.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { taskWorkspaceReconfiguration, adoptTaskWorkspaceConfiguration } from "../../dist/executor/taskWorkspaceRefresh.js";
import { assertTaskProjectWriteAuthority } from "../../dist/task/taskAuthority.js";
import { acceptProviderTurn, beginProviderTurn, createProviderRuntimeBinding, settleProviderTurn } from "../../dist/runtime/providerRuntimeIdentity.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { processLeaderWakeups } from "../../dist/scheduler/leaderWakeupProcessor.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createProjectResources } from "../../dist/resources/projectResourceService.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";

test("root-contained configuration adoption preserves active native execution and exact project authority", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-scope-refresh-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-11-05T00:00:00Z");
  const owner = { scope: "task", taskId: "task-1", roleName: "leader" };
  const agent = createConfiguredAgent("codex", "codex", "unused-fixture", [], [], now);
  store.saveConfiguredAgent(agent);
  store.saveTask(activateTask(createTask(owner.taskId, "Refresh", now, { cwd: home }), now));
  const empty = createManagedWorkspace({ owner: { type: "task", taskId: owner.taskId },
    root: home, entries: [] }, now);
  store.saveManagedWorkspace(empty);
  const leader = createRole(owner.taskId, "leader", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.saveRole(owner.taskId, leader);
  const effective = resolveEffectiveLaunch({ role: leader, purpose: "execution", workspace: empty });
  const original = recordRoleAgentSession(createRoleSessionSet(owner, agent.id, now), {
    agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: "preserved-thread",
    policy: "fixed", status: "active", effective
  }, now);
  const activeBinding = acceptProviderTurn(beginProviderTurn(createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: "preserved-thread", startedAt: now.toISOString()
  }), { attemptId: "active-input", authorityEpoch: 1, submittedAt: now.toISOString() }),
  { attemptId: "active-input", nativeTurnId: "same-turn", acceptedAt: now.toISOString() });
  store.saveTaskRoleSessionSet(original);
  const resources = createProjectResources(store, () => now);
  const adoptedEnvironment = resources.prepare(owner.taskId, { kind: "scratch" });
  resources.adopt(owner.taskId, adoptedEnvironment.id);
  const capturedEnvironment = resources.resolveExecutionEnvironment(owner.taskId, adoptedEnvironment.id);
  const stalePreparation = resources.prepare(owner.taskId, { kind: "scratch" });
  const entry = { projectId: "project-1", directory: "app", path: join(home, "app"),
    access: "write", branch: "task-main", baseRef: "master", baseCommit: "a".repeat(40) };
  store.saveProject(createProject(entry.projectId, "app", entry.path,
    { stable: "master", development: "master" }, now));
  const expanded = { ...empty, entries: [entry] };
  store.saveManagedWorkspace(expanded);
  store.saveTask({ ...store.getTask(owner.taskId), projectBindings: [
    { projectId: entry.projectId, directory: entry.directory, baseRef: entry.baseRef,
      baseCommit: entry.baseCommit, currentCommit: entry.baseCommit }
  ] });
  assert.deepEqual(resources.resolveExecutionEnvironment(owner.taskId, adoptedEnvironment.id), capturedEnvironment,
    "An adopted directory and its grants are independent of later Git binding intent.");
  assert.throws(() => resources.adopt(owner.taskId, stalePreparation.id), /intent changed/,
    "Unadopted preparation still fences concurrent intent changes.");
  const target = taskWorkspaceReconfiguration(store, owner, effective);
  assert.deepEqual(target.effective.writeProjectIds, ["project-1"]);
  assert.deepEqual(store.getRoleSession(owner.taskId, "leader").effective.writeProjectIds, []);
  assert.equal(target.unsupported, undefined);
  const separateEnvironment = { ...effective, executionEnvironment: capturedEnvironment };
  assert.match(taskWorkspaceReconfiguration(store, owner, separateEnvironment).unsupported,
    /outside the captured native root/,
    "A separately adopted scratch cwd cannot silently gain the Task-main boundary.");
  store.saveManagedWorkspace({ ...expanded, entries: [{ ...entry, path: join(home, "..", "outside") }] });
  assert.throws(() => adoptTaskWorkspaceConfiguration(store, owner.taskId, now), /outside the captured native root/);
  assert.deepEqual(store.getTaskRoleSessionSet(owner.taskId, "leader"), original,
    "An incompatible boundary retains the exact Session without lifecycle fallback.");
  store.saveManagedWorkspace(expanded);
  const readOnly = { ...effective, profileAccess: "read", writeProjectIds: [] };
  assert.deepEqual(taskWorkspaceReconfiguration(store, owner, readOnly).effective.writeProjectIds, []);
  const other = { ...effective, workspace: { root: join(home, "review"), entries: [] } };
  assert.equal(taskWorkspaceReconfiguration(store, owner, other).effective, other);
  const changed = { ...target.effective, workspace: { ...target.effective.workspace,
    entries: [{ ...entry, path: join(home, "old-app") }] } };
  assert.match(taskWorkspaceReconfiguration(store, owner, changed).unsupported, /path, branch or access/);
  const alias = { ...target.effective, workspace: { ...target.effective.workspace,
    entries: [{ ...entry, baseRef: "alias", baseCommit: "b".repeat(40) }] } };
  assert.equal(taskWorkspaceReconfiguration(store, owner, alias).effective, alias,
    "Git-only changes do not restart a Host.");

  runTaskCommand(["message", "queue", owner.taskId, "One durable input", "--request-id", "input-one"],
    store, { environment: {}, now: () => now });
  let submissions = 0;
  const delivery = { prepareRoleSession: async request => {
    assert.equal(request.nativeSessionId, "preserved-thread");
    assert.deepEqual(request.effective.writeProjectIds, ["project-1"]);
    return {};
  }, waitUntilReady: async value => value, sendOnce: async () => { submissions++; return { status: "sent" }; } };
  const reconcile = () => processLeaderWakeups(new FileSchedulerStoreAdapter(store), delivery,
    new Date(now.getTime() + 120_000));
  await reconcile();
  assert.equal(submissions, 0);
  assert.equal(store.listEvents(owner.taskId).filter(e => e.type === "notification.delivery").at(-1).payload.outcome,
    "deferred", "Scope backpressure cannot reject or duplicate the original input.");
  store.saveTaskRoleSessionSet({ ...original, providerBinding: activeBinding });
  const env = { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: owner.taskId, YUI_ROLE: "leader",
    CODEX_THREAD_ID: "preserved-thread" };
  assert.throws(() => assertTaskProjectWriteAuthority(store, env, owner.taskId, entry.projectId), /captured/);
  const lane = { kind: "role-runtime", taskId: owner.taskId, roleName: "leader" };
  enqueueWork(store, lane, "runtime-host-upgrade-required", now);
  assert.throws(() => adoptTaskWorkspaceConfiguration(store, owner.taskId, now), /existing runtime lifecycle/);
  assert.deepEqual(store.getRoleSession(owner.taskId, "leader").effective, effective);
  store.removeWorkMailbox(lane); // Fixture releases its reservation, not a product cleanup path.
  adoptTaskWorkspaceConfiguration(store, owner.taskId, now);
  assert.equal(store.getRoleSession(owner.taskId, "leader").nativeSessionId, "preserved-thread");
  assert.deepEqual(store.getTaskRoleSessionSet(owner.taskId, "leader").providerBinding, activeBinding,
    "Adoption does not end, interrupt, resume or replace the active native Turn.");
  assert.equal(assertTaskProjectWriteAuthority(store, env, owner.taskId, entry.projectId), "leader");
  assert.equal(store.getWorkMailbox({ kind: "role-runtime", taskId: owner.taskId, roleName: "leader" }), null);
  // The scheduler may deliver later input only after its ordinary native gate;
  // configuration adoption itself never claims or submits that input.
  store.saveTaskRoleSessionSet({ ...store.getTaskRoleSessionSet(owner.taskId, "leader"),
    providerBinding: settleProviderTurn(activeBinding, { attemptId: "active-input",
      status: "completed", settledAt: now.toISOString() }) });
  await reconcile();
  await reconcile();
  assert.equal(submissions, 1);
  assert.equal(store.listMessages(owner.taskId).length, 1);
});
