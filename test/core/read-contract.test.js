import assert from "node:assert/strict";
import test from "node:test";
import { boundedDocument, recordPage, encodeReadCursor, readDigest } from "../../dist/output/boundedRead.js";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { readTaskContext, listTaskContext, inspectTaskContext } from "../../dist/context/taskContext.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runOperatorCommand } from "../../dist/commands/operatorCommands.js";
import { readCommandText } from "../../dist/commands/textInput.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { readDocument } from "../helpers/read-document.js";
import { createTaskWake } from "../../dist/scheduler/taskWake.js";
import { runContextEntry, runContextPointerPage } from "../../dist/context/runContextPack.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createRoleSessionSet, recordRoleAgentSession, bindTaskRoleProviderRuntime } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createFixtureRun } from "../helpers/runFixture.mjs";
import { completeRun } from "../../dist/agentRun/agentRun.js";
import { createProviderRuntimeBinding, beginProviderTurn, acceptProviderTurn, settleProviderTurn } from "../../dist/runtime/providerRuntimeIdentity.js";
import { recordProviderFailure, admitProviderRetry } from "../../dist/runtime/providerRetry.js";

test("submission receipts identify exact saved UTF-8 body without another body read", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-submission-body-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-11-03T00:00:00Z");
  store.saveTask(createTask("task-1", "Body transport", now));
  const body = "  原文😀\r\n{\"nested\":\"$HOME `literal`\", \"n\":1}\n";
  const payloadFile = join(home, "payload.txt");
  const submit = text => {
    writeFileSync(payloadFile, text);
    return runOperatorCommand(["submit", "--body-file", payloadFile, "--task", "task-1",
      "--intent", "record", "--request-id", "body-key"], store,
    { environment: {}, now: () => now }).data;
  };
  const receipt = submit(body).message;
  assert.equal(readCommandText(undefined, payloadFile, "--summary", "usage"), body.trim(),
    "Summary/file normalization is outside the exact body transport change");
  assert.equal(readCommandText("  inline  ", undefined, "--body", "usage",
    { preserveFileWhitespace: true }), "inline", "Inline body behavior remains unchanged");
  const saved = store.listMessages("task-1").find(message => message.id === receipt.id);
  const expected = "f3dff3a07242b12792cb67438328629118f08665972cafa8c327dcf9c1b5efac";
  assert.equal(saved.body, body);
  assert.equal(receipt.bodySha256, expected);
  assert.equal(receipt.bodyBytes, Buffer.byteLength(body, "utf8"));
  assert.equal(receipt.digest, readDigest(saved), "Record identity remains separate from body bytes");
  assert.equal(receipt.body, undefined, "Receipt does not re-expand the original");
  assert.equal(submit(body).message.bodySha256, expected);
  assert.equal(store.listMessages("task-1").length, 1, "Idempotent receipt is not a new effect");
  assert.throws(() => submit(body.trim()), /conflict|different|key/i);
  assert.equal(runTaskCommand(["message", "show", `task-1/${receipt.id}`], store).data.body, body);
  const receiptFile = join(home, "receipt.json");
  writeFileSync(receiptFile, JSON.stringify({ ok: true, data: { taskId: "task-1", message: receipt } }));
  writeFileSync(payloadFile, body);
  const verify = (task = "task-1", key = "body-key") => spawnSync(process.execPath, [
    "skills/yui-operator/scripts/verify-submission.mjs",
    receiptFile, payloadFile, task, "record", key
  ], { encoding: "utf8" });
  const verified = verify();
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout), { ok: true, taskId: "task-1",
    messageId: receipt.id, intent: "record", submissionKey: "body-key",
    bodyBytes: Buffer.byteLength(body), bodySha256: expected });
  assert.notEqual(verify("task-other").status, 0, "Wrong target must not verify");
  assert.notEqual(verify("task-1", "other-key").status, 0, "Wrong operation must not verify");
  writeFileSync(payloadFile, body.trim());
  assert.notEqual(verify().status, 0, "Raw whitespace must participate in comparison");
  assert.equal(readFileSync(payloadFile, "utf8"), body.trim(), "Failure preserves evidence");
  writeFileSync(payloadFile, body);
  const { bodySha256: _checksum, ...withoutChecksum } = receipt;
  writeFileSync(receiptFile, JSON.stringify({ ok: true, data: { taskId: "task-1", message: withoutChecksum } }));
  assert.notEqual(verify().status, 0, "An absent checksum is unknown, not a match");
  assert.equal(store.listMessages("task-1").length, 1, "Local verification never submits or acknowledges");
  writeFileSync(payloadFile, " \r\n ");
  assert.throws(() => runOperatorCommand(["submit", "--body-file", payloadFile,
    "--task", "task-1", "--intent", "record"], store, { environment: {} }), /required/i);
});

