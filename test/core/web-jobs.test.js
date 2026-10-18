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
import { createTask } from "../../dist/task/task.js";
import { createJobDefinition } from "../../dist/job/jobDefinition.js";
import { createWebJobs } from "../../dist/web/webJobs.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";

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
  const role = createGlobalRole("operator", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.createGlobalRoleIfAbsent(role);
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "global", roleName: "operator" }, agent.id, now
  ), { agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: "web-jobs",
    status: "active", policy: "fixed", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, now));
  for (const taskId of ["task-1", "task-2"]) {
    store.saveTask(createTask(taskId, taskId, now));
    store.saveJobDefinition(createJobDefinition({ id: "owned-" + taskId, title: taskId,
      scope: { kind: "task", taskId },
      configuration: { kind: "shell", owner: { kind: "task", taskId }, projectId: "project-1",
        workspace: home, head: "a".repeat(40), env: {}, steps: [{ name: "probe", command: "true" }] }
    }, now));
  }
  server = createYuiWebServer(store, { token: "test-token", jobs: createWebJobs(store, home) });
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
  assert.equal((await api("settings/schedules", { op: "enable", id: "cadence", expectedRevision: plan.revision })).status, 409);
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
