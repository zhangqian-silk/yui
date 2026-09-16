import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { processLeaderWakeups } from "../../dist/scheduler/leaderWakeupProcessor.js";
import { pendingCompletionMessages } from "../../dist/task/completionReadiness.js";
import { RuntimeHostContentionError } from "../../dist/runtime/ports.js";
import { toRuntimeLaunchFailure } from "../../dist/runtime/launchDiagnostics.js";
import { validateAgentLaunchConfiguration } from "../../dist/executor/agentConfigurationCatalog.js";
import { renderAgentConfigurationCatalog } from "../../dist/output/agentConfigurationPresentation.js";
import { routeInvocation } from "../../dist/cli/invocationRouter.js";

const at = new Date("2026-09-16T00:00:00Z");
const later = new Date("2026-09-16T00:02:00Z");
const catalog = {
  schemaVersion: 1, agentId: "claude", adapterId: "claude",
  models: [
    { value: "default", label: "Default", isDefault: true,
      resolvedModel: "provider/default", efforts: [{ value: "low", label: "Low" }] },
    { value: "sonnet", label: "Custom Sonnet", isDefault: false,
      resolvedModel: "provider/custom-model", efforts: [{ value: "low", label: "Low" }] },
  ],
  fields: [{ key: "model", choices: [], allowCustom: true }],
  warnings: [],
};

test("model validation respects native custom IDs and rejection lists exact native choices", () => {
  assert.doesNotThrow(() => validateAgentLaunchConfiguration(catalog, { model: "sonnet", effort: "low" }));
  assert.doesNotThrow(() => validateAgentLaunchConfiguration(catalog, { model: "provider/custom-model", effort: "low" }));
  assert.doesNotThrow(() => validateAgentLaunchConfiguration(catalog, { model: "provider/other-model" }),
    "An open native model field is not a closed alias whitelist.");
  const closed = { ...catalog, fields: [{ key: "model", choices: [], allowCustom: false }] };
  assert.throws(() => validateAgentLaunchConfiguration(closed, { model: "unknown" }), error => {
    assert.match(error.message, /field=model/);
    assert.match(error.message, /sonnet/);
    assert.match(error.message, /provider\/custom-model/);
    assert.match(error.message, /config agent capabilities claude/);
    return true;
  });
  assert.throws(() => validateAgentLaunchConfiguration(catalog,
    { model: "provider/custom-model", effort: "invalid" }), error => {
    assert.match(error.message, /field=effort/);
    assert.match(error.message, /low/);
    assert.match(error.message, /sonnet/);
    assert.match(error.message, /provider\/custom-model/);
    return true;
  });
  const rendered = renderAgentConfigurationCatalog({ source: "live", attemptedAt: at.toISOString(), catalog });
  assert.match(rendered, /sonnet/);
  assert.match(rendered, /provider\/custom-model/);
  assert.match(rendered, /custom.*Provider|Provider.*custom/i);
});

