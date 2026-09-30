import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { activateTask, completeTask, createTask } from "../../dist/task/task.js";
import { createGlobalRole, createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession, bindTaskRoleProviderRuntime } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { checkGrant, recordGrantUse } from "../../dist/grant/capabilityGrant.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { archiveLeaderTask } from "../../dist/task/leaderArchive.js";
import { createProviderRuntimeBinding, transferProviderAuthority } from "../../dist/runtime/providerRuntimeIdentity.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createProject } from "../../dist/repository/project.js";
import { createReleaseWorkflow } from "../../dist/release/releaseWorkflow.js";
import { runReleaseWorkflow } from "../../dist/release/releaseWorkflowEngine.js";
import { createBuiltinCapabilities } from "../../dist/kernel/builtinCapabilities.js";
import { InstanceHost } from "../../dist/kernel/instanceHost.js";
import { createDurableJobControl } from "../../dist/controller/jobControl.js";

const now = new Date("2026-09-30T00:00:00Z");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-leader-auth-"));
  const home = join(root, "home");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  store.saveTask(activateTask(createTask("task-1", "Bounded authority", now), now));
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole("task-1", "leader", [binding], "codex", home, now);
  store.saveRole("task-1", role);
  const set = recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "leader" }, "codex", now), {
    agentId: "codex", adapterId: "codex", nativeSessionId: "leader-current", status: "active",
    policy: "fixed", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  }, now);
  store.saveTaskRoleSessionSet(set);
  const environment = { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1", YUI_ROLE: "leader",
    YUI_NATIVE_SESSION_ID: "leader-current", YUI_WORKSPACE: home };
  const message = (body, kind = "user") => {
    const value = createTaskMessage(store.nextMessageId("task-1"), "task-1", body, kind,
      kind === "role-result" ? { type: "role", roleName: "leader" } : { type: kind }, now);
    store.saveMessage("task-1", value);
    return value;
  };
  return { store, root, home, set, role, environment, message,
    command: (args, env = environment) => runTaskCommand(args, store, { environment: env, now: () => now }) };
}

