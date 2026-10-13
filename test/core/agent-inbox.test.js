import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { bindGlobalRoleProviderRuntime, createRoleSessionSet, recordRoleAgentSession, updateRoleAgentSessionStatus } from "../../dist/executor/agentExecutor.js";
import { createGlobalRoleMessage, createTaskMessage } from "../../dist/message/message.js";
import { runInboxCommand } from "../../dist/commands/inboxCommands.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { pendingCompletionMessages } from "../../dist/task/completionReadiness.js";
import { deliverGlobalInputs } from "../../dist/controller/globalInputDelivery.js";
import { messageContinuationBlocker, prepareMessageContinuations } from "../../dist/message/messageContinuation.js";
import { applyGlobalInputControl } from "../../dist/commands/globalRoleCommands.js";
import { readDocument } from "../helpers/read-document.js";
import { createReviewRound, createTaskReviewRound, attachReviewRoundWorkspace, startReviewRound } from "../../dist/review/reviewRound.js";
import { createFixtureRun } from "../helpers/runFixture.mjs";
import { createProviderRuntimeBinding } from "../../dist/runtime/providerRuntimeIdentity.js";
import { failRun } from "../../dist/agentRun/agentRun.js";
import { createProject } from "../../dist/repository/project.js";

const now = new Date("2026-10-13T00:00:00Z");
function fixture(t, name) {
  const home = mkdtempSync(join(tmpdir(), "yui-agent-inbox-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  const role = createGlobalRole(name, [createRoleAgentBinding(agent)], agent.id, home, now);
  store.createGlobalRoleIfAbsent(role);
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "global", roleName: name }, agent.id, now), {
    agentId: agent.id, adapterId: "codex", nativeSessionId: `${name}-native`,
    policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  }, now));
  const env = { YUI_SESSION_SCOPE: "global", YUI_ROLE: name, CODEX_THREAD_ID: `${name}-native` };
  const command = (...args) => runInboxCommand(args, store, env, now);
  const add = body => {
    const id = store.nextGlobalRoleMessageId();
    store.saveGlobalRoleMessage(createGlobalRoleMessage(id, name, body, "user", { type: "user" }, now,
      { inputControl: { action: "queue", requestId: id } }));
    return id;
  };
  return { store, command, add, env };
}

for (const role of ["operator", "assistant"]) test(`${role} own inbox reads, claims and acknowledges without delivery fabrication`, t => {
  const { store, command, add, env } = fixture(t, role);
  const id = add("Complete original");
  const revision = store.getStateRevision();
  assert.equal(command("list").items[0].id, id);
  assert.equal(command("show", id).body, "Complete original");
  assert.equal(store.getStateRevision(), revision);
  assert.throws(() => command("ack", id, "--request-id", "read-is-not-handled", "--reason", "handled"), /claim/i);
  const claimed = command("claim", id, "--request-id", "claim-one");
  assert.deepEqual(command("claim", id, "--request-id", "claim-one"), claimed);
  const next = add("Later input must survive");
  const ack = command("ack", id, "--request-id", "ack-one", "--reason", "Processed original");
  assert.deepEqual(command("ack", id, "--request-id", "ack-one", "--reason", "Processed original"), ack);
  assert.deepEqual(command("list").items.map(item => item.id), [next]);
  const original = command("show", id);
  assert.equal(original.delivery, undefined);
  assert.equal(original.inbox.ack.reason, "Processed original");
  assert.equal(original.body, "Complete original");
  assert.throws(() => runInboxCommand(["list"], store, { ...env, CODEX_THREAD_ID: "replaced" }), /Session/);
  assert.throws(() => runInboxCommand(["list"], store, {}), /managed/i);
});

