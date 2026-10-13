import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadYuiSkillContexts, compileRoleSessionContext } from "../../dist/context/roleSessionContext.js";
import { checkSessionSkills, materializeSessionBootstrap, readSessionBootstrapManifest } from "../../dist/context/sessionBootstrapManifest.js";
import { checkCurrentSkills } from "../../dist/context/currentSkills.js";
import { verifySkillPackage } from "../../dist/context/skillPackage.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-skill-package-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = join(home, "skills", "sample");
  mkdirSync(join(source, "references"), { recursive: true });
  mkdirSync(join(source, "scripts"));
  writeFileSync(join(source, "SKILL.md"), "Read references/guide.md and scripts/check.sh.\n");
  writeFileSync(join(source, "VERSION"), "1\n");
  writeFileSync(join(source, "references/guide.md"), "original reference\n");
  writeFileSync(join(source, "scripts/check.sh"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
  return { home, source };
}

test("full packages preserve resources, source and executable intent; references alone change version without rewriting snapshots", t => {
  const { home, source } = fixture(t);
  const [first] = loadYuiSkillContexts(home, ["sample", "sample"]);
  assert.equal(first.package.fileCount, 4);
  assert.equal(first.package.source.path, source);
  assert.equal(readFileSync(join(first.path, "references/guide.md"), "utf8"), "original reference\n");
  assert.equal(loadYuiSkillContexts(home, ["sample"])[0].path, first.path);
  writeFileSync(join(source, "references/guide.md"), "new reference\n");
  const [second] = loadYuiSkillContexts(home, ["sample"]);
  assert.notEqual(second.package.digest, first.package.digest);
  assert.equal(readFileSync(join(first.path, "references/guide.md"), "utf8"), "original reference\n");
  writeFileSync(join(source, "scripts/check.sh"), "#!/bin/sh\nexit 43\n");
  const changedScript = loadYuiSkillContexts(home, ["sample"])[0];
  assert.notEqual(changedScript.package.digest, second.package.digest);
  assert.match(readFileSync(join(first.path, "scripts/check.sh"), "utf8"), /exit 42/);
  chmodSync(join(source, "scripts/check.sh"), 0o644);
  assert.notEqual(loadYuiSkillContexts(home, ["sample"])[0].package.digest, changedScript.package.digest);
  const builtin = loadYuiSkillContexts(home, ["yui-runtime", "yui-leader"]);
  assert.equal(builtin[0].package.digest, builtin[1].package.digest);
  assert.equal(readFileSync(join(builtin[1].path, "../yui-runtime/SKILL.md"), "utf8").length > 0, true);
  const bootstrap = materializeSessionBootstrap({ yuiHome: home,
    role: { name: "leader", launchRevision: 1, defaultAccess: "write" },
    owner: { scope: "task", taskId: "task-1" }, roleKind: "leader", skills: [first],
    entryPoint: { executable: process.execPath, cliEntry: "/fixture/cli.js" } });
  assert.equal(readSessionBootstrapManifest(bootstrap.manifestPath).skills[0].digest, first.package.digest);
});

test("old Sessions resume with current Skills without requiring or rewriting frozen evidence", t => {
  const { home, source } = fixture(t);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date();
  store.saveTask(activateTask(createTask("task-1", "Skill snapshot", now, { cwd: home }), now));
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: "task-1" }, root: home, entries: []
  }, now));
  store.saveConfiguredAgent(createConfiguredAgent("codex", "codex", "false", [], [], now));
  const role = { ...createRole("task-1", "leader",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })], "codex", home, now), skills: ["sample"] };
  store.saveRole("task-1", role);
  const first = resolveEffectiveLaunch({ store, role, purpose: "execution" });
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet({
    scope: "task", taskId: "task-1", roleName: "leader"
  }, "codex", now), { agentId: "codex", adapterId: "codex", nativeSessionId: "fixture",
    policy: "fixed", status: "active", effective: first }, now));
  writeFileSync(join(source, "SKILL.md"), "Current instructions.\n");
  writeFileSync(join(source, "VERSION"), "2\n");
  const resumed = resolveEffectiveLaunch({ store, role, purpose: "execution" });
  assert.deepEqual(resumed.skillPackages, first.skillPackages);
  const context = compileRoleSessionContext(home, role, { scope: "task", taskId: "task-1" });
  assert.equal(context.skills.at(-1).path, source);
  assert.equal(context.skills.at(-1).version, "2");
  assert.equal(context.skills.at(-1).content, "Current instructions.");
  const planner = new FileRoleLaunchPlanner(home, store, {
    environment: { HOME: home, PATH: process.env.PATH, CODEX_HOME: join(home, "account") }
  });
  const plan = () => planner.plan({ taskId: "task-1", roleName: "leader", agentId: "codex", adapterId: "codex",
    mode: "resume", nativeSessionId: "fixture" });
  assert.equal(readSessionBootstrapManifest(plan().launch.env.YUI_SESSION_MANIFEST).skills.at(-1).path, source);
  const ref = first.skillPackages.at(-1);
  chmodSync(join(ref.path, "references/guide.md"), 0o600);
  writeFileSync(join(ref.path, "references/guide.md"), "tampered\n");
  assert.throws(() => verifySkillPackage(ref), /changed/);
  assert.doesNotThrow(plan, "Corrupt historical audit files are not current loading authority.");
  const sessions = store.getTaskRoleSessionSet("task-1", "leader");
  const { skillPackages, ...unrecorded } = sessions.sessions.codex.effective;
  store.saveTaskRoleSessionSet({ ...sessions, sessions: { ...sessions.sessions,
    codex: { ...sessions.sessions.codex, effective: unrecorded } } });
  assert.doesNotThrow(plan, "Valid pre-1.5 Session evidence may be absent.");
  assert.equal(store.getTaskRoleSessionSet("task-1", "leader").sessions.codex.effective.skillPackages, undefined);
  rmSync(source, { recursive: true });
  assert.throws(plan, /Skill.*sample.*unreadable|Skill.*sample.*missing/);
});

