import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerRuntime } from "../../dist/runtime/codexAppServerRuntime.js";

test("long-history resume, observation and exact terminal recovery use bounded native pages", async () => {
  const calls = [];
  const old = { id: "owned", status: "failed", items: [], error: { message: "capacity" } };
  const latest = { id: "latest", status: "completed", items: [] };
  const runtime = new CodexAppServerRuntime({ request: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume" || method === "thread/read") {
      assert.equal(method === "thread/resume" ? params.excludeTurns : !params.includeTurns, true,
        "a full-history response would exceed the 16 MiB transport bound");
      return { thread: { id: "long-thread", status: { type: "idle" }, turns: [] } };
    }
    if (method === "thread/turns/list") {
      assert.equal(params.itemsView, "notLoaded");
      assert.ok(params.limit <= 50);
      return params.limit === 1 ? { data: [latest], nextCursor: "older" }
        : params.cursor ? { data: [old], nextCursor: null } : { data: [latest], nextCursor: "older" };
    }
    assert.equal(method, "thread/items/list");
    assert.equal(params.turnId, "owned");
    assert.equal(params.sortDirection, "desc");
    assert.equal(params.limit, 1);
    return { data: [{ turnId: "owned", item: { type: "agentMessage", text: "Original report\n" } }], nextCursor: null };
  } });
  assert.equal((await runtime.resumeConversation("long-thread")).latestTurnStatus, "completed");
  assert.equal((await runtime.readConversation("long-thread")).latestTurnStatus, "completed");
  const terminal = await runtime.readTurn("long-thread", "owned");
  assert.equal(terminal.turnId, "owned");
  assert.equal(terminal.error, "capacity");
  assert.equal(terminal.output, "Original report\n");
  assert.equal(calls.filter(c => c.method === "thread/items/list").length, 1);
});

test("bounded recovery refuses foreign items and cyclic or malformed pagination", async () => {
  for (const mode of ["foreign", "cycle", "missing-cursor"]) {
    const runtime = new CodexAppServerRuntime({ request: async method => {
      if (method === "thread/turns/list") {
        if (mode === "cycle") return { data: [], nextCursor: "same" };
        if (mode === "missing-cursor") return { data: [] };
        return { data: [{ id: "owned", status: "completed", items: [] }], nextCursor: null };
      }
      return { data: [{ turnId: "foreign", item: { type: "agentMessage", text: "not ours" } }], nextCursor: null };
    } });
    await assert.rejects(runtime.readTurn("long-thread", "owned"), /Codex/);
  }
});

test("metadata-only active history retains exact Turn identity and refuses a new submit", async () => {
  const calls = [];
  const runtime = new CodexAppServerRuntime({ request: async (method, params) => {
    calls.push(method);
    if (method === "thread/turns/list") {
      return { data: [{ id: "active", status: "inProgress", items: [] }], nextCursor: null };
    }
    assert.equal(params.includeTurns, false);
    return { thread: { id: "thread", status: { type: "active" }, turns: [] } };
  } });
  assert.equal((await runtime.inspectConversation("thread")).activeTurnId, "active");
  assert.equal((await runtime.submitTurn({
    conversationId: "thread", text: "do not submit", expectedNoActiveTurn: true
  })).status, "busy");
  assert.ok(!calls.includes("turn/start"));
});