test("partial batches, long originals, restart and unknown delivery preserve each exact input", async t => {
  const { store, command, add, env } = fixture(t, "operator");
  const long = "完整😀".repeat(9000);
  const first = add(long);
  const second = add("not handled");
  assert.throws(() => command("claim", second, "--request-id", "skip"), /Earlier/);
  const original = readDocument(cursor => command("show", first, ...(cursor ? ["--cursor", cursor] : [])));
  assert.equal(original.body, long);
  const page = command("list", "--limit", "1");
  assert.equal(command("list", "--cursor", page.nextCursor).items[0].id, second);
  assert.throws(() => command("list", "--role", "assistant"), /option/);
  command("claim", first, "--request-id", "c");
  let ensured = false;
  await deliverGlobalInputs(store.rootDirectory(), store, async () => { ensured = true; }, error => { throw error; });
  assert.equal(ensured, false, "claimed input never auto-submits or starts a turn");
  const partial = command("ack", first, second, "--request-id", "a", "--reason", "Handled only the claimed item");
  assert.deepEqual(partial.results.map(result => result.ok), [true, false]);
  assert.equal(command("show", second).inbox, undefined);
  const unknown = store.listGlobalRoleMessages("operator").find(m => m.id === second);
  store.updateGlobalRoleMessage({ ...unknown, control: { requestId: second,
    receiptId: `global-input:operator/${second}`, outcome: "delivery-unknown", observedAt: now.toISOString() } });
  assert.throws(() => command("claim", second, "--request-id", "unknown"), /unknown/);
  assert.equal(command("show", second).control.outcome, "delivery-unknown");
  const reopened = new SqliteTaskStore(store.rootDirectory());
  t.after(() => reopened.close());
  const saved = readDocument(cursor => runInboxCommand(["show", first, ...(cursor ? ["--cursor", cursor] : [])], reopened, env));
  assert.equal(saved.inbox.ack.reason, "Handled only the claimed item");
  assert.equal(saved.delivery, undefined);
  store.transaction(() => { for (let i = 0; i < 128; i++) add(`Pending ${i}: ${"正文".repeat(300)}`); });
  let cursor;
  const seen = [];
  do {
    const page = command("list", "--limit", "37", ...(cursor ? ["--cursor", cursor] : []));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32768);
    seen.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(new Set(seen).size, 129);
  assert.equal(command("show", second).inbox, undefined, "reading every page still does not consume input");
});

test("native admission and active consumption arbitrate atomically on the original Global Message", t => {
  const { store, command, add } = fixture(t, "assistant");
  store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(store.getGlobalRoleSessionSet("assistant"),
    createProviderRuntimeBinding({ providerNamespace: "openai/codex", accountScope: "codex",
      conversationId: "assistant-native", startedAt: now.toISOString() }), now));
  const adapter = new FileSchedulerStoreAdapter(store);
  const input = id => ({ roleName: "assistant", agentId: "codex", nativeSessionId: "assistant-native",
    attemptId: `global-input:assistant/${id}`, authorityEpoch: 1, authorityOwner: "controller",
    holderId: "controller", now, boundedText: "Original" });
  const first = add("Manual wins");
  const original = store.listGlobalRoleMessages("assistant")[0];
  store.updateGlobalRoleMessage({ ...original, deliveryTarget: { agentId: "codex", nativeSessionId: "assistant-native" } });
  command("claim", first, "--request-id", "manual");
  assert.throws(() => store.updateGlobalRoleMessage({ ...original,
    deliveryTarget: { agentId: "codex", nativeSessionId: "assistant-native" } }), /ownership changed/);
  assert.throws(() => adapter.beginAgentHostProviderTurn(input(first)), /settled|unconfirmed/);
  assert.equal(store.getGlobalRoleSessionSet("assistant").providerBinding.run, null);
  command("ack", first, "--request-id", "handled", "--reason", "Processed");
  assert.throws(() => adapter.beginAgentHostProviderTurn(input(first)), /settled|unconfirmed/);
  const second = add("Automatic wins");
  store.updateGlobalRoleMessage({ ...store.listGlobalRoleMessages("assistant")[1],
    deliveryTarget: { agentId: "codex", nativeSessionId: "assistant-native" } });
  adapter.beginAgentHostProviderTurn(input(second));
  assert.throws(() => command("claim", second, "--request-id", "cannot-take-over"), /pending|native-attempt/);
  assert.equal(command("show", second).inbox, undefined);
  assert.equal(command("show", second).control.outcome, "pending");
});