test("Leader grants require original input, exact bounded resources and current delivery identity; retries do not replenish uses", async t => {
  const f = fixture(t);
  const path = join(f.root, "authorized"); mkdirSync(path);
  const source = f.message(`Read ${path} for this Task.`);
  const host = new InstanceHost();
  t.after(() => host.close());
  const capabilities = createBuiltinCapabilities(host, f.store, createDurableJobControl(f.store));
  const caller = capabilities.authenticate({ scope: "task", taskId: "task-1", role: "leader",
    nativeSessionId: "leader-current" }, "task-1");
  const register = input => capabilities.registry.call(caller, {
    name: "resource.local.register", requestId: "register-one", input
  });
  assert.notEqual((await register({ displayName: "No source", path })).kind, "value");
  const registered = await register({ displayName: "Authorized", path,
    sourceMessage: source.id, purpose: source.body });
  assert.equal(registered.kind, "value", JSON.stringify(registered));
  const resource = registered.value;
  const args = ["grant", "issue", "task-1", "--action", "resource.local.read",
    "--scope-home", path, "--param", `resourceId=${resource.id}`, "--source-message", source.id,
    "--purpose", source.body, "--request-id", "read-once", "--max-uses", "1",
    "--expires-at", "2026-10-01T00:00:00Z"];
  const replace = (name, value) => args.map((arg, index) => args[index - 1] === name ? value : arg);
  assert.throws(() => f.command(args, {}), /delivery Leader/);
  assert.throws(() => f.command(args, { ...f.environment, YUI_NATIVE_SESSION_ID: "old" }), /delivery Leader/);
  assert.throws(() => f.command(args, { ...f.environment, YUI_ROLE: "worker" }), /delivery Leader/);
  assert.throws(() => f.command(replace("--purpose", "Publish everything")), /verbatim/);
  const report = f.message(source.body, "role-result");
  assert.throws(() => f.command(replace("--source-message", report.id)), /original user/);
  assert.throws(() => f.command(replace("--action", "controller-replace")), /action authority/);
  assert.throws(() => f.command(replace("--scope-home", f.home)), /overlaps/);
  const grant = f.command(args).data;
  assert.equal(grant.authorizationSource.messageId, source.id);
  assert.equal(grant.scope.taskId, "task-1");
  assert.equal(checkGrant(grant, { action: "resource.local.write", params: { resourceId: resource.id } }, now).allowed, false);
  f.store.saveCapabilityGrant("task-1", recordGrantUse(grant, now));
  assert.equal(f.command(args).data.usesUsed, 1);
  assert.equal(f.store.listCapabilityGrants("task-1").length, 1);
  assert.throws(() => f.command(replace("--max-uses", "2")), /different authorization/);
  f.command(["grant", "revoke", "task-1", grant.id]);
  assert.equal(checkGrant(f.store.getCapabilityGrant("task-1", grant.id),
    { action: "resource.local.read", params: { resourceId: resource.id } }, now).reason, "grant-revoked");
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const operator = createGlobalRole("operator", [binding], "codex", f.home, now);
  f.store.saveGlobalRole(operator);
  f.store.saveGlobalRoleSessionSet(recordRoleAgentSession(
    createRoleSessionSet({ scope: "global", roleName: "operator" }, "codex", now), {
      agentId: "codex", adapterId: "codex", nativeSessionId: "operator-current", policy: "fixed", status: "active",
      effective: resolveEffectiveLaunch({ role: operator, purpose: "execution" })
    }, now));
  const opEnvironment = { YUI_SESSION_SCOPE: "global", YUI_ROLE: "operator", YUI_NATIVE_SESSION_ID: "operator-current" };
  const operatorGrant = f.command(["grant", "issue", "task-1", "--action", "post-verify"], opEnvironment).data;
  assert.throws(() => f.command(["grant", "revoke", "task-1", operatorGrant.id]), /Operator/);
  f.command(["grant", "revoke", "task-1", operatorGrant.id], opEnvironment);
});

test("Leader release grants bind the workflow source rather than a claimed step parameter", async t => {
  const f = fixture(t);
  f.store.saveProject(createProject("project-1", "Fixture", join(f.root, "project"),
    { stable: "main", development: "main" }, now, { remoteUrl: "https://github.com/fixture/repo.git" }));
  f.store.saveTask({ ...f.store.getTask("task-1"), projectBindings: [
    { projectId: "project-1", directory: "Repo", baseRef: "main", baseCommit: "a".repeat(40), currentCommit: "a".repeat(40) }
  ] });
  const source = f.message("Verify this Task's reviewed release in fixture/repo.");
  const grant = f.command(["grant", "issue", "task-1", "--source-message", source.id, "--purpose", source.body,
    "--request-id", "release-one", "--action", "post-verify", "--scope-project", "project-1",
    "--scope-repo", "fixture/repo", "--param", `sourceCommit=${"a".repeat(40)}`, "--param", "command=fixture",
    "--expires-at", "2026-10-01T00:00:00Z", "--max-uses", "1",
    "--irreversibility-ceiling", "irreversible"]).data;
  let calls = 0;
  const ports = { executeStep: async () => { calls++; return { outcome: "succeeded", externalId: "checked" }; },
    queryStepEffect: async () => ({ state: "unknown" }) };
  for (const [id, commit, expected] of [
    ["release-workflow-1", "b".repeat(40), "unauthorized"],
    ["release-workflow-2", "a".repeat(40), "succeeded"]
  ]) {
    f.store.saveReleaseWorkflow("task-1", createReleaseWorkflow(id, "task-1", {
      grantId: grant.id, source: { repository: { owner: "fixture", name: "repo" }, commit },
      plan: [{ id: "verify", kind: "post-verify", params: { command: "fixture", sourceCommit: "a".repeat(40) } }]
    }, now));
    assert.equal((await runReleaseWorkflow(f.store, "task-1", id, ports, { now: () => now })).outcome, expected);
  }
  assert.equal(calls, 1);
  const tagGrant = f.command(["grant", "issue", "task-1", "--source-message", source.id, "--purpose", source.body,
    "--request-id", "tag-one", "--action", "version-tag", "--scope-project", "project-1",
    "--scope-repo", "fixture/repo", "--param", `sourceCommit=${"a".repeat(40)}`, "--param", "version=1.2.3",
    "--expires-at", "2026-10-01T00:00:00Z", "--max-uses", "1",
    "--irreversibility-ceiling", "irreversible"]).data;
  for (const [id, tag, expected] of [
    ["release-workflow-3", "v9.9.9", "unauthorized"],
    ["release-workflow-4", "v1.2.3", "succeeded"]
  ]) {
    f.store.saveReleaseWorkflow("task-1", createReleaseWorkflow(id, "task-1", {
      grantId: tagGrant.id, source: { repository: { owner: "fixture", name: "repo" }, commit: "a".repeat(40) },
      plan: [{ id: "tag", kind: "version-tag", params: {
        version: "1.2.3", tag, repositoryPath: join(f.root, "project")
      } }]
    }, now));
    assert.equal((await runReleaseWorkflow(f.store, "task-1", id, ports, { now: () => now })).outcome, expected);
  }
  assert.equal(calls, 2);
  assert.equal(f.store.getCapabilityGrant("task-1", tagGrant.id).usesUsed, 1);
});

