import assert from "node:assert/strict";
import test from "node:test";
import { boundedDocument, recordPage, encodeReadCursor, readDigest } from "../../dist/output/boundedRead.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { readTaskContext, listTaskContext, inspectTaskContext } from "../../dist/context/taskContext.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
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
import { createProviderRuntimeBinding, beginProviderTurn, acceptProviderTurn, settleProviderTurn } from "../../dist/runtime/providerRuntimeIdentity.js";
import { recordProviderFailure, admitProviderRetry } from "../../dist/runtime/providerRetry.js";

test("current Run retry facts stay visible without replaying diagnostics; exact reads retain the original", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-context-retry-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-10-31T00:00:00Z");
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  const role = createRole("task-1", "leader", [createRoleAgentBinding(agent)], agent.id, home, now);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  store.saveTask(createTask("task-1", "Retry visibility", now));
  store.saveConfiguredAgent(agent);
  store.saveRole("task-1", role);
  const run = createFixtureRun(store, "run-1", "task-1", role.name, "resume",
    { source: { type: "yui", channel: "task-dispatch" }, directive: "Continue original work", deltaRefIds: [] },
    now, { effective });
  store.saveRun(run);
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
  const revision = store.getStateRevision();
  const context = runTaskCommand(["context", task.id], store, { environment: {} }).data;
  assert.equal(context.phase.status, "draft");
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
  assert.deepEqual(entry.authority, pack.authority);
  const next = runContextPointerPage(pack, { cursor: entry.pointerPage.nextCursor });
  assert.equal(next.items[0].refId, "message-16");
  assert.equal(pack.pointers.length, 100);
});
