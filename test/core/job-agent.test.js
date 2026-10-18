import test from "node:test";
import assert from "node:assert/strict";
import { createJobDefinition } from "../../dist/job/jobDefinition.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding, createRole } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createJobDefinitionControl } from "../../dist/controller/jobDefinitionControl.js";
import { createProviderRuntimeBinding, beginProviderTurn, acceptProviderTurn, settleProviderTurn } from "../../dist/runtime/providerRuntimeIdentity.js";
import { createTask, activateTask, stopTaskExecution } from "../../dist/task/task.js";
import { createTaskWake } from "../../dist/scheduler/taskWake.js";
import { recordJobAgentObservation } from "../../dist/job/agentJobObservation.js";
import { assertJobAgentCommand } from "../../dist/job/agentRoleScope.js";
import { recordProviderFailure, admitProviderRetry } from "../../dist/runtime/providerRetry.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { failRun } from "../../dist/agentRun/agentRun.js";
import { prepareMessageContinuations } from "../../dist/message/messageContinuation.js";
import { projectCompletionReadiness } from "../../dist/task/completionReadiness.js";
import { archiveSettlementChecks, archiveExecutionChecks } from "../../dist/task/archivePreflight.js";
import Database from "../../dist/sqlite/driver.js";
import { applySqliteMinorUpgrades, validateSqliteSchemaObjects } from "../../dist/storage/sqliteSchema.js";
import { usePre120Layout } from "../helpers/pre19Storage.mjs";
import { createScheduleControl } from "../../dist/controller/scheduleControl.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-job-agent-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  const agent = createConfiguredAgent("fixture", "codex", "false", [], [], now);
  store.saveConfiguredAgent(agent);
  const control = createJobDefinitionControl(store, home);
  const call = (id, op, extra = {}, caller = { scope: "user" }, scope = { kind: "global" }) =>
    control({ id, op, scope, caller, ...extra }, new Date());
  function session(role, nativeId) {
    const owner = role.taskId ? { scope: "task", taskId: role.taskId, roleName: role.name }
      : { scope: "global", roleName: role.name };
    const set = recordRoleAgentSession(createRoleSessionSet(owner, agent.id, now),
      { agentId: agent.id, adapterId: "codex", nativeSessionId: nativeId, status: "active",
        policy: "fixed", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, now);
    const next = { ...set, providerBinding: createProviderRuntimeBinding({
      providerNamespace: "openai/codex", accountScope: "fixture", conversationId: nativeId, startedAt: now.toISOString()
    }) };
    if (role.taskId) store.saveTaskRoleSessionSet(next); else store.saveGlobalRoleSessionSet(next);
    return owner.scope === "task" ? { scope: "task", taskId: role.taskId, role: role.name, nativeSessionId: nativeId }
      : { scope: "global", role: role.name, nativeSessionId: nativeId };
  }
  function setFor(recipient) {
    return recipient.scope === "task" ? store.getTaskRoleSessionSet(recipient.taskId, recipient.roleName)
      : store.getGlobalRoleSessionSet(recipient.roleName);
  }
  function saveSet(set) {
    if (set.owner.scope === "task") store.saveTaskRoleSessionSet(set); else store.saveGlobalRoleSessionSet(set);
  }
  function deliver(run) {
    const attempt = run.attempts.at(-1);
    const set = setFor(attempt.recipient);
    let input = { kind: "message", roleName: attempt.recipient.roleName, messageId: attempt.messageId };
    if (attempt.recipient.scope === "task") {
      const taskId = attempt.recipient.taskId;
      const wakeId = store.nextTaskWakeId(taskId);
      store.saveTaskWake(taskId, createTaskWake({ id: wakeId, taskId, reasons: ["job-agent-input"],
        refs: [{ type: "message", taskId, id: attempt.messageId }], fromCursor: now.toISOString(), toCursor: now.toISOString(), now }));
      input = { kind: "wake", taskId, wakeId };
    }
    const attemptId = `job-fixture:${attempt.messageId}`;
    const nativeTurnId = `native:${attempt.messageId}`;
    const started = beginProviderTurn(set.providerBinding, { attemptId, authorityEpoch: set.providerBinding.authority.epoch,
      submittedAt: new Date().toISOString(), input });
    saveSet({ ...set, providerBinding: acceptProviderTurn(started, {
      attemptId, nativeTurnId, acceptedAt: new Date().toISOString()
    }) });
  }
  function terminal(run) {
    const set = setFor(run.attempts.at(-1).recipient);
    saveSet({ ...set, providerBinding: settleProviderTurn(set.providerBinding, {
      attemptId: set.providerBinding.run.attemptId, nativeTurnId: set.providerBinding.run.nativeTurnId,
      status: "completed", settledAt: new Date().toISOString()
    }) });
  }
  const report = (run, outcome = "succeeded") => ({ schemaVersion: 1, sourceRun: { scope: run.scope, runId: run.id },
    outcome, summary: `Explicit ${outcome}`, evidence: [] });
  return { store, home, agent, now, call, session, deliver, terminal, report, setFor, saveSet };
}