test("a successor can finish retained role-addressed handling, while the replaced Session is denied", t => {
  const { store, command, add, env } = fixture(t, "operator");
  const id = add("Preserve across an interrupted handler");
  command("claim", id, "--request-id", "old-claim");
  const set = updateRoleAgentSessionStatus(store.getGlobalRoleSessionSet("operator"), "codex", "ended", now, "stopped");
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(set, { ...set.sessions.codex,
    status: "active", endReason: undefined, nativeSessionId: "successor" }, new Date(now.getTime() + 1000)));
  assert.throws(() => command("ack", id, "--request-id", "old", "--reason", "old session"), /Session/);
  const successor = { ...env, CODEX_THREAD_ID: "successor" };
  assert.equal(runInboxCommand(["list"], store, successor).items[0].blocked, "claimed-by-previous-session");
  const ack = runInboxCommand(["ack", id, "--request-id", "successor-done",
    "--reason", "Read original and verified prior effects, completed handling"], store, successor);
  assert.equal(ack.inbox.claim.actor.nativeSessionId, "operator-native");
  assert.equal(ack.inbox.ack.actor.nativeSessionId, "successor");
});

test("an unsubmitted Global steer can be explicitly handled without replay or blocking later input", t => {
  const { store, command, add } = fixture(t, "operator");
  const result = applyGlobalInputControl("operator", { action: "steer", body: "Old correction",
    requestId: "no-turn", expectedTarget: "absent-turn", to: "operator" }, store, { env: {} });
  assert.equal(result.data.steer.code, "NO_ACTIVE_TURN");
  const original = store.listGlobalRoleMessages("operator")[0];
  const later = add("Later ordinary input");
  assert.throws(() => command("claim", later, "--request-id", "skip-old"), /Earlier/);
  command("claim", original.id, "--request-id", "handle-old");
  // A delayed control writer read before the claim cannot admit a native steer.
  assert.throws(() => store.updateGlobalRoleMessage({ ...original, control: {
    requestId: "no-turn", receiptId: `steer:operator/${original.id}`,
    outcome: "pending", observedAt: now.toISOString()
  } }), /ownership changed/);
  command("ack", original.id, "--request-id", "old-done", "--reason", "Read original; no action remains");
  command("claim", later, "--request-id", "handle-later");
  const retained = command("show", original.id);
  assert.equal(retained.inputControl.action, "steer", "explicit handling never downgrades steer to queue");
  assert.equal(retained.control, undefined);
  assert.equal(retained.delivery, undefined);
});

function taskFixture(t) {
  const f = fixture(t, "operator");
  const { store } = f;
  const home = store.rootDirectory();
  store.saveTask(activateTask(createTask("task-1", "Own inbox", now, { cwd: home }), now));
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: "task-1" }, root: home, entries: []
  }, now));
  for (const name of ["leader", "worker", "reviewer"]) {
    const role = createRole("task-1", name, [createRoleAgentBinding(store.getConfiguredAgent("codex"))], "codex", home, now);
    store.saveRole("task-1", role);
    if (name === "leader") store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
      { scope: "task", taskId: "task-1", roleName: name }, "codex", now), {
      agentId: "codex", adapterId: "codex", nativeSessionId: `${name}-native`,
      policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
    }, now));
  }
  const envFor = role => ({ YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1", YUI_ROLE: role,
    CODEX_THREAD_ID: `${role}-native` });
  const inbox = (role, ...args) => runInboxCommand(args, store, envFor(role), now);
  const task = args => runTaskCommand(args, store, { now: () => now, environment: {} });
  return { ...f, task, inbox, envFor };
}