test("package path boundaries and size limits reject symlinks and overlarge files before use", t => {
  const { home, source } = fixture(t);
  symlinkSync("/etc/passwd", join(source, "references/escape"));
  assert.throws(() => loadYuiSkillContexts(home, ["sample"]), /symlinks/);
  rmSync(join(source, "references/escape"));
  writeFileSync(join(source, "oversized"), Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.throws(() => loadYuiSkillContexts(home, ["sample"]), /exceeds limits/);
  assert.throws(() => loadYuiSkillContexts(home, ["../escape"]), /Invalid/);
});

test("each check resolves live versions from stable paths, including a historical manifest with missing audit files", t => {
  const { home, source } = fixture(t);
  const frozen = loadYuiSkillContexts(home, ["sample"]);
  const bootstrap = materializeSessionBootstrap({ yuiHome: home,
    role: { name: "leader", launchRevision: 1, defaultAccess: "write" },
    owner: { scope: "task", taskId: "task-1" }, roleKind: "leader", skills: frozen,
    entryPoint: { executable: process.execPath, cliEntry: "/fixture/cli.js" } });
  const original = readFileSync(bootstrap.manifestPath, "utf8");
  rmSync(join(home, "runtime", "skill-packages"), { recursive: true });
  const check = () => checkSessionSkills(home, bootstrap.manifestPath);
  const first = check();
  assert.deepEqual(first.skills, [{ id: "sample", path: source, version: "1", versionPath: join(source, "VERSION") }]);
  assert.deepEqual(check(), first, "Checking again stores no consumed/loaded state.");
  assert.equal(Object.hasOwn(first.skills[0], "content"), false);
  assert.equal(Object.hasOwn(first, "loaded"), false, "Context presence is an Agent judgment, never a fabricated receipt.");
  writeFileSync(join(source, "references/guide.md"), "Updated required reference.\n");
  writeFileSync(join(source, "VERSION"), "2\n");
  assert.equal(check().skills[0].version, "2");
  assert.equal(check().skills[0].path, source);
  assert.equal(readFileSync(bootstrap.manifestPath, "utf8"), original, "Never rewrite historical manifests.");
  rmSync(join(source, "VERSION"));
  assert.throws(check, /Current Skill sample.*VERSION/);
  writeFileSync(join(source, "VERSION"), "2\n");
  rmSync(join(source, "SKILL.md"));
  assert.throws(check, /Current Skill sample.*SKILL.md/);
  assert.throws(() => checkCurrentSkills(home, ["../escape"]), /Invalid/);
});