test("result discovery reuses attributed author summaries without exposing report bodies or changing originals", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-context-summary-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-11-02T00:00:00Z");
  store.saveTask(createTask("task-1", "Result discovery", now));
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  const role = createRole("task-1", "worker", [createRoleAgentBinding(agent)], agent.id, home, now);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  const report = "Yui-Summary: Candidate ready; model benefit remains unknown.\n\n" + "Full report only in exact read.\n".repeat(200);
  const run = completeRun(createFixtureRun(store, "run-1", "task-1", "worker", "resume",
    { source: { type: "yui", channel: "task-dispatch" }, directive: "Inspect", deltaRefIds: [] },
    now, { effective }), report, now);
  store.saveRun(run);
  const message = createTaskMessage("message-1", "task-1", "Execution completed.", "role-result",
    { type: "role", roleName: "worker" }, now, { resultRef: { type: "agent-run-result", runId: run.id } });
  store.saveMessage("task-1", message);
  const revision = store.getStateRevision();
  const readResult = cursor => runTaskCommand(["run", "show", "task-1/run-1",
    "--view", "result", ...(cursor ? ["--cursor", cursor] : [])], store, { environment: {} }).data;
  const resultView = readDocument(readResult);
  assert.deepEqual(resultView.result, run.result, "Result view must return the complete original, not a summary");
  assert.equal(resultView.run.id, run.id);
  assert.equal(resultView.run.input, undefined);
  assert.equal(resultView.run.effective, undefined);
  assert.equal(resultView.reads.full, "yui task run show task-1/run-1 --view full --json");
  const fullView = readDocument(cursor => runTaskCommand(["run", "show", "task-1/run-1",
    ...(cursor ? ["--cursor", cursor] : [])], store, { environment: {} }).data);
  assert.deepEqual(fullView.run, run, "Default full audit evidence is unchanged");
  const list = listTaskContext(store, "task-1", "task-message");
  const index = readTaskContext(store, "task-1").records.filter(item => item.ref.store === "task-message");
  for (const entry of [list.items[0], index[0]]) {
    assert.equal(entry.summary, "Author summary (agent-run-result): Candidate ready; model benefit remains unknown.");
    assert.equal(JSON.stringify(entry).includes("Full report only"), false);
    const original = inspectTaskContext(store, "task-1", entry.ref);
    assert.deepEqual(original.value, message);
    assert.equal(original.result.output, report);
  }
  assert.equal(store.getStateRevision(), revision);
  const longRun = { ...run, result: { ...run.result, output: report.repeat(8) } };
  store.saveRun(longRun);
  const firstResultPage = readResult();
  assert.ok(firstResultPage.contentPage?.nextCursor);
  assert.deepEqual(readDocument(readResult).result, longRun.result);
  assert.throws(() => runTaskCommand(["run", "show", "task-1/run-1", "--view", "full",
    "--cursor", firstResultPage.contentPage.nextCursor], store, { environment: {} }), /cursor/i);
  store.saveRun({ ...run, status: "active", result: undefined });
  assert.equal(readDocument(readResult).result, null, "No report must not become an empty success");
  const failedResult = { ...run.result, output: undefined, failureReason: "missing-result",
    diagnostic: "Provider ended without an original report." };
  store.saveRun({ ...run, status: "failed", result: failedResult });
  const failedView = readDocument(readResult);
  assert.equal(failedView.run.status, "failed");
  assert.deepEqual(failedView.result, JSON.parse(JSON.stringify(failedResult)));
  store.saveRun(run);
  const boundarySummary = "x".repeat(498) + "; NOT VERIFIED";
  assert.equal(Buffer.byteLength(boundarySummary), 512);
  store.saveRun({ ...run, result: { ...run.result, output: `Yui-Summary: ${boundarySummary}` } });
  for (const entry of [
    listTaskContext(store, "task-1", "task-message").items[0],
    readTaskContext(store, "task-1").records.find(item => item.ref.store === "task-message")
  ]) {
    assert.ok(Buffer.byteLength(entry.summary) <= 512, "Source labels count toward the summary budget");
    assert.equal(entry.summary, "Author summary (agent-run-result) omitted: exceeds discovery budget; read original.");
  }
  store.saveRun({ ...run, result: { ...run.result, output: "Yui-Summary: " + "x".repeat(513) + "; NOT VERIFIED" } });
  assert.equal(listTaskContext(store, "task-1", "task-message").items[0].summary, "body: Execution completed.",
    "Oversized summaries must not be clipped into apparent success");
  store.saveRun({ ...run, roleName: "other-role" });
  assert.equal(listTaskContext(store, "task-1", "task-message").items[0].summary, "body: Execution completed.",
    "A mismatched linked Run cannot supply discovery text");
});

