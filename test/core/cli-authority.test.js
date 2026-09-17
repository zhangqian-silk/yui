import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createProject } from "../../dist/repository/project.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession, updateRoleAgentSessionStatus } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { materializeSessionBootstrap } from "../../dist/context/sessionBootstrapManifest.js";
import { createRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { freezeRunContextSnapshot } from "../../dist/context/runContextPack.js";
import { contextSnapshotRef } from "../../dist/context/contextSnapshot.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { createDecision } from "../../dist/decision/decision.js";
import { createDurableJob } from "../../dist/job/durableJob.js";
import { createDurableJobControl, parseDurableJobRefParams } from "../../dist/controller/jobControl.js";
import { startControllerServer } from "../../dist/core/controllerServer.js";

const execute = promisify(execFile);

test("public CLI fences replaced Operators, Home configuration and cross-Task reads", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-cli-authority-"));
  const home = join(root, "home");
  const store = new SqliteTaskStore(home);
  let server;
  t.after(async () => { await server?.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const now = new Date("2026-09-16T00:00:00Z");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const agent = createConfiguredAgent("fixture", "codex", "false", [], [], now);
  store.saveConfiguredAgent(agent);
  const binding = createRoleAgentBinding(agent);
  store.saveProject(createProject("project-1", "fixture", workspace, { stable: "main", development: "main" }, now));
  const operator = createGlobalRole("operator", [binding], agent.id, workspace, now);
  store.saveGlobalRole(operator);
  const session = (role, nativeSessionId) => ({ agentId: agent.id, adapterId: agent.adapterId,
    nativeSessionId, status: "active", policy: "fixed", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) });
  let set = recordRoleAgentSession(createRoleSessionSet({ scope: "global", roleName: "operator" }, agent.id, now),
    session(operator, "operator-old"), now);
  store.saveGlobalRoleSessionSet(set);
  set = updateRoleAgentSessionStatus(set, agent.id, "ended", now, "stopped");
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(set, session(operator, "operator-current"), now));
  const base = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, YUI_HOME: home,
    CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), YUI_STORE_WORKER: "false" };
  const environment = (role, owner, nativeSessionId) => {
    const manifest = materializeSessionBootstrap({ yuiHome: home, role, owner,
      roleKind: owner.scope === "global" ? "operator" : role.name, skills: [],
      entryPoint: { executable: process.execPath, cliEntry: resolve("dist/cli.js") } });
    return { ...base, YUI_SESSION_SCOPE: owner.scope, YUI_ROLE: role.name,
      ...(owner.taskId ? { YUI_TASK_ID: owner.taskId } : {}),
      YUI_NATIVE_SESSION_ID: nativeSessionId, YUI_AGENT_ID: agent.id, YUI_ADAPTER_ID: agent.adapterId,
      YUI_SESSION_MANIFEST: manifest.manifestPath, YUI_WORKSPACE: workspace };
  };
  const cli = async (args, env) => {
    try {
      const { stdout } = await execute(process.execPath, [resolve("dist/cli.js"), ...args, "--json"],
        { cwd: workspace, env, timeout: 10000 });
      return { ok: true, data: JSON.parse(stdout) };
    } catch (error) { return { ok: false, error: error.stderr }; }
  };
  const old = environment(operator, { scope: "global" }, "operator-old");
  const current = environment(operator, { scope: "global" }, "operator-current");
  const knowledge = ["project", "knowledge", "add", "project-1", "Authority", "--body", "Bounded fixture."];
  assert.equal((await cli(knowledge, old)).ok, false, "Replaced Operator cannot write Knowledge.");
  assert.equal(store.getProject("project-1").knowledge.length, 0);
  assert.equal((await cli(["session", "context", "operator"], old)).ok, true, "Historical self context remains readable.");
  assert.equal((await cli(knowledge, current)).ok, true);
  for (const id of ["task-1", "task-2"]) store.saveTask(activateTask(createTask(id, id, now), now));
  const worker = createRole("task-1", "worker", [binding], agent.id, workspace, now);
  store.saveRole("task-1", worker);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet({
    scope: "task", taskId: "task-1", roleName: "worker"
  }, agent.id, now), session(worker, "worker-current"), now));
  store.saveWorkItem("task-1", createWorkItem("work-item-1", "task-1", { title: "Own work", assignee: "worker" }, now));
  const snapshot = freezeRunContextSnapshot(store, {
    taskId: "task-1", roleName: "worker", purpose: "execution", workItemId: "work-item-1"
  }, now);
  store.saveActiveRun(createRun("run-1", "task-1", "worker", "new",
    createRunInput({ source: { type: "yui", channel: "workitem-dispatch" }, directive: "Only own work.",
      contextSnapshotRef: contextSnapshotRef(snapshot), deltaRefIds: [] }),
    now, { workItemId: "work-item-1", effective: session(worker, "worker-current").effective }));
  const env = environment(worker, { scope: "task", taskId: "task-1" }, "worker-current");
  const config = ["config", "resources", "set", "resources-gc-auto-quarantine", "true"];
  assert.equal((await cli(config, env)).ok, false, "Worker cannot change Home policy.");
  assert.notEqual(store.getConfig().resourcesGcAutoQuarantine, true);
  assert.equal((await cli(["config", "resources", "show"], env)).ok, true);
  assert.equal((await cli(config, current)).ok, true);
  store.saveDecision("task-2", createDecision("decision-1", "task-2", "Other decision", "Other rationale.", now));
  assert.equal((await cli(["task", "decision", "list", "task-2"], env)).ok, false);
  assert.equal((await cli(["task", "decision", "list", "--status", "active", "task-2"], env)).ok, false);
  assert.equal((await cli(["task", "context", "task-2"], env)).ok, false);
  assert.equal((await cli(["task", "context", "read", "task-1"], env)).ok, true);
  assert.equal((await cli(["task", "context", "inspect", "task-1", "--store", "task", "--ref", "task-1"], env)).ok, true);
  assert.equal((await cli(["task", "decision", "list", "task-2"], current)).ok, true);
  // A transport-only fixture prevents a regression from starting a scheduler.
  let jobReads = 0;
  server = await startControllerServer(home, method => {
    if (method === "job.get") { jobReads++; return { job: { taskId: "task-2", id: "job-1" } }; }
    throw new Error(`Unexpected fixture RPC: ${method}`);
  });
  assert.equal((await cli(["job", "get", "--task", "task-2", "--job", "job-1"], env)).ok, false);
  assert.equal(jobReads, 0, "CLI refuses a different Task before contacting Job control.");
});