test("Agent Jobs select logical targets independently of their ownership", () => {
  const now = new Date("2026-10-19T00:00:00Z");
  for (const target of [
    { kind: "operator" },
    { kind: "task", taskId: "task-1", roleName: "leader" },
    { kind: "job", agentId: "codex" }
  ]) {
    const job = createJobDefinition({ id: "analysis", scope: { kind: "global" },
      title: "Analysis", configuration: { kind: "agent", target, input: "Analyze the saved evidence." } }, now);
    assert.deepEqual(job.configuration.target, target);
    assert.throws(() => createJobDefinition({ ...job,
      configuration: { ...job.configuration, target: { ...target, nativeSessionId: "permanent" } } }, now));
  }
});

test("1.19 history survives Agent migration and process, Task, Agent executors coexist without sharing grants", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-job-coexist-"));
  let store = new SqliteTaskStore(home);
  t.after(() => { store?.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date(), scope = { kind: "global" }, caller = { scope: "user" };
  const agent = createConfiguredAgent("fixture", "codex", "false", [], [], now);
  store.saveConfiguredAgent(agent);
  store.saveConfig({ ...store.getConfig(), defaultAgent: agent.id });
  let control = createJobDefinitionControl(store, home);
  const call = (id, op, extra = {}) => control({ scope, caller, id, op, ...extra }, now);
  const processConfig = { kind: "builtin", action: "system.noop", input: {} };
  const taskConfig = { kind: "task", goal: "delivery", target: { kind: "new",
    title: "Independent delivery", description: "Normal authorized activation only.", projectBindings: [] } };
  call("process", "define", { title: "Process", configuration: processConfig });
  call("delivery", "define", { title: "Task", configuration: taskConfig });
  const process = call("process", "run", { trigger: { source: "manual", key: "original" } }).run;
  const delegated = call("delivery", "run", { trigger: { source: "manual", key: "original" } }).run;
  store.close(); store = undefined;
  const db = new Database(join(home, "yui.db"));
  try {
    const tables = ["job_definitions", "global_job_runs", "task_records", "global_role_session_sets"];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    usePre120Layout(db);
    db.prepare("UPDATE storage_schema SET minor=19").run();
    validateSqliteSchemaObjects(db, "1.19");
    applySqliteMinorUpgrades(db, home);
    validateSqliteSchemaObjects(db);
    assert.equal(db.prepare("SELECT minor FROM storage_schema").get().minor, 20);
    assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_job_runs").get().n, 0);
  } finally { db.close(); }
  store = new SqliteTaskStore(home);
  control = createJobDefinitionControl(store, home);
  assert.equal(call("process", "run-get", { runId: process.id }).id, process.id);
  assert.equal(call("delivery", "run-confirm", { runId: delegated.id }).businessResult, undefined);
  assert.equal(store.getTask(delegated.delegation.taskId).status, "draft");
  call("agent", "define", { title: "Agent", configuration: {
    kind: "agent", target: { kind: "job", agentId: agent.id }, input: "Inspect only this Job."
  } });
  const run = call("agent", "run", { trigger: { source: "manual", key: "original" } }).run;
  assert.equal(run.executor, "agent");
  assert.deepEqual(control({ op: "list", scope, caller }, now).map(job => job.id).sort(), ["agent", "delivery", "process"]);
  for (const [id, configuration] of [["agent", taskConfig], ["delivery", processConfig]]) {
    assert.throws(() => call(id, "update", { expectedRevision: 1, title: "Retarget", configuration }), /executor kind/);
  }
  const schedules = createScheduleControl(store, home);
  for (const id of ["agent", "delivery"]) {
    assert.throws(() => schedules({ op: "create", scope, caller, id: `schedule-${id}`, jobId: id,
      authorization: "service", rule: { kind: "interval", everyMs: 60000, anchor: now.toISOString() } }, now), /service|builtin/i);
  }
  assert.equal(store.listSchedules(scope).length, 0);
  assert.equal(call("agent", "run-confirm", { runId: run.id }).businessResult, undefined);
  assert.equal(store.getTask(delegated.delegation.taskId).status, "draft");
});

test("Job Agent reuses a Role Session, preserves input/artifacts through replacement, fences old results", async t => {
  const f = fixture(t);
  const { call, store, session, deliver, terminal, report } = f;
  call("analysis", "define", { title: "Analysis", configuration: {
    kind: "agent", target: { kind: "job", agentId: f.agent.id }, input: "Saved durable requirements."
  } });
  const run = call("analysis", "run", { trigger: { source: "manual", key: "one" } }).run;
  assert.equal(call("analysis", "run", { trigger: { source: "manual", key: "one" } }).run.id, run.id);
  const role = store.getGlobalRole(run.attempts[0].recipient.roleName);
  assert.deepEqual(role.jobOwner, { scope: { kind: "global" }, jobId: "analysis" });
  assert.throws(() => assertJobAgentCommand(role, ["task", "create", "not delegated"]), /limited/);
  assert.throws(() => assertJobAgentCommand(role, ["config", "role", "add", "another"]), /limited/);
  assert.doesNotThrow(() => assertJobAgentCommand(role, ["job", "run-context"]));
  assert.equal(store.getGlobalRole("operator"), null);
  const caller = session(role, "session-one");
  assert.throws(() => call("analysis", "run-claim", { runId: run.id }, caller), /accepted native Turn/);
  deliver(run);
  assert.equal(call("analysis", "run-get", { runId: run.id }, caller).businessResult, undefined);
  call("analysis", "run-claim", { runId: run.id }, caller);
  assert.throws(() => call("analysis", "update", { title: "hijack", expectedRevision: 1,
    configuration: run.configuration }, caller), /Operator/);
  const artifact = await call("analysis", "artifact-save", { runId: run.id, artifact: {
    relativePath: "report.md", content: "fixed evidence"
  } }, caller);
  assert.equal(artifact.status, "registered");
  call("analysis", "run-report", { runId: run.id, result: report(run) }, caller);
  terminal(run);
  const second = call("analysis", "run", { trigger: { source: "manual", key: "two" } }).run;
  assert.equal(second.attempts[0].recipient.roleName, role.name);
  assert.equal(store.getGlobalRoleSessionSet(role.name).sessions[f.agent.id].nativeSessionId, "session-one");
  deliver(second);
  call("analysis", "run-claim", { runId: second.id }, caller);
  terminal(second);
  const observed = call("analysis", "run-confirm", { runId: second.id });
  assert.equal(observed.status, "running", "native completion is not business success");
  assert.equal(observed.businessResult, undefined);
  assert.equal(observed.attempts[0].terminal.status, "completed");
  assert.throws(() => call("analysis", "session-new", { expectedSessionId: "session-one" }), /proven stopped/);
  const set = store.getGlobalRoleSessionSet(role.name);
  f.saveSet({ ...set, sessions: { [f.agent.id]: { ...set.sessions[f.agent.id], status: "ended", endReason: "stopped" } } });
  call("analysis", "session-new", { expectedSessionId: "session-one" });
  assert.ok(Object.keys(store.getGlobalRoleSessionSet(role.name).history).length);
  const successor = session(role, "session-two");
  assert.throws(() => call("analysis", "run-context", { runId: second.id }, caller), /current managed/);
  const context = call("analysis", "run-context", { runId: second.id }, successor);
  assert.equal(context.configuration.input, "Saved durable requirements.");
  assert.equal(context.history[0].result.outcome, "succeeded");
  assert.equal((await call("analysis", "artifact-read", { runId: run.id, reference: artifact.reference }, successor)).content, "fixed evidence");
  assert.throws(() => call("analysis", "run-report", { runId: second.id, result: report(second) }, successor), /accepted native Turn/);
  const continueInput = { runId: second.id, expectedAttemptId: observed.attempts.at(-1).execution.attemptId };
  const continued = call("analysis", "run-continue", continueInput);
  assert.equal(call("analysis", "run-continue", continueInput).attempts.length, 2);
  assert.equal(continued.id, second.id);
  assert.equal(continued.attempts.length, 2);
  deliver(continued);
  call("analysis", "run-claim", { runId: second.id }, successor);
  call("analysis", "run-report", { runId: second.id, result: report(second) }, successor);
  assert.equal(call("analysis", "run-continue", continueInput).attempts.length, 2);
  assert.throws(() => call("analysis", "run-report", { runId: run.id, result: report(run, "failed") }, successor), /original Job message|own/);
  assert.equal(store.listAgentJobRuns({ kind: "global" }, "analysis").length, 2);
});

test("shared Operator/Task targets keep their authority, exact native input and cooperative cancellation", t => {
  const f = fixture(t);
  const { store, call, session, deliver, terminal, report } = f;
  const operator = createGlobalRole("operator", [createRoleAgentBinding(f.agent)], f.agent.id, f.home, f.now);
  store.createGlobalRoleIfAbsent(operator);
  const operatorCaller = session(operator, "operator-one");
  call("coordination", "define", { title: "Coordinate", configuration: {
    kind: "agent", target: { kind: "operator" }, input: "Coordinate only."
  } });
  const run = call("coordination", "run", { trigger: { source: "manual", key: "op" } }).run;
  deliver(run);
  call("coordination", "run-claim", { runId: run.id }, operatorCaller);
  call("coordination", "run-cancel", { runId: run.id });
  const before = store.getGlobalRoleSessionSet("operator").providerBinding;
  assert.equal(before.run.status, "accepted");
  assert.ok(call("coordination", "run-context", { runId: run.id }, operatorCaller).cancelRequestedAt);
  assert.throws(() => call("coordination", "run-continue", { runId: run.id }), /proven exact/);
  call("coordination", "run-report", { runId: run.id, result: report(run, "cancelled") }, operatorCaller);
  terminal(run);
  const task = activateTask(createTask("task-1", "Existing delivery", f.now), f.now);
  store.saveTask(task);
  const leader = createRole(task.id, "leader", [createRoleAgentBinding(f.agent)], f.agent.id, f.home, f.now);
  store.saveRole(task.id, leader);
  const taskCaller = session(leader, "task-one");
  call("task-call", "define", { title: "Task continuation", configuration: {
    kind: "agent", target: { kind: "task", taskId: task.id, roleName: "leader" }, input: "Only existing Task scope."
  } });
  const taskRun = call("task-call", "run", { trigger: { source: "manual", key: "task" } }).run;
  assert.throws(() => call("task-call", "run-claim", { runId: taskRun.id }, operatorCaller), /execution target/);
  deliver(taskRun);
  call("task-call", "run-claim", { runId: taskRun.id }, taskCaller);
  call("task-call", "run-report", { runId: taskRun.id, result: report(taskRun) }, taskCaller);
  store.saveTask(stopTaskExecution(task, new Date()));
  assert.throws(() => call("task-call", "run", { trigger: { source: "manual", key: "stopped" } }), /execution-enabled/);
  assert.throws(() => call("task-call", "run-claim", { runId: taskRun.id }, taskCaller), /execution-enabled/);
  assert.equal(store.listTasks().length, 1, "Agent execution creates no Task");
  assert.equal(store.listGlobalJobRuns().length, 0, "Agent execution creates no fabricated shell Run");
});

test("isolated Job calls fence sibling results and preserve unknown delivery without replay", t => {
  const f = fixture(t);
  const { call, store, session, deliver, terminal, report, setFor } = f;
  call("parallel", "define", { title: "Independent calls", configuration: {
    kind: "agent", target: { kind: "job", agentId: f.agent.id }, concurrency: "isolated", input: "Independent input."
  } });
  const first = call("parallel", "run", { trigger: { source: "manual", key: "a" } }).run;
  const second = call("parallel", "run", { trigger: { source: "manual", key: "b" } }).run;
  assert.notEqual(first.attempts[0].recipient.roleName, second.attempts[0].recipient.roleName);
  const caller = session(store.getGlobalRole(first.attempts[0].recipient.roleName), "isolated-a");
  assert.throws(() => call("parallel", "run-context", { runId: second.id }, caller), /not found/);
  deliver(first);
  recordJobAgentObservation(store, first.attempts[0].recipient, setFor(first.attempts[0].recipient).providerBinding, new Date());
  assert.ok(store.getAgentJobRun(first.id).attempts[0].execution);
  assert.equal(store.getAgentJobRun(first.id).businessResult, undefined);
  terminal(first);
  recordJobAgentObservation(store, first.attempts[0].recipient, setFor(first.attempts[0].recipient).providerBinding, new Date());
  assert.equal(store.getAgentJobRun(first.id).attempts[0].terminal.status, "completed");
  assert.equal(store.getAgentJobRun(first.id).businessResult, undefined);
  const continued = call("parallel", "run-continue", { runId: first.id,
    expectedAttemptId: store.getAgentJobRun(first.id).attempts.at(-1).execution.attemptId });
  const set = setFor(first.attempts[0].recipient);
  const pending = beginProviderTurn(set.providerBinding, { attemptId: "unknown", authorityEpoch: set.providerBinding.authority.epoch,
    submittedAt: new Date().toISOString(), input: { kind: "message", roleName: first.attempts[0].recipient.roleName,
      messageId: continued.attempts.at(-1).messageId } });
  f.saveSet({ ...set, providerBinding: { ...pending, run: { ...pending.run, status: "delivery-unknown" } } });
  assert.equal(call("parallel", "run-confirm", { runId: first.id }).status, "unknown-needs-attention");
  assert.throws(() => call("parallel", "run-continue", { runId: first.id }), /proven exact/);
  assert.throws(() => call("parallel", "session-new", { runId: first.id, expectedSessionId: "isolated-a" }), /proven stopped/);
  assert.throws(() => call("parallel", "run-report", { runId: first.id, result: report(first) }, caller), /accepted native Turn/);
  assert.equal(store.getAgentJobRun(first.id).attempts.length, 2);
});

test("classified Provider recovery remains the sole retry owner and retains exact Job attempts", t => {
  const f = fixture(t);
  f.call("recover", "define", { title: "Recovery", configuration: {
    kind: "agent", target: { kind: "job", agentId: f.agent.id }, input: "Continue existing work."
  } });
  const run = f.call("recover", "run", { trigger: { source: "manual", key: "one" } }).run;
  const recipient = run.attempts[0].recipient;
  const caller = f.session(f.store.getGlobalRole(recipient.roleName), "retry-session");
  f.deliver(run);
  f.call("recover", "run-claim", { runId: run.id }, caller);
  const set = f.setFor(recipient);
  const at = Date.now();
  let binding = settleProviderTurn(set.providerBinding, { attemptId: set.providerBinding.run.attemptId,
    nativeTurnId: set.providerBinding.run.nativeTurnId, status: "failed", settledAt: new Date(at).toISOString() });
  binding = recordProviderFailure({ ...binding, run: { ...binding.run, retrySupported: true } }, {
    error: { source: "provider", phase: "turn-execute", category: "rate-limit", code: "provider.rate-limit",
      message: "Retryable fixture", raw: "deterministic rate limit",
      inputDisposition: "accepted", sessionDisposition: "recoverable", retryable: true },
    failureRef: "fixture", at, random: () => 0
  });
  f.saveSet({ ...set, providerBinding: binding });
  recordJobAgentObservation(f.store, recipient, binding, new Date(at));
  assert.throws(() => f.call("recover", "run-continue", { runId: run.id }), /bounded Provider recovery/);
  const due = Date.parse(binding.retry.nextEligibleAt);
  binding = admitProviderRetry(binding, { attemptId: "retry", at: due });
  binding = beginProviderTurn(binding, { attemptId: "retry", authorityEpoch: binding.authority.epoch,
    submittedAt: new Date(due).toISOString(), retrySupported: true });
  binding = acceptProviderTurn(binding, { attemptId: "retry", nativeTurnId: "retry-turn", acceptedAt: new Date(due).toISOString() });
  f.saveSet({ ...set, providerBinding: binding });
  recordJobAgentObservation(f.store, recipient, binding, new Date(due));
  const observed = f.store.getAgentJobRun(run.id);
  assert.equal(observed.attempts.length, 2);
  assert.equal(observed.attempts[0].terminal.status, "failed");
  assert.equal(observed.attempts[1].messageId, observed.attempts[0].messageId);
  assert.equal(observed.attempts[1].execution.nativeTurnId, "retry-turn");
  assert.equal(observed.businessResult, undefined);
});

test("existing Worker Assignment uses its real message continuation without acquiring another workspace", t => {
  const f = fixture(t);
  const { store, call, now, home, agent } = f;
  store.saveTask(activateTask(createTask("task-1", "Existing Assignment", now, { cwd: home }), now));
  store.saveManagedWorkspace(createManagedWorkspace({ owner: { type: "task", taskId: "task-1" }, root: home, entries: [] }, now));
  for (const name of ["leader", "worker"]) store.saveRole("task-1",
    createRole("task-1", name, [createRoleAgentBinding(agent)], agent.id, home, now));
  const command = args => runTaskCommand(args, store, { now: () => now, environment: {} });
  command(["work", "create", "task-1", "Original work", "--role", "worker"]);
  command(["work", "dispatch", "task-1/work-item-1"]);
  const original = store.getActiveRun("task-1", "worker");
  const caller = f.session(store.getRole("task-1", "worker"), "worker-native");
  const recipient = { scope: "task", taskId: "task-1", roleName: "worker" };
  const set = f.setFor(recipient);
  f.saveSet({ ...set, sessions: { ...set.sessions,
    [agent.id]: { ...set.sessions[agent.id], effective: original.effective } } });
  store.saveRun(failRun(original, "runtime-failed", "Known prior terminal", now, {
    providerNamespace: "openai/codex", accountScope: "fixture", conversationId: "worker-native",
    nativeTurnId: "old", status: "failed"
  }));
  store.clearActiveRun("task-1", "worker");
  call("worker-call", "define", { title: "Continue assigned work", configuration: {
    kind: "agent", target: { kind: "task", taskId: "task-1", roleName: "worker", ownerRunId: original.id },
    input: "Work only in the original Assignment."
  } });
  const run = call("worker-call", "run", { trigger: { source: "manual", key: "one" } }).run;
  prepareMessageContinuations(store, "task-1", new Date(), "worker");
  const continuation = store.getActiveRun("task-1", "worker");
  assert.ok(continuation);
  assert.equal(continuation.workItemId, original.workItemId);
  assert.deepEqual(continuation.effective, original.effective);
  const current = f.setFor(recipient);
  const started = beginProviderTurn(current.providerBinding, { attemptId: "assignment", authorityEpoch: 1,
    submittedAt: new Date().toISOString(), input: { kind: "run", taskId: "task-1", runId: continuation.id } });
  f.saveSet({ ...current, providerBinding: acceptProviderTurn(started, {
    attemptId: "assignment", nativeTurnId: "assignment-turn", acceptedAt: new Date().toISOString()
  }) });
  call("worker-call", "run-claim", { runId: run.id }, caller);
  call("worker-call", "run-report", { runId: run.id, result: f.report(run) }, caller);
  assert.equal(store.getAgentJobRun(run.id).businessResult.outcome, "succeeded");
  assert.throws(() => call("worker-call", "run", { trigger: { source: "manual", key: "escape" } }, caller), /Operator/);
});

test("Task-owned Job business settlement and native quiescence remain independent lifecycle boundaries", t => {
  const f = fixture(t);
  const task = activateTask(createTask("task-1", "Owned Agent Job", f.now), f.now);
  f.store.saveTask(task);
  const leader = createRole(task.id, "leader", [createRoleAgentBinding(f.agent)], f.agent.id, f.home, f.now);
  f.store.saveRole(task.id, leader);
  const manager = f.session(leader, "task-manager");
  const scope = { kind: "task", taskId: task.id };
  const call = (op, extra = {}, caller = manager) => f.call("owned", op, extra, caller, scope);
  const definition = { title: "Owned Job", configuration: {
    kind: "agent", target: { kind: "job", agentId: f.agent.id }, input: "Only this Job's work."
  } };
  const set = f.store.getTaskRoleSessionSet(task.id, "leader");
  const readOnlySet = { ...set, sessions: { ...set.sessions, [f.agent.id]: {
    ...set.sessions[f.agent.id], effective: { ...set.sessions[f.agent.id].effective, profileAccess: "read" }
  } } };
  f.store.saveTaskRoleSessionSet(readOnlySet);
  assert.throws(() => call("define", definition), /writable delivery/);
  f.store.saveTaskRoleSessionSet(set);
  call("define", definition);
  const run = call("run", { trigger: { source: "manual", key: "one" } }).run;
  f.store.saveTaskRoleSessionSet(readOnlySet);
  assert.equal(call("run-get", { runId: run.id }).id, run.id);
  assert.throws(() => call("run-cancel", { runId: run.id }), /writable delivery/);
  f.store.saveTaskRoleSessionSet(set);
  const resource = `job:${task.id}/${run.id}`;
  assert.ok(projectCompletionReadiness(f.store.readCompletionReadinessFacts(task.id)).blockers.some(blocker => blocker.ref.id === run.id));
  assert.ok(archiveSettlementChecks(f.store, task).some(check => check.resource === resource));
  const caller = f.session(f.store.getGlobalRole(run.attempts[0].recipient.roleName), "owned-native");
  f.deliver(run);
  call("run-claim", { runId: run.id }, caller);
  call("run-report", { runId: run.id, result: f.report(run) }, caller);
  assert.equal(archiveSettlementChecks(f.store, task).some(check => check.resource === resource), false);
  assert.ok(archiveExecutionChecks(f.store, task.id).some(check => check.resource === resource));
  f.terminal(run);
  call("run-confirm", { runId: run.id });
  assert.equal(archiveExecutionChecks(f.store, task.id).some(check => check.resource === resource), false);
});