test("current Run retry facts stay visible without replaying diagnostics; exact reads retain the original", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-context-retry-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-10-31T00:00:00Z");
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  const role = createRole("task-1", "leader", [createRoleAgentBinding(agent)], agent.id, home, now);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  store.saveTask({ ...createTask("task-1", "Retry visibility", now),
    status: "active", executionGate: { state: "enabled" } });
  store.saveConfiguredAgent(agent);
  store.saveRole("task-1", role);
  const run = createFixtureRun(store, "run-1", "task-1", role.name, "resume",
    { source: { type: "yui", channel: "task-dispatch" }, directive: "Continue original work", deltaRefIds: [] },
    now, { effective });
  store.saveActiveRun(run);
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: agent.id,
    conversationId: "fixture-session", startedAt: now.toISOString()
  });
  binding = beginProviderTurn(binding, {
    attemptId: "original", runId: run.id, authorityEpoch: 1, submittedAt: now.toISOString(),
    input: { kind: "run", taskId: run.taskId, runId: run.id }, retrySupported: true
  });
  binding = acceptProviderTurn(binding, {
    attemptId: "original", nativeTurnId: "native-original", acceptedAt: now.toISOString()
  });
  binding = settleProviderTurn(binding, {
    attemptId: "original", nativeTurnId: "native-original", status: "failed", settledAt: now.toISOString()
  });
  binding = recordProviderFailure(binding, {
    at: now.getTime(), random: () => 0, failureRef: "failure-original",
    error: { source: "provider", phase: "turn-execute", category: "availability", code: "provider.temporary",
      message: "Temporary failure", raw: "完整诊断😀\n".repeat(7000), inputDisposition: "accepted",
      sessionDisposition: "recoverable", retryable: true }
  });
  const due = binding.retry.nextEligibleAt;
  binding = admitProviderRetry(binding, { attemptId: "retry-1", at: Date.parse(due) });
  binding = beginProviderTurn(binding, {
    attemptId: "retry-1", runId: run.id, authorityEpoch: 1, submittedAt: due, retrySupported: true
  });
  // Acceptance is unknown: neither summary nor detail may turn it into success.
  binding = { ...binding, run: { ...binding.run, status: "delivery-unknown" },
    retryHistory: [{ ...binding.retry, chainId: "historical", status: "recovered" }] };
  const sessions = recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: role.name }, agent.id, now
  ), { agentId: agent.id, adapterId: "codex", nativeSessionId: "fixture-session",
    policy: "fixed", status: "active", effective }, now);
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(sessions, binding, now));
  const revision = store.getStateRevision();
  const roleView = runTaskCommand(["role", "show", "task-1", "leader"], store, { environment: {} }).data;
  assert.deepEqual(roleView.role, role);
  assert.equal(roleView.contentPage, undefined, "Routine configuration must not load retry/history bodies.");
  assert.equal(roleView.session.effective.agentId, agent.id);
  assert.equal(roleView.session.nativeSessionId, "fixture-session");
  assert.equal(roleView.observation, "recorded-configuration-not-live-state");
  assert.equal(roleView.controlTarget.fromBinding, true, "Unknown retained execution must remain discoverable.");
  assert.equal(roleView.runs, undefined);
  assert.equal(roleView.sessions, undefined);
  const fullRole = readDocument(cursor => runTaskCommand(["role", "show", "task-1", "leader",
    "--view", "full", ...(cursor === undefined ? [] : ["--cursor", cursor])], store, { environment: {} }).data);
  assert.deepEqual(fullRole.role, role);
  assert.deepEqual(fullRole.sessions, store.getTaskRoleSessionSet("task-1", "leader"));
  assert.equal(fullRole.runs[0].id, run.id);
  t.diagnostic(`Role current/full document bytes: ${Buffer.byteLength(JSON.stringify(roleView))}/${Buffer.byteLength(JSON.stringify(fullRole))}; synthetic long diagnostic, not model tokens`);
  const fullRolePage = runTaskCommand(["role", "show", "task-1", "leader", "--view", "full"],
    store, { environment: {} }).data.contentPage;
  assert.throws(() => runTaskCommand(["role", "show", "task-1", "leader", "--cursor", fullRolePage.nextCursor],
    store, { environment: {} }), /cursor|source/i, "Full-history cursors cannot continue the current view.");
  assert.throws(() => runTaskCommand(["role", "show", "task-1", "leader", "--view", "unknown"],
    store, { environment: {} }), /view/);
  const roleStatus = runTaskCommand(["role", "status", "task-1", "leader"], store, { environment: {} }).data;
  assert.equal(roleStatus.contentPage, undefined, "Current status must not replay retry diagnostics.");
  assert.equal(roleStatus.role.activeRun.id, run.id);
  assert.equal(roleStatus.role.activeRun.inputs, undefined);
  assert.equal(roleStatus.role.execution.delivery, "delivery-unknown");
  assert.equal(roleStatus.role.execution.retry.status, "delivery-unknown");
  assert.equal(roleStatus.role.execution.retry.error.raw, undefined);
  assert.equal(roleStatus.role.execution.retry.historyCount, 1);
  assert.equal(roleStatus.role.nativeSession.nativeSessionId, "fixture-session");
  assert.deepEqual(roleStatus.role.effectiveLaunch, effective);
  const fullStatus = readDocument(cursor => runTaskCommand(["role", "status", "task-1", "leader",
    "--view", "full", ...(cursor === undefined ? [] : ["--cursor", cursor])], store, { environment: {} }).data);
  assert.deepEqual(fullStatus.role.activeRun, run);
  assert.equal(fullStatus.role.execution.retry.error.raw, binding.retry.error.raw);
  assert.equal(roleStatus.role.health, fullStatus.role.health);
  assert.equal(roleStatus.role.healthReason, fullStatus.role.healthReason);
  const statusPage = runTaskCommand(["role", "status", "task-1", "leader", "--view", "full"],
    store, { environment: {} }).data.contentPage;
  assert.throws(() => runTaskCommand(["role", "status", "task-1", "leader",
    "--cursor", statusPage.nextCursor], store, { environment: {} }), /cursor|source/i);
  assert.throws(() => runTaskCommand(["role", "status", "task-1", "leader", "--view", "unknown"],
    store, { environment: {} }), /view/);
  t.diagnostic(`Role status current/full bytes: ${Buffer.byteLength(JSON.stringify(roleStatus))}/${Buffer.byteLength(JSON.stringify(fullStatus))}`);
  const runStatus = runTaskCommand(["run", "show", "task-1/run-1", "--view", "status"],
    store, { environment: {} }).data;
  assert.equal(runStatus.contentPage, undefined, "Run status must not replay retry diagnostics either.");
  assert.equal(runStatus.execution.delivery, "delivery-unknown");
  assert.equal(runStatus.execution.retry.status, "delivery-unknown");
  assert.equal(runStatus.execution.retry.historyCount, 1);
  assert.equal(runStatus.execution.retry.error.raw, undefined);
  const context = runTaskCommand(["context", run.taskId], store, { environment: {} }).data;
  const entry = context.records.find(record => record.ref.store === "run");
  assert.ok(entry, "A large retry diagnostic must not push the current Run off the page");
  assert.equal(entry.execution.delivery, "delivery-unknown");
  assert.equal(entry.execution.retry.status, "delivery-unknown");
  assert.equal(entry.execution.retry.detailOmitted, true);
  assert.equal(entry.execution.retry.error.raw, undefined);
  assert.equal(entry.execution.retry.history, undefined);
  assert.equal(entry.execution.retry.historyCount, 1);
  assert.equal(entry.execution.retry.failureRef, "failure-original");
  assert.equal(entry.execution.retry.currentDetailCommand, "yui task role session retry task-1 leader show --json");
  const retryArgs = ["role", "session", "retry", "task-1", "leader", "show"];
  let narrowPages = 0;
  const narrow = readDocument(cursor => {
    const page = runTaskCommand([...retryArgs, ...(cursor === undefined ? [] : ["--cursor", cursor])],
      store, { environment: {} }).data;
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: page })) + 1 <= 32768);
    narrowPages++;
    return page;
  });
  assert.ok(narrowPages > 1);
  assert.equal(narrow.retry.error.raw, binding.retry.error.raw);
  assert.equal(narrow.retry.status, "delivery-unknown");
  assert.equal(narrow.retry.history[0].chainId, "historical");
  assert.equal(narrow.run, undefined, "Retry detail does not repeat Run configuration or input.");
  const first = runTaskCommand(retryArgs, store, { environment: {} }).data.contentPage;
  assert.throws(() => runTaskCommand(["role", "session", "retry", "task-1", "leader", "cancel",
    "--cursor", first.nextCursor], store, { environment: {} }), /Usage/);
  let pages = 0;
  const original = readDocument(cursor => {
    const page = runTaskCommand(["context", "inspect", run.taskId, "--store", "run", "--ref", run.id,
      "--digest", entry.ref.digest, ...(cursor === undefined ? [] : ["--cursor", cursor])],
    store, { environment: {} }).data;
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: page })) + 1 <= 32768);
    pages++;
    return page;
  });
  assert.ok(pages > 1);
  assert.deepEqual(original.value, run);
  assert.equal(original.execution.delivery, entry.execution.delivery);
  assert.equal(original.execution.retry.status, entry.execution.retry.status);
  assert.equal(original.execution.retry.error.raw, binding.retry.error.raw);
  assert.equal(original.execution.retry.history[0].chainId, "historical");
  assert.deepEqual(narrow.retry, original.execution.retry, "Narrow and full reads return equal diagnostic evidence.");
  assert.equal(store.getStateRevision(), revision, "Summary and complete reads do not create receipts");
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(sessions, {
    ...binding, retry: { ...binding.retry, reason: "new evidence" }
  }, now));
  assert.throws(() => runTaskCommand([...retryArgs, "--cursor", first.nextCursor],
    store, { environment: {} }), /changed/i, "Paging cannot mix retry observations.");
});