test("Job read authority is enforced by the control port, not just the CLI", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-job-read-scope-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-09-16T00:00:00Z");
  for (const id of ["task-1", "task-2"]) store.saveTask(createTask(id, id, now));
  const agent = createConfiguredAgent("fixture", "codex", "false", [], [], now);
  const role = createRole("task-1", "leader", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.saveRole("task-1", role);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet({
    scope: "task", taskId: "task-1", roleName: "leader"
  }, agent.id, now), { agentId: agent.id, adapterId: agent.adapterId,
    nativeSessionId: "leader-current", status: "active", policy: "fixed",
    effective: resolveEffectiveLaunch({ role, purpose: "planning" }) }, now));
  const caller = { scope: "task", taskId: "task-1", role: "leader", nativeSessionId: "leader-current" };
  for (const taskId of ["task-1", "task-2"]) store.saveDurableJob(taskId, createDurableJob({
    id: "job-1", taskId, owner: { kind: "task" }, projectId: "project-1", head: "a".repeat(40),
    workspace: home, env: {}, steps: [{ name: "check", command: "true" }], artifactsLocator: `artifacts/${taskId}/job-1`,
    operation: { requestId: "read-fixture", actorId: `task:${taskId}/role:leader`, authorityRef: "fixture", inputDigest: "b".repeat(64) }
  }, now));
  const jobs = createDurableJobControl(store);
  assert.throws(() => parseDurableJobRefParams({ taskId: "task-1", jobId: "job-1" }), /params/i);
  const read = parseDurableJobRefParams({ taskId: "task-1", jobId: "job-1", caller });
  assert.equal(jobs.getJob(read.taskId, read.jobId, read.caller).taskId, "task-1");
  assert.throws(() => jobs.getJob("task-2", "job-1", caller), /Task|scope|outside/i);
});
