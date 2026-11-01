import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as notices from "../../dist/context/sessionSkillNotice.js";
import { materializeSessionBootstrap } from "../../dist/context/sessionBootstrapManifest.js";
import { loadYuiSkillContexts } from "../../dist/context/roleSessionContext.js";
import { codexInteractiveSkillInput } from "../../dist/runtime/codexInteractiveHost.js";

test("Host checks live Skills without repeated model checks; only accepted notices advance metadata", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-host-skills-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = join(home, "skills", "sample");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "Keep original requirements.\n");
  writeFileSync(join(source, "VERSION"), "1\n");
  const other = join(home, "skills", "unchanged-skill");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "SKILL.md"), "Keep other requirements.\n");
  writeFileSync(join(other, "VERSION"), "1\n");
  const bootstrap = materializeSessionBootstrap({
    yuiHome: home, role: { name: "leader", launchRevision: 1, defaultAccess: "write" },
    owner: { scope: "task", taskId: "task-1" }, roleKind: "leader",
    skills: loadYuiSkillContexts(home, ["sample", "unchanged-skill"]),
    entryPoint: { executable: process.execPath, cliEntry: "/fixture/cli.js" }
  });
  const env = { YUI_SESSION_MANIFEST: bootstrap.manifestPath };
  const notice = notices.createSessionSkillNotice(home);
  const first = notice.prepare("original input", env, "thread-1");
  assert.match(first.text, /sample/);
  assert.match(first.text, /unchanged-skill/);
  assert.ok(first.text.includes(bootstrap.roleProfilePath),
    "Cold guidance supplies the exact Manifest profile, not a Task configuration projection.");
  assert.ok(first.text.endsWith("original input"));
  assert.equal(notice.prepare("original input", env, "thread-1").text, first.text,
    "Preparation/unknown submission is not an accepted notice.");
  first.commit();
  const warm = notice.prepare("next input", env, "thread-1");
  assert.doesNotMatch(warm.text, /versionPath|sample|session skills --json/);
  assert.ok(!warm.text.includes(bootstrap.roleProfilePath),
    "Unchanged input must not repeat the cold profile pointer.");
  assert.ok(Buffer.byteLength(warm.text) < Buffer.byteLength(first.text));
  // An unchanged long-running conversation carries only the engineering
  // observation, not a repeated instruction/recovery manual on every input.
  for (let index = 0; index < 100; index += 1) {
    const body = `business input ${index}`;
    const next = notice.prepare(body, env, "thread-1");
    assert.ok(next.text.endsWith(body), "Keep the business input verbatim.");
    assert.ok(Buffer.byteLength(next.text) - Buffer.byteLength(body) <= 128,
      "Ordinary input has a bounded check result, not loading procedures.");
    next.commit();
  }
  writeFileSync(join(source, "VERSION"), "2\n");
  const changed = notice.prepare("upgrade input", env, "thread-1");
  assert.match(changed.text, /sample/);
  assert.match(changed.text, /"version":"2"/);
  assert.doesNotMatch(changed.text, /unchanged-skill/,
    "A version change should only repeat the affected Skill pointer.");
  changed.commit();
  assert.match(notice.prepare("new thread", env, "thread-2").text, /sample/);
  assert.match(notice.prepare("recovery", env, "thread-1", { recovery: true }).text, /sample/);
  notice.invalidate();
  changed.commit();
  assert.match(notice.prepare("reattached", env, "thread-1").text, /sample/,
    "A late acceptance must not erase a recovery boundary.");
  const renewed = notice.prepare("ready", env, "thread-1");
  renewed.commit();
  rmSync(join(source, "VERSION"));
  assert.throws(() => notice.prepare("must not submit", env, "thread-1"), /Current Skill sample/);
  writeFileSync(join(source, "VERSION"), "2\n");
  assert.match(notice.prepare("repaired", env, "thread-1").text, /sample/);
  const originalParts = [{ type: "text", text: "user original" }, { type: "image", url: "fixture-image" }];
  const native = codexInteractiveSkillInput(notice, env, "thread-1", { input: originalParts, threadId: "thread-1" });
  assert.deepEqual(native.params.input.slice(1), originalParts);
  assert.equal(native.params.threadId, "thread-1");
  assert.match(native.params.input[0].text, /sample/);
  native.commit();
  const nativeWarm = codexInteractiveSkillInput(notice, env, "thread-1", { input: originalParts });
  assert.doesNotMatch(nativeWarm.params.input[0].text, /sample|session skills --json/);
  assert.deepEqual(nativeWarm.params.input.slice(1), originalParts);
  assert.equal(notice.prepare("unmanaged", {}, "thread-1").text, "unmanaged");
});