test("current Context indexes background records without repeatedly embedding their bodies", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-context-index-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-10-27T00:00:00Z");
  const task = { ...createTask("task-1", "Current task", now),
    description: "Complete original requirement, not a default notification payload." };
  store.saveTask(task);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id }, root: home,
    entries: [{ projectId: "project-1", directory: "project", access: "write",
      path: join(home, "project"), branch: "task-main", baseRef: "main", baseCommit: "a".repeat(40) }]
  }, now));
  for (let i = 1; i <= 12; i++) store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "integration-attempt", taskId: task.id, integrationAttemptId: `integration-${i}` },
    root: join(home, `integration-${i}`), entries: []
  }, now));
  const revision = store.getStateRevision();
  const context = runTaskCommand(["context", task.id], store, { environment: {} }).data;
  assert.equal(context.phase.status, "draft");
  const workspaceIndex = context.records.filter(record => record.ref.store === "managed-workspace");
  assert.equal(workspaceIndex[0].ref.refId, "task:task-1",
    "Historical integration workspaces must not displace the Task's own workspace from the current index");
  assert.equal(context.collections.find(c => c.store === "managed-workspace").total, 13);
  const workspaceHistory = listTaskContext(store, task.id, "managed-workspace");
  assert.equal(workspaceHistory.total, 13);
  assert.equal(workspaceHistory.complete, true);
  assert.equal(workspaceHistory.items[0].ref.refId, "integration-attempt:task-1:integration-1",
    "Explicit full discovery keeps its existing ordering");
  assert.equal(workspaceHistory.items.filter(item => item.ref.refId.startsWith("integration-attempt:")).length, 12);
  for (const family of ["task", "managed-workspace", "remote-delivery"]) {
    const entry = context.records.find(record => record.ref.store === family);
    assert.ok(entry, `${family} remains discoverable`);
    assert.equal(entry.omitted, true);
    assert.equal(entry.value, undefined, `${family} body belongs to an exact read`);
    assert.ok(entry.summary.length > 0);
    const original = inspectTaskContext(store, task.id, {
      store: family, refId: entry.ref.refId, digest: entry.ref.digest
    });
    assert.equal(original.ref.digest, entry.ref.digest);
    if (family === "task") assert.deepEqual(original.value, task);
    if (family === "managed-workspace") {
      assert.equal(original.value.entries[0].baseCommit, "a".repeat(40));
      assert.ok(entry.summary.includes(home), "Workspace identity remains useful for discovery");
    }
  }
  assert.equal(store.getStateRevision(), revision, "Index and original reads have no effects");
});

