import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { CURRENT_CONFIG_SCHEMA_VERSION } from "../../dist/storage/taskStore.js";
import { createJobDefinition } from "../../dist/job/jobDefinition.js";
import { createWebJobs } from "../../dist/web/webJobs.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";
import { createJobDefinitionControl } from "../../dist/controller/jobDefinitionControl.js";
import { createWebTaskSurface } from "../../dist/web/webTaskSurface.js";
import vm from "node:vm";
import { JOBS_SCRIPT } from "../../dist/web/assets/client/views/jobs.js";

test("Web Job ingress fixes scope, rejects caller injection and preserves exact Run / schedule semantics", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-web-jobs-"));
  let server, store;
  t.after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    store?.close(); rmSync(home, { recursive: true, force: true });
  });
  store = new SqliteTaskStore(home);
  const now = new Date();
  const agent = createConfiguredAgent("codex", "codex", "false", [], [], now);
  store.saveConfiguredAgent(agent);
  store.saveConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION, defaultAgent: agent.id, defaultWorkspace: home });
  const role = createGlobalRole("operator", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.createGlobalRoleIfAbsent(role);
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "global", roleName: "operator" }, agent.id, now
  ), { agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: "web-jobs",
    status: "active", policy: "fixed", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, now));
  for (const taskId of ["task-1", "task-2"]) {
    assert.equal(store.nextTaskId(), taskId);
    store.saveTask(createTask(taskId, taskId, now));
    store.saveJobDefinition(createJobDefinition({ id: "owned-" + taskId, title: taskId,
      scope: { kind: "task", taskId },
      configuration: { kind: "shell", owner: { kind: "task", taskId }, projectId: "project-1",
        workspace: home, head: "a".repeat(40), env: {}, steps: [{ name: "probe", command: "true" }] }
    }, now));
  }
  server = createYuiWebServer(store, { token: "test-token", jobs: createWebJobs(store, home),
    surface: createWebTaskSurface(store, home) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(base + "/settings/jobs")).status, 200, "Jobs settings is directly navigable/reloadable");
  const api = async (path, body, headers = {}) => {
    const response = await fetch(base + "/api/" + path, {
      headers: { "x-yui-web-token": "test-token", "content-type": "application/json", origin: base, ...headers },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {})
    });
    return { status: response.status, body: await response.json() };
  };
  const global = "settings/jobs", task = "tasks/task-1/jobs";
  const config = { kind: "builtin", action: "system.noop", input: {} };
  assert.equal((await api(global, { op: "define", id: "noop", title: "Probe", configuration: config })).status, 200);
  assert.equal((await api(global, { op: "define", id: "cross-origin", title: "Probe", configuration: config },
    { origin: "http://other.invalid" })).status, 403);
  assert.deepEqual((await api(task + "?op=list")).body.map(j => j.id), ["owned-task-1"]);
  assert.equal((await api(task + "?op=show&id=owned-task-2")).status, 409);
  assert.equal((await api(task + "?op=list&scope=global")).status, 409);
  assert.equal((await api(global, { op: "run", id: "noop", requestId: "bad", caller: { scope: "user" } })).status, 409);
  assert.equal((await api(task, { op: "run", id: "noop", requestId: "bad", scope: { kind: "global" } })).status, 409);
  assert.equal((await api(task, { op: "run", id: "owned-task-1", requestId: "terminal" })).status, 409);
  assert.equal((await api(global + "?op=list", null, { "x-yui-web-token": "wrong" })).status, 403);
  const plan = (await api("settings/schedules", { op: "create", id: "cadence", jobId: "noop",
    authorization: "service",
    rule: { kind: "interval", anchor: now.toISOString(), everyMs: 60000 } })).body;
  const first = (await api(global, { op: "run", id: "noop", requestId: "first" })).body;
  assert.equal(first.run.status, "queued");
  assert.equal((await api(global, { op: "run", id: "noop", requestId: "second" })).body.reason, "overlap");
  assert.equal((await api("settings/schedules?op=show&id=cadence")).body.schedule.nextDue, plan.nextDue);
  const cancel = (await api(global, { op: "run-cancel", id: "noop", runId: first.run.id })).body;
  assert.ok(cancel.cancelRequestedAt);
  assert.equal((await api("settings/schedules", { op: "disable", id: "cadence", expectedRevision: plan.revision })).body.state, "disabled");
  assert.equal((await api(global + "?op=run-get&id=noop&runId=" + first.run.id)).body.id, first.run.id);
  assert.equal((await api(global + "?op=runs&id=noop")).body.length, 1);
  const control = createJobDefinitionControl(store, home);
  const saved = await control({ op: "artifact-save", scope: { kind: "global" }, caller: { scope: "user" },
    id: "noop", runId: first.run.id, artifact: { relativePath: "report.md", content: "# Fixed first version" } }, now);
  await control({ op: "artifact-save", scope: { kind: "global" }, caller: { scope: "user" },
    id: "noop", runId: first.run.id, artifact: { relativePath: "report.md", content: "# Later version",
      expectedHead: saved.reference.version } }, now);
  const preview = new URLSearchParams({ op: "artifact-preview", id: "noop", runId: first.run.id,
    reference: JSON.stringify(saved.reference), offset: "0" });
  const pinned = await api(global + "?" + preview);
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  assert.equal(pinned.body.content, "# Fixed first version", "refresh reads selected commit, not HEAD");
  preview.set("reference", JSON.stringify({ ...saved.reference, relativePath: "private.md" }));
  assert.equal((await api(global + "?" + preview)).status, 409, "only registered exact objects are readable");
  assert.equal((await api(task + "?op=artifact-list&id=noop&runId=" + first.run.id)).status, 409);
  assert.equal((await api(global + "?op=artifact-list&id=noop&runId=" + first.run.id)).body.artifacts.length, 2);
  assert.equal((await api("settings/schedules", { op: "enable", id: "cadence", expectedRevision: plan.revision })).status, 409);
  store.saveTask(activateTask(store.getTask("task-1"), now));
  assert.equal((await api(task, { op: "define", id: "delegate", title: "Task A delivery",
    configuration: { kind: "task", goal: "delivery", target: { kind: "new", title: "Task B",
      description: "Isolated delegated delivery", projectBindings: [] } } })).status, 200);
  const admitted = await api(task, { op: "run", id: "delegate", requestId: "delegate-one" });
  assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
  const delegated = admitted.body.run;
  const targetId = delegated.delegation.taskId;
  assert.notEqual(targetId, "task-1");
  assert.equal(store.getTask(targetId).source.run.runId, delegated.id);
  assert.deepEqual((await api("tasks/" + targetId + "/workbench")).body.task.source, store.getTask(targetId).source,
    "bounded Task header carries exact immutable source, even when full Task record is omitted");
  assert.deepEqual((await api("tasks/" + targetId + "/jobs?op=list")).body, [], "source Job is not owned by target Task");
  const ordinary = (await api("dashboard?source=ordinary")).body.tasks;
  const instances = (await api("dashboard?source=job")).body.tasks;
  assert.ok(ordinary.every(t => t.id !== targetId));
  assert.ok(instances.some(t => t.id === targetId));
  assert.ok((await api("dashboard?search=Task%20B")).body.tasks.some(t => t.id === targetId));
  await api(task, { op: "run-cancel", id: "delegate", runId: delegated.id });
  assert.equal(store.getTask(targetId).status, "draft", "cancel only requests delegation cancellation, never stops target");
  assert.equal(store.getTask("task-1").executionGate.state, "enabled");
  assert.equal((await api(global, { op: "define", id: "agent-view", title: "Agent",
    configuration: { kind: "agent", target: { kind: "job", agentId: "codex" }, input: "fixture only" } })).status, 200);
  const agentRun = (await api(global, { op: "run", id: "agent-view", requestId: "agent-one" })).body.run;
  assert.equal((await api(global + "?op=run-get&id=agent-view&runId=" + agentRun.id)).body.executor, "agent");
  assert.equal((await api(global + "?op=run-evidence&id=agent-view&runId=" + agentRun.id)).body.attempts.length, 1);
  assert.equal((await api(global + "?op=session-inspect&id=agent-view")).status, 200);
  assert.equal((await api(global, { op: "session-new", id: "agent-view", expectedSessionId: "unobserved" })).status, 409);
});