test("Leader claims one fixed window without accepting results, consuming later input, or fabricating native delivery", t => {
  const { store, inbox } = taskFixture(t);
  const target = { kind: "role", taskId: "task-1", roleName: "leader" };
  const message = createTaskMessage("message-1", "task-1", "First user input", "user", { type: "user" }, now);
  store.saveMessage("task-1", message);
  enqueueWork(store, target, "user-message", now, [{ type: "message", taskId: "task-1", id: message.id }]);
  const id = inbox("leader", "list").items[0].id;
  const before = store.getWorkMailbox(target);
  assert.equal(inbox("leader", "show", id).refs[0].id, message.id);
  assert.deepEqual(store.getWorkMailbox(target), before);
  const claimed = inbox("leader", "claim", id, "--request-id", "window");
  assert.deepEqual(inbox("leader", "claim", id, "--request-id", "window"), claimed);
  assert.equal(pendingCompletionMessages(store, "task-1").length, 1);
  assert.equal(new FileSchedulerStoreAdapter(store).claimLeaderNotification("task-1", now), null);
  const next = createTaskMessage("message-2", "task-1", "Later user input", "user", { type: "user" }, now);
  store.saveMessage("task-1", next);
  enqueueWork(store, target, "user-message", now, [{ type: "message", taskId: "task-1", id: next.id }]);
  const beforeFailure = store.getWorkMailbox(target);
  const saveWake = store.saveTaskWake.bind(store);
  store.saveTaskWake = () => { throw new Error("injected receipt persistence failure"); };
  assert.throws(() => inbox("leader", "ack", claimed.id, "--request-id", "done", "--reason",
    "Read the original and implemented the request"), /injected/);
  store.saveTaskWake = saveWake;
  assert.deepEqual(store.getWorkMailbox(target), beforeFailure);
  assert.equal(store.getTaskWake("task-1", claimed.id).inbox.ack, undefined);
  inbox("leader", "ack", claimed.id, "--request-id", "done", "--reason", "Read the original and implemented the request");
  assert.deepEqual(pendingCompletionMessages(store, "task-1").map(m => m.id), [next.id]);
  assert.deepEqual(store.getWorkMailbox(target).pending.refs.map(r => r.id), [next.id]);
  assert.equal(store.getTaskWake("task-1", claimed.id).consumedAt, undefined);
  assert.equal(store.getTask("task-1").status, "active");
  assert.deepEqual(store.listEvents("task-1").filter(e => e.type === "notification.delivery"), []);
  assert.throws(() => inbox("worker", "show", claimed.id), /Assignment|Session/);
  // Winning automatic ownership is just as exclusive, even when rejected/unknown.
  const pending = inbox("leader", "list").items[0].id;
  const automatic = new FileSchedulerStoreAdapter(store).claimLeaderNotification("task-1", now);
  assert.ok(automatic);
  assert.throws(() => inbox("leader", "claim", pending, "--request-id", "too-late"), /changed|earlier/);
  assert.throws(() => inbox("leader", "claim", automatic.wakeId, "--request-id", "steal"), /automatic/);
});