test("bounded discovery and exact long-document reads preserve content and reject mixed sources", () => {
  const original = { body: "需求😀\n".repeat(20000), result: { output: "原始结果".repeat(20000) } };
  let cursor;
  let text = "";
  let pages = 0;
  do {
    const result = boundedDocument(original, "task-1/message-1", cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32768);
    text += result.contentPage.text;
    cursor = result.contentPage.nextCursor;
    pages++;
    if (pages === 1) {
      assert.throws(() => boundedDocument(original, "task-2/message-1", cursor), /cursor|source/i);
      assert.throws(() => boundedDocument({ ...original, body: "changed" }, "task-1/message-1", cursor), /changed/i);
    }
  } while (cursor !== null);
  assert.deepEqual(JSON.parse(text), original);
  assert.ok(pages > 2);
  const records = Array.from({ length: 1000 }, (_, id) => ({ id, summary: "x".repeat(400) }));
  const first = recordPage(records, "global:operator");
  assert.equal(first.items.length, 20);
  assert.equal(first.total, 1000);
  const next = recordPage(records, "global:operator", { cursor: first.nextCursor });
  assert.equal(next.items[0].id, 20);
  assert.throws(() => recordPage(records, "global:other", { cursor: first.nextCursor }), /cursor|scope/i);
  assert.throws(() => recordPage(records.slice(1), "global:operator", { cursor: first.nextCursor }), /changed/i);
  assert.throws(() => recordPage(records, "global:operator", { limit: 10000 }), /limit/i);
});

test("document pages use the wire budget without losing Unicode or old cursor continuations", () => {
  for (const [body, source] of [
    ["a".repeat(80000), "task-1/message-1"],
    ["需求😀\n".repeat(10000), "task-1/message-1"],
    ['"\\\u0000😀'.repeat(10000), "\u0000".repeat(1024)]
  ]) {
    const original = { body };
    const text = JSON.stringify(original);
    let cursor;
    let rebuilt = "";
    let pages = 0;
    do {
      const result = boundedDocument(original, source, cursor);
      const page = result.contentPage;
      // Run-context wrapping plus ordinary dynamic display metadata fits in
      // the shared headroom; budget the encoded response, not the body.
      assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: {
        context: result, backlogObservation: { observedAt: "2026-10-24T00:00:00.000Z", oldestAgeMs: 123 }
      } })) + 1 <= 32768);
      assert.equal(page.offset, rebuilt.length);
      assert.ok(page.text.length > 0);
      if (!page.complete) assert.ok(!/[\uD800-\uDBFF]$/u.test(page.text));
      rebuilt += page.text;
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null);
    assert.equal(rebuilt, text);
    if (body[0] === "a") assert.ok(pages <= 3, "ASCII documents should fill the bounded response");
    // A previously issued 4096-unit cursor remains meaningful: no new
    // page-size alignment rule or cursor schema is introduced.
    let offset = 4096;
    if (/[\uD800-\uDBFF]/u.test(text[offset - 1])) offset--;
    const oldCursor = encodeReadCursor({ source, digest: readDigest(original), offset });
    let remaining = "";
    cursor = oldCursor;
    do {
      const page = boundedDocument(original, source, cursor).contentPage;
      remaining += page.text;
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.equal(text.slice(0, offset) + remaining, text);
  }
  const inline = { body: "a".repeat(16373) };
  assert.equal(Buffer.byteLength(JSON.stringify(inline)), 16384);
  assert.equal(boundedDocument(inline, "inline"), inline);
  const over = boundedDocument({ body: inline.body + "a" }, "inline");
  assert.equal(over.contentPage.complete, true);
  const terminal = boundedDocument({ body: "a".repeat(32084) }, "task-1/message-1");
  assert.equal(terminal.contentPage.complete, true);
  const end = terminal.contentPage.text.length - 1;
  const nonterminal = { contentPage: { ...terminal.contentPage,
    text: terminal.contentPage.text.slice(0, end), complete: false,
    nextCursor: encodeReadCursor({ source: terminal.contentPage.source,
      digest: terminal.contentPage.digest, offset: end })
  } };
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: terminal })) + 256 <= 32768);
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: nonterminal })) + 256 > 32768,
    "A fitting terminal page must not be rejected because its longer cursor-bearing neighbor fails");
});

test("list budget includes escaped identities, continuation and the response envelope", () => {
  const records = Array.from({ length: 100 }, (_, id) => ({ id, summary: "界".repeat(330) }));
  const source = "\u0000".repeat(1024);
  let cursor;
  const found = [];
  do {
    const page = recordPage(records, source, { limit: 100, cursor },
      { identity: { nativeSessionId: "界".repeat(1000) } });
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: page })) <= 32768);
    found.push(...page.items.map(item => item.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  assert.deepEqual(found, records.map(item => item.id));
});

