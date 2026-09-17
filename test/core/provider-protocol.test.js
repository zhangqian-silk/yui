import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodexAppServerRuntime, CodexPreSubmissionError, codexTurnInput, codexTurnOutput
} from "../../dist/runtime/codexAppServerRuntime.js";
import { startStructuredProviderSession } from "../../dist/runtime/structuredProviderHost.js";
import { builtinAgentDriverRegistry } from "../../dist/runtime/builtinAgentDrivers.js";
import { claudeTranscriptObserver } from "../../dist/runtime/builtinTranscriptObserver.js";
import { publishStructuredProviderTerminal } from "../../dist/controller/structuredProviderObservation.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const threadId = "protocol-thread";
const turnId = "fake-turn-1";
const userItem = { type: "userMessage", id: "user-1", content: [
  { type: "text", text: "Original input", text_elements: [] },
  { type: "image", url: "data:image/png;base64,AA", text: "not human text" }
] };
const agentItem = { type: "agentMessage", id: "agent-1", text: " Original report\n第二行\n" };
const turn = { id: turnId, status: "completed", error: null, items: [userItem, agentItem] };

// Reduced fixtures of the fields Yui consumes, grounded in Codex 0.153.4's
// generated v2 types and Claude Code 2.1.270's shipped schemas/producers.
// See docs/provider-protocol-contracts.md for provenance and omissions.
test("Codex keeps method-specific identities and current input/output shapes", async () => {
  const calls = [];
  const runtime = new CodexAppServerRuntime({ request: async (method, params) => {
    calls.push({ method, params });
    if (method === "turn/start") return { turn: { ...turn, status: "inProgress" } };
    if (method === "turn/steer") return { turnId };
    return { thread: { id: threadId, status: { type: "active", activeFlags: [] },
      turns: [{ ...turn, status: "inProgress" }] } };
  } });
  assert.equal((await runtime.openConversation({ cwd: root })).conversationId, threadId);
  for (const snapshot of [
    await runtime.readConversation(threadId), await runtime.resumeConversation(threadId)
  ]) {
    assert.equal(snapshot.activeTurnId, turnId);
    assert.equal(snapshot.turns[0].output, agentItem.text);
  }
  assert.deepEqual(await runtime.startTurn({
    conversationId: threadId, text: "start", expectedNoActiveTurn: false
  }), { status: "accepted", turnId });
  assert.deepEqual(await runtime.steerTurn({
    conversationId: threadId, expectedTurnId: turnId, text: "steer"
  }), { status: "accepted", turnId });
  assert.deepEqual(calls.find(c => c.method === "turn/start").params.input,
    [{ type: "text", text: "start", text_elements: [] }]);
  assert.equal(codexTurnInput(turn), "Original input");
  assert.equal(codexTurnOutput(turn), agentItem.text);
  const obsolete = { items: [
    { type: "user_message", text: "old input" },
    { type: "message", message: { role: "assistant", content: "old report" } },
    { type: "agent_message", content: [{ text: "old report" }] }
  ] };
  assert.equal(codexTurnInput(obsolete), undefined);
  assert.equal(codexTurnOutput(obsolete), undefined);
});

