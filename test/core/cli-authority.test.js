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
import { compileRoleSessionContext } from "../../dist/context/roleSessionContext.js";
import { createRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { freezeRunContextSnapshot } from "../../dist/context/runContextPack.js";
import { contextSnapshotRef } from "../../dist/context/contextSnapshot.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { createDecision } from "../../dist/decision/decision.js";
import { createDurableJob } from "../../dist/job/durableJob.js";
import { createDurableJobControl, parseDurableJobRefParams } from "../../dist/controller/jobControl.js";
import { startControllerServer } from "../../dist/core/controllerServer.js";
import { installDevLauncher } from "../../scripts/manage-dev-launcher.mjs";
import { createGlobalRoleMessage } from "../../dist/message/message.js";
import Database from "../../dist/sqlite/driver.js";
import { usePre19Layout } from "../helpers/pre19Storage.mjs";

const execute = promisify(execFile);

test("maintenance authenticates native-only Operators before migrating an old Home", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-maintenance-authority-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  const now = new Date("2026-09-16T00:00:00Z");
  const agent = createConfiguredAgent("fixture", "codex", "false", [], [], now);
  const role = createGlobalRole("operator", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.saveGlobalRole(role);
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(
    createRoleSessionSet({ scope: "global", roleName: "operator" }, agent.id, now),
    { agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: "desktop-current",
      status: "active", policy: "fixed", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, now));
  store.close();
  // Historical Role/Session records survive the declared 1.7 -> 1.9 path.
  const db = new Database(join(home, "yui.db"));
  usePre19Layout(db);
  db.prepare("UPDATE storage_schema SET minor=7").run();
  db.close();
  const { launcherPath } = installDevLauncher({ projectRoot: process.cwd(), outputDir: join(home, "dev") });
  const base = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
    YUI_HOME: home, CODEX_THREAD_ID: "desktop-current", YUI_STORE_WORKER: "false" };
  const preflight = env => execute(launcherPath, ["--json", "upgrade", "--update-preflight"],
    { env, timeout: 10000 });
  const result = JSON.parse((await preflight(base)).stdout);
  assert.equal(result.data.status, "migration-ready");
  for (const env of [
    { ...base, CODEX_THREAD_ID: "replaced" },
    { ...base, YUI_SESSION_SCOPE: "global", YUI_ROLE: "operator", CODEX_THREAD_ID: "replaced" },
    { ...base, YUI_SESSION_SCOPE: "task", YUI_ROLE: "leader", YUI_TASK_ID: "task-1" },
    { ...base, YUI_ROLE: "other" }
  ]) await assert.rejects(preflight(env));
  const check = new Database(join(home, "yui.db"), { readonly: true });
  assert.equal(check.prepare("SELECT minor FROM storage_schema").get().minor, 7);
  check.close();
  await assert.rejects(execute(launcherPath, ["--json", "inbox", "list"], { env: base, timeout: 10000 }),
    /storage version 1.7/);
  const malformed = new Database(join(home, "yui.db"));
  try { malformed.exec("CREATE TABLE unexpected (id TEXT)"); } finally { malformed.close(); }
  await assert.rejects(preflight(base), /unexpected schema objects/);
});

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
  const { launcherPath } = installDevLauncher({ projectRoot: process.cwd(), outputDir: join(root, "dev") });
  const bin = dirname(launcherPath);
  const base = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, YUI_HOME: home,
    CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), YUI_STORE_WORKER: "false" };
  const environment = (role, owner, nativeSessionId) => {
    const manifest = materializeSessionBootstrap({ yuiHome: home, role, owner,
      roleKind: owner.scope === "global" ? "operator" : role.name,
      skills: compileRoleSessionContext(home, role, owner).skills,
      entryPoint: { executable: process.execPath, cliEntry: resolve("dist/cli.js") } });
    return { ...base, YUI_SESSION_SCOPE: owner.scope, YUI_ROLE: role.name,
      ...(owner.taskId ? { YUI_TASK_ID: owner.taskId } : {}),
      YUI_NATIVE_SESSION_ID: nativeSessionId, YUI_AGENT_ID: agent.id, YUI_ADAPTER_ID: agent.adapterId,
      YUI_SESSION_MANIFEST: manifest.manifestPath, YUI_WORKSPACE: workspace };
  };
  const cli = async (args, env) => {
    try {
      const { stdout } = await execute(launcherPath, [...args, "--json"],
        { cwd: workspace, env, timeout: 10000 });
      return { ok: true, data: JSON.parse(stdout) };
    } catch (error) { return { ok: false, error: error.stderr }; }
  };
  const old = environment(operator, { scope: "global" }, "operator-old");
  const current = environment(operator, { scope: "global" }, "operator-current");
  assert.equal((await cli(["session", "skills"], old)).ok, false, "An instruction check cannot revive a replaced caller.");
  const currentSkills = await cli(["session", "skills"], current);
  assert.equal(currentSkills.ok, true, JSON.stringify(currentSkills));
  assert.deepEqual(currentSkills.data.data.skills.map(s => s.id), ["yui-runtime", "yui-operator"]);
  const knowledge = ["project", "knowledge", "add", "project-1", "Authority", "--body", "Bounded fixture."];
  assert.equal((await cli(knowledge, old)).ok, false, "Replaced Operator cannot write Knowledge.");
  assert.equal(store.getProject("project-1").knowledge.length, 0);
  assert.equal((await cli(["session", "context", "operator"], old)).ok, true, "Historical self context remains readable.");
  assert.equal((await cli(["role", "message", "list", "operator"], old)).ok, true,
    "Separating Message reads must preserve historical self-read without restoring writes.");
  assert.equal((await cli(knowledge, current)).ok, true);
  const inboxId = store.nextGlobalRoleMessageId();
  store.saveGlobalRoleMessage(createGlobalRoleMessage(inboxId, "operator", "Handle in this turn",
    "user", { type: "user" }, now, { inputControl: { action: "queue", requestId: "inbox-cli" } }));
  assert.equal((await cli(["inbox", "list"], old)).ok, false);
  const inboxList = await cli(["inbox", "list"], current);
  assert.equal(inboxList.ok, true, inboxList.error);
  assert.equal(inboxList.data.data.items[0].id, inboxId);
  const desktop = { ...base, CODEX_THREAD_ID: "operator-current" };
  const desktopInbox = await cli(["inbox", "list"], desktop);
  assert.equal(desktopInbox.ok, true, desktopInbox.error);
  assert.equal(desktopInbox.data.data.identity.roleName, "operator");
  assert.equal(desktopInbox.data.data.items[0].id, inboxId);
  const desktopSkills = await cli(["session", "skills"], desktop);
  assert.equal(desktopSkills.ok, true, desktopSkills.error);
  assert.deepEqual(desktopSkills.data.data.skills.map(s => s.id), ["yui-runtime", "yui-operator"]);
  assert.equal((await cli(["inbox", "list"], { ...desktop, YUI_ROLE: "foreign" })).ok, false);
  assert.equal((await cli(["inbox", "show", inboxId], current)).data.data.body, "Handle in this turn");
  assert.equal(store.listGlobalRoleMessages("operator")[0].inbox, undefined);
  const claim = await cli(["inbox", "claim", inboxId, "--request-id", "claim-cli"], current);
  assert.equal(claim.ok, true, claim.error);
  const ack = await cli(["inbox", "ack", inboxId, "--request-id", "ack-cli", "--reason", "Routed and verified"], current);
  assert.equal(ack.ok, true, ack.error);
  assert.equal(store.listGlobalRoleMessages("operator")[0].inbox.ack.reason, "Routed and verified");
  assert.equal(store.listGlobalRoleMessages("operator")[0].delivery, undefined);
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
  const workerSkills = await cli(["session", "skills"], env);
  assert.equal(workerSkills.ok, true, JSON.stringify(workerSkills));
  assert.deepEqual(workerSkills.data.data.skills.map(s => s.id), ["yui-runtime", "yui-worker"]);
  const desktopWorker = { ...base, CODEX_THREAD_ID: "worker-current" };
  assert.equal((await cli(["inbox", "list"], desktopWorker)).ok, true);
  assert.equal((await cli(["task", "context", "task-2"], desktopWorker)).ok, false);
  assert.equal((await cli(["session", "skills"], { ...env, YUI_TASK_ID: "task-2" })).ok, false);
  const config = ["config", "resources", "set", "resources-gc-auto-quarantine", "true"];
  for (const partial of [{ YUI_SESSION_MANIFEST: current.YUI_SESSION_MANIFEST }, { YUI_TASK_ID: "task-1" }]) {
    const incomplete = { ...base, ...partial };
    assert.equal((await cli(["task", "cancel", "task-1"], incomplete)).ok, false);
    assert.equal(store.getTask("task-1").status, "active");
    assert.equal((await cli(config, incomplete)).ok, false);
    assert.equal((await cli(["help"], incomplete)).ok, true, "Offline help is not execution authority.");
  }
  assert.equal((await cli(config, env)).ok, false, "Worker cannot change Home policy.");
  assert.notEqual(store.getConfig().resourcesGcAutoQuarantine, true);
  assert.equal((await cli(["config", "resources", "show"], env)).ok, true);
  assert.equal((await cli(config, current)).ok, true);
  store.saveDecision("task-2", createDecision("decision-1", "task-2", "Other decision", "Other rationale.", now));
  assert.equal((await cli(["task", "decision", "list", "task-2"], env)).ok, false);
  assert.equal((await cli(["task", "decision", "list", "--status", "active", "task-2"], env)).ok, false);
  assert.equal((await cli(["task", "context", "task-2"], env)).ok, false);
  assert.equal((await cli(["task", "context", "read", "task-1"], env)).ok, true);
  assert.equal((await cli(["task", "run", "context", "task-1/run-1"], env)).ok, true);
  assert.equal((await cli(["task", "context", "list", "task-1", "--store", "task-message"], env)).ok, true);
  assert.equal((await cli(["task", "context", "list", "task-2", "--store", "task-message"], env)).ok, false);
  assert.equal((await cli(["role", "message", "list", "operator"], env)).ok, false);
  assert.equal((await cli(["task", "context", "inspect", "task-1", "--store", "task", "--ref", "task-1"], env)).ok, true);
  assert.equal((await cli(["task", "usage", "task-1", "--limit", "20"], env)).ok, false,
    "Reading the Task record does not authorize a Worker to read all Roles' usage evidence.");
  assert.equal((await cli(["task", "usage", "task-1"], current)).ok, true);
  assert.equal((await cli(["task", "decision", "list", "task-2"], current)).ok, true);
  const searched = await cli(["task", "search", "Other rationale"], current);
  assert.equal(searched.ok, true);
  assert.equal(searched.data.data.items[0].taskId, "task-2");
  assert.equal((await cli(["task", "search", "Other rationale"], env)).ok, false);
  const leader = createRole("task-1", "leader", [binding], agent.id, workspace, now);
  store.saveRole("task-1", leader);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet({
    scope: "task", taskId: "task-1", roleName: "leader"
  }, agent.id, now), session(leader, "leader-current"), now));
  const leaderEnv = environment(leader, { scope: "task", taskId: "task-1" }, "leader-current");
  const scopedSearch = await cli(["task", "search", "Other rationale"], leaderEnv);
  assert.equal(scopedSearch.ok, true);
  assert.deepEqual(scopedSearch.data.data.items, []);
  assert.equal((await cli(["task", "search", "Other rationale", "--task", "task-2"], leaderEnv)).ok, false);
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