test("daily Context, discovery and original reads stay bounded as history grows without consuming inputs", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-read-contract-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-09-30T00:00:00Z");
  store.saveTask(createTask("task-1", "Bounded context", now));
  store.saveTask(createTask("task-2", "Foreign scope", now));
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  store.createGlobalRoleIfAbsent(createGlobalRole("operator", [createRoleAgentBinding(agent)], agent.id, home, now));
  const global = args => runGlobalRoleCommand(args, store, { env: {}, jsonOutput: true }).data;
  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  const sizes = [];
  for (let i = 1; i <= 200; i++) {
    store.saveMessage("task-1", createTaskMessage(`message-${i}`, "task-1", "正文😀".repeat(300),
      "user", { type: "user" }, now));
    store.saveEvent("task-1", createTaskEvent(`event-${i}`, "task-1", "fixture.history", { detail: "x".repeat(2000) }, now));
    const receipt = global(["message", "queue", "operator", "正文😀".repeat(300), "--request-id", `request-${i}`]);
    assert.equal(receipt.message.body, undefined);
    if (i === 20 || i === 200) sizes.push({
      records: i, task: bytes(readTaskContext(store, "task-1")),
      global: bytes(global(["context", "operator"])),
      events: bytes(runTaskCommand(["event", "list", "task-1"], store).data)
    });
  }
  const revision = store.getStateRevision();
  const before = store.listGlobalRoleMessages("operator");
  // Current Skill metadata can push this deliberately large Unicode Context
  // over the inline limit; use the existing exact-document continuation.
  const context = readDocument(cursor => {
    const page = global(["context", "operator", ...(cursor === undefined ? [] : ["--cursor", cursor])]);
    assert.ok(bytes(page) < 32768);
    return page;
  });
  assert.deepEqual(context.currentSkills.map(skill => skill.id), ["yui-runtime", "yui-operator"]);
  assert.equal(context.pending.total, 200);
  assert.equal(context.pending.items.length, 8);
  const pendingIds = [...context.pending.items.map(m => m.id)];
  let cursor = context.pending.nextCursor;
  while (cursor !== null) {
    const page = global(["message", "list", "operator", "--current", "--cursor", cursor]);
    pendingIds.push(...page.items.map(m => m.id));
    cursor = page.nextCursor;
  }
  assert.equal(new Set(pendingIds).size, 200);
  assert.deepEqual(store.listGlobalRoleMessages("operator"), before);
  assert.equal(store.getStateRevision(), revision);
  const taskContext = readTaskContext(store, "task-1");
  assert.equal(taskContext.attention.messages.count, 200);
  assert.equal(taskContext.records.some(r => r.ref.store === "task-event"), false);
  const list = listTaskContext(store, "task-1", "task-message");
  assert.equal(list.items.length, 20);
  assert.equal(list.total, 200);
  assert.throws(() => listTaskContext(store, "task-2", "task-message", { cursor: list.nextCursor }), /scope|cursor/i);
  assert.equal(inspectTaskContext(store, "task-1", list.items[0].ref).value.body, "正文😀".repeat(300));
  const refs = list.items.slice(0, 3).map(item => item.ref);
  const inspectBatch = (selected = refs, cursor) => runTaskCommand(
    ["context", "inspect", "task-1", "--refs", JSON.stringify(selected),
      ...(cursor === undefined ? [] : ["--cursor", cursor])], store).data;
  const grouped = inspectBatch();
  assert.deepEqual(grouped.items, refs.map(ref => inspectTaskContext(store, "task-1", ref)));
  const compactRefs = refs.flatMap(ref => ["--context-ref", `${ref.store}/${ref.refId}@${ref.digest}`]);
  assert.deepEqual(runTaskCommand(["context", "inspect", "task-1", ...compactRefs], store).data, grouped);
  assert.throws(() => runTaskCommand(["context", "inspect", "task-1", ...compactRefs,
    "--refs", JSON.stringify(refs)], store), /combine/i);
  assert.throws(() => runTaskCommand(["context", "inspect", "task-1", "--context-ref",
    "task-message/message-1"], store), /store\/refId@digest/i);
  assert.equal(store.getStateRevision(), revision, "Grouped inspection is read-only");
  assert.throws(() => inspectBatch([refs[0], { ...refs[1], digest: "0".repeat(64) }]), /changed/i);
  assert.throws(() => inspectBatch([refs[0], refs[0]]), /duplicate/i);
  assert.throws(() => inspectBatch(Array(9).fill(refs[0])), /1.*8/i);
  assert.throws(() => inspectBatch([{ store: "task-message", refId: refs[0].refId }]), /digest/i);
  assert.throws(() => runTaskCommand(["context", "inspect", "task-1", "--refs",
    JSON.stringify(refs), "--store", "task-message"], store), /combine/i);
  // A legal long requirement remains fully readable through the command.
  const body = "完整原文😀".repeat(12000);
  store.saveMessage("task-1", createTaskMessage("message-201", "task-1", body, "user", { type: "user" }, now));
  let pages = 0;
  const original = readDocument(cursor => {
    const data = runTaskCommand(["message", "show", "task-1/message-201",
      ...(cursor === undefined ? [] : ["--cursor", cursor])], store).data;
    assert.ok(bytes(data) < 32768);
    pages++;
    return data;
  });
  assert.equal(original.body, body);
  assert.ok(pages > 1);
  const longRef = listTaskContext(store, "task-1", "task-message").items.find(item => item.ref.refId === "message-201").ref;
  const longSelection = [longRef, refs[0]];
  let groupedPages = 0;
  const groupedOriginal = readDocument(cursor => {
    const data = inspectBatch(longSelection, cursor);
    assert.ok(bytes(data) < 32768, "One shared budget, not eight full page budgets");
    groupedPages++;
    return data;
  });
  assert.equal(groupedOriginal.items[0].value.body, body);
  assert.equal(groupedOriginal.items[1].value.body, "正文😀".repeat(300));
  assert.ok(groupedPages > 1);
  const continuation = inspectBatch(longSelection).contentPage.nextCursor;
  assert.throws(() => inspectBatch([...longSelection].reverse(), continuation), /cursor|scope/i);
  store.updateMessage("task-1", { ...store.listMessages("task-1").find(message => message.id === "message-201"),
    body: `${body}changed` });
  assert.throws(() => inspectBatch(longSelection, continuation), /changed/i,
    "Changed originals cannot be mixed with earlier batch pages");
  for (const sample of sizes) for (const key of ["task", "global", "events"]) assert.ok(sample[key] < 32768);
  const actor = { scope: "task", taskId: "task-1", roleName: "leader", agentId: "codex", nativeSessionId: "fixture" };
  const claim = { actor, at: now.toISOString(), requestId: "claim" };
  const inbox = { claim, ack: { ...claim, reason: "Handled exact input" } };
  store.updateMessage("task-1", { ...store.listMessages("task-1")[0], inbox });
  store.saveTaskWake("task-1", { ...createTaskWake({
    id: "wake-1", taskId: "task-1", reasons: ["user-message"], now,
    fromCursor: now.toISOString(), toCursor: now.toISOString(),
    refs: [{ type: "message", taskId: "task-1", id: "message-2" }]
  }), inbox });
  assert.equal(readTaskContext(store, "task-1").attention.messages.count, 199);
  assert.equal(listTaskContext(store, "task-1", "task-message", { view: "current" }).total, 199);
  assert.equal(listTaskContext(store, "task-1", "task-message").total, 201, "Original history remains readable.");
  store.saveEvent("task-1", createTaskEvent("event-201", "task-1", "message.updated", { messageId: "message-2" }, now));
  assert.equal(readTaskContext(store, "task-1").attention.messages.count, 200, "A changed original is not covered by an earlier ack.");
  for (const [id, receipt] of [["wake-2", { claim }], ["wake-3", inbox]]) {
    store.saveTaskWake("task-1", { ...createTaskWake({
      id, taskId: "task-1", reasons: ["user-message"], now,
      fromCursor: now.toISOString(), toCursor: now.toISOString(),
      refs: [{ type: "message", taskId: "task-1", id: "message-3" }]
    }), inbox: receipt });
  }
  assert.equal(readTaskContext(store, "task-1").attention.messages.count, 200,
    "The original unacknowledged owner is not replaced by a later window's acknowledgement.");
  const globalMessages = store.listGlobalRoleMessages("operator");
  const globalClaim = { ...claim, actor: { ...actor, scope: "global", taskId: undefined, roleName: "operator" } };
  delete globalClaim.actor.taskId;
  store.updateGlobalRoleMessage({ ...globalMessages[0], inbox: { claim: globalClaim, ack: { ...globalClaim, reason: "Handled" } } });
  store.updateGlobalRoleMessage({ ...globalMessages[1], control: {
    requestId: "unknown", receiptId: "unknown", outcome: "delivery-unknown", observedAt: now.toISOString()
  } });
  const pending = global(["message", "list", "operator", "--pending"]);
  assert.equal(pending.total, 199);
  assert.ok(pending.items.some(item => item.control?.outcome === "delivery-unknown"));
  assert.equal(pending.items.find(item => item.control?.outcome === "delivery-unknown").deliveryState, "delivery-unknown");
  assert.ok(pending.items.every(item => item.handling === "unclaimed"));
  assert.equal(context.recent, undefined);
  t.diagnostic(`Returned compact JSON bytes: ${JSON.stringify(sizes)}; original read pages=${pages}`);
});