for (const roleName of ["worker", "leader"]) test(`${roleName} own Assignment inbox excludes Task-wide, foreign-role and foreign-Assignment input`, t => {
  const { store, inbox, task, envFor } = taskFixture(t);
  const ownInbox = (...args) => inbox(roleName, ...args);
  task(["work", "create", "task-1", "Bounded work", "--role", roleName]);
  task(["work", "dispatch", "task-1/work-item-1"]);
  const run = store.getActiveRun("task-1", roleName);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName }, "codex", now), {
    agentId: "codex", adapterId: "codex", nativeSessionId: `${roleName}-native`,
    policy: "fixed", status: "active", effective: run.effective
  }, now));
  task(["message", "queue", "task-1", "Worker correction", "--to", roleName,
    "--work-item", "work-item-1", "--request-id", "worker-input"]);
  const id = ownInbox("list").items.find(item => item.kind === "message").id;
  store.saveMessage("task-1", createTaskMessage("message-2", "task-1", "Leader only", "user", { type: "user" }, now));
  assert.throws(() => ownInbox("show", "message-2"), /scope/);
  assert.equal(ownInbox("show", id).body, "Worker correction");
  ownInbox("claim", id, "--request-id", "worker-claim");
  prepareMessageContinuations(store, "task-1", now, roleName);
  assert.equal(store.listRuns("task-1").length, 1);
  ownInbox("ack", id, "--request-id", "worker-done", "--reason", "Applied to the bounded assignment");
  assert.equal(store.getWorkItem("task-1", "work-item-1").status, "open");
  assert.equal(store.getRun("task-1", run.id).status, "active");
  assert.equal(store.listMessages("task-1")[0].continuation.runId, undefined);
  assert.throws(() => runInboxCommand(["show", id], store, { ...envFor(roleName), YUI_TASK_ID: "task-2" }), /exists|current/);
  assert.throws(() => runInboxCommand(["ack", id, "--request-id", "old", "--reason", "bad"], store,
    { ...envFor(roleName), CODEX_THREAD_ID: "old" }), /Session/);
  task(["message", "queue", "task-1", "Interrupted clarification", "--to", roleName,
    "--work-item", "work-item-1", "--request-id", "interrupted"]);
  const interrupted = ownInbox("list").items.find(item => item.kind === "message").id;
  ownInbox("claim", interrupted, "--request-id", "before-interruption");
  assert.throws(() => task(["message", "handoff", `task-1/${interrupted}`, "--to", roleName]), /stopped|terminal|pending/i);
  const failed = failRun(run, "runtime-failed", "Interrupted while handling", now, {
    providerNamespace: "openai/codex", accountScope: "codex", conversationId: `${roleName}-native`,
    nativeTurnId: "worker-turn", status: "failed"
  });
  store.saveRun(failed);
  store.clearActiveRun("task-1", roleName);
  task(["work", "dispatch", "task-1/work-item-1"]);
  assert.throws(() => ownInbox("show", interrupted), /scope/);
  task(["message", "handoff", `task-1/${interrupted}`, "--to", roleName]);
  const retained = ownInbox("show", interrupted);
  assert.equal(retained.inbox.claim.actor.runId, run.id, "handoff preserves the interrupted handler's audit");
  assert.throws(() => task(["message", "handoff", `task-1/${interrupted}`, "--to", roleName]), /stopped/);
  prepareMessageContinuations(store, "task-1", now, roleName);
  assert.equal(store.listRuns("task-1").length, 2, "handoff does not replay a claimed message");
  ownInbox("ack", interrupted, "--request-id", "after-interruption",
    "--reason", "Read prior handling evidence and finished the clarification");
  assert.equal(ownInbox("show", interrupted).inbox.ack.actor.runId, store.getActiveRun("task-1", roleName).id);
});

