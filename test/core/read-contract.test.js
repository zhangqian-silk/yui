import assert from "node:assert/strict";
import test from "node:test";
import { boundedDocument, recordPage } from "../../dist/output/boundedRead.js";
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
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { readDocument } from "../helpers/read-document.js";

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
  const context = global(["context", "operator"]);
  assert.equal(context.pending.total, 200);
  assert.equal(context.pending.items.length, 8);
  const pendingIds = [...context.pending.items.map(m => m.id)];
  let cursor = context.pending.nextCursor;
  while (cursor !== null) {
    const page = global(["message", "list", "operator", "--pending", "--cursor", cursor]);
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
  t.diagnostic(`Returned compact JSON bytes: ${JSON.stringify(sizes)}; original read pages=${pages}`);
});
