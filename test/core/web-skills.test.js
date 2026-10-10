import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createWebSkills } from "../../dist/web/webSkills.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-web-skills-"));
  let store;
  t.after(() => { store?.close(); rmSync(home, { recursive: true, force: true }); });
  store = new SqliteTaskStore(home);
  const now = new Date();
  const agent = createConfiguredAgent("fixture", "codex", "unused", [], [], now);
  const binding = createRoleAgentBinding(agent);
  store.saveConfiguredAgent(agent);
  store.saveGlobalRole(createGlobalRole("worker", [binding], agent.id, home, now));
  store.saveTask(activateTask(createTask("task-1", "Skills", now), now));
  store.saveRole("task-1", createRole("task-1", "leader", [binding], agent.id, home, now));
  const source = join(home, "skills", "sample");
  mkdirSync(join(source, "references"), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: sample\ndescription: A useful sample\n---\nRead references/guide.md");
  writeFileSync(join(source, "references/guide.md"), "original");
  return { home, store, source, service: createWebSkills(store) };
}

test("Skill browsing is bounded read-only data; missing, oversized and escaping resources are explicit", t => {
  const { service, home, source } = fixture(t);
  const catalog = service.catalog("useful sample");
  assert.deepEqual(catalog.items.map(s => s.id), ["sample"]);
  assert.equal(existsSync(join(home, "runtime", "skill-packages")), false, "browsing does not snapshot");
  assert.deepEqual(service.file({ id: "sample" }).files, ["SKILL.md", "references/guide.md"]);
  assert.equal(service.file({ id: "sample", resource: "references/guide.md" }).content, "original");
  assert.throws(() => service.file({ id: "../sample" }), /Invalid/);
  assert.throws(() => service.file({ id: "sample", resource: "../../outside" }), /not in/);
  assert.throws(() => service.file({ id: "missing" }), /ENOENT/);
  writeFileSync(join(source, "big.txt"), Buffer.alloc(256 * 1024 + 1, "a"));
  assert.throws(() => service.file({ id: "sample", resource: "big.txt" }), /256 KiB/);
  symlinkSync(join(source, "SKILL.md"), join(source, "escape"));
  assert.throws(() => service.file({ id: "sample", resource: "escape" }), /symlink/);
});

test("Role Skill saves share revisions and guards; removal preserves source and frozen Session evidence", t => {
  const { service, store, source } = fixture(t);
  for (const target of [{ scope: "global", role: "worker" }, { scope: "task", task: "task-1", role: "leader" }]) {
    const before = service.role(target);
    const save = skills => service.save({ target, revision: service.role(target).revision, skills, acknowledgeLive: true });
    save(["sample"]);
    assert.equal(service.role(target).launchRevision, before.launchRevision + 1);
    assert.throws(() => service.save({ target, revision: before.revision, skills: [] }), /changed since/);
    assert.throws(() => save(["missing"]), /not found/);
    assert.deepEqual(service.role(target).skills, ["sample"]);
    const role = target.scope === "global" ? store.getGlobalRole("worker") : store.getRole("task-1", "leader");
    const effective = resolveEffectiveLaunch({ store, role, purpose: "execution" });
    const owner = target.scope === "global" ? { scope: "global", roleName: "worker" }
      : { scope: "task", taskId: "task-1", roleName: "leader" };
    const sessions = recordRoleAgentSession(createRoleSessionSet(owner, "fixture", new Date()), {
      agentId: "fixture", adapterId: "codex", nativeSessionId: "frozen", status: "active", policy: "fixed", effective
    }, new Date());
    if (target.scope === "global") store.saveGlobalRoleSessionSet(sessions);
    else store.saveTaskRoleSessionSet(sessions);
    const loaded = service.role(target).session;
    if (target.scope === "global") assert.throws(() => service.save({
      target, revision: service.role(target).revision, skills: []
    }), /live native Session/);
    save([]);
    assert.deepEqual(service.role(target).session, loaded);
    assert.equal(existsSync(join(source, "SKILL.md")), true);
    writeFileSync(join(source, "references/guide.md"), "changed");
    assert.equal(service.file({ id: "sample", resource: "references/guide.md" }).content, "changed");
    const frozen = { target, id: "sample", frozen: true, resource: "references/guide.md",
      digest: loaded.packages.find(p => p.id === "sample").digest };
    assert.equal(service.file(frozen).content, "original");
    assert.throws(() => service.file({ ...frozen, digest: "0".repeat(64) }), /version changed/);
    writeFileSync(join(source, "references/guide.md"), "original");
  }
  assert.equal(readFileSync(join(source, "references/guide.md"), "utf8"), "original");
});

test("Skill HTTP ingress authenticates reads and mutations and never accepts filesystem paths as frozen evidence", async t => {
  const { service, store } = fixture(t);
  const server = createYuiWebServer(store, { skills: service, token: "fixture-token" });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "x-yui-web-token": "fixture-token", "content-type": "application/json" };
  assert.equal((await fetch(base + "/api/skills/catalog")).status, 403);
  assert.equal((await fetch(base + "/api/skills/catalog", { headers })).status, 200);
  const target = { scope: "task", task: "task-1", role: "leader" };
  const response = await fetch(base + "/api/skills/role", { method: "POST", headers,
    body: JSON.stringify({ target, revision: service.role(target).revision, skills: ["sample"] }) });
  assert.equal(response.status, 200);
  assert.deepEqual(store.getRole("task-1", "leader").skills, ["sample"]);
  const rejected = await fetch(base + "/api/skills/file?scope=task&task=task-1&role=leader&id=sample&frozen=true", { headers });
  assert.equal(rejected.status, 409);
  assert.match((await rejected.json()).error, /No frozen package evidence/);
});
