import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, activateTask, completeTask } from "../../dist/task/task.js";
import { createTaskBrief } from "../../dist/brief/taskBrief.js";
import { createDecision } from "../../dist/decision/decision.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { inspectTaskContext } from "../../dist/context/taskContext.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { completeRun } from "../../dist/agentRun/agentRun.js";
import { createFixtureRun } from "../helpers/runFixture.mjs";
import { readDocument } from "../helpers/read-document.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";
import { createWebTaskSurface } from "../../dist/web/webTaskSurface.js";

test("body search pages authoritative records, pins originals and never widens Task scope", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-search-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-10-10T00:00:00Z");
  for (const id of ["task-1", "task-2"]) {
    store.saveTask(completeTask(activateTask(createTask(id, "Unrelated title", now), now), now,
      { by: "leader", summary: `正文 needle ${id}` }));
    store.saveTaskBrief(id, createTaskBrief({ objective: "正文 needle", boundaries: [],
      currentFocus: "Done", leaderSummary: "Retained", updatedBy: "leader" }, now));
    store.saveDecision(id, createDecision("decision-1", id, "Choice", "正文 needle rationale", now));
  }
  const search = (environment = {}, ...args) =>
    runTaskCommand(["search", "needle", "--limit", "2", ...args], store, { environment }).data;
  const revision = store.getStateRevision();
  const first = search();
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const items = [...first.items];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = search({}, "--cursor", cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  }
  assert.equal(items.length, 6);
  assert.deepEqual(new Set(items.map(item => item.kind)), new Set(["brief", "decision", "completion"]));
  const hit = items.find(item => item.kind === "brief");
  assert.match(hit.snippet, /正文 needle/);
  assert.equal(inspectTaskContext(store, hit.taskId, hit.ref).value.objective, "正文 needle");
  assert.equal(hit.authority, "reference-only");
  assert.equal(store.getStateRevision(), revision);
  store.saveTaskBrief(hit.taskId, { ...store.getTaskBrief(hit.taskId), objective: "Revised" });
  assert.throws(() => inspectTaskContext(store, hit.taskId, hit.ref), /changed/);
  assert.equal(search({}, "--kind", "brief").items.length, 1);
  assert.throws(() => search({}, "--kind", "message", "--cursor", first.nextCursor), /cursor/i);
  assert.throws(() => search({}, "--limit", "101"), /limit|search/i);
  assert.throws(() => runTaskCommand(["search", " "], store), /query|search/i);

  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  for (const name of ["leader", "worker"]) {
    const role = createRole("task-1", name, [createRoleAgentBinding(agent)], agent.id, home, now);
    store.saveRole("task-1", role);
    store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
      { scope: "task", taskId: "task-1", roleName: name }, agent.id, now
    ), { agentId: agent.id, adapterId: "codex", nativeSessionId: name,
      policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, now));
  }
  const env = { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1", YUI_ROLE: "leader",
    YUI_NATIVE_SESSION_ID: "leader", YUI_WORKSPACE: home };
  assert.ok(search(env).items.every(item => item.taskId === "task-1"));
  assert.throws(() => search(env, "--task", "task-2"), /outside/i);
  assert.throws(() => search(env, "--cursor", first.nextCursor), /cursor/i);
  assert.throws(() => search({ ...env, YUI_ROLE: "worker", YUI_NATIVE_SESSION_ID: "worker" }), /Assignment/i);
  assert.throws(() => search({ YUI_ROLE: "leader" }), /identity/i);
  assert.throws(() => search({ YUI_SESSION_SCOPE: "global", YUI_ROLE: "reviewer" }), /Operator/i);
  const foreign = items.find(item => item.taskId === "task-2");
  assert.throws(() => inspectTaskContext(store, foreign.taskId, foreign.ref, env), /outside/i);
});

test("message/result bodies stay bounded, expand completely, and share the token-authenticated Web port", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-search-web-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-10-10T00:00:00Z");
  store.saveTask(createTask("task-1", "Source", now));
  const body = "正文😀".repeat(12000) + "unique match <script>alert(1)</script>" + "tail".repeat(1000);
  store.saveMessage("task-1", createTaskMessage("message-1", "task-1", body, "user", { type: "user" }, now));
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  const role = createRole("task-1", "leader", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.saveRole("task-1", role);
  const run = createFixtureRun(store, "run-1", "task-1", "leader", "new",
    { source: { type: "yui", channel: "task-dispatch" }, deltaRefIds: [] }, now,
    { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) });
  store.saveRun(completeRun(run, body, now));
  const search = (...args) => runTaskCommand(["search", "unique match", ...args], store, { environment: {} }).data;
  const before = store.getStateRevision();
  const page = search();
  assert.deepEqual(new Set(page.items.map(item => item.kind)), new Set(["message", "result"]));
  for (const hit of page.items) {
    assert.ok([...hit.snippet].length <= 320);
    assert.ok(hit.offset > 1000);
    assert.ok(!hit.snippet.includes("\uFFFD"));
    const original = readDocument(cursor => inspectTaskContext(store, hit.taskId, { ...hit.ref, cursor }));
    assert.equal(hit.kind === "message" ? original.value.body : original.value.result.output, body);
  }
  assert.equal(store.getStateRevision(), before);
  // An export is just a citation/excerpt: supplying it as recorded input in
  // a new Draft does not restore source Sessions, Runs or execution authority.
  const target = createTask("task-2", "New work", now);
  store.saveTask(target);
  const reference = { ...page.items[0], authority: "reference-only" };
  runTaskCommand(["message", "send", target.id, JSON.stringify(reference), "--intent", "record"],
    store, { environment: {}, now: () => now });
  assert.equal(store.getTask(target.id).status, "draft");
  assert.equal(store.listRuns(target.id).length, 0);
  assert.equal(store.listRoleSessionSets(target.id).length, 0);

  const server = createYuiWebServer(store, { token: "search-test", surface: createWebTaskSurface(store) });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(base + path, { headers: { "x-yui-web-token": "search-test" } });
  assert.equal((await fetch(base + "/api/search?query=unique")).status, 403);
  const response = await get("/api/search?query=unique%20match&task=task-1");
  assert.equal(response.status, 200);
  const web = await response.json();
  assert.deepEqual(web.items, page.items);
  assert.equal((await get("/api/search?query=unique&limit=101")).status, 400);
  const hit = web.items[0];
  const params = new URLSearchParams({ store: hit.ref.store, ref: hit.ref.refId, digest: hit.ref.digest });
  const expanded = await (await get(`/api/tasks/${hit.taskId}/inspect?${params}`)).json();
  assert.ok(expanded.contentPage);
  // Many escaped multibyte snippets exercise the byte budget independently
  // of the requested item limit; every page remains resumable.
  for (let i = 2; i <= 35; i++) store.saveMessage("task-1",
    createTaskMessage(`message-${i}`, "task-1", "unique match " + '"😀'.repeat(200), "user", { type: "user" }, now));
  let cursor, count = 0;
  do {
    const batch = search("--task", "task-1", "--limit", "100", ...(cursor ? ["--cursor", cursor] : []));
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: batch })) <= 32768);
    count += batch.items.length; cursor = batch.nextCursor;
  } while (cursor);
  assert.equal(count, 36);
});