test("source-authorized ordinary archive survives ending its caller and records a durable result", async t => {
  const f = fixture(t);
  const source = f.message("Archive this Task after completion.");
  f.store.saveTask(completeTask(f.store.getTask("task-1"), now, { by: "leader", summary: "No code delivery" }));
  let stopped = 0;
  const coordinator = {
    preparer: { inspectWorkspaceCleanup: async () => [] },
    runtime: { stopTaskRoleSessions: async () => {
      stopped++;
      f.store.saveTaskRoleSessionSet({ ...f.set, sessions: { codex: {
        ...f.set.sessions.codex, status: "ended", endReason: "stopped"
      } } });
    } },
    cleanupTaskForArchive: async () => ({ taskId: "task-1", status: "removed" })
  };
  const request = { sourceMessage: source.id, purpose: source.body, requestId: "archive-once" };
  assert.throws(() => f.command(["archive", "task-1", "--integrated"]), /source-authorized/);
  const result = await archiveLeaderTask(f.store, coordinator, "task-1", f.environment, request);
  assert.equal(result.status, "archived");
  assert.equal(f.store.getTask("task-1").archivedBy, "leader");
  assert.equal((await archiveLeaderTask(f.store, coordinator, "task-1", f.environment, request)).replayed, true);
  assert.equal(stopped, 1);
  assert.equal(f.store.listEvents("task-1").filter(event => event.type === "task.archived").length, 1);
});

test("only admitted human-writer input becomes a durable user Message, without another delivery", t => {
  const f = fixture(t);
  let binding = createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: "leader-current", startedAt: now.toISOString() });
  binding = transferProviderAuthority(binding, { expectedEpoch: binding.authority.epoch,
    expectedOwner: "controller", owner: "human", holderId: "console-user", changedAt: now.toISOString() });
  f.store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(f.set, binding, now));
  const adapter = new FileSchedulerStoreAdapter(f.store);
  const input = { taskId: "task-1", roleName: "leader", agentId: "codex", nativeSessionId: "leader-current",
    attemptId: "human:one", authorityOwner: "human", authorityEpoch: binding.authority.epoch,
    holderId: "console-user", boundedText: "Publish this Task's exact reviewed version.", now };
  adapter.beginAgentHostProviderTurn(input);
  adapter.beginAgentHostProviderTurn(input);
  assert.equal(f.store.listMessages("task-1").length, 1);
  assert.equal(f.store.listMessages("task-1")[0].body, input.boundedText);
  assert.equal(f.store.getWorkMailbox({ kind: "role", taskId: "task-1", roleName: "leader" }), null);
  assert.throws(() => adapter.beginAgentHostProviderTurn({ ...input, boundedText: "different" }), /different|identity|input/i);
});
