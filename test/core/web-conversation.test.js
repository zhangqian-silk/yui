import assert from "node:assert/strict";
import test from "node:test";
import { readCodexConversationPage } from "../../dist/web/webConversation.js";
import { foldPublicReply } from "../../dist/runtime/publicReply.js";

test("live public reply is bounded and fenced to exact Thread/Turn; reasoning is excluded", () => {
  let reply = foldPublicReply(undefined, "thread", "item/agentMessage/delta",
    { threadId: "thread", turnId: "turn", itemId: "item", delta: "Hello" });
  assert.equal(reply.text, "Hello");
  assert.equal(foldPublicReply(reply, "thread", "item/agentMessage/delta",
    { threadId: "other", turnId: "turn", itemId: "item", delta: "wrong" }), reply);
  assert.equal(foldPublicReply(reply, "thread", "item/reasoning/summaryTextDelta",
    { threadId: "thread", turnId: "turn", itemId: "private", delta: "PRIVATE" }), reply);
  reply = foldPublicReply(reply, "thread", "item/agentMessage/delta",
    { threadId: "thread", turnId: "turn", itemId: "item", delta: "x".repeat(7000) });
  assert.equal(reply.text.length, 6000);
  assert.equal(reply.truncated, true);
  const next = foldPublicReply(reply, "thread", "item/agentMessage/delta",
    { threadId: "thread", turnId: "next-turn", itemId: "item", delta: "New" });
  assert.equal(next.text, "New");
  assert.equal(foldPublicReply(next, "thread", "turn/started", { threadId: "thread" }), undefined);
});

test("conversation reads page public native items without resuming or exposing reasoning", async () => {
  const calls = [];
  let closed = false;
  const result = await readCodexConversationPage({ command: "fixture", args: [], cwd: "/", environment: {} },
    { nativeSessionId: "thread-a", cursor: "older" }, async () => ({
      request: async (method, params) => {
        calls.push([method, params]);
        if (method === "initialize") return {};
        if (method === "thread/read") return { thread: { id: "thread-a", status: { type: "idle" }, turns: [] } };
        return { data: [
          { turnId: "turn-a", item: { id: "reason", type: "reasoning", text: "PRIVATE" } },
          { turnId: "turn-a", item: { id: "answer", type: "agentMessage", text: "**Hello**" } },
          { turnId: "turn-a", item: { id: "tool", type: "commandExecution", command: "npm test", status: "completed", aggregatedOutput: "secret output" } }
        ], nextCursor: "next", backwardsCursor: "back" };
      }, notify: async () => {}, close: () => { closed = true; }
    }));
  assert.deepEqual(calls.map(c => c[0]), ["initialize", "thread/read", "thread/items/list"]);
  assert.equal(calls[1][1].includeTurns, false);
  assert.equal(calls[2][1].limit, 40);
  assert.equal(calls[2][1].cursor, "older");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].turnId, "turn-a");
  assert.equal(result.items[0].text, "**Hello**");
  assert.equal(result.nextCursor, "next");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret output/);
  assert.equal(closed, true);
});

test("unsupported native pagination fails explicitly, never hydrates full history", async () => {
  const calls = [];
  await assert.rejects(readCodexConversationPage({ command: "fixture", args: [], cwd: "/", environment: {} },
    { nativeSessionId: "thread-a" }, async () => ({
      request: async (method) => {
        calls.push(method);
        if (method === "initialize") return {};
        if (method === "thread/read") return { thread: { id: "thread-a", status: { type: "idle" }, turns: [] } };
        throw new Error("item pagination unsupported");
      }, notify: async () => {}, close: () => {}
    })), /pagination unsupported/);
  assert.deepEqual(calls, ["initialize", "thread/read", "thread/items/list"]);
});
