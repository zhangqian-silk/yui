import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createAgentProfile, updateAgentProfile } from "../../dist/profile/agentProfile.js";
import { createWebSettings } from "../../dist/web/webSettings.js";
import { staticAgentConfigurationFields } from "../../dist/executor/agentConfigurationFields.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";

test("role template preview is read-only; application is atomic and pins role, template and inherited runtime", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-role-profile-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  const agent = createConfiguredAgent("fixture", "codex", "unused", [], [], now);
  store.saveConfiguredAgent(agent);
  for (const name of ["worker", "reviewer"]) store.saveGlobalRole(createGlobalRole(
    name, [createRoleAgentBinding(agent)], agent.id, home, now,
    { systemPrompt: "Original instructions", responsibilities: ["Keep role responsibility"] }));
  store.saveAgentProfile(createAgentProfile({ id: "reader", defaultAccess: "read",
    instructions: "Inspect without edits", runtime: { source: "global-worker" } }, now));
  let validationHook = () => {};
  let catalogReads = 0;
  const settings = createWebSettings(store, { environment: { HOME: home }, catalogs: {
    resolve: async ({ agent }) => {
      catalogReads++; validationHook();
      return { source: "fallback", attemptedAt: now.toISOString(), catalog: {
        schemaVersion: 1, agentId: agent.id, adapterId: agent.adapterId, models: [],
        fields: staticAgentConfigurationFields(agent.adapterId), warnings: [] } };
    }
  } });
  const initial = store.getGlobalRole("reviewer");
  const preview = settings.previewProfile("role/reviewer", "reader");
  assert.equal(catalogReads, 0, "preview must not start Agent discovery");
  assert.deepEqual(store.getGlobalRole("reviewer"), initial);
  assert.ok(preview.changes.some(change => change.key === "systemPrompt" && change.after === "Inspect without edits"));
  assert.equal(preview.result.systemPrompt, "Inspect without edits", "the preview carries the instructions the Role will read");
  assert.ok(Object.hasOwn(preview.result, "description") && Object.hasOwn(preview.result, "constraints"));
  const body = { id: "role/reviewer", profileId: "reader", revision: preview.revision, acknowledgeLive: false };
  store.saveAgentProfile(updateAgentProfile(store.getAgentProfile("reader"), { instructions: "New version" }, new Date()));
  await assert.rejects(settings.applyProfile(body), /changed/i);
  assert.deepEqual(store.getGlobalRole("reviewer"), initial);
  const fresh = settings.previewProfile(body.id, body.profileId);
  validationHook = () => runGlobalRoleCommand(["update", "worker", "--system-prompt", "Unrelated behavior"], store, { yuiHome: home });
  const saved = await settings.applyProfile({ ...body, revision: fresh.revision });
  assert.equal(saved.group.observation.defaultAccess, "read");
  assert.equal(store.getGlobalRole("reviewer").systemPrompt, "New version");
  assert.deepEqual(store.getGlobalRole("reviewer").responsibilities, ["Keep role responsibility"]);
  assert.equal(store.getGlobalRoleSessionSet("reviewer"), null, "same-Agent application starts no Session");
  store.saveAgentProfile(updateAgentProfile(store.getAgentProfile("reader"), { instructions: "Later edit" }, new Date()));
  assert.equal(store.getGlobalRole("reviewer").systemPrompt, "New version", "applied templates are snapshots, not links");
  const stale = settings.previewProfile(body.id, body.profileId);
  const before = store.getGlobalRole("reviewer");
  validationHook = () => runGlobalRoleCommand(["update", "worker", "--effort", "high"], store, { yuiHome: home });
  await assert.rejects(settings.applyProfile({ ...body, revision: stale.revision }), /changed/i);
  assert.deepEqual(store.getGlobalRole("reviewer"), before);
  store.saveAgentProfile(updateAgentProfile(store.getAgentProfile("reader"), { enabled: false }, new Date()));
  assert.equal(settings.read(body.id).profiles.find(p => p.id === "reader").available, false);
  assert.throws(() => settings.previewProfile(body.id, "reader"), /disabled/i);

  validationHook = () => {};
  const second = createConfiguredAgent("second", "codex", "unused", [], [], now);
  store.saveConfiguredAgent(second);
  store.saveAgentProfile(createAgentProfile({ id: "second-template", runtime: { source: "explicit", agentId: second.id },
    instructions: "New Agent template" }, now));
  const live = recordRoleAgentSession(createRoleSessionSet({ scope: "global", roleName: "reviewer" }, agent.id, now), {
    agentId: agent.id, adapterId: "codex", nativeSessionId: "fixture-session", status: "active",
    policy: "fixed", effective: resolveEffectiveLaunch({ role: store.getGlobalRole("reviewer"), purpose: "execution" })
  }, now);
  store.saveGlobalRoleSessionSet(live);
  const server = createYuiWebServer(store, { settings, token: "fixture-token" });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/settings/profile`;
  const headers = { "x-yui-web-token": "fixture-token", "content-type": "application/json" };
  assert.equal((await fetch(base + "?id=role/reviewer&profileId=second-template")).status, 403);
  const plan = await (await fetch(base + "?id=role/reviewer&profileId=second-template", { headers })).json();
  const application = { id: body.id, profileId: "second-template", revision: plan.revision };
  assert.equal((await fetch(base, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(application) })).status, 403);
  const rejected = await fetch(base, { method: "POST", headers, body: JSON.stringify(application) });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).disposition, "not-submitted");
  assert.equal(store.getGlobalRole("reviewer").activeAgentId, agent.id);
  const applied = await fetch(base, { method: "POST", headers,
    body: JSON.stringify({ ...application, acknowledgeLive: true }) });
  assert.equal(applied.status, 200);
  assert.equal(store.getGlobalRole("reviewer").activeAgentId, second.id);
  assert.deepEqual(store.getGlobalRoleSessionSet("reviewer"), live, "switching desired Agent preserves the live Session identity");
});
