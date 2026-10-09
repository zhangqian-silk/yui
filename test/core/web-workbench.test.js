import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createProject } from "../../dist/repository/project.js";
import { activateTask, completeTask, createTask } from "../../dist/task/task.js";
import { createTaskBrief } from "../../dist/brief/taskBrief.js";
import { createInputRequest } from "../../dist/input/inputRequest.js";
import { createWebTaskSurface } from "../../dist/web/webTaskSurface.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";
import { archiveOrdinaryTask } from "../../dist/task/ordinaryArchive.js";
import { SELECTION_SCRIPT } from "../../dist/web/assets/client/app/selection.js";
import { FORMS_SCRIPT } from "../../dist/web/assets/client/ui/forms.js";
import { TASK_PAGE_SCRIPT } from "../../dist/web/assets/client/views/task/page.js";

test("Web task operations share durable intent, reject authority fields, and return actual lifecycle receipts", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-workbench-"));
  const store = new SqliteTaskStore(home);
  let server;
  t.after(async () => {
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
  });
  const now = new Date();
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  store.saveConfiguredAgent(createConfiguredAgent("codex", "codex", "false", [], [], now));
  store.saveGlobalRole(createGlobalRole("leader", [binding], "codex", home, now));
  store.saveConfig({ ...store.getConfig(), defaultAgent: "codex", defaultWorkspace: home });
  store.saveProject(createProject("project-1", "Fixture", join(home, "project"),
    { stable: "main", development: "main" }, now));
  const archiveEffects = [];
  const coordinator = {
    store, preparer: { home },
    prepareTaskForArchive: async id => { archiveEffects.push(["prepare", id]); },
    cleanupArchivedTask: async id => { archiveEffects.push(["cleanup", id]); }
  };
  const surface = createWebTaskSurface(store, { yuiHome: home }, [], undefined, {
    archive: id => archiveOrdinaryTask(coordinator, id, { environment: {}, yuiHome: home })
  });
  server = createYuiWebServer(store, {
    surface, token: "fixture-token",
    answerInput: async ({ taskId, inputId, answer }) => surface.answer(taskId, inputId, answer)
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "x-yui-web-token": "fixture-token", "content-type": "application/json" };
  const post = async (path, body, authenticated = true) => {
    const response = await fetch(base + path, {
      method: "POST", headers: authenticated ? headers : { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const input = { title: "Plan a feature", requirements: "Keep original requirements",
    projectIds: ["project-1"], plan: true, requestId: "create-plan" };
  assert.equal((await post("/api/tasks", input, false)).status, 403);
  assert.equal((await post("/api/tasks", { ...input, actor: "leader" })).status, 409);
  assert.equal((await post("/api/tasks", { ...input, projectIds: ["project-missing"] })).status, 409);
  assert.equal(store.listTasks().length, 0, "failed creation leaves no Task or planning wake");
  const created = await post("/api/tasks", input);
  assert.equal(created.status, 200);
  const id = created.body.task.id;
  assert.equal(created.body.task.status, "draft");
  assert.equal(created.body.submission.planning, "entered");
  assert.equal(created.body.submission.delivery, "queued");
  assert.equal(created.body.submission.activation, "none");
  assert.equal(store.getTask(id).description, input.requirements);
  assert.equal(store.getTask(id).projectBindings[0].projectId, "project-1");
  assert.equal(store.listMessages(id)[0].body, input.requirements);
  assert.equal((await post("/api/tasks", input)).status, 409);
  assert.equal(store.listTasks().length, 1, "same saved creation key cannot create a second Task");
  const only = await post("/api/tasks", { ...input, plan: false, projectIds: [], requestId: "create-only" });
  assert.equal(only.body.submission.planning, "none");
  assert.equal(only.body.submission.delivery, "none");
  assert.equal(store.getTask(only.body.task.id).activationRequest, undefined);
  const start = await post(`/api/tasks/${id}/activate`, { requestId: "start" });
  assert.equal(start.status, 200);
  assert.equal(start.body.result.request.disposition, "pending");
  assert.equal(store.getTask(id).status, "draft", "request is not workspace adoption or execution");
  assert.equal((await post(`/api/tasks/${id}/activate`, { requestId: "start", actor: "operator" })).status, 409);
  assert.equal((await post(`/api/tasks/${id}/archive`, { requestId: "archive" })).status, 409);
  assert.deepEqual(archiveEffects, []);
  store.saveTask({ ...store.getTask(only.body.task.id), executionGate: { state: "stopped" } });
  const refused = await post(`/api/tasks/${only.body.task.id}/activate`, { requestId: "stopped" });
  assert.equal(refused.body.disposition, "not-submitted");
  assert.match(refused.body.error, /stopped/);
  assert.equal(store.getTask(only.body.task.id).activationRequest, undefined);

  for (const [inputId, choices, answer] of [
    ["input-1", [{ key: "yes", label: "Proceed" }], { choiceKey: "yes" }],
    ["input-2", [], { text: "A precise free-text answer" }]
  ]) {
    store.saveInputRequest(id, createInputRequest(inputId, id,
      { taskId: id, roleName: "leader", agentId: "codex", nativeSessionId: "fixture" },
      { question: "Choose", choices, blockedRefs: [] }, now));
    assert.equal((await post(`/api/tasks/${id}/inputs/${inputId}/answer`, { ...answer, actor: "operator" })).status, 400);
    const answered = await post(`/api/tasks/${id}/inputs/${inputId}/answer`, answer);
    assert.equal(answered.status, 200);
    assert.equal(answered.body.request.status, "answered");
    assert.equal(answered.body.request.resolution.answeredBy, "user");
    assert.equal((await post(`/api/tasks/${id}/inputs/${inputId}/answer`, answer)).status, 409);
  }
  const terminal = completeTask(activateTask(createTask("task-90", "Settled", now), now),
    now, { by: "user", summary: "No code delivery" });
  store.saveTask(terminal);
  assert.equal((await post("/api/tasks/task-90/archive", { requestId: "archive", force: true })).status, 409);
  const archived = await post("/api/tasks/task-90/archive", { requestId: "archive" });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.result.task.status, "archived");
  assert.deepEqual(archiveEffects, [["prepare", "task-90"], ["cleanup", "task-90"]]);

  const long = "Long original requirements. ".repeat(2000);
  store.saveTask({ ...store.getTask(id), description: long });
  store.saveTaskBrief(id, createTaskBrief({ objective: long, boundaries: [long],
    technicalApproach: long, currentFocus: long, leaderSummary: long, updatedBy: "leader" }, now));
  const workbench = await (await fetch(base + `/api/tasks/${id}/workbench`, { headers })).json();
  assert.ok(workbench.task.description.length <= 1201);
  assert.ok(workbench.brief.leaderSummary.length <= 1201);
  assert.ok(JSON.stringify(workbench).length < 60000);
  const source = workbench.core.records.find(entry => entry.ref.store === "task");
  assert.equal(source.omitted, true);
  assert.equal(store.getTask(id).description, long, "summaries never overwrite original requirements");
  const observation = await (await fetch(base + `/api/tasks/${id}?compact=true`, { headers })).json();
  for (const field of ["messages", "runs", "brief", "workItems", "task"]) assert.equal(observation[field], undefined);
});

test("selecting a Task uses its bounded workbench without automatically expanding original bodies", async () => {
  const calls = [];
  const runtime = vm.createContext({ window: { addEventListener() {} } });
  vm.runInContext(SELECTION_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), runtime);
  const detail = { task: { id: "task-1", status: "active" }, core: { records: [], coreCursor: "1" },
    brief: { currentFocus: "Current work" } };
  const deps = {
    state: { selected: "task-1", detail: null },
    api: {
      workbench: async () => { calls.push("workbench"); return detail; },
      inspect: () => assert.fail("no eager exact read"),
      observation: async () => { calls.push("observation"); return {}; }
    },
    taskView: { render() {}, observationArrived() {} }
  };
  await runtime.load(deps, "task-1", false);
  assert.deepEqual(calls, ["workbench", "observation"]);
  assert.equal(deps.state.detail.briefValue.currentFocus, "Current work");
});

test("Task panels stay lazy and unknown mutations preserve both the input guard and the actual reason", async () => {
  const builds = [];
  const elements = [];
  const h = (spec, attrs = {}, ...children) => {
    const element = { spec, ...attrs, children, dataset: { ...(attrs?.dataset || {}) },
      append(...items) { this.children.push(...items); } };
    elements.push(element);
    return element;
  };
  const runtime = vm.createContext({
    h, clear() {}, updateObservation() {},
    taskBar() {}, taskMeta() {}, taskTabs() {},
    renderOverviewPanel: () => builds.push("overview"),
    renderDelivery: () => builds.push("delivery"),
    renderRuntime: () => builds.push("runtime"),
    renderRecords: () => builds.push("records")
  });
  // Rendering's helper declarations need no browser here; the stub header
  // functions keep this assertion about panel initialization, not DOM layout.
  vm.runInContext(TASK_PAGE_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, "")
    + "\ntaskBar = taskMeta = taskTabs = function () { return null; };", runtime);
  runtime.renderTaskDetail(h("container"), {
    task: { id: "task-1" }, core: { coreCursor: "cursor" }, viewState: {}
  }, key => key, "en", { activeTab: "overview" });
  assert.deepEqual(builds, ["overview"]);
  const delivery = elements.find(element => element.id === "panel-delivery");
  delivery.onShow();
  assert.deepEqual(builds, ["overview", "delivery"]);
  assert.equal(delivery.onShow, null);
  const forms = vm.createContext({ crypto: { randomUUID: () => "request-1" } });
  vm.runInContext(FORMS_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), forms);
  const receipt = { dataset: {} }, control = {}, form = { dataset: {} };
  await forms.submitWrite({ control, receipt, form, t: key => key, unknownKey: "unknown",
    send: async () => { throw new Error("Delivery coverage is not established"); },
    saved: () => assert.fail("must not claim success") });
  assert.equal(control.disabled, true);
  assert.equal(form.dataset.unsent, "true");
  assert.match(receipt.textContent, /request-1.*Delivery coverage is not established/);
});
