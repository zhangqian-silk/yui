import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { appendRunInput, completeRun, createRun, failRun, runInputEnvelope, validateRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput, serializeRunInputEnvelope } from "../../dist/context/runInputContract.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { contextContentDigest, contextSnapshotRef, createContextSnapshot } from "../../dist/context/contextSnapshot.js";
import { buildRunContextPack, buildRunContextDelta, expandRunContextRef, freezeRunContextSnapshot } from "../../dist/context/runContextPack.js";
import { readDispatchContextRefs, runTaskCommand } from "../../dist/commands/taskCommands.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";
import { createFixtureRun } from "../helpers/runFixture.mjs";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { processActiveRoleRunDeliveries } from "../../dist/scheduler/activeRoleRunDelivery.js";
import { findCommandNode } from "../../dist/cli/commandCatalog.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { readDocument } from "../helpers/read-document.js";
import { createReviewRound, createTaskReviewRound } from "../../dist/review/reviewRound.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { prepareMessageContinuations } from "../../dist/message/messageContinuation.js";
import { addProjectKnowledge, createProject, retireProjectKnowledge } from "../../dist/repository/project.js";
import { createIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";

test("managed dispatch freezes explicit materials and candidate reports; continuation preserves their exact evidence", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-dispatch-evidence-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-09-17T00:00:00Z");
  const later = new Date(now.getTime() + 1000);
  let project = addProjectKnowledge(createProject("project-1", "Fixture", join(home, "project"),
    { stable: "main", development: "main" }, now), "knowledge-1", "Applicable rule", "Original rule",
    now, undefined, { scope: "Review and implementation", expiresWhen: "After explicit replacement" });
  project = retireProjectKnowledge(addProjectKnowledge(project, "knowledge-2", "Old rule", "Retired",
    now), "knowledge-2", now);
  store.saveProject(project);
  const task = activateTask(createTask("task-1", "Reliable handoff", now, {
    cwd: home, projectBindings: [{ projectId: "project-1", directory: "project",
      baseRef: "main", baseCommit: "b".repeat(40), currentCommit: "b".repeat(40) }]
  }), now);
  store.saveTask(task);
  const projectEntry = root => ({
    projectId: "project-1", directory: "project", access: "read",
    path: join(root, "project"), branch: "fixture", baseRef: "main", baseCommit: "b".repeat(40)
  });
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id }, root: home,
    entries: [{ ...projectEntry(home), access: "write" }]
  }, now));
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  for (const name of ["worker", "reviewer", "reader"]) {
    store.saveRole(task.id, createRole(task.id, name, [binding], binding.agentId, home, now));
  }
  const command = args => runTaskCommand(args, store, { now: () => later, environment: {} });
  const message = createTaskMessage("message-1", task.id, "Original bounded requirement", "user", { type: "user" }, now);
  store.saveMessage(task.id, message);
  command(["work", "create", task.id, "Bounded repair", "--role", "worker"]);
  const workerRoot = join(home, "work-1");
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "work-item", taskId: task.id, workItemId: "work-item-1" },
    root: workerRoot, entries: [projectEntry(workerRoot)]
  }, now));
  const selector = `task-message/${message.id}@${contextContentDigest(message)}`;
  for (const invalid of [
    `task-message/missing@${contextContentDigest(message)}`,
    `task-message/${message.id}@${"0".repeat(64)}`,
    `task/${task.id}@${"0".repeat(64)}`,
    `task-message/task-2/message-1@${contextContentDigest(message)}`
  ]) {
    assert.throws(() => command(["work", "dispatch", `${task.id}/work-item-1`,
      "--context-ref", invalid]), /Required Context.*cannot be frozen/);
    assert.deepEqual(store.listRuns(task.id), []);
  }
  command(["work", "dispatch", `${task.id}/work-item-1`, "--context-ref", selector]);
  const worker = store.getActiveRun(task.id, "worker");
  const knowledgePointer = buildRunContextPack(store, task.id, worker.id).pointers
    .find(ref => ref.store === "project-knowledge");
  assert.match(knowledgePointer.summary, /Review and implementation/);
  assert.equal(expandRunContextRef(store, task.id, worker.id, "project-1:knowledge-1", "project-knowledge").value.version, 1);
  assert.equal(buildRunContextPack(store, task.id, worker.id).pointers
    .some(ref => ref.refId === "project-1:knowledge-2"), false);
  store.saveProject(retireProjectKnowledge(project, "knowledge-1", later));
  assert.equal(expandRunContextRef(store, task.id, worker.id, "project-1:knowledge-1", "project-knowledge").value.status,
    "active", "retirement changes future selection, not an existing Run's frozen evidence");
  assert.equal(expandRunContextRef(store, task.id, worker.id, message.id, "task-message").value.body,
    message.body);
  store.updateMessage(task.id, { ...message, body: "Later revision must not leak" });
  assert.equal(expandRunContextRef(store, task.id, worker.id, message.id, "task-message").value.body,
    message.body);
  const session = recordRoleAgentSession(createRoleSessionSet({
    scope: "task", taskId: task.id, roleName: "worker"
  }, binding.agentId, now), {
    agentId: binding.agentId, adapterId: binding.adapterId, nativeSessionId: "worker-native",
    policy: "fixed", status: "active", effective: worker.effective
  }, now);
  store.saveTaskRoleSessionSet(session);
  const workerEnv = {
    YUI_SESSION_SCOPE: "task", YUI_TASK_ID: task.id, YUI_ROLE: "worker",
    YUI_NATIVE_SESSION_ID: "worker-native", YUI_WORKSPACE: workerRoot
  };
  const privateMessage = createTaskMessage("message-2", task.id, "Private other-role evidence", "system", { type: "system" }, now);
  store.saveMessage(task.id, privateMessage);
  assert.throws(() => readDispatchContextRefs(store, task.id,
    [`task-message/${privateMessage.id}@${contextContentDigest(privateMessage)}`], workerEnv),
  /current scope|Assignment/);
  const report = "Original report😀\n".repeat(2400);
  store.saveRun(completeRun(worker, report, later));
  store.clearActiveRun(task.id, "worker");
  runTaskCommand(["work", "update", `${task.id}/work-item-1`, "done", "--summary", "Capture original result"],
    store, { now: () => later, environment: {}, candidateGitSnapshot: {
      schemaVersion: 1, reviewBaseCommit: "b".repeat(40),
      projects: [{ projectId: "project-1", commit: "b".repeat(40) }]
    } });
  const candidate = store.getWorkItem(task.id, "work-item-1").candidates.at(-1);
  const resultMessage = createTaskMessage("message-3", task.id, "Original execution result", "role-result",
    { type: "role", roleName: "worker" }, later, {
      runId: worker.id, resultRef: { type: "agent-run-result", runId: worker.id }
    });
  store.saveMessage(task.id, resultMessage);
  command(["work", "create", task.id, "Read selected evidence", "--role", "reader"]);
  const readerRoot = join(home, "work-2");
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "work-item", taskId: task.id, workItemId: "work-item-2" },
    root: readerRoot, entries: [projectEntry(readerRoot)]
  }, now));
  const dispatchedTask = store.getTask(task.id);
  command(["work", "dispatch", `${task.id}/work-item-2`, "--context-ref",
    `task-message/${resultMessage.id}@${contextContentDigest(resultMessage)}`,
    "--context-ref", `task/${task.id}@${contextContentDigest(dispatchedTask)}`]);
  const reader = store.getActiveRun(task.id, "reader");
  assert.equal(expandRunContextRef(store, task.id, reader.id, worker.id, "source-run").value.result.output, report);
  store.saveRun(failRun(reader, "runtime-failed", "Temporary provider failure", later));
  store.clearActiveRun(task.id, "reader");
  store.updateMessage(task.id, { ...resultMessage, body: "Changed after dispatch" });
  store.saveTask({ ...store.getTask(task.id), title: "Renamed after dispatch" });
  command(["run", "retry", `${task.id}/${reader.id}`]);
  const retriedReader = store.getActiveRun(task.id, "reader");
  assert.equal(expandRunContextRef(store, task.id, retriedReader.id, task.id,
    "task").value.title, dispatchedTask.title);
  assert.equal(expandRunContextRef(store, task.id, retriedReader.id, resultMessage.id,
    "task-message").value.body, resultMessage.body);
  assert.equal(expandRunContextRef(store, task.id, retriedReader.id, worker.id,
    "source-run").value.result.output, report);
  const round = createReviewRound("review-round-1", task.id, candidate.workItemId, candidate.id,
    "reviewer", "leader", "b".repeat(40), later);
  store.saveReviewRound(task.id, round);
  const reviewWorkspace = createManagedWorkspace({
    owner: { type: "review-round", taskId: task.id, reviewRoundId: round.id },
    root: join(home, "review"), entries: [{
      projectId: "project-1", directory: "project", access: "write",
      path: join(home, "review", "project"), branch: "review-fixture",
      baseRef: "b".repeat(40), baseCommit: "b".repeat(40)
    }]
  }, later);
  const reviewContract = { taskId: task.id, roleName: "reviewer", purpose: "review",
    workItemId: candidate.workItemId, reviewRoundId: round.id, workspace: reviewWorkspace };
  const snapshot = freezeRunContextSnapshot(store, reviewContract, later);
  const review = createRun(store.nextRunId(task.id), task.id, "reviewer", "new", createRunInput({
    source: { type: "yui", channel: "workitem-dispatch" },
    contextSnapshotRef: contextSnapshotRef(snapshot), deltaRefIds: []
  }), later, { purpose: "review", workItemId: candidate.workItemId, reviewRoundId: round.id,
    workspace: reviewWorkspace,
    effective: resolveEffectiveLaunch({ role: store.getRole(task.id, "reviewer"), purpose: "review",
      workspace: reviewWorkspace, reviewRoundId: round.id, reviewBaseCommit: round.reviewBaseCommit }) });
  store.saveRun(review);
  const expanded = readDocument(cursor => command(["run", "context", "expand",
    `${task.id}/${review.id}`, worker.id, "--store", "source-run",
    ...(cursor === undefined ? [] : ["--cursor", cursor])]).data.context);
  assert.equal(expanded.value.result.output, report);
  assert.equal(expanded.ref.evidenceOf, `${candidate.workItemId}/${candidate.id}`);
  const completed = store.getRun(task.id, worker.id);
  store.saveRun({ ...completed, result: { ...completed.result, output: "Drifted report" } });
  assert.throws(() => freezeRunContextSnapshot(store, reviewContract, later), /source\/report drifted/);
  assert.equal(expandRunContextRef(store, task.id, review.id, worker.id, "source-run").value.result.output, report);
  store.saveRun(completed);
  store.saveWorkItem(task.id, { ...store.getWorkItem(task.id, candidate.workItemId),
    candidates: [{ ...candidate, source: { type: "run", runId: "run-999" } }] });
  assert.throws(() => freezeRunContextSnapshot(store, reviewContract, later), /source\/report drifted/);
  store.saveWorkItem(task.id, { ...store.getWorkItem(task.id, candidate.workItemId), candidates: [candidate] });
  const finalRound = createTaskReviewRound("review-round-2", task.id, "reviewer", "leader", {
    schemaVersion: 1, projects: [{ projectId: "project-1", commit: "b".repeat(40) }]
  }, later);
  store.saveReviewRound(task.id, finalRound);
  const finalContext = { ...reviewContract, workItemId: undefined, reviewRoundId: finalRound.id };
  assert.equal(freezeRunContextSnapshot(store, finalContext, later).resources
    .find(({ ref }) => ref.store === "source-run").value.result.output, report);
  const integration = createIntegrationAttempt({
    id: "integration-1", taskId: task.id, projectId: "project-1", targetRef: "fixture",
    beforeCommit: "a".repeat(40), source: { kind: "work-item",
      workItemId: candidate.workItemId, startCommit: "a".repeat(40),
      resultCommit: "b".repeat(40), strategy: "ff" }
  }, later);
  const endedAt = later.toISOString();
  store.saveIntegrationAttempt(task.id, { ...integration, status: "committed",
    candidateCommit: "d".repeat(40), afterCommit: "d".repeat(40), summary: "Integrated", endedAt });
  store.saveReviewRound(task.id, { ...finalRound, taskCandidate: {
    schemaVersion: 1, projects: [{ projectId: "project-1", commit: "d".repeat(40) }]
  }, reviewBaseCommit: "d".repeat(40) });
  assert.equal(freezeRunContextSnapshot(store, finalContext, later).resources
    .find(({ ref }) => ref.store === "source-run").value.result.output, report,
  "The exact integrated head carries the report of its named source Candidate.");
  store.saveReviewRound(task.id, { ...finalRound, taskCandidate: {
    schemaVersion: 1, projects: [{ projectId: "project-1", commit: "c".repeat(40) }]
  }, reviewBaseCommit: "c".repeat(40) });
  assert.equal(freezeRunContextSnapshot(store, finalContext, later).resources
    .some(({ ref }) => ref.store === "source-run"), false,
  "An unrelated Task head must not inherit the Candidate's validation report.");
  // Older attempts on this same branch and attempts on other targets are not
  // proof of this head. Both used to leak the old producer's report.
  store.saveIntegrationAttempt(task.id, { ...integration, id: "integration-2",
    status: "committed", beforeCommit: "e".repeat(40), endedAt,
    candidateCommit: "c".repeat(40), afterCommit: "c".repeat(40), summary: "Other source",
    source: { kind: "upstream", branch: "upstream", remoteCommit: "c".repeat(40),
      taskBaseCommit: "e".repeat(40), strategy: "rebase" } });
  assert.equal(freezeRunContextSnapshot(store, finalContext, later).resources
    .some(({ ref }) => ref.store === "source-run"), false);
  store.saveIntegrationAttempt(task.id, { ...integration, id: "integration-3",
    targetRef: "other-target", status: "committed", endedAt,
    candidateCommit: "c".repeat(40), afterCommit: "c".repeat(40), summary: "Other target" });
  const unmatched = freezeRunContextSnapshot(store, finalContext, later);
  assert.equal(unmatched.resources.some(({ ref }) => ref.store === "source-run"), false);
  assert.match(unmatched.refs.find(ref => ref.store === "review-round").summary, /evidence gap/i);
  store.saveReviewRound(task.id, finalRound);
  assert.equal(freezeRunContextSnapshot(store, finalContext, later).resources
    .find(({ ref }) => ref.store === "source-run").value.result.output, report,
  "An exact Candidate head remains readable even when unrelated attempts exist.");

  // The supported scoped continuation copies the same Assignment, including
  // its explicit materials, rather than re-reading today's edited Message.
  store.saveEvent(task.id, createTaskEvent(store.nextEventId(task.id), task.id, "run.session-prepared",
    { runId: worker.id, roleName: "worker", nativeSessionId: "worker-native" }, now));
  command(["message", "send", task.id, "Clarify the same requirement",
    "--to", "worker", "--work-item", candidate.workItemId]);
  prepareMessageContinuations(store, task.id, later, "worker");
  const continued = store.getActiveRun(task.id, "worker");
  assert.ok(continued);
  assert.deepEqual(continued.effective, worker.effective);
  assert.equal(expandRunContextRef(store, task.id, continued.id, message.id, "task-message").value.body,
    message.body);

  store.saveManagedWorkspace(reviewWorkspace);
  store.saveRun(completeRun(review, "Original review result", later));
  store.saveReviewRound(task.id, { ...round, workspace: reviewWorkspace,
    reviewerRunId: review.id, status: "completed", endedAt: later.toISOString() });
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet({
    scope: "task", taskId: task.id, roleName: "reviewer"
  }, binding.agentId, later), {
    agentId: binding.agentId, adapterId: binding.adapterId, nativeSessionId: "review-native",
    policy: "fixed", status: "active", effective: review.effective
  }, later));
  store.saveEvent(task.id, createTaskEvent(store.nextEventId(task.id), task.id, "run.session-prepared",
    { runId: review.id, roleName: "reviewer", nativeSessionId: "review-native" }, later));
  command(["message", "send", task.id, "Clarify the same frozen review",
    "--to", "reviewer", "--work-item", candidate.workItemId, "--review-round", round.id]);
  prepareMessageContinuations(store, task.id, later, "reviewer");
  const reviewContinuation = store.getActiveRun(task.id, "reviewer");
  assert.ok(reviewContinuation);
  assert.equal(expandRunContextRef(store, task.id, reviewContinuation.id, worker.id, "source-run")
    .value.result.output, report);
  assert.equal(expandRunContextRef(store, task.id, reviewContinuation.id, review.id, "source-run")
    .value.result.output, "Original review result");
});

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
  const originalReport = "Exact selected Producer result😀\n".repeat(1200);
  const resources = [
    ["task", task.id, task],
    ["task-brief", task.id, { objective: "The original objective" }],
    ["source-run", "run-source", { result: { output: originalReport } }]
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
  const initialPack = buildRunContextPack(store, task.id, run.id);
  assert.deepEqual(runTaskCommand(["run", "context", "delta", `${task.id}/${run.id}`,
    "--after", initialPack.snapshot.digest], store, { environment: sanitizedTestEnv() }).data.contextDelta.refs, []);
  const expandedReport = readDocument(cursor => runTaskCommand([
    "run", "context", "expand", `${task.id}/${run.id}`, "run-source", "--store", "source-run",
    ...(cursor === undefined ? [] : ["--cursor", cursor])
  ], store, { environment: sanitizedTestEnv() }).data.context);
  assert.equal(expandedReport.value.result.output, originalReport);
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
    originalReport);
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
  const invalid = { ...run, id: "run-2", inputs: [{ ...run.inputs[0], input: createRunInput(missing) }] };
  assert.equal(validateRun(invalid), invalid);
  store.saveRun(invalid);
  assert.deepEqual(store.getRun(task.id, invalid.id), invalid,
    "Incomplete execution evidence remains readable for supervision.");
  assert.throws(() => runInputEnvelope(invalid), /Context Snapshot.*required/i);
  const continued = appendRunInput(run, createRunInput(missing), now);
  store.saveRun(continued);
  assert.equal(store.getRun(task.id, run.id).inputs.length, 2);
  assert.equal(runInputEnvelope(continued, 2).contextSnapshotRef, undefined,
    "Subsequent input does not establish a new Assignment.");
  assert.throws(() => serializeRunInputEnvelope({
    protocol: "yui-run/v1", runId: invalid.id, roleName: role.name, purpose: "execution",
    subject: { taskId: task.id }, source: input.source, deltaRefIds: []
  }), /Context Snapshot.*required/i);
  store.databaseHandle().prepare("UPDATE turns SET payload=json_remove(payload,'$.inputs[0].input.contextSnapshotRef')").run();
  assert.equal(store.getRun(task.id, run.id).inputs[0].input.contextSnapshotRef, undefined,
    "Missing execution evidence must not prevent inspection of the Run.");
});