for (const scope of ["work-item", "task"]) test(`Reviewer reads only its frozen ${scope} ReviewRound mailbox; handling does not finish the Review`, t => {
  const { store, inbox, task } = taskFixture(t);
  task(["work", "create", "task-1", "Reviewable result"]);
  task(["work", "update", "task-1/work-item-1", "running"]);
  task(["work", "update", "task-1/work-item-1", "done", "--summary", "Evidence"]);
  const candidate = store.getWorkItem("task-1", "work-item-1").candidates.at(-1);
  let round = createReviewRound("review-round-1", "task-1", "work-item-1", candidate.id,
    "reviewer", "leader", "b".repeat(40), now);
  if (scope === "task") {
    store.saveProject(createProject("project-1", "Fixture", join(store.rootDirectory(), "project"),
      { stable: "main", development: "main" }, now));
    store.saveTask({ ...store.getTask("task-1"), projectBindings: [{
      projectId: "project-1", directory: "project", baseRef: "main",
      baseCommit: "b".repeat(40), currentCommit: "b".repeat(40)
    }] });
    round = createTaskReviewRound("review-round-1", "task-1", "reviewer", "leader", {
      schemaVersion: 1, projects: [{ projectId: "project-1", commit: "b".repeat(40) }]
    }, now);
  }
  const workspace = createManagedWorkspace({ owner: { type: "review-round", taskId: "task-1", reviewRoundId: round.id },
    root: join(store.rootDirectory(), "review"), entries: [{
      projectId: "project-1", directory: "project", access: "write",
      path: join(store.rootDirectory(), "review", "project"), branch: "fixture-review",
      baseRef: "b".repeat(40), baseCommit: "b".repeat(40)
    }] }, now);
  const effective = resolveEffectiveLaunch({ role: store.getRole("task-1", "reviewer"),
    purpose: "review", workspace, reviewRoundId: round.id, reviewBaseCommit: round.reviewBaseCommit });
  store.saveManagedWorkspace(workspace);
  const run = createFixtureRun(store, store.nextRunId("task-1"), "task-1", "reviewer", "new",
    { source: { type: "yui", channel: "workitem-dispatch" }, deltaRefIds: [] }, now,
    { purpose: "review", ...(scope === "task" ? {} : { workItemId: "work-item-1" }),
      reviewRoundId: round.id, workspace, effective });
  round = startReviewRound(attachReviewRoundWorkspace(round, workspace), run.id);
  store.saveReviewRound("task-1", round);
  store.saveRun(run);
  store.saveActiveRun(run);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "reviewer" }, "codex", now), {
    agentId: "codex", adapterId: "codex", nativeSessionId: "reviewer-native",
    policy: "fixed", status: "active", effective
  }, now));
  task(["message", "queue", "task-1", "Review clarification", "--to", "reviewer",
    "--review-round", round.id, "--request-id", "review-input"]);
  const id = inbox("reviewer", "list").items[0].id;
  assert.equal(inbox("reviewer", "show", id).body, "Review clarification");
  inbox("reviewer", "claim", id, "--request-id", "review-claim");
  if (scope === "task") {
    store.saveTask({ ...store.getTask("task-1"), projectBindings: store.getTask("task-1").projectBindings
      .map(binding => ({ ...binding, currentCommit: "c".repeat(40) })) });
    assert.equal(messageContinuationBlocker(store, store.listMessages("task-1")[0]), "review-candidate-stale",
      "a new continuation still needs a current candidate");
  }
  inbox("reviewer", "ack", id, "--request-id", "review-handled", "--reason", "Included in the review analysis");
  if (scope === "task") {
    task(["message", "queue", "task-1", "Later frozen clarification", "--to", "reviewer",
      "--review-round", round.id, "--request-id", "later-review-input"]);
    const later = store.listMessages("task-1").at(-1).id;
    inbox("reviewer", "claim", later, "--request-id", "later-review-claim");
    const saved = store.getReviewRoundWorkspace("task-1", round.id);
    store.saveManagedWorkspace({ ...saved, entries: saved.entries.map(entry => ({
      ...entry, baseRef: "d".repeat(40), baseCommit: "d".repeat(40)
    })) });
    assert.throws(() => inbox("reviewer", "ack", later, "--request-id", "drift",
      "--reason", "Must not authorize changed workspace"), /review-workspace-drift/);
    store.saveManagedWorkspace(saved);
    inbox("reviewer", "ack", later, "--request-id", "later-review-done", "--reason", "Reviewed frozen clarification");
  }
  assert.equal(store.getReviewRound("task-1", round.id).status, "running");
  assert.equal(store.getWorkItem("task-1", "work-item-1").status, "open");
  store.saveMessage("task-1", createTaskMessage("message-3", "task-1", "Another assignment",
    "system", { type: "system" }, now, { recipient: { roleName: "reviewer",
      ownerRunId: run.id, reviewRoundId: "review-round-2", workItemId: "work-item-1" } }));
  assert.throws(() => inbox("reviewer", "show", "message-3"), /scope/);
});