test("unknown Codex identity/state cannot submit, resume or settle a child", async () => {
  for (const response of [
    { id: threadId, status: { type: "idle" }, turns: [] },
    { thread: { status: { type: "idle" }, turns: [] } },
    { thread: { id: "different-thread", status: { type: "idle" }, turns: [] } },
    { thread: { id: `${threadId} `, status: { type: "idle" }, turns: [] } },
    { thread: { id: threadId, turns: [turn] } },
    { thread: { id: threadId, status: { type: "future" }, turns: [turn] } },
    { thread: { id: threadId, status: { type: "idle" },
      turns: [turn, { id: "newer-turn", status: "running" }] } },
    { thread: { id: threadId, status: { type: "idle" }, turns: [{ ...turn, id: undefined }] } }
  ]) {
    const calls = [];
    const runtime = new CodexAppServerRuntime({ request: async method => {
      calls.push(method);
      return response;
    } });
    await assert.rejects(runtime.readConversation(threadId), /Codex/);
    await assert.rejects(runtime.resumeConversation(threadId), /Codex/);
    await assert.rejects(runtime.startTurn({
      conversationId: threadId, text: "must not submit", expectedNoActiveTurn: true
    }), CodexPreSubmissionError);
    assert.equal((await runtime.inspectConversation(threadId)).state, "unknown");
    assert.equal((await runtime.queryKnownContinuations({
      providerNamespace: "openai/codex", accountScope: "fixture", conversationId: "parent",
      continuations: [{ continuationId: threadId }]
    })).quality, "unavailable");
    assert.ok(calls.every(method => method !== "turn/start"));
  }
});