test("missing Snapshot fails only its execution; supervision can retire and explicitly retry from current facts", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-missing-run-snapshot-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-09-17T00:00:00Z");
  const task = activateTask(createTask("task-1", "Keep original execution evidence", now,
    { cwd: home }), now);
  store.saveTask(task);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id }, root: home, entries: []
  }, now));
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "leader", [binding], binding.agentId, home, now);
  store.saveRole(task.id, role);
  const run = createFixtureRun(store, store.nextRunId(task.id), task.id, role.name, "new", createRunInput({
    source: { type: "yui", channel: "task-dispatch" }, directive: "Original intent", deltaRefIds: []
  }), now, { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) });
  store.saveActiveRun(run);
  const adapter = new FileSchedulerStoreAdapter(store);
  const originalGetSnapshot = store.getContextSnapshot.bind(store);
  store.getContextSnapshot = () => null;
  const outcomes = await processActiveRoleRunDeliveries(adapter, {
    prepareRoleSession: async () => assert.fail("Missing evidence must fail before Provider preparation")
  }, now);
  assert.equal(outcomes[0].status, "failed");
  assert.match(outcomes[0].error, /Context Snapshot is missing/i);
  assert.deepEqual(store.getRun(task.id, run.id).inputs, run.inputs);
  const options = { now: () => now, environment: sanitizedTestEnv() };
  store.getContextSnapshot = originalGetSnapshot;
  // Missing reference is also an operational failure, not a reason to reject
  // the entire Home or hide the record from Leader/Operator.
  store.databaseHandle().prepare("UPDATE turns SET payload=json_remove(payload,'$.inputs[0].input.contextSnapshotRef')").run();
  const original = store.getRun(task.id, run.id);
  assert.ok(runTaskCommand(["run", "show", `${task.id}/${run.id}`], store, options));
  store.validateCurrentRecords();
  runTaskCommand(["run", "retire", `${task.id}/${run.id}`, "--reason", "Evidence unavailable",
    "--expected-progress-at", now.toISOString()], store, options);
  assert.equal(store.listEvents(task.id).find(event => event.type === "run.retired").payload.expectedProgressAt,
    now.toISOString(), "The current retirement argument preserves the exact recorded fence.");
  runTaskCommand(["run", "retry", `${task.id}/${run.id}`], store, options);
  const successor = store.getActiveRun(task.id, role.name);
  assert.notEqual(successor.id, run.id);
  assert.ok(buildRunContextPack(store, task.id, successor.id).snapshot);
  assert.deepEqual(store.getRun(task.id, run.id), original, "Retry never rewrites missing original evidence.");
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