test("retained claims fence only their Assignment, with explicit retirement preserving original evidence", t => {
  const { store, inbox, task } = taskFixture(t);
  const dispatch = title => {
    task(["work", "create", "task-1", title, "--role", "worker"]);
    const work = store.listWorkItems("task-1").at(-1);
    task(["work", "dispatch", `task-1/${work.id}`]);
    const run = store.getActiveRun("task-1", "worker");
    store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
      { scope: "task", taskId: "task-1", roleName: "worker" }, "codex", now), {
      agentId: "codex", adapterId: "codex", nativeSessionId: "worker-native",
      policy: "fixed", status: "active", effective: run.effective
    }, now));
    task(["message", "queue", "task-1", title, "--to", "worker",
      "--work-item", work.id, "--request-id", work.id]);
    return { run, work, message: store.listMessages("task-1").at(-1) };
  };
  const stop = run => {
    store.saveRun(failRun(run, "runtime-failed", "Exact native terminal", now, {
      providerNamespace: "openai/codex", accountScope: "codex", conversationId: "worker-native",
      nativeTurnId: `turn-${run.id}`, status: "failed"
    }));
    store.clearActiveRun("task-1", "worker");
  };
  const old = dispatch("Old assignment");
  inbox("worker", "claim", old.message.id, "--request-id", "old-claim");
  stop(old.run);
  task(["work", "retire", `task-1/${old.work.id}`, "--summary", "No further implementation"]);
  const next = dispatch("Independent assignment");
  stop(next.run);
  prepareMessageContinuations(store, "task-1", now, "worker");
  assert.equal(store.listMessages("task-1").find(m => m.id === next.message.id).continuation.runId, "run-3");
  assert.throws(() => inbox("worker", "show", old.message.id), /scope/);
  assert.throws(() => inbox("worker", "ack", old.message.id, "--request-id", "foreign",
    "--reason", "Other assignment cannot settle it"), /scope/);
  task(["message", "retire", `task-1/${old.message.id}`, "--reason", "Reviewed original and effects; assignment obsolete"]);
  const retained = store.listMessages("task-1").find(m => m.id === old.message.id);
  assert.equal(retained.body, old.message.body);
  assert.equal(retained.inbox.claim.actor.runId, old.run.id);
  assert.equal(retained.inbox.ack, undefined, "retirement is not fabricated Agent acknowledgement");
  const continuation = store.getActiveRun("task-1", "worker");
  task(["message", "queue", "task-1", "Interrupted current handling", "--to", "worker",
    "--work-item", next.work.id, "--request-id", "current-claim"]);
  const current = store.listMessages("task-1").at(-1);
  inbox("worker", "claim", current.id, "--request-id", "current");
  task(["message", "queue", "task-1", "Later same-assignment input", "--to", "worker",
    "--work-item", next.work.id, "--request-id", "later"]);
  const later = store.listMessages("task-1").at(-1);
  stop(continuation);
  prepareMessageContinuations(store, "task-1", now, "worker");
  assert.equal(store.getActiveRun("task-1", "worker"), null, "unfinished claim still fences its own Assignment");
  task(["message", "retire", `task-1/${current.id}`, "--reason", "Original and effects inspected; no action remains"]);
  prepareMessageContinuations(store, "task-1", now, "worker");
  assert.equal(store.listMessages("task-1").find(m => m.id === later.id).continuation.runId, "run-4");
  assert.equal(store.listMessages("task-1").find(m => m.id === current.id).continuation.runId, undefined,
    "explicit retirement unblocks later input without replaying the retired claim");
});
