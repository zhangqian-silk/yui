import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  bindGlobalRoleProviderRuntime,
  createRoleSessionSet,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import {
  createGlobalRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { operatorSessionTitle } from "../../dist/runtime/sessionTitle.js";
import { createProviderRuntimeBinding } from "../../dist/runtime/providerRuntimeIdentity.js";
import { startStructuredProviderSession } from "../../dist/runtime/structuredProviderHost.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { RuntimeLaunchCoordinator } from "../../dist/controller/runtimeLaunchCoordinator.js";

const root = resolve(".");

test("Role CLI display edits flow through launch and persistence without replacing the Session", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-role-title-flow-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-11-02T01:00:00Z");
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  const agent = createConfiguredAgent("codex", "codex", "unused", [], [], now);
  store.saveConfiguredAgent(agent);
  for (const name of ["operator", "assistant"]) {
    store.saveGlobalRole(createGlobalRole(name, [createRoleAgentBinding(agent)], agent.id, home, now));
  }
  const command = args => runGlobalRoleCommand(args, store, { yuiHome: home, env: {} });
  command(["update", "operator", "--instance-code", "dev-bj"]);
  assert.match(command(["show", "operator"]), /Instance code\s+dev-bj/);
  const planner = new FileRoleLaunchPlanner(home, store, { now: () => now, environment: { HOME: home, PATH: process.env.PATH } });
  const owner = { scope: "global", roleName: "operator" };
  const effective = resolveEffectiveLaunch({ store, role: store.getGlobalRole("operator"), purpose: "execution" });
  let appliedTitle = "Yui Operator @dev-bj · 1102";
  const host = async (request, before) => {
    const planned = planner.planGlobalRole({ ...request, roleName: request.owner.roleName });
    before({ ...request, sessionTitle: planned.sessionTitle, generatedTitle: planned.generatedTitle });
    return { id: "fixture-binding", hostRef: "fixture-host", owner, agentId: agent.id, adapterId: agent.adapterId,
      nativeSessionId: "same-native-session", appliedGeneratedTitle: appliedTitle };
  };
  const coordinator = new RuntimeLaunchCoordinator(new FileSchedulerStoreAdapter(store),
    { start: host, restore: host }, { now: () => now });
  await coordinator.prepare({ owner, roleName: "operator", agentId: agent.id, adapterId: agent.adapterId,
    effective, workspace: effective.workspace.root, mode: "new" });
  const original = store.getGlobalRoleSessionSet("operator").sessions.codex;
  assert.equal(original.title, "Yui Operator @dev-bj · 1102");
  assert.equal(original.generatedTitle, original.title);
  command(["update", "operator", "--clear-instance-code"]);
  assert.deepEqual(store.getGlobalRoleSessionSet("operator").sessions.codex, original, "configuration has no Session side effect");
  const resumed = planner.planGlobalRole({ roleName: "operator", agentId: agent.id, adapterId: agent.adapterId,
    mode: "resume", nativeSessionId: original.nativeSessionId });
  assert.equal(resumed.sessionTitle, "Yui · Operator · 1102");
  assert.equal(resumed.launch.providerControl.previousSessionTitle, original.title);
  await coordinator.prepare({ owner, roleName: "operator", agentId: agent.id, adapterId: agent.adapterId,
    effective, workspace: effective.workspace.root, mode: "resume", nativeSessionId: original.nativeSessionId });
  assert.equal(store.getGlobalRoleSessionSet("operator").sessions.codex.generatedTitle, original.title,
    "reusing a live Host must not persist unapplied naming intent");
  appliedTitle = undefined;
  await coordinator.prepare({ owner, roleName: "operator", agentId: agent.id, adapterId: agent.adapterId,
    effective, workspace: effective.workspace.root, mode: "resume", nativeSessionId: original.nativeSessionId });
  assert.equal(store.getGlobalRoleSessionSet("operator").sessions.codex.generatedTitle, original.title,
    "missing or failed native naming receipt must preserve the last known generated title");
  appliedTitle = resumed.sessionTitle;
  await coordinator.prepare({ owner, roleName: "operator", agentId: agent.id, adapterId: agent.adapterId,
    effective, workspace: effective.workspace.root, mode: "resume", nativeSessionId: original.nativeSessionId });
  assert.equal(store.getGlobalRoleSessionSet("operator").sessions.codex.generatedTitle, appliedTitle);
  assert.equal(store.getGlobalRole("operator").launchRevision, original.effective.sourceDesiredRevision);
  const set = store.getGlobalRoleSessionSet("operator");
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(set, { ...original, title: "My own name" }, now));
  assert.equal(planner.planGlobalRole({ roleName: "operator", agentId: agent.id, adapterId: agent.adapterId,
    mode: "resume", nativeSessionId: original.nativeSessionId }).sessionTitle, undefined);
  command(["update", "assistant", "--instance-code", "上海"]);
  assert.equal(planner.planGlobalRole({ roleName: "assistant", agentId: agent.id, adapterId: agent.adapterId,
    mode: "new" }).sessionTitle, "Yui assistant @上海");
});