function fixtureHome(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-protocol-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

async function peer(t, adapterId, events, callbacks, restoredTurns) {
  let session;
  t.after(async () => {
    if (session === undefined) return;
    session.terminate("SIGTERM");
    await session.waitForExit();
  });
  const codex = adapterId === "codex";
  const opened = await startStructuredProviderSession({
    schemaVersion: 1, command: process.execPath,
    args: [join(root, "test/fixtures", codex
      ? "fake-codex-app-server-proxy.mjs" : "fake-claude-stream.mjs"), threadId],
    environment: {
      PATH: process.env.PATH, YUI_FAKE_THREAD_ID: threadId,
      YUI_FAKE_PROTOCOL_EVENTS: JSON.stringify(events),
      ...(restoredTurns === undefined ? {} : { YUI_FAKE_RESUMED_TURNS: JSON.stringify(restoredTurns) })
    },
    cwd: root, childLifecycle: "persistent", startMode: "provider",
    providerControl: {
      schemaVersion: 1, adapterId,
      ...(restoredTurns === undefined ? { kind: "start", mode: "new" } : {
        kind: "restore", mode: "resume", ownedTurn: { turnId, attemptId: "restored-input" }
      }),
      transport: codex ? "codex-app-server-proxy" : "claude-stream-json",
      nativeSessionId: threadId,
      authority: { epoch: 1, owner: "controller", holderId: "protocol-test" },
      ...(codex ? { codexThread: {} } : {})
    }
  }, callbacks);
  session = opened.session;
  return opened;
}

test("Codex native terminals preserve exact ownership through result publication", { timeout: 5000 }, async t => {
  const home = fixtureHome(t);
  const terminals = [], inputs = [], activities = [], diagnostics = [];
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const event = (nativeTurn, id = threadId) => ({
    method: "turn/completed", params: { threadId: id, turn: nativeTurn }
  });
  const { session } = await peer(t, "codex", [
    event({ ...turn, status: undefined }),
    event({ ...turn, status: "future" }),
    event({ ...turn, id: undefined }),
    { method: "turn/completed", params: { threadId, turnId, status: "completed", items: [agentItem] } },
    event(turn, "foreign-thread"),
    { method: "item/completed", params: { threadId, turnId, item: userItem } },
    { method: "item/completed", params: { threadId, turnId,
      item: { id: "unknown-tool", type: "commandExecution" } } },
    { method: "item/completed", params: { threadId, turnId,
      item: { id: "declined-tool", type: "commandExecution", status: "declined" } } },
    { method: "item/completed", params: { threadId, turnId,
      item: { id: "failed-tool", type: "dynamicToolCall", status: "completed", success: false } } },
    { method: "item/completed", params: { threadId, turnId,
      item: { id: "completed-tool", type: "commandExecution", status: "completed", exitCode: 0 } } },
    event({ ...turn, id: "another-clients-turn", status: "interrupted" }),
    event(turn)
  ], {
    onInput: value => inputs.push(value),
    onActivity: value => activities.push(value),
    onTerminal: value => {
      terminals.push(value);
      if (value.nativeTurnId === turnId && value.status === "completed") finish();
    },
    mirrorOutput: (stream, text) => { if (stream === "stderr") diagnostics.push(text); }
  });
  await session.submitTurn({ attemptId: "owned-input", boundedText: "Original input" });
  await done;
  assert.deepEqual(terminals.map(v => [v.nativeTurnId, v.status, v.clientOwned]), [
    ["another-clients-turn", "cancelled", false], [turnId, "completed", true]
  ]);
  assert.equal(inputs[0].input, "Original input");
  assert.deepEqual(activities.map(value => [value.id, value.phase]), [
    ["declined-tool", "failed"], ["failed-tool", "failed"], ["completed-tool", "completed"]
  ]);
  assert.equal(terminals[1].attemptId, "owned-input");
  assert.match(diagnostics.join(""), /protocol/i);
  const environment = {
    YUI_HOME: home, YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1",
    YUI_ROLE: "leader", YUI_AGENT_ID: "codex", YUI_ADAPTER_ID: "codex", YUI_WORKSPACE: home
  };
  for (const terminal of terminals) {
    await publishStructuredProviderTerminal({ home, environment, terminal });
  }
  const completed = new FileRuntimeEventInbox(home).list()
    .filter(entry => entry.observation.kind === "turn.completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].observation.fence.receiptId, "owned-input");
  assert.equal(completed[0].observation.payload.output, agentItem.text);
});

test("Codex restore recovers only its exact owned terminal with the original report", { timeout: 5000 }, async t => {
  const { session, recoveredTerminal } = await peer(t, "codex", [], {
    mirrorOutput: () => {}
  }, [turn, { ...turn, id: "other-turn", items: [{ ...agentItem, text: "Another report" }] }]);
  assert.equal(session.conversationId, threadId);
  assert.equal(recoveredTerminal.nativeTurnId, turnId);
  assert.equal(recoveredTerminal.attemptId, "restored-input");
  assert.equal(recoveredTerminal.clientOwned, true);
  assert.equal(recoveredTerminal.status, "completed");
  assert.equal(recoveredTerminal.output, agentItem.text);
});

test("Claude stream uses current result and Goal events, never guessed success", { timeout: 5000 }, async t => {
  const terminals = [], goals = [], diagnostics = [];
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const result = { type: "result", session_id: threadId, uuid: "result-1",
    subtype: "success", is_error: false, result: "Claude original report" };
  const { session } = await peer(t, "claude", [
    { ...result, subtype: undefined },
    { ...result, subtype: "future" },
    { ...result, is_error: undefined },
    { ...result, uuid: undefined },
    { ...result, session_id: "foreign-session" },
    { type: "assistant", session_id: threadId, active_goal: {
      objective: "invented goal", status: "complete", updatedAt: 1789600000
    } },
    { type: "active_goal", session_id: "foreign-session", value: null },
    { type: "active_goal", session_id: threadId, value: {
      condition: "Actual goal", iterations: 1, set_at: 1789600000000, tokens_at_start: 0
    } },
    { type: "active_goal", session_id: threadId, value: null },
    result
  ], {
    onGoal: value => goals.push(value),
    onTerminal: value => { terminals.push(value); finish(); },
    mirrorOutput: (stream, text) => { if (stream === "stderr") diagnostics.push(text); }
  });
  await session.submitTurn({ attemptId: "claude-owned-input", boundedText: "Original input" });
  await done;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].status, "completed");
  assert.equal(terminals[0].attemptId, "claude-owned-input");
  assert.equal(terminals[0].output, result.result);
  assert.equal(goals.length, 2);
  assert.equal(goals[0].objective, "Actual goal");
  assert.equal(goals[0].status, "active");
  assert.equal(goals[1], null);
  assert.match(diagnostics.join(""), /protocol/i);

  // Error subtypes need no result text. Conversely, subtype success can
  // legitimately carry is_error=true; both must retain failure evidence.
  for (const subtype of ["error_max_turns", "success"]) {
    let finishFailure;
    const failure = new Promise(resolve => { finishFailure = resolve; });
    const { session: failedSession } = await peer(t, "claude", [{
      ...result, subtype, is_error: true, result: undefined, errors: ["Native failure details"]
    }], { onTerminal: finishFailure, mirrorOutput: () => {} });
    await failedSession.submitTurn({ attemptId: `failed-${subtype}`, boundedText: "error fixture" });
    const terminal = await failure;
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.error, "Native failure details");
    assert.deepEqual(JSON.parse(terminal.rawError).errors, ["Native failure details"]);
  }
});

