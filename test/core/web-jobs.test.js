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
import { JOBS_APP_SCRIPT } from "../../dist/web/assets/client/app/jobs.js";
import { MANAGE_SHELL_SCRIPT } from "../../dist/web/assets/client/layout/manageShell.js";

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
  assert.equal((await fetch(base + "/jobs")).status, 200, "the Jobs entry is directly navigable/reloadable");
  assert.equal((await fetch(base + "/jobs?task=task-1&job=owned-task-1")).status, 200);
  assert.equal((await fetch(base + "/settings/jobs")).status, 200, "the retired Settings address still opens (client redirects)");
  const api = async (path, body, headers = {}) => {
    const response = await fetch(base + "/api/" + path, {
      headers: { "x-yui-web-token": "test-token", "content-type": "application/json", origin: base, ...headers },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {})
    });
    return { status: response.status, body: await response.json() };
  };
  // Scope discovery: the global scope plus every Task that owns Jobs/plans, counts per scope.
  const scopes = (await api("jobs/scopes")).body;
  assert.deepEqual(scopes.global, { definitions: 0, schedules: 0, enabledSchedules: 0 });
  assert.deepEqual(scopes.tasks.map(item => [item.taskId, item.definitions]), [["task-2", 1], ["task-1", 1]]);
  assert.equal((await api("jobs/scopes?task=task-1")).status, 400, "scope discovery takes no caller options");
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
  // The Web Task list reads without a category: every real Task, the Job-created one marked by its source.
  const everyTask = (await api("dashboard")).body;
  assert.equal(everyTask.total, store.listTasks().length);
  assert.equal(everyTask.tasks.find(t => t.id === targetId).source.kind, "job-run");
  assert.ok(everyTask.tasks.some(t => t.id === "task-1"));
  const scopedAfter = (await api("jobs/scopes")).body;
  assert.equal(scopedAfter.global.definitions, 1);
  assert.equal(scopedAfter.global.schedules, 1);
  assert.equal(scopedAfter.tasks.find(item => item.taskId === "task-1").definitions, 2);
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
  const job = { id: "analysis", title: "Analysis", revision: 1,
    configuration: { ...old.configuration, input: "Summarize the week", futureField: { nested: "kept" } } };
  const location = new URL("http://fixture/settings/jobs?job=analysis&jobRun=old-success");
  const ctx = vm.createContext({
    h, URL, URLSearchParams, location, formatDateTime: iso => iso, icon: () => h("svg"),
    badge: (label, tone) => h("span.badge", { dataset: { tone } }, label), dot: (tone, label) => h("span.dot", { title: label }),
    history: { state: {}, replaceState(_state, _title, url) { location.href = String(url); } },
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
  // Configuration reads as named fields; unknown fields stay visible and the
  // exact JSON is only inside a closed disclosure.
  assert.match(text(root), /jobs.cfg.agentInput.*Summarize the week/);
  assert.match(text(root), /jobs.cfg.other.*futureField.*kept/);
  const rawViews = elements.filter(n => n.spec === "details.job-raw");
  assert.ok(rawViews.some(n => text(n).includes('"futureField"')) && rawViews.every(n => !n.open));
  assert.equal(reads.some(url => url.includes("op=logs")), false, "Agent history must not require process logs");
  await view.refresh(); await flush();
  assert.equal(new URL(reads.filter(url => url.includes("op=run-get")).at(-1), location).searchParams.get("runId"), old.id);
  const runNow = elements.findLast(n => n.children?.includes("jobs.runNow"));
  runNow.onclick(); await flush();
  assert.match(text(root), /jobs.unknown/);
  runNow.onclick(); await flush();
  assert.equal(writes.length, 1, "unknown submission is not retried with a fresh request id");
});