test("Decision save returns bounded identity without replaying its long submitted rationale", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-decision-receipt-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-11-03T00:00:00Z");
  store.saveTask(createTask("task-1", "Decision receipt", now));
  const rationale = "完整业务依据😀\n".repeat(3000).trim();
  const result = runTaskCommand(["decision", "record", "task-1", "--title", "Chosen plan",
    "--rationale", rationale], store, { now: () => now, environment: {} });
  const saved = store.getDecision("task-1", "decision-1");
  assert.equal(result.output, "Recorded decision decision-1 for task-1\n");
  assert.equal(result.data.taskId, "task-1");
  assert.equal(result.data.effect, "saved");
  assert.deepEqual(result.data.decision, { id: saved.id, taskId: saved.taskId,
    status: saved.status, createdAt: saved.createdAt, updatedAt: saved.updatedAt,
    digest: readDigest(saved), rationaleBytes: Buffer.byteLength(rationale) });
  assert.ok(Buffer.byteLength(JSON.stringify(result.data)) < 1024);
  assert.equal(saved.rationale, rationale);
  const original = readDocument(cursor => runTaskCommand(["decision", "show", "task-1",
    saved.id, ...(cursor ? ["--cursor", cursor] : [])], store, { environment: {} }).data);
  assert.deepEqual(original.decision, saved);
  assert.equal(store.listDecisions("task-1").length, 1);
  const superseded = runTaskCommand(["decision", "supersede", "task-1", saved.id,
    "--reason", "New requirement"], store, { now: () => now, environment: {} });
  assert.equal(superseded.data.decision.status, "superseded");
  assert.equal(superseded.data.decision.digest, readDigest(store.getDecision("task-1", saved.id)));
  assert.equal(superseded.data.decision.rationale, undefined);
  assert.equal(superseded.data.read, "yui task decision show task-1 decision-1 --json");
  assert.equal(result.data.contentOmitted, true);
  const short = runTaskCommand(["decision", "record", "task-1", "--title", "Plan",
    "--rationale", '{"allocation":"Cedar","kits":24,"remaining":10,"note":"完整😀"}'],
  store, { now: () => now, environment: {} });
  const shortSaved = store.getDecision("task-1", "decision-2");
  assert.equal(short.data.contentOmitted, false);
  assert.equal(short.data.effect, "saved");
  assert.equal(short.data.read, undefined, "A complete saved value is not a fetch-next instruction");
  assert.deepEqual(short.data.decision, { ...shortSaved,
    digest: readDigest(shortSaved), rationaleBytes: Buffer.byteLength(shortSaved.rationale) });
  const shortSuperseded = runTaskCommand(["decision", "supersede", "task-1", shortSaved.id,
    "--reason", "Revised source"], store, { now: () => now, environment: {} });
  assert.equal(shortSuperseded.data.contentOmitted, false);
  assert.equal(shortSuperseded.data.read, undefined);
  assert.deepEqual(shortSuperseded.data.decision, {
    ...store.getDecision("task-1", shortSaved.id),
    digest: readDigest(store.getDecision("task-1", shortSaved.id)),
    rationaleBytes: Buffer.byteLength(shortSaved.rationale)
  });
  const largeTitle = runTaskCommand(["decision", "record", "task-1",
    "--title", "边界😀".repeat(400), "--rationale", "Short body"],
  store, { now: () => now, environment: {} });
  assert.equal(largeTitle.data.contentOmitted, true, "Bound the complete encoded record, not rationale alone");
  assert.equal(largeTitle.data.decision.title, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(largeTitle.data)) < 1024);
});