test("Claude resume never passes generated names without native ownership evidence", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-claude-title-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-11-02T01:00:00Z");
  const agent = createConfiguredAgent("claude", "claude", "unused", [], [], now);
  store.saveConfiguredAgent(agent);
  store.saveGlobalRole(createGlobalRole("assistant", [createRoleAgentBinding(agent)], agent.id, home, now));
  runGlobalRoleCommand(["update", "assistant", "--instance-code", "dev-bj"], store, { yuiHome: home, env: {} });
  const planner = new FileRoleLaunchPlanner(home, store, { now: () => now,
    environment: { HOME: home, PATH: process.env.PATH } });
  const created = planner.planGlobalRole({ roleName: "assistant", agentId: agent.id,
    adapterId: agent.adapterId, mode: "new" });
  assert.ok(created.launch.args.includes("--name"));
  const effective = resolveEffectiveLaunch({ store, role: store.getGlobalRole("assistant"), purpose: "execution" });
  new FileSchedulerStoreAdapter(store).recordLaunchedRuntimeNativeSession({
    owner: { scope: "global", roleName: "assistant" }, agentId: agent.id, adapterId: agent.adapterId,
    nativeSessionId: created.session.nativeSessionId, effective, generatedTitle: created.generatedTitle
  }, () => {}, now);
  const resumed = planner.planGlobalRole({ roleName: "assistant", agentId: agent.id,
    adapterId: agent.adapterId, mode: "resume", nativeSessionId: created.session.nativeSessionId });
  assert.equal(resumed.launch.args.includes("--name"), false);
});

test("Operator Session titles use the configured local calendar date", () => {
  const beforeShanghaiMidnight = new Date("2026-12-31T15:59:59.999Z");
  const afterShanghaiMidnight = new Date("2026-12-31T16:00:00.000Z");

  assert.equal(
    operatorSessionTitle(new Date("2026-03-02T01:00:00.000Z"), "Asia/Shanghai"),
    "Yui · Operator · 0302"
  );
  assert.equal(
    operatorSessionTitle(beforeShanghaiMidnight, "Asia/Shanghai"),
    "Yui · Operator · 1231"
  );
  assert.equal(
    operatorSessionTitle(afterShanghaiMidnight, "Asia/Shanghai"),
    "Yui · Operator · 0101"
  );
  assert.equal(
    operatorSessionTitle(afterShanghaiMidnight, "America/Los_Angeles"),
    "Yui · Operator · 1231"
  );
});