test("rejected Leader startup stays quiet across reopen, preserves input and explicitly retries without replaying unknown delivery", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-launch-rejection-"));
  let store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const agent = createConfiguredAgent("claude", "claude", "claude", [], [], at);
  store.saveConfiguredAgent(agent);
  store.saveTask(activateTask(createTask("task-1", "Keep failed input", at, { cwd: home }), at));
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: "task-1" }, root: home, entries: []
  }, at));
  const configure = effort => store.saveRole("task-1", createRole("task-1", "leader",
    [createRoleAgentBinding(agent, { adapterId: "claude", model: "sonnet", effort,
      permission: { strategy: "bypass" } })], agent.id, home, at));
  configure("invalid");
  const command = args => runTaskCommand(args, store, { environment: {}, now: () => at });
  const target = { kind: "role", taskId: "task-1", roleName: "leader" };
  const deliveries = () => store.listEvents("task-1").filter(e => e.type === "notification.delivery");
  command(["message", "queue", "task-1", "Original requirement", "--request-id", "original"]);
  let preparations = 0, submissions = 0, forgotten = 0, uncertain = false;
  const delivery = {
    prepareRoleSession: async request => {
      preparations++;
      if (preparations === 1) throw new RuntimeHostContentionError("previous-process", "Cleanup is still draining");
      try { validateAgentLaunchConfiguration(catalog, request.effective); }
      catch (error) { throw toRuntimeLaunchFailure(error, "validation", { agentId: "claude" }); }
      return {};
    },
    waitUntilReady: async prepared => prepared,
    sendOnce: async () => {
      submissions++;
      if (uncertain) throw new Error("Connection dropped after submit");
      return { status: "sent" };
    },
    forgetPrepared: () => { forgotten++; },
  };
  const reconcile = () => processLeaderWakeups(new FileSchedulerStoreAdapter(store), delivery, later);
  await reconcile();
  assert.equal(deliveries().at(-1).payload.outcome, "deferred", "Real host contention remains retryable.");
  await reconcile();
  assert.equal(deliveries().at(-1).payload.outcome, "rejected", "A configuration error must not be deferred forever.");
  const failureEvents = store.listEvents("task-1").filter(e => e.type === "runtime.agent-error");
  assert.equal(failureEvents.length, 1, "Runless startup refusal needs one canonical failure fact.");
  assert.equal(failureEvents[0].payload.runId, undefined, "Never invent a Run for a notification failure.");
  assert.equal(JSON.parse(failureEvents[0].payload.capabilityContext).status, "recorded");
  assert.ok(store.getWorkMailbox({ kind: "operator" }).pending.refs.some(ref => ref.id === failureEvents[0].id),
    "An unavailable Leader must hand the failure to its existing Operator channel.");
  const rejectedClaim = store.getWorkMailbox(target).processing;
  const rejectedWake = store.listTaskWakes("task-1")[0];
  assert.ok(rejectedClaim, "Keep unaccepted input visible rather than silently consuming it.");
  const shown = command(["wake", "show", "task-1", rejectedWake.id]);
  assert.match(shown.output, /Notification: rejected/);
  assert.match(shown.output, /field=effort/);
  assert.match(shown.output, /sonnet/);
  assert.match(shown.output, /provider\/custom-model/);
  assert.match(shown.output, /wake retry task-1 wake-1/);
  assert.equal(shown.data.deliveryEvents.at(-1).payload.outcome, "rejected");
  store.close();
  store = new SqliteTaskStore(home);
  command(["message", "queue", "task-1", "Later input", "--request-id", "later"]);
  const revision = store.getStateRevision();
  for (let i = 0; i < 30; i++) await reconcile();
  assert.equal(preparations, 2);
  assert.equal(submissions, 0);
  assert.equal(forgotten, 2);
  assert.equal(deliveries().length, 2);
  assert.equal(store.listEvents("task-1").filter(e => e.type === "runtime.agent-error").length, 1);
  assert.equal(store.getStateRevision(), revision, "Repeated passes must not keep writing the same failure.");
  assert.deepEqual(pendingCompletionMessages(store, "task-1").map(m => m.body),
    ["Original requirement", "Later input"]);
  assert.throws(() => command(["complete", "task-1", "--summary", "Not delivered"]), /pending-user-input/);
  configure("low");
  await reconcile();
  assert.equal(preparations, 2, "Configuration edits alone do not replay a rejected notification.");
  const retryArgs = ["wake", "retry", "task-1", rejectedWake.id, "--reason", "Corrected model effort; retry original input"];
  assert.equal(routeInvocation(["task", ...retryArgs]).kind, "execute");
  command(retryArgs);
  assert.throws(() => command(retryArgs), /no rejected notification claim/, "A repeated command cannot queue duplicate input.");
  assert.doesNotMatch(command(["wake", "show", "task-1", rejectedWake.id]).output, /Recovery:/,
    "Historical rejection must not suggest retrying an already-released claim.");
  assert.ok(store.getWorkMailbox(target).pending.refs.some(ref => ref.id === "message-1"));
  assert.ok(store.getWorkMailbox(target).pending.refs.some(ref => ref.id === "message-2"));
  await reconcile();
  assert.equal(preparations, 3);
  assert.equal(submissions, 1);
  assert.equal(store.listTaskWakes("task-1")[0].status, "dispatched",
    "Successor acceptance must not rewrite the rejected wake as accepted.");
  assert.equal(store.listTaskWakes("task-1").at(-1).status, "consumed");
  assert.throws(() => command(["wake", "retry", "task-1", store.listTaskWakes("task-1").at(-1).id,
    "--reason", "Accepted input must not be replayed"]), /accepted notification/);
  assert.deepEqual(pendingCompletionMessages(store, "task-1"), []);
  assert.equal(store.listMessages("task-1").length, 2);
  assert.equal(store.listRuns("task-1").length, 0);
  await reconcile();
  assert.equal(submissions, 1);

  uncertain = true;
  command(["message", "queue", "task-1", "Uncertain input", "--request-id", "uncertain"]);
  await reconcile();
  const unknownClaim = store.getWorkMailbox(target).processing;
  assert.equal(deliveries().at(-1).payload.outcome, "unknown");
  assert.throws(() => command(["wake", "retry", "task-1", store.listTaskWakes("task-1").at(-1).id,
    "--reason", "Must not bypass unknown native acceptance"]), /unknown acceptance/);
  await reconcile();
  assert.equal(store.getWorkMailbox(target).processing.batchId, unknownClaim.batchId);
  assert.equal(submissions, 2, "An ambiguous Provider write must never be replayed by notification retry.");
});