test("Job index counts, searches and empties exactly one scope and routes a pick through history", async () => {
  const h = (spec, attrs, ...children) => ({ spec, ...attrs, children: children.flat().filter(v => v != null), dataset: { ...(attrs?.dataset || {}) },
    disabled: false, classList: { add() {}, toggle() {} }, append(...items) { this.children.push(...items.flat()); },
    replaceChildren(...items) { this.children = items.flat().filter(v => v != null); }, querySelectorAll() { return []; },
    addEventListener(name, fn) { this["on" + name] = fn; } });
  const sync = { id: "project-sync-project-1", title: "Project sync · Yui", revision: 1, builtin: "project-sync",
    configuration: { kind: "builtin", action: "project.refresh", projectId: "project-1" },
    results: { latest: { status: "failed" } } };
  const report = { id: "weekly-report", title: "Weekly report", revision: 2,
    configuration: { kind: "shell", projectId: "project-2" } };
  const plan = { id: "project-sync-project-1", jobId: sync.id, state: "eligible", builtin: { enabled: false, projectId: "project-1" },
    nextDue: "2026-10-22T00:00:00Z", rule: { kind: "interval", anchor: "2026-10-01T00:00:00Z", everyMs: 3600000 } };
  let jobs = [sync, report];
  const location = new URL("http://fixture/jobs");
  const picks = [];
  const ctx = vm.createContext({ h, URL, URLSearchParams, location, formatDateTime: iso => iso, icon: () => h("svg"),
    badge: (label, tone) => h("span.badge", { dataset: { tone } }, label), dot: (tone, label) => h("span.dot", { title: label, dataset: { tone } }),
    history: { state: {}, replaceState() { throw new Error("index picks are history steps, not replacements"); } },
    window: { confirm: () => true }, crypto: { randomUUID: () => "x" },
    requestJson: async url => {
      const q = new URL(url, location).searchParams;
      assert.ok(url.startsWith("/api/settings/"), "the global scope reads only global records");
      if (url.includes("/schedules")) return q.get("op") === "list" ? [plan] : { schedule: plan };
      if (q.get("op") === "list") return jobs;
      if (q.get("op") === "runs") return [];
      return {};
    },
    submitMutation: async () => { throw new Error("no writes"); } });
  vm.runInContext(JOBS_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), ctx);
  const text = node => typeof node === "string" ? node : [node?.textContent, ...(node?.children || []).map(text)].join(" ");
  const walk = node => node && typeof node === "object" ? [node, ...(node.children || []).flatMap(walk)] : [];
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const t = (key, fallback) => ({ "jobs.count": "{total} Jobs", "jobs.countFiltered": "{shown} of {total} Jobs" })[key] ?? fallback ?? key;
  const index = h("div"), root = h("div");
  const view = ctx.mountJobs(root, t, undefined, { index, navigate: selection => picks.push(selection),
    heading: { title: "Jobs", hint: "hint" }, notice: "moved" });
  await flush();
  const rows = () => walk(index).filter(n => n.spec === "button.job-row");
  assert.equal(rows().length, 2);
  assert.match(text(index), /2 Jobs/);
  const syncRow = rows().find(n => n.dataset.job === sync.id);
  assert.match(text(syncRow), /jobs.type.projectSync/, "the builtin Project sync reads as its own Job type");
  assert.equal(walk(syncRow).find(n => n.spec === "span.dot").dataset.tone, "idle", "an off plan shows the on/off preference");
  assert.equal(walk(syncRow).find(n => n.spec === "span.badge").dataset.status, "failed", "Run status is a separate badge");
  assert.match(text(rows().find(n => n.dataset.job === report.id)), /jobs.noSchedule.*/);
  assert.match(text(root), /moved/);
  const search = walk(index).find(n => n.spec === "input");
  search.value = "weekly"; search.oninput();
  assert.deepEqual(rows().map(n => n.dataset.job), [report.id]);
  assert.match(text(index), /1 of 2 Jobs/);
  search.value = "nothing"; search.oninput();
  assert.equal(rows().length, 0);
  assert.match(text(index), /jobs.noMatch/);
  search.value = ""; search.oninput();
  rows().find(n => n.dataset.job === sync.id).onclick();
  assert.deepEqual(picks.map(p => ({ ...p })), [{ job: sync.id }]);
  view.select(sync.id); await flush();
  assert.equal(rows().find(n => n.dataset.job === sync.id)["aria-current"], "true");
  jobs = []; await view.refresh(false); await flush();
  assert.match(text(index), /0 Jobs/);
  assert.match(text(index), /jobs.empty/);
});