test("Claude Hooks keep current optional prompt identity without inventing Goal or child success", () => {
  const driver = builtinAgentDriverRegistry().requireByAdapterId("claude").runtime;
  assert.equal(driver.nativeTurnId({ payload: { prompt_id: "prompt-1", turn_id: "obsolete" } }), "prompt-1");
  assert.equal(driver.nativeTurnId({ payload: { turn_id: "obsolete" } }), undefined);
  assert.equal(driver.nativeTurnId({
    hookEventName: "MessageDisplay", payload: { turn_id: "display-turn" }
  }), "display-turn", "MessageDisplay really has a method-specific turn_id");
  const mapped = driver.mapHook({
    hookEventName: "SubagentStop", occurrenceId: "hook-1",
    payload: { session_id: threadId, agent_id: "child-1", stop_hook_active: false,
      last_assistant_message: "Child report", parent_subagent_id: "guessed",
      active_goal: { objective: "guessed", status: "complete" } }
  });
  assert.ok(mapped.every(value => !value.kind.startsWith("goal.")));
  assert.ok(mapped.every(value => value.payload.outcome !== "succeeded"));
  assert.equal(mapped.find(value => value.kind === "continuation.reported").payload.summary, "Child report");
  assert.ok(mapped.every(value => value.fence?.parentContinuationId === undefined));
  const stop = driver.mapHook({ hookEventName: "Stop", payload: {}, occurrenceId: "hook-2" });
  assert.equal(stop.find(value => value.kind === "turn.completed").payload.output, undefined);
  const snapshot = payload => driver.mapHook({ hookEventName: "Stop", payload, occurrenceId: "hook-3" })
    .find(value => value.kind === "native-work.snapshot").payload.snapshotComplete;
  assert.equal(snapshot({ background_tasks_complete: true }), false);
  assert.equal(snapshot({ background_tasks: [], session_crons: [] }), true);
  assert.equal(snapshot({ background_tasks: [{}], session_crons: [] }), false);
});

test("transcript sampling accepts only its current process-local cursor and retains deduplication", async t => {
  const home = fixtureHome(t);
  const locator = join(home, "transcript.jsonl");
  writeFileSync(locator, JSON.stringify({ type: "assistant", message: {
    id: "message-1", usage: { input_tokens: 10, output_tokens: 5 }
  } }) + "\n");
  const source = { schemaVersion: 1, sourceId: "test", transport: "append-only-jsonl", locator };
  const first = await claudeTranscriptObserver(source);
  assert.equal(first.status, "healthy");
  assert.equal(first.usages.length, 1);
  assert.equal((await claudeTranscriptObserver(source, first.cursor)).usages, undefined);
  await assert.rejects(claudeTranscriptObserver(source, {
    offset: 0, remainder: "", state: {}
  }), /cursor/i);
  const { fileFingerprint: _removed, ...obsolete } = first.cursor;
  await assert.rejects(claudeTranscriptObserver(source, obsolete), /cursor/i);
  const unavailable = await claudeTranscriptObserver({ ...source, locator: join(home, "later.jsonl") });
  assert.equal(unavailable.status, "unavailable");
  assert.equal((await claudeTranscriptObserver(source, unavailable.cursor)).usages.length, 1);
});
