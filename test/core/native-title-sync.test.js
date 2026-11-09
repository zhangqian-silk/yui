import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { synchronizeNativeTitle } from "../../dist/runtime/nativeTitleSync.js";
import { confirmedNativeTitles, nativeTitleDirectory } from "../../dist/runtime/nativeTitleReceipt.js";
import { startStructuredProviderSession } from "../../dist/runtime/structuredProviderHost.js";
import { CodexNamingClient } from "../../dist/execution/codexThreadNaming.js";

function fixture(t, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "yui-title-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = join(home, "native.json"), events = join(home, "events.jsonl");
  writeFileSync(state, "{}");
  const environment = { ...process.env, CODEX_HOME: home, YUI_FAKE_TITLE_STATE: state,
    YUI_FAKE_TITLE_EVENTS: events, ...extra };
  const request = {
    home, accountHome: home, command: process.execPath,
    baseArgs: [resolve("test/fixtures/fake-native-title.mjs")], environment,
    identity: { scope: "task", taskId: "task-1", roleName: "leader", agentId: "codex", threadId: "thread-1" },
    newThread: true, title: "Yui Leader task-1 Draft @dev · 修复", timeoutMs: 1000
  };
  return { request, state, events, changes: () => existsSync(events)
    ? readFileSync(events, "utf8").trim().split("\n").map(JSON.parse).filter(item => item.method) : [] };
}

test("native title receipts preserve manual names and fence reconnect/duplicate responses", async t => {
  const f = fixture(t);
  const first = await synchronizeNativeTitle(f.request);
  assert.equal(first.status, "confirmed");
  assert.equal(JSON.parse(readFileSync(f.state)).name, f.request.title);
  assert.deepEqual(confirmedNativeTitles(f.request.home, f.request.identity), [f.request.title]);
  assert.equal((await synchronizeNativeTitle({ ...f.request, newThread: false })).status, "confirmed");
  assert.equal(f.changes().length, 1);
  const executionTitle = "Yui Leader task-1 @dev · 修复";
  assert.equal((await synchronizeNativeTitle({ ...f.request, newThread: false,
    localTitle: "My local name", generatedTitle: executionTitle })).status, "preserved");
  assert.equal(f.changes().length, 1);
  assert.equal((await synchronizeNativeTitle({ ...f.request, newThread: false,
    localTitle: f.request.title, generatedTitle: executionTitle })).status, "confirmed",
  "Native evidence resolves a stale local generated label.");
  assert.deepEqual(confirmedNativeTitles(f.request.home, f.request.identity), [f.request.title, executionTitle]);
  writeFileSync(f.state, JSON.stringify({ name: "My title" }));
  assert.equal((await synchronizeNativeTitle({ ...f.request, newThread: false, title: "Yui Leader task-1 @new · 修复" })).status, "preserved");
  assert.equal(f.changes().length, 2);
  writeFileSync(f.state, JSON.stringify({ name: "Yui Host checked current Skills; no Agent check needed." }));
  assert.equal((await synchronizeNativeTitle({ ...f.request, newThread: false })).status, "preserved");
  assert.equal(f.changes().length, 2, "A pollution prefix is not generated-name ownership.");
});

test("persisted-but-unanswered rename is unknown, never replayed after reconnect", async t => {
  const f = fixture(t, { YUI_FAKE_TITLE_STALL: "1" });
  const result = await synchronizeNativeTitle({ ...f.request, timeoutMs: 250 });
  assert.equal(result.status, "unknown");
  assert.equal(JSON.parse(readFileSync(f.state)).name, f.request.title, "Mutation really happened before the lost reply.");
  assert.equal((await synchronizeNativeTitle({ ...f.request, newThread: false })).status, "not-submitted");
  assert.equal(f.changes().length, 1);
  assert.deepEqual(confirmedNativeTitles(f.request.home, f.request.identity), []);
  const saved = JSON.parse(readFileSync(join(nativeTitleDirectory(f.request.home, f.request.identity), "receipt.json")));
  assert.equal(saved.status, "unknown");
  assert.equal(saved.attemptId, result.attemptId);
});

