import test from "node:test";
import assert from "node:assert/strict";
import { createCodexNativeAccess } from "../../dist/runtime/codexNativeAccess.js";
import { openControlledCodexTui } from "../../dist/runtime/controlledCodexTui.js";
import { resolve } from "node:path";

test("native access attaches to the same Thread and answers exact requests once", async () => {
  const sent = [], reads = [];
  let emit;
  const access = createCodexNativeAccess("thread", {}, {
    onMessage(listener) { emit = listener; },
    async request(method, params) { reads.push({ method, params }); return { thread: { id: "thread" } }; },
    async send(message) { sent.push(message); }
  });
  await access.read("thread/resume", { threadId: "thread", cwd: "/not-the-host" });
  assert.deepEqual(reads, [{ method: "thread/resume", params: { threadId: "thread" } }]);
  assert.throws(() => access.validateTurn({ model: "not-the-managed-model" }), /configuration/);
  await assert.rejects(access.read("thread/start", {}));
  await assert.rejects(access.read("thread/resume", { threadId: "other" }));
  emit({ id: 1, method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", turnId: "turn", command: "test" } });
  assert.equal(access.requests.length, 1);
  await assert.rejects(access.respond(1, "thread", "old-turn", { decision: "accept" }));
  assert.equal(sent.length, 0);
  await access.respond(1, "thread", "turn", { decision: "decline" });
  await assert.rejects(access.respond(1, "thread", "turn", { decision: "accept" }));
  assert.deepEqual(sent, [{ id: 1, result: { decision: "decline" } }]);
  emit({ id: 2, method: "item/tool/requestUserInput",
    params: { threadId: "thread", turnId: "turn", questions: [{ id: "q" }] } });
  await assert.rejects(access.respond(2, "thread", "turn", { answers: { wrong: { answers: ["x"] } } }));
  await access.respond(2, "thread", "turn", { answers: { q: { answers: ["x"] } } });
  emit({ id: 3, method: "item/fileChange/requestApproval", params: { threadId: "thread", turnId: "turn" } });
  emit({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn" } } });
  assert.equal(access.requests.length, 0);
});

test("native TUI relay uses one existing connection and forwards complete prompts and native answers", async t => {
  let emit, exited;
  const mutations = [], replies = [], errors = [];
  const done = new Promise(resolve => { exited = resolve; });
  const access = createCodexNativeAccess("thread", { userAgent: "fixture" }, {
    onMessage(listener) { emit = listener; },
    async request(method, params) {
      assert.equal(method, "thread/resume"); assert.equal(params.threadId, "thread");
      return { thread: { id: "thread" } };
    },
    async send(message) {
      replies.push(message);
      emit({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: message.id } });
    }
  });
  const tui = await openControlledCodexTui({
    command: process.execPath, cwd: process.cwd(),
    environment: { ...process.env, YUI_AGENT_BASE_ARGS: JSON.stringify([resolve("test/fixtures/fake-managed-codex-tui.mjs")]) }
  }, "thread", access, {
    respond: (id, turnId, result) => access.respond(id, "thread", turnId, result),
    async mutate(method, params) {
      mutations.push({ method, params });
      emit({ id: "approval", method: "item/commandExecution/requestApproval",
        params: { threadId: "thread", turnId: "turn", command: "fixture only" } });
      return { turn: { id: "turn", items: [], status: "inProgress", error: null } };
    }, onExit: exited, onError: error => errors.push(error)
  });
  t.after(() => tui.close());
  await done;
  assert.deepEqual(errors, []);
  assert.deepEqual(mutations, [{ method: "turn/start",
    params: { threadId: "thread", input: [{ type: "text", text: "complete prompt" }] } }]);
  assert.deepEqual(replies, [{ id: "approval", result: { decision: "decline" } }]);
});

test("native access retains pending requests observed during resume", async () => {
  const request = { id: "restored", method: "item/fileChange/requestApproval",
    params: { threadId: "thread", turnId: "turn" } };
  const sent = [];
  const access = createCodexNativeAccess("thread", {}, {
    onMessage() {}, async request() { return {}; }, async send(value) { sent.push(value); }
  }, [request]);
  assert.equal(access.requests[0].id, "restored");
  await access.respond("restored", "thread", "turn", { decision: "decline" });
  assert.deepEqual(sent, [{ id: "restored", result: { decision: "decline" } }]);
});