test("Jobs entry keeps one live view across every route source: drafts, writes in flight, late reads and artifacts", async () => {
  const h = (spec, attrs, ...children) => ({ spec, ...attrs, children: children.flat().filter(v => v != null),
    dataset: { ...(attrs?.dataset || {}) }, hidden: false, disabled: false, classList: { add() {}, toggle() {} },
    append(...items) { this.children.push(...items.flat().filter(v => v != null)); },
    prepend(...items) { this.children.unshift(...items); },
    replaceChildren(...items) { this.children = items.flat().filter(v => v != null); },
    querySelectorAll() { return []; }, querySelector() { return null; },
    addEventListener(name, fn) { this["on" + name] = fn; } });
  const walk = node => node && typeof node === "object" ? [node, ...(node.children || []).flatMap(walk)] : [];
  const text = node => walk(node).map(n => typeof n === "string" ? n : n.textContent || "").join(" ")
    + " " + walk(node).flatMap(n => n.children || []).filter(c => typeof c === "string").join(" ");
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  const nodes = new Map();
  const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, h("div")); return nodes.get(key); },
    addEventListener(name, fn) { this["on" + name] = fn; } };
  const location = new URL("http://fixture/jobs?job=old&jobRun=old-run");
  const history = { state: null, pushes: 0,
    replaceState(state, _, url) { this.state = state; if (url) location.href = new URL(url, location).href; },
    pushState(state, _, url) { this.pushes++; this.replaceState(state, _, url); } };
  const handlers = {};
  let confirmAnswer = true, confirms = 0, alerts = 0;
  const window = { addEventListener(name, fn) { handlers[name] = fn; }, confirm: () => { confirms++; return confirmAnswer; },
    alert: () => { alerts++; } };
  // Reads answer at once unless a test holds them; held reads resolve later.
  const held = [], reads = [];
  let holdGlobalList = true, pendingWrite = null;
  const ref = version => ({ version: version.repeat(40), relativePath: version + ".md", owner: { kind: "job" } });
  const records = {
    global: { jobs: [{ id: "old", title: "Old", revision: 1, configuration: { kind: "shell" } }],
      runs: [{ id: "old-run", status: "succeeded", createdAt: "2026-10-20T00:00:00Z", trigger: { source: "manual", key: "k" },
        configuration: { kind: "shell" }, artifacts: [ref("a"), ref("b")] }] },
    task: { jobs: [{ id: "new", title: "New", revision: 1, configuration: { kind: "shell" } },
      { id: "other", title: "Other", revision: 1, configuration: { kind: "shell" } }], runs: [] }
  };
  const requestJson = url => {
    reads.push(url);
    if (url === "/api/jobs/scopes") return Promise.resolve({ tasks: [{ taskId: "task-2", title: "Two" }] });
    const q = new URL(url, location).searchParams;
    const scope = url.startsWith("/api/tasks/task-2/") ? records.task : records.global;
    const value = url.includes("/schedules") ? [] : q.get("op") === "list" ? scope.jobs : q.get("op") === "runs" ? scope.runs
      : q.get("op") === "run-get" ? scope.runs.find(r => r.id === q.get("runId"))
      : q.get("op") === "artifact-preview" ? { text: "preview" } : [];
    if (holdGlobalList && scope === records.global && q.get("op") === "list") {
      holdGlobalList = false;
      return new Promise(resolve => held.push(() => resolve(value)));
    }
    return Promise.resolve(value);
  };
  const ctx = vm.createContext({ h, icon: () => h("svg"), URL, URLSearchParams, location, history, window, document,
    formatDateTime: iso => iso, badge: label => h("span.badge", null, label), dot: () => h("span.dot"),
    drawArtifact: viewer => viewer.replaceChildren("artifact-drawn"), crypto: { randomUUID: () => "r" }, CSS: { escape: v => v },
    createI18n: () => ({ t: key => key, subscribe() {}, getLocale: () => "en" }), requestJson,
    submitMutation: () => new Promise(resolve => { pendingWrite = resolve; }),
    rememberPlace() {}, linkPlaces() {} });
  const body = script => script.replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  const shell = vm.runInContext("(() => {" + body(MANAGE_SHELL_SCRIPT)
    + "\nreturn { i18n, registerManagePage, navigateManage, replaceManageRoute, pushManageRoute, startManagement };})()", ctx);
  const views = vm.runInContext("(() => {" + body(JOBS_SCRIPT) + "\nreturn { mountJobs };})()", ctx);
  const mounts = [];
  Object.assign(ctx, shell, { mountJobs: (...args) => { mounts.push(args[2] || "global"); return views.mountJobs(...args); } });
  for (const page of ["models", "settings"]) shell.registerManagePage(page, { show() {} });
  vm.runInContext("(() => {" + body(JOBS_APP_SCRIPT) + "})()", ctx);
  shell.startManagement();
  const here = () => location.pathname + location.search;
  const root = nodes.get("#jobs-root");
  const editorOpen = () => walk(root).some(n => typeof n.spec === "string" && n.spec.startsWith("form."));
  const openDraft = () => {
    walk(nodes.get("#jobs-index")).find(n => n.id === "jobs-create").onclick();
    walk(root).find(n => typeof n.spec === "string" && n.spec.startsWith("form.")).oninput();
  };

  // 1. A late read of a replaced view never writes the new view's address.
  assert.deepEqual(mounts, ["global"]);
  shell.navigateManage({ page: "jobs", section: "jobs", task: "task-2", job: "new" });
  await flush();
  assert.deepEqual(mounts, ["global", "task-2"]);
  held.forEach(release => release()); await flush();
  assert.equal(here(), "/jobs?task=task-2&job=new", "the retired global view must not pin old/old-run");

  // 2. A draft is discarded only on confirmation, for links, controls and Back/Forward alike.
  openDraft();
  confirmAnswer = false;
  assert.equal(shell.navigateManage({ page: "jobs", section: "jobs", task: null }), false);
  assert.equal(here(), "/jobs?task=task-2&job=new");
  assert.deepEqual(mounts, ["global", "task-2"], "a cancelled scope change keeps the view");
  const pushes = history.pushes;
  location.href = "http://fixture/jobs?job=old";
  handlers.popstate(); await flush();
  assert.equal(here(), "/jobs?task=task-2&job=new", "a cancelled Back restores the kept view's address");
  assert.equal(history.pushes, pushes + 1);
  location.href = "http://fixture/jobs?task=task-2&job=other";
  handlers.popstate(); await flush();
  assert.equal(here(), "/jobs?task=task-2&job=new", "a cancelled same-scope Job change keeps the editor's Job");
  assert.equal(editorOpen(), true);
  assert.equal(confirms, 3);
  confirmAnswer = true;
  location.href = "http://fixture/jobs?task=task-2&job=other";
  handlers.popstate(); await flush();
  assert.equal(editorOpen(), false, "an editor never outlives the Job it was opened on");
  assert.equal(here(), "/jobs?task=task-2&job=other");
  assert.deepEqual(mounts, ["global", "task-2"]);

  // 3. A write in flight keeps its selection; leaving Jobs keeps the view and its receipt
  //    lands without rewriting the page that is now shown.
  walk(root).find(n => n.spec === "button.btn.btn-primary" && n.children.includes("jobs.runNow")).onclick();
  assert.equal(shell.navigateManage({ page: "jobs", section: "jobs", task: null }), false);
  assert.match(text(root), /jobs.leaveBusy/);
  assert.equal(shell.navigateManage({ page: "settings", section: "preferences" }), true);
  assert.equal(here(), "/settings/preferences");
  pendingWrite({ run: { id: "run-9", status: "queued" } }); await flush();
  assert.equal(here(), "/settings/preferences", "a hidden Jobs view must not write the Settings address");
  assert.match(text(root), /run-9/, "the receipt stays observable in the kept view");
  assert.deepEqual(mounts, ["global", "task-2"]);

  // 4. An artifact-only route change opens exactly that artifact.
  holdGlobalList = false;
  const a = JSON.stringify(ref("a")), b = JSON.stringify(ref("b"));
  shell.navigateManage({ page: "jobs", section: "jobs", task: null, job: "old", jobRun: "old-run", artifact: a });
  await flush();
  location.href = "http://fixture/jobs?" + new URLSearchParams({ job: "old", jobRun: "old-run", artifact: b });
  handlers.popstate(); await flush();
  const previews = reads.filter(url => url.includes("artifact-preview")).map(url => new URL(url, location).searchParams.get("reference"));
  assert.equal(previews.at(-1), b);
  assert.equal(new URL(location.href).searchParams.get("artifact"), b);
  assert.equal(alerts, 0);

  // 5. A Run opened from its row shows directly under that row and is one
  //    history step: Back closes it again, Forward reopens it in place.
  shell.navigateManage({ page: "jobs", section: "jobs", task: null, job: "old" }); await flush();
  const runRow = () => walk(root).find(n => n.spec === "button.job-run-row");
  const underRow = () => { const list = walk(root).find(n => (n.children || []).includes(runRow()));
    const next = list.children[list.children.indexOf(runRow()) + 1];
    return typeof next?.spec === "string" && next.spec.startsWith("div.job-run-inline") ? next : null; };
  assert.equal(runRow()["aria-expanded"], "false");
  const before = history.pushes;
  runRow().onclick(); await flush();
  assert.equal(here(), "/jobs?job=old&jobRun=old-run");
  assert.equal(history.pushes, before + 1, "opening a Run is a history step");
  assert.equal(runRow()["aria-expanded"], "true");
  assert.match(text(underRow()), /old-run/, "the Run detail is the row's next sibling, not appended below the list");
  location.href = "http://fixture/jobs?job=old";
  handlers.popstate(); await flush();
  assert.equal(runRow()["aria-expanded"], "false", "Back closes the Run opened in place");
  location.href = "http://fixture/jobs?job=old&jobRun=old-run";
  handlers.popstate(); await flush();
  assert.equal(runRow()["aria-expanded"], "true");
  assert.match(text(underRow()), /old-run/);
});