test("native account mismatch and unowned historic names are never changed", async t => {
  const f = fixture(t, { YUI_FAKE_TITLE_ACCOUNT: "/not-the-business-account" });
  assert.equal((await synchronizeNativeTitle(f.request)).status, "not-submitted");
  assert.equal(f.changes().length, 0);
  delete f.request.environment.YUI_FAKE_TITLE_ACCOUNT;
  assert.equal((await synchronizeNativeTitle({ ...f.request, newThread: false })).status, "preserved");
  assert.equal(f.changes().length, 0, "An unnamed historical Thread is not newly owned.");
});

test("metadata process exit rejects later requests without waiting for a lost deadline", async t => {
  const f = fixture(t);
  const client = await CodexNamingClient.start(f.request.command, f.request.environment, f.request.baseArgs, 1000);
  client.child.kill("SIGKILL");
  await client.exited;
  await assert.rejects(client.request("thread/read", { threadId: "thread-1" }), /closed/);
});

test("an intervening manual rename or malformed receipt never becomes a confirmed automatic rename", async t => {
  const edited = fixture(t, { YUI_FAKE_TITLE_EDIT_BEFORE_WRITE: "1" });
  assert.equal((await synchronizeNativeTitle(edited.request)).status, "preserved");
  assert.equal(edited.changes().length, 0);
  assert.equal(JSON.parse(readFileSync(edited.state)).name, "Manual between reads");
  const malformed = fixture(t, { YUI_FAKE_TITLE_BAD_REPLY: "1" });
  assert.equal((await synchronizeNativeTitle(malformed.request)).status, "unknown");
  assert.deepEqual(confirmedNativeTitles(malformed.request.home, malformed.request.identity), []);
});

test("a stalled metadata process cannot block business Goal or Turn control", async t => {
  const f = fixture(t, { YUI_FAKE_TITLE_STALL: "1", YUI_FAKE_STALL_THREAD_NAME: "1" });
  let done;
  const terminal = new Promise(resolve => { done = resolve; });
  let reported;
  const titleResult = new Promise(resolve => { reported = resolve; });
  const opened = await startStructuredProviderSession({
    schemaVersion: 1, command: process.execPath,
    args: [resolve("test/fixtures/fake-codex-app-server-proxy.mjs")], cwd: resolve("."),
    executionEnvironment: { taskId: "task-1", preparationId: "preparation-1",
      environmentRef: "task-1/preparation-1", access: "write", isolation: "trusted-local",
      directory: { path: f.request.home, device: "1", inode: "1", ownership: "preparation" } },
    environment: { ...f.request.environment, YUI_HOME: f.request.home, YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: "task-1", YUI_ROLE: "leader", YUI_AGENT_ID: "codex",
      YUI_AGENT_BASE_ARGS: JSON.stringify(f.request.baseArgs) },
    childLifecycle: "persistent", startMode: "provider",
    providerControl: { schemaVersion: 1, adapterId: "codex", transport: "codex-app-server-proxy",
      kind: "start", mode: "new", sessionOnly: true, sessionTitle: f.request.title,
      authority: { epoch: 1, owner: "controller", holderId: "controller" }, codexThread: {} }
  }, { onTerminal: done, mirrorOutput: (_stream, text) => {
    if (text.startsWith("Native title: ")) reported(JSON.parse(text.slice("Native title: ".length)));
  } });
  t.after(() => opened.session.terminate("SIGTERM"));
  assert.equal(opened.goal, null);
  await opened.session.submitTurn({ attemptId: "business-1", boundedText: "continue" });
  assert.equal((await terminal).status, "completed");
  assert.equal((await titleResult).status, "unknown");
  assert.equal(opened.session.appliedGeneratedTitle, undefined);
  assert.equal(f.changes().length, 1);
});