test("only a newly created global Operator Session receives the dated title", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-operator-title-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  store.saveConfig({ ...store.getConfig(), timeZone: "Pacific/Kiritimati" });
  const now = new Date("2026-09-19T10:30:00.000Z");
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  const binding = createRoleAgentBinding(agent);
  const operator = createGlobalRole("operator", [binding], agent.id, home, now);
  const assistant = createGlobalRole("assistant", [binding], agent.id, home, now);
  store.saveConfiguredAgent(agent);
  store.saveGlobalRole(operator);
  store.saveGlobalRole(assistant);
  const planner = new FileRoleLaunchPlanner(home, store, {
    cliPath: join(root, "dist", "cli.js"),
    environment: { HOME: home, PATH: process.env.PATH },
    now: () => now
  });

  const created = planner.planGlobalRole({
    roleName: "operator",
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  });
  assert.equal(created.sessionTitle, "Yui · Operator · 0920");
  assert.equal(created.launch.providerControl.sessionTitle, "Yui · Operator · 0920");
  assert.equal(created.launch.env.YUI_SESSION_TITLE, "Yui · Operator · 0920");
  assert.equal(planner.planGlobalRole({
    roleName: "assistant",
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  }).sessionTitle, undefined);

  const effective = resolveEffectiveLaunch({ store, role: operator, purpose: "execution" });
  store.saveGlobalRoleSessionSet(bindGlobalRoleProviderRuntime(recordRoleAgentSession(
    createRoleSessionSet(
      { scope: "global", roleName: operator.name },
      agent.id,
      now
    ),
    {
      agentId: agent.id,
      adapterId: agent.adapterId,
      nativeSessionId: "operator-existing",
      policy: "fixed",
      status: "active",
      effective
    },
    now
  ), createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: "codex",
    conversationId: "operator-existing",
    startedAt: now.toISOString()
  }), now));
  const resumed = planner.planGlobalRole({
    roleName: "operator",
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "resume",
    nativeSessionId: "operator-existing"
  });
  assert.equal(resumed.sessionTitle, undefined);
  assert.equal(resumed.launch.providerControl.sessionTitle, undefined);
  assert.equal(resumed.launch.env.YUI_SESSION_TITLE, undefined);
});

test("a rejected Codex rename is diagnostic and does not discard the new Session", async (t) => {
  let session;
  t.after(() => session?.terminate("SIGTERM"));
  const diagnostics = [];
  const opened = await startStructuredProviderSession({
    schemaVersion: 1,
    command: process.execPath,
    args: [join(root, "test", "fixtures", "fake-codex-app-server-proxy.mjs")],
    environment: {
      ...process.env,
      YUI_FAKE_EXPECT_THREAD_NAME: "Yui · Operator · 0920",
      YUI_FAKE_REJECT_THREAD_NAME: "1"
    },
    cwd: root,
    childLifecycle: "persistent",
    startMode: "provider",
    providerControl: {
      schemaVersion: 1,
      adapterId: "codex",
      transport: "codex-app-server-proxy",
      kind: "start",
      mode: "new",
      sessionOnly: true,
      sessionTitle: "Yui · Operator · 0920",
      authority: { epoch: 1, owner: "controller", holderId: "controller" },
      codexThread: {}
    }
  }, {
    onDiagnostic: diagnostic => diagnostics.push(diagnostic),
    mirrorOutput: () => {}
  });
  session = opened.session;

  assert.equal(session.nativeSessionId, "fake-thread-1");
  assert.equal(session.appliedGeneratedTitle, undefined);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].failure.detail, /thread naming is unavailable/u);
  assert.equal(diagnostics[0].failure.sessionDisposition, "recoverable");
});

test("resume renames only a native title still owned by Yui", async t => {
  for (const [nativeName, reject] of [["Yui Operator @old · 1102", true],
    ["User title", false], [undefined, false], ["Yui Operator @old · 1102", false]]) {
    const diagnostics = [];
    const opened = await startStructuredProviderSession({
      schemaVersion: 1, command: process.execPath,
      args: [join(root, "test", "fixtures", "fake-codex-app-server-proxy.mjs")],
      environment: { ...process.env, YUI_FAKE_REJECT_THREAD_NAME: reject ? "1" : "0",
        ...(nativeName === undefined ? {} : { YUI_FAKE_THREAD_NAME: nativeName }) },
      cwd: root, childLifecycle: "persistent", startMode: "provider",
      providerControl: {
        schemaVersion: 1, adapterId: "codex", transport: "codex-app-server-proxy",
        kind: "restore", mode: "resume", nativeSessionId: "existing-thread", sessionOnly: true,
        sessionTitle: "Yui Operator @new · 1102", previousSessionTitle: "Yui Operator @old · 1102",
        authority: { epoch: 1, owner: "controller", holderId: "controller" }, codexThread: {}
      }
    }, { onDiagnostic: value => diagnostics.push(value), mirrorOutput: () => {} });
    t.after(() => opened.session.terminate("SIGTERM"));
    assert.equal(opened.session.nativeSessionId, "existing-thread");
    assert.equal(diagnostics.length, reject ? 1 : 0);
    assert.equal(opened.session.appliedGeneratedTitle,
      !reject && nativeName === "Yui Operator @old · 1102" ? "Yui Operator @new · 1102" : undefined);
    opened.session.terminate("SIGTERM");
  }
});
