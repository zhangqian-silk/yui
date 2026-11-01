// Small adapter for the existing runner. No model or new background service.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { digest } from "./evidence.mjs";
import { judgeContext } from "./context-oracle.mjs";

export const contextDefinitions = ["CTX-OP", "CTX-LEADER"].map(id => ({
  id, category: "context", split: "dev", family: id, modes: ["F"], tags: []
})).concat(["CTX-OP-CONFIRM", "CTX-LEADER-CONFIRM"].map(id => ({
  id, category: "context", split: "holdout", family: id, modes: ["F"], tags: []
})));
export const contextRecipe = Object.freeze({
  version: "context-proxy-1", stages: ["entry", "continue", "recovery"],
  recoveryReferences: ["references/context-ordering.md", "references/recovery.md"],
  body: "Analysis only: preserve α. Read the current original; do not activate, accept, publish or resend anything."
});

export function measureFrames(frames) {
  let resident = 0;
  const result = { newVisibleUtf8: 0, newVisibleCharacters: 0, residentUtf8: [],
    recoveryReloadUtf8: 0, notificationUtf8: 0, tokens: "unknown" };
  for (const frame of frames) {
    if (frame.reset) resident = 0; // A declared proxy reset, not observed model compaction.
    for (const chunk of frame.chunks) {
      const bytes = Buffer.byteLength(chunk.text);
      result.newVisibleUtf8 += bytes;
      result.newVisibleCharacters += [...chunk.text].length;
      resident += bytes;
      if (chunk.kind === "notification") result.notificationUtf8 += bytes;
      if (frame.stage === "recovery" && ["skill", "reference", "developer"].includes(chunk.kind))
        result.recoveryReloadUtf8 += bytes;
    }
    result.residentUtf8.push(resident);
  }
  return result;
}

export async function runContextProxy(checkout, fixture, condition) {
  const load = path => import(pathToFileURL(join(checkout, "dist", path)).href);
  const presentation = await load("interaction/notificationPresentation.js");
  const bootstrap = await load("context/sessionBootstrapManifest.js");
  const { compileRoleSessionContext } = await load("context/roleSessionContext.js");
  const confirmationBytes = readFileSync(new URL("./context-confirmation.json", import.meta.url), "utf8");
  const confirmation = JSON.parse(confirmationBytes).families[condition.id];
  const body = confirmation ? confirmation.body + "\n" + confirmation.padding.repeat(confirmation.repeat)
    : contextRecipe.body;
  const operator = condition.id.startsWith("CTX-OP"), role = operator ? "operator" : "leader";
  const task = fixture.call(["task", "create", "Analysis only"], "prepare").task;
  fixture.call(["task", "message", "send", task.id, body,
    "--intent", "record", "--request-id", "context-source"], "prepare");
  const records = fixture.messageRecords(task.id);
  if (records.length !== 1) throw new Error("Expected one original context source");
  const source = records[0].value, originalId = source.id;
  const profile = { name: role, launchRevision: 1, defaultAccess: "read",
    description: "Read the current synthetic original; no business effects." };
  const owner = operator ? { scope: "global" } : { scope: "task", taskId: task.id };
  const compiled = compileRoleSessionContext(fixture.home, profile, owner);
  const materialized = bootstrap.materializeSessionBootstrap({
    yuiHome: fixture.home, role: profile, owner, roleKind: role, skills: compiled.skills,
    entryPoint: { executable: process.execPath, cliEntry: join(checkout, "dist/cli.js") }
  });
  // This is a component/CLI proxy with no managed writer. A Manifest here is
  // measurement material, never a fabricated active Session or execution grant.
  const notification = operator
    ? presentation.globalMessagePresentation(role, originalId, {
      author: { type: "user" }, body: `Yui-Summary: Inspect ${task.id}/${originalId}. Analysis only.`
    })
    : presentation.taskNotificationPresentation({
      taskId: task.id, id: "wake-context", reasons: ["user-message", "session-replaced"],
      fromCursor: "2026-10-23T00:00:00.000Z", toCursor: "2099-01-01T00:00:00.000Z",
      refs: [{ type: "message", taskId: task.id, id: originalId }]
    }, { listMessages: () => [source], getRun: () => null });
  const fullNotification = bootstrap.withSessionContextPointer(notification, {
    YUI_SESSION_MANIFEST: materialized.manifestPath
  });
  const before = fixture.call(["task", "show", task.id]).task;
  const first = fixture.trace.length, originals = [], frames = [];
  for (const stage of contextRecipe.stages) {
    const chunks = [], frame = { stage, reset: stage === "recovery", chunks };
    const add = (kind, text, path) => chunks.push({ kind, text, sha256: digest(text), ...(path ? { path } : {}) });
    add("notification", fullNotification);
    if (stage !== "continue") {
      add("developer", compiled.developerInstructions);
      add("profile", readFileSync(materialized.roleProfilePath, "utf8"), materialized.roleProfilePath);
      for (const skill of compiled.skills)
        add("skill", readFileSync(join(skill.path, "SKILL.md"), "utf8"), join(skill.path, "SKILL.md"));
      if (stage === "recovery") {
        const runtime = compiled.skills.find(skill => skill.id === "yui-runtime");
        for (const ref of contextRecipe.recoveryReferences)
          add("reference", readFileSync(join(runtime.path, ref), "utf8"), join(runtime.path, ref));
      }
    }
    const capture = args => {
      const start = fixture.trace.length;
      const value = fixture.detail(args);
      for (const entry of fixture.trace.slice(start))
        add("context", entry.stdout + entry.stderr);
      return value;
    };
    // Global Context performs its own current Skill check. Leader's public
    // context does not, so use the actual target checkSessionSkills component.
    if (operator) capture(["session", "context", role]);
    else {
      add("context", JSON.stringify({ ok: true, data:
        bootstrap.checkSessionSkills(fixture.home, materialized.manifestPath) }) + "\n");
      capture(["task", "context", task.id]);
    }
    const read = capture(["task", "message", "show", `${task.id}/${originalId}`]);
    originals.push(read.message ?? read);
    frames.push(frame);
  }
  const actionTrace = fixture.trace.slice(first);
  const after = fixture.call(["task", "show", task.id]).task;
  condition.manifest = { sourceHashes: { recipe: digest(JSON.stringify(contextRecipe)),
    body: digest(body), confirmation: digest(confirmationBytes) } };
  condition.role = role;
  condition.proxy = { frames, source, originals, actionTrace, snapshots: [before, after],
    skillVersions: compiled.skills.map(({ id, version }) => ({ id, version })),
    cost: { ...measureFrames(frames), cliCalls: actionTrace.length, modelRequests: 0,
      frames: frames.length, associatedExecutorCost: "not-measured-no-delegation" } };
  condition.score = judgeContext(condition.proxy);
  condition.businessStatus = condition.score.status;
  condition.status = condition.score.status === "fail" ? "fail" : "partial-evidence";
  condition.boundaries = { semanticQuality: "pending-human", activeRoleExecution: "not-exercised",
    analysisEffects: "no-observed-task-change", notification: "actual-product-renderer",
    instructionCost: "actual-product-files", contextCost: "actual-cli-outputs",
    compaction: "declared-proxy-reset-not-native-observation" };
  condition.stages = { saved: true, discovered: true, understood: "unverified", acted: false };
}