test("Run entry samples references and live lists without changing frozen authority", () => {
  const pointers = Array.from({ length: 100 }, (_, i) => ({
    store: "task-message", refId: `message-${i}`, digest: "d".repeat(64), summary: "摘要😀".repeat(400)
  }));
  const pack = {
    identity: { taskId: "task-1", runId: "run-1" }, snapshot: { digest: "frozen" },
    authority: { writableProjectIds: ["project-1"] }, pointers, deltaRefs: pointers,
    input: { source: { type: "yui", channel: "task-dispatch" }, directive: "完整要求".repeat(10000) },
    skillPackages: ["historical"], inventory: { refs: 100, frozenBytes: 100000, complete: true },
    liveTaskState: { activeRuns: pointers, activeTaskReviews: [], providerRetries: [] }
  };
  const entry = runContextEntry(pack);
  assert.equal(entry.pointers.length, 16);
  assert.equal(entry.pointerPage.total, 100);
  assert.equal(entry.inventory.complete, false);
  assert.equal(entry.liveTaskState.activeRuns.length, 8);
  assert.equal(entry.skillPackages, undefined);
  assert.equal(entry.input.directive, undefined);
  assert.equal(entry.input.directiveOmitted, true);
  assert.match(entry.reads.input, /--view input$/);
  assert.match(entry.reads.refs, /--view refs$/);
  assert.deepEqual(entry.authority, pack.authority);
  const next = runContextPointerPage(pack, { cursor: entry.pointerPage.nextCursor });
  assert.equal(next.items[0].refId, "message-16");
  assert.equal(pack.pointers.length, 100);
  // A complete small directive costs no more than the old bounded summary.
  // Its explicit completeness avoids a mandatory second call for the same text.
  const short = "😀".repeat(128);
  const shortPack = { ...pack, input: { ...pack.input, directive: short } };
  const smallEntry = runContextEntry(shortPack);
  assert.equal(smallEntry.input.directive, short);
  assert.equal(smallEntry.input.directiveOmitted, false);
  assert.equal(smallEntry.input.directiveSummary, undefined);
  assert.equal(smallEntry.reads.input, undefined);
  const completeEntry = runContextEntry({ ...shortPack, pointers: pointers.slice(0, 2) });
  assert.equal(completeEntry.pointerPage.complete, true);
  assert.equal(completeEntry.reads.refs, undefined);
  assert.match(completeEntry.reads.full, /--view full$/);
  assert.equal(completeEntry.reads.expand,
    "yui task run context expand task-1/run-1 --context-ref <store/refId> [--context-ref <store/refId> ...] --mode full --json");
  assert.equal(runContextEntry({ ...shortPack, pointers: [] }).reads.expand, undefined);
  assert.deepEqual(shortPack.input, { ...pack.input, directive: short }, "Projection never edits the frozen input");
  const overBoundary = runContextEntry({ ...shortPack, input: { ...shortPack.input, directive: short + "x" } });
  assert.equal(overBoundary.input.directive, undefined);
  assert.equal(overBoundary.input.directiveOmitted, true);
  const empty = runContextEntry({ ...shortPack, input: { ...shortPack.input, directive: "" } });
  assert.equal(empty.input.directive, "");
  assert.equal(empty.input.directiveOmitted, false);
});