test("global Web management uses local user authority without an Operator Session", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-web-sessionless-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const web = createWebJobs(store, home), scope = { kind: "global" }, now = new Date();
  web.mutate(scope, "jobs", { op: "define", id: "local", title: "Local",
    configuration: { kind: "builtin", action: "system.noop", input: {} } }, now);
  assert.equal(web.read(scope, "jobs", { op: "list" }, now).length, 1);
  assert.equal(web.mutate(scope, "jobs", { op: "run", id: "local", requestId: "once" }, now).run.operation.actorId, "user");
  assert.equal(store.getGlobalRoleSessionSet("operator"), null);
  assert.equal(store.listTasks().length, 0);
});

test("Job view keeps historical Agent results when diagnostics fail and never replays an unknown write", async () => {
  const elements = [], reads = [], writes = [];
  const h = (spec, attrs, ...children) => {
    const node = { spec, ...attrs, children: children.flat().filter(v => v != null), dataset: {}, disabled: false,
      classList: { add() {}, toggle() {} }, append(...items) { this.children.push(...items.flat()); },
      prepend(...items) { this.children.unshift(...items); }, replaceChildren(...items) { this.children = items.flat(); },
      querySelectorAll() { return []; }, addEventListener() {} };
    elements.push(node); return node;
  };
  const run = (id, outcome, day) => ({ id, executor: "agent", status: outcome, createdAt: `2026-10-${day}T00:00:00Z`,
    trigger: { source: "manual", key: id }, configuration: { kind: "agent", target: { kind: "operator" } },
    businessResult: { outcome, summary: id + " business result" } });
  const old = run("old-success", "succeeded", "17"), latest = run("new-failure", "failed", "18");
  const job = { id: "analysis", title: "Analysis", revision: 1, configuration: old.configuration };
  const location = new URL("http://fixture/settings/jobs?job=analysis&jobRun=old-success");
  const ctx = vm.createContext({
    h, URL, URLSearchParams, location, history: { state: {}, replaceState(_state, _title, url) { location.href = String(url); } },
    window: { confirm: () => true }, crypto: { randomUUID: () => "one-request" },
    requestJson: async url => {
      reads.push(url); const q = new URL(url, location).searchParams;
      if (url.includes("/schedules")) return [];
      if (q.get("op") === "list") return [job];
      if (q.get("op") === "runs") return [old, latest];
      if (q.get("op") === "run-get") return q.get("runId") === old.id ? old : latest;
      throw new Error("diagnostic unavailable");
    },
    submitMutation: async (...args) => { writes.push(args); throw Object.assign(new Error("lost receipt"), { disposition: "unknown" }); }
  });
  vm.runInContext(JOBS_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), ctx);
  const root = h("div"), view = ctx.mountJobs(root, key => key);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  const text = node => typeof node === "string" ? node : [node?.textContent, ...(node?.children || []).map(text)].join(" ");
  assert.match(text(root), /new-failure.*failed/);
  assert.match(text(root), /jobs.recentSuccess.*old-success.*succeeded/);
  assert.match(text(root), /old-success business result/);
  assert.match(text(root), /diagnostic unavailable/);
  assert.equal(reads.some(url => url.includes("op=logs")), false, "Agent history must not require process logs");
  await view.refresh(); await flush();
  assert.equal(new URL(reads.filter(url => url.includes("op=run-get")).at(-1), location).searchParams.get("runId"), old.id);
  const runNow = elements.findLast(n => n.children?.includes("jobs.runNow"));
  runNow.onclick(); await flush();
  assert.match(text(root), /jobs.unknown/);
  runNow.onclick(); await flush();
  assert.equal(writes.length, 1, "unknown submission is not retried with a fresh request id");
});
