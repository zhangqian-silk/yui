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

const root = resolve(".");

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

  const effective = resolveEffectiveLaunch({ role: operator, purpose: "execution" });
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
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].failure.detail, /thread naming is unavailable/u);
  assert.equal(diagnostics[0].failure.sessionDisposition, "recoverable");
});
