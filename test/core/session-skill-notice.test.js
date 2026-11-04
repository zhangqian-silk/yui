import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as notices from "../../dist/context/sessionSkillNotice.js";
import { materializeSessionBootstrap, checkSessionSkills, checkSessionSkillsAsync } from "../../dist/context/sessionBootstrapManifest.js";
import { loadYuiSkillContexts } from "../../dist/context/roleSessionContext.js";
import { codexInteractiveSkillInput } from "../../dist/runtime/codexInteractiveHost.js";
import { createNonBlockingChecks } from "../../dist/runtime/lifecycleChecks.js";
import { createHostSessionLifecycle } from "../../dist/runtime/hostSessionLifecycle.js";
import { CodexAppServerRuntime } from "../../dist/runtime/codexAppServerRuntime.js";
import { isNativeContextRecovery } from "../../dist/runtime/contextRecovery.js";

test("Host checks live Skills without repeated model checks; only accepted notices advance metadata", async t => {
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
  assert.deepEqual(await checkSessionSkillsAsync(home, bootstrap.manifestPath, new AbortController().signal),
    checkSessionSkills(home, bootstrap.manifestPath), "Advisory async checks resolve the same current metadata.");
  const notice = notices.createSessionSkillNotice(home);
  const first = notice.prepare("original input", env, "thread-1");
  assert.equal(first.inputText, "original input");
  assert.match(first.context, /sample/);
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
  // An unchanged long-running conversation has no extra injected content.
  for (let index = 0; index < 100; index += 1) {
    const body = `business input ${index}`;
    const next = notice.prepare(body, env, "thread-1");
    assert.ok(next.text.endsWith(body), "Keep the business input verbatim.");
    assert.equal(next.text, body,
      "Ordinary input is byte-for-byte unchanged, without notices, markers or separators.");
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
  const compacted = notice.prepare("after compact", env, "thread-1", { contextEpoch: 1 });
  compacted.commit();
  assert.doesNotMatch(notice.prepare("same epoch", env, "thread-1", { contextEpoch: 1 }).text, /sample/);
  assert.match(notice.prepare("next compact", env, "thread-1", { contextEpoch: 2 }).text, /sample/);
  notice.invalidate();
  changed.commit();
  assert.match(notice.prepare("reattached", env, "thread-1").text, /sample/,
    "A late acceptance must not erase a recovery boundary.");
  const renewed = notice.prepare("ready", env, "thread-1");
  renewed.commit();
  const compacted = { method: "item/completed", params: { threadId: "thread-1", item: { type: "contextCompaction" } } };
  assert.equal(isNativeContextRecovery("codex", "other-thread", compacted), false);
  assert.equal(isNativeContextRecovery("codex", "thread-1", compacted), true);
  const afterCompaction = notice.prepare("after compaction", env, "thread-1", { contextEpoch: 1 });
  assert.equal(afterCompaction.inputText, "after compaction");
  assert.match(afterCompaction.context, /sample/);
  rmSync(join(source, "VERSION"));
  let reportFailure;
  const failure = new Promise(resolve => { reportFailure = resolve; });
  const checks = createNonBlockingChecks([notices.createSessionSkillLifecycleCheck(home, () => env)], reportFailure);
  const lifecycle = createHostSessionLifecycle({ after: checks });
  lifecycle.send({ type: "connected", occupancy: "idle", nativeSessionId: "thread-1" });
  assert.equal(lifecycle.state, "idle", "Invalid Skill metadata cannot hold Session lifecycle transitions.");
  assert.match(String(await failure), /Current Skill sample/);
  checks.close();
  assert.throws(() => notice.prepare("must not submit", env, "thread-1"), /Current Skill sample/);
  writeFileSync(join(source, "VERSION"), "2\n");
  assert.match(notice.prepare("repaired", env, "thread-1").text, /sample/);
  const originalParts = [{ type: "text", text: "user original" }, { type: "image", url: "fixture-image" }];
  const native = codexInteractiveSkillInput(notice, env, "thread-1", { input: originalParts, threadId: "thread-1" });
  assert.deepEqual(native.params.input, originalParts,
    "Host metadata must never enter the native user input/title preview.");
  assert.equal(native.params.threadId, "thread-1");
  assert.match(native.params.additionalContext["yui.session-skills"].value, /sample/);
  assert.equal(native.params.additionalContext["yui.session-skills"].kind, "application");
  native.commit();
  const nativeWarm = codexInteractiveSkillInput(notice, env, "thread-1", { input: originalParts });
  assert.equal(nativeWarm.params.input, originalParts,
    "Unchanged native input retains every original part without an extra text part.");
  assert.equal(nativeWarm.params.additionalContext, undefined);
  const callerContext = { editor: { kind: "untrusted", value: "Selected code" } };
  assert.deepEqual(codexInteractiveSkillInput(notice, env, "thread-1",
    { input: originalParts, additionalContext: callerContext }).params.additionalContext.editor,
  callerContext.editor, "Native client context must survive Host mediation.");
  assert.equal(notice.prepare("unmanaged", {}, "thread-1").text, "unmanaged");
});

test("Codex submit and steer keep application context out of user input", async () => {
  const requests = [];
  const runtime = new CodexAppServerRuntime({
    async request(method, params) {
      requests.push({ method, params });
      if (method === "thread/read") return { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } };
      if (method === "thread/turns/list") return { data: [{ id: "turn-1", status: "inProgress" }], nextCursor: null };
      return method === "turn/start" ? { turn: { id: "turn-1" } } : { turnId: "turn-1" };
    }
  });
  const additionalContext = { "yui.session-skills": { kind: "application", value: "internal check" } };
  await runtime.submitTurn({ conversationId: "thread-1", attemptId: "input-1",
    text: "business", expectedNoActiveTurn: true, additionalContext });
  await runtime.steerTurn({ conversationId: "thread-1", expectedTurnId: "turn-1",
    text: "follow-up", additionalContext });
  for (const [index, request] of requests.filter(request => request.method.startsWith("turn/")).entries()) {
    assert.deepEqual(request.params.additionalContext, additionalContext);
    assert.equal(request.params.input[0].text, index === 0 ? "business" : "follow-up");
  }
});
