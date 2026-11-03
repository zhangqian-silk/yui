import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { FrameworkFixture } from "./fixture.mjs";
import { fixturePermissionArguments } from "./isolation.mjs";
import { save, now, hash, completeJsonLines, Failure, subjectInstructions, environmentInstructions, planningReferences, lifecycleWorkingSet, currentPlanningContract, isSessionRecovery, chainStages, routesStage, isBusinessScenario } from "./common.mjs";
import { ReplayObserver } from "./support/replay-observer.mjs";
import { gradeHandling, initialPlanningBinding, gradeBusiness, gradeGlobal, gradeLoads, gradeReads, instructionLoadCosts, outcome, forbiddenFileChanges, stageVerdict, stageAllowsContinuation, subjectFailure, controllerAccessFailure, protocolApplicable, gradeDecisionChanges, gradeSkillBinding, gradeRoutedInput, gradeRecoveryStop, gradeRecoverySuccessor, gradeRecoveryPreservation, gradeRecoveryInspection, gradeRecoveryCheckpoint } from "./judge.mjs";
import { tokenTotals } from "../adapters/codex/usage.mjs";
import { epochAt, nativeEvidence, selectTerminal, selectHandlingTerminal, nativeCommandFailures, reportingAction, nativeContinuationProof, gradeCliExecution } from "./native-evidence.mjs";
import { attributeNativeEvents, readNativeTransports } from "./native-ownership.mjs";
import { reportingCarrier, taskFactsCarrier, taskFactsAction, contextExpansionAction, gradeInstructionObligations, gradeHostSkillCheck } from "./obligations.mjs";
const [planFile, scenario, output] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile));
const preflightBytes = readFileSync(join(dirname(planFile), "preflight.json"));
if (hash(preflightBytes) !== plan.preflightIdentity) throw Error("Frozen preflight identity changed");
const preflight = JSON.parse(preflightBytes);
const scene = plan.businessScenarios?.[scenario];
if (isBusinessScenario(scenario) && (!scene || hash(JSON.stringify(plan.businessScenarios)) !== preflight.businessScenariosHash))
  throw Error("Missing or changed frozen business scenario");
if (!plan.scenarios.includes(scenario)) throw Error("Scenario not frozen");
for (const [path, digest] of Object.entries(plan.harnessFiles))
  if (hash(readFileSync(join(plan.harnessRoot, path))) !== digest) throw Error(`Frozen harness changed: ${path}`);
mkdirSync(output);
const f = new FrameworkFixture(plan.product, output, plan.mode, scenario, plan.providerBin, plan.permissionMode, plan.cliEntryMode,
  plan.originalToolAvailability === "available" ? plan.originalToolFiles : undefined);
f.client.deadline = Date.now() + plan.limits.cliBudgetMs;
const report = { scenario, plannedStages: chainStages(scenario), startedAt: now(), completedStages: 0, stages: [], routes: [], status: "not-run",
  decisionPolicy: plan.decisionPolicy,
  permissionMode: plan.permissionMode ?? "workspace-write", osIsolation: plan.osIsolation ?? "unproven",
  mode: plan.mode, actualModelCalls: plan.mode === "fake" ? 0 : "unknown",
  historicalPerformanceConditions: 59, frameworkScenario: true, inputIdentity: plan.inputIdentity,
  harnessIdentity: plan.harnessIdentity, configurationIdentity: plan.configurationIdentity };
let observer, interrupted, initialDispatch, initialRun, startupGuidance;
const sourceFiles = new Map(), nativeAdapter = plan.mode === "real" || ["native-normal", "normal-warm"].includes(scenario) || isSessionRecovery(scenario) || isBusinessScenario(scenario);
process.on("SIGTERM", () => { interrupted = "SIGTERM"; }); process.on("SIGINT", () => { interrupted = "SIGINT"; });
const values = (state, table) => (state[table] ?? []).map(r => JSON.parse(r.payload));
const rawTransports = () => readNativeTransports(output);
const transports = () => attributeNativeEvents(rawTransports()).events;
function checkControllerPrerequisite(terminal, stage) {
  if (!nativeAdapter) return;
  const failure = controllerAccessFailure(nativeCommandFailures(transports(), {
    ...terminal.binding, threadId: terminal.threadId, turnId: terminal.turnId,
  }));
  if (failure) {
    report.failureFacts = { ...failure, nativeTerminal: terminal };
    report.blockedStage = stage;
    throw new Failure(failure.status, failure.fact + "; no retry/replay");
  }
}
const traces = () => existsSync(join(output, "participant")) ? readdirSync(join(output, "participant"))
  .map(n => JSON.parse(readFileSync(join(output, "participant", n)))) : [];
const expectedSources = new Map();
function cliProcessEvidence() {
  const path = join(output, "cli-process-receipts.jsonl");
  if (!existsSync(path)) return undefined;
  try {
    const { records, tail } = completeJsonLines(readFileSync(path, "utf8"));
    return { receipts: records, incomplete: Boolean(tail), launcherSha256: preflight.launcher };
  } catch { return { receipts: [], incomplete: true, launcherSha256: preflight.launcher }; }
}
const skillBinding = (bundles, roleName, scope) => gradeSkillBinding(bundles, expectedSkillSources(roleName), scope,
  gradeHostSkillCheck(transports(), expectedSkillSources(roleName), scope, [...sourceFiles.values()]));
const cliIdentity = (terminal, scope, effect) => nativeAdapter
  ? gradeCliExecution(transports(), terminal.binding, preflight.actualCli["--json version"],
    { ...scope, nativeStartAt: terminal.startedAt, throughAt: terminal.at, effect }, [...sourceFiles.values()], cliProcessEvidence())
  : { status: "pass", scope: "deterministic parent-spawned fixture entry only; not native Subject execution" };
const originalOptions = () => ({ originalAudits: existsSync(join(output, "original-tool-audit.jsonl"))
  ? readFileSync(join(output, "original-tool-audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [] });
function expectedSkillSources(roleName) {
  if (!expectedSources.has(roleName)) expectedSources.set(roleName, ["yui-runtime", `yui-${roleName}`].map(id => {
    const path = join(plan.product, "skills", id), versionPath = join(path, "VERSION");
    const bytes = readFileSync(versionPath);
    if (hash(bytes) !== preflight.skills[`${id}/VERSION`]?.sha256)
      throw new Failure("framework-invalid", "Frozen Skill version changed", "group");
    return { id, path, version: bytes.toString().trim(), versionPath };
  }));
  return expectedSources.get(roleName);
}
async function until(label, callback) {
  const deadline = Date.now() + plan.limits.stageWaitMs;
  for (;;) {
    if (interrupted) throw new Failure("interrupted", `User/coordinator ${interrupted}`);
    if (f.collector && f.collector.exitCode !== null)
      throw new Failure("infrastructure-failed", "Independent collector exited during business; no next input");
    const value = callback(); if (value) return value;
    if (Date.now() > deadline) throw new Failure("infrastructure-failed", `Timeout ${label}; no replay`);
    await delay(50);
  }
}
function captureInitialPlanning(state, taskId, messageId) {
  if (!initialDispatch) {
    const binding = initialPlanningBinding(state, taskId, messageId);
    if (binding) {
      initialDispatch = binding.dispatch; initialRun = binding.run;
      save(join(output, "initial-dispatch.json"), { at: now(), ...binding });
    }
  }
  return initialDispatch && initialRun;
}
async function nativeTerminal(since, originalId, roleName, taskId, expectedThread, onState) {
  let progressAt = Date.now();
  const completedTools = new Set();
  return until("exact native terminal", () => {
    const events = transports();
    if (plan.mode === "real" && events.some(e => e.binding?.roleName === roleName
      && e.binding?.taskId === taskId && e.message?.result?.model
      && (e.message.result.model !== "gpt-6-luna" || e.message.result.reasoningEffort !== "medium")))
      throw new Failure("framework-invalid", "Actual native model/effort differs from frozen gpt-6-luna/medium", "group");
    if (plan.mode === "real") {
      const start = events.find(e => Date.parse(e.at) >= Date.parse(since) && e.binding?.roleName === roleName
        && e.binding?.taskId === taskId && e.message?.method === "turn/started");
      if (start) {
        const threadId = start.message.params.threadId;
        const currentScope = {
          taskId, roleName, threadId, turnId: start.message.params.turn.id,
          epoch: epochAt(events, threadId, now()), beforeAt: now(), afterAt: since,
        };
        const binding = skillBinding(nativeEvidence(events), roleName, currentScope);
        if (binding.status === "fail")
          throw new Failure("framework-invalid", `Actual CLI Skill source differs from frozen product: ${JSON.stringify(binding)}`, "group");
      }
    }
    for (const e of events) {
      const item = e.message?.params?.item;
      if (Date.parse(e.at) < Date.parse(since) || e.binding?.roleName !== roleName
        || e.binding?.taskId !== taskId || e.message?.method !== "item/completed"
        || item?.type !== "commandExecution") continue;
      const fingerprint = hash(JSON.stringify([item.command, item.exitCode, item.aggregatedOutput]));
      if (!completedTools.has(fingerprint)) {
        completedTools.add(fingerprint); progressAt = Date.now();
      }
    }
    if (Date.now() - progressAt > plan.limits.idleWaitMs)
      throw new Failure("infrastructure-failed", "No novel completed native tool within idle budget; no replay");
    const state = observer.readState();
    onState?.(state);
    const original = taskId ? values(state, "task_wakes").find(w => w.taskId === taskId && w.refs.some(r => r.id === originalId))
      : values(state, "global_role_messages").find(m => m.id === originalId);
    const receipt = original?.inbox?.ack ?? original?.inbox?.claim;
    const run = taskId && !original && initialRun ? values(state, "turns").find(r => r.id === initialRun.id) : null;
    if (!receipt && !run) return false;
    if (run && !run.result?.provider) return false;
    const terminal = selectHandlingTerminal(events, { since, roleName, taskId, expectedThread, receipt, run });
    if (terminal) {
      const turn = terminal.turn;
      if (turn.status !== "completed") {
        const commands = nativeAdapter ? nativeCommandFailures(transports(), { roleName, taskId,
          threadId: terminal.threadId, turnId: terminal.turnId })
          : traces().filter(t => t.scope?.taskId === taskId && t.scope?.roleName === roleName
            && t.threadId === terminal.threadId && t.turnId === terminal.turnId).flatMap(t => t.trace);
        report.failureFacts = { ...subjectFailure(commands),
          nativeTerminal: { threadId: terminal.threadId, turnId: terminal.turnId, status: turn.status, error: turn.error } };
        throw new Failure(report.failureFacts.status, `Exact owned native ${turn.status}: ${JSON.stringify(turn.error)}; ${JSON.stringify(report.failureFacts)}`);
      }
      let result; try { result = JSON.parse(turn.items.find(i => i.type === "agentMessage")?.text); } catch { /* real text */ }
      if (!nativeAdapter && !result?.handled.some(h => h.inboxId === originalId || h.original?.refId === originalId)) return false;
      const { turn: omitted, ...receipt } = terminal;
      return { ...receipt, result,
        reportItemId: turn.items.findLast(i => i.type === "agentMessage" && i.text?.trim())?.id };
    }
    return false;
  });
}
function instructionFiles(terminal, recovery = false, stage) {
  const path = terminal.binding?.manifestPath;
  if (!path?.startsWith(f.home + "/runtime/session-manifests/"))
    throw new Failure("framework-invalid", "Missing exact Host-owned Manifest binding");
  const manifest = JSON.parse(readFileSync(path));
  const files = [...manifest.skills.map(s => ({ path: join(s.path, "SKILL.md"), kind: "core" })),
    { path: manifest.roleProfileRef.path, kind: "profile" },
    ...[...planningReferences(terminal.binding.roleName, preflight.skills, recovery,
        { inspectExisting: recovery, businessStage: scene ? stage : undefined }),
      ...(recovery ? ["yui-runtime/references/recovery.md",
        ...(lifecycleWorkingSet(preflight.skills) ? ["yui-runtime/references/inbox-recovery.md"] : [])] : [])]
      .map(p => ({ path: join(plan.product, "skills", p), kind: "topic" }))];
  return files.map(file => {
    if (!file.path.startsWith(f.home + "/runtime/role-profiles/") && !file.path.startsWith(plan.product + "/skills/"))
      throw new Failure("framework-invalid", "Instruction outside frozen product/owned profile");
    const body = readFileSync(file.path, "utf8");
    if (file.path.startsWith(plan.product + "/skills/")) {
      const frozen = preflight.skills[relative(join(plan.product, "skills"), file.path)];
      if (frozen?.sha256 !== hash(body)) throw new Failure("framework-invalid", "Frozen product Skill changed", "group");
    }
    return { ...file, body, bytes: Buffer.byteLength(body), sha256: hash(body) };
  });
}
function evidenceFor(terminal, beforeAt, afterAt, recovery = false, stage) {
  const events = transports();
  const reporting = nativeAdapter ? reportingAction(events, terminal) : undefined;
  const business = { status: Number.isFinite(Date.parse(beforeAt)) ? "observed" : "unknown",
    kind: "business-effect-or-recovery-ACK", at: beforeAt };
  // A Message/report preceding the Decision already constrains base entries.
  // This can only tighten their deadline, never extend it to the report.
  const firstBusiness = reporting?.status === "observed" && Date.parse(reporting.at) < Date.parse(beforeAt)
    ? reporting : business;
  const scope = { taskId: terminal.binding.taskId, roleName: terminal.binding.roleName,
    threadId: terminal.threadId, turnId: terminal.turnId,
    epoch: epochAt(events, terminal.threadId, beforeAt), beforeAt, afterAt,
    ...(nativeAdapter ? { loadActions: {
      business: firstBusiness, reporting,
    } } : {}) };
  const files = instructionFiles(terminal, recovery, stage);
  for (const file of files) sourceFiles.set(file.path, file);
  const manifestPath = terminal.binding.manifestPath, manifestBody = readFileSync(manifestPath, "utf8");
  sourceFiles.set(manifestPath, { path: manifestPath, body: manifestBody, bytes: Buffer.byteLength(manifestBody),
    sha256: hash(manifestBody), kind: "manifest" });
  // A multi-file tool can include optional references as well as mandatory
  // entries. Verify the whole concatenation against the frozen inventory, not
  // only mandatory files; unknown/truncated text never becomes slice credit.
  for (const [path, meta] of Object.entries(preflight.skills)) {
    const absolute = join(plan.product, "skills", path);
    if (sourceFiles.has(absolute)) continue;
    if (!path.endsWith(".md")) {
      sourceFiles.set(absolute, { path: absolute, kind: "inventory-only", bytes: meta.bytes, sha256: meta.sha256 });
      continue;
    }
    const body = readFileSync(absolute, "utf8");
    if (hash(body) !== meta.sha256) throw new Failure("framework-invalid", "Frozen instruction inventory changed", "group");
    sourceFiles.set(absolute, { path: absolute, kind: "reference-inventory", body, bytes: Buffer.byteLength(body), sha256: meta.sha256 });
  }
  const bundles = nativeAdapter ? nativeEvidence(transports(), [...sourceFiles.values()], originalOptions()) : traces();
  if (nativeAdapter) {
    if (currentPlanningContract(preflight.skills)) {
      const expansion = contextExpansionAction(bundles, events, scope);
      scope.contextExpansionAction = expansion;
      if (expansion.status !== "not-observed") {
        const file = sourceFiles.get(join(plan.product, "skills/yui-runtime/references/context-reads.md"));
        files.push({ ...file, kind: "topic", action: expansion });
      }
    }
    const action = taskFactsAction(bundles, events, scope);
    scope.taskFactsAction = action;
    if (action.status !== "not-observed") {
      const carrier = taskFactsCarrier(preflight.skills);
      const file = carrier.status === "observed" && sourceFiles.get(join(plan.product, "skills", carrier.path));
      if (file) {
        const existing = files.findIndex(f => f.path === file.path);
        if (existing >= 0) files[existing] = { ...files[existing], action };
        else files.push({ ...file, kind: "topic", action });
      }
      else scope.taskContextObservation = { status: "unknown", carrier, action,
        reason: "Observed Task-fact read, but this frozen product's exact instruction carrier is not reviewed; obligation is not waived" };
    }
  }
  return { scope, files, bundles };
}
const instructionGrade = ev => gradeInstructionObligations(ev.bundles, ev.files, ev.scope,
  reportingCarrier(preflight.skills));
function checkpoint() { save(join(output, `checkpoint-${report.stages.length}-${report.completedStages}.json`), report); }
function publicSubmission(args, key, task) {
  const response = f.client.call(args, "producer");
  const originals = values(observer.readState(), "messages").filter(m => m.taskId === task && m.submissionKey === key);
  if (originals.length !== 1) throw new Failure("framework-invalid", "Public submission missing/ambiguous exact original; no replay");
  // operator submit intentionally returns a text receipt. Read actual saved
  // provenance instead of guessing an ID, replaying, or requiring old shape.
  return { response, message: originals[0], exactReadback: true };
}
try {
  await f.prepare();
  if (hash(readFileSync(f.cli)) !== preflight.launcher
    || hash(readFileSync(join(plan.product, "dist/cli.js"))) !== preflight.actualBuild["cli.js"]?.sha256)
    throw new Failure("framework-invalid", "Actual owned CLI launcher/build differs from frozen product", "group");
  report.productEntry = { cli: f.cli, launcherSha256: preflight.launcher,
    wrapper: join(f.root, "bin/yui"), wrapperSha256: hash(readFileSync(join(f.root, "bin/yui"))),
    cliBuildSha256: preflight.actualBuild["cli.js"].sha256,
    limit: "Frozen wrapper delegates to this exact launcher. Proxy environment is not Thread execution proof; per-stage cliIdentity is required." };
  observer = await ReplayObserver.create(plan.product, f);
  if (scenario === "collector-fail") {
    f.collector.kill("SIGTERM"); await f.collectorExit;
    throw new Failure("infrastructure-failed", "Injected actual owned collector exit before input; observation unknown");
  }
  if (scenario === "unknown-lifecycle") throw new Failure("observation-unknown", "Injected active-execution observation unknown; no business input started", "group");
  const instructions = subjectInstructions(plan.instructions, join(f.root, "bin/yui"), plan.product, plan.cliEntryMode);
  save(join(output, "subject-configuration.json"), {
    instructions, sha256: hash(instructions), limits: plan.limits,
    permissionMode: plan.permissionMode, permissionArguments: plan.permissionArguments, osIsolation: plan.osIsolation,
    templateIdentity: plan.configurationIdentity, cli: join(f.root, "bin/yui"), product: plan.product,
  });
  for (const role of ["operator", "leader"]) f.client.call(["config", "role", "update", role,
    "--model", "gpt-6-luna", "--effort", "medium", ...fixturePermissionArguments(plan.permissionMode),
    "--system-prompt", instructions, ...(role === "operator" ? ["--workspace", f.root] : []), "--yes"], "configure");
  const task = f.client.call(["task", "create", "Framework isolated planning business"], "producer").task.id;
  f.ownedTasks = [task];
  // Managed Codex deliberately keeps Role instructions in the profile. Put
  // environment-only guidance in each exact owned cwd BEFORE its first Thread
  // starts, so bootstrap CLI selection cannot depend on reading that profile.
  const workspace = values(observer.readState(), "task_roles")
    .find(r => r.taskId === task && r.name === "leader")?.workspace;
  if (workspace !== join(f.home, "runtime/task-runtimes/planning", task))
    throw new Failure("framework-invalid", "Unexpected planning cwd; no instruction write");
  startupGuidance = "# Isolated evaluation CLI binding\n\n"
    + environmentInstructions(join(f.root, "bin/yui"), plan.product, plan.cliEntryMode) + "\n"
    + (f.originalTool ? `\nOptional read-only original-body tool: ${process.execPath} ${f.originalTool.entry} '<JSON request>'. `
      + `Request {"kind":"run-message","runId":"exact run","messageId":"exact Run pointer refId"}; `
      + `or {"kind":"task-message","messageId":"exact Task Message ref from current context/wake"}; `
      + `or {"kind":"inbox-message","messageId":"exact Global inbox Message ID"}. `
      + `No CLI/Home/owner/Thread arguments: the existing fixture entry is bound; preserve inherited managed identity. `
      + `Explicit routes only; Task wakes are not Messages, no ID-based guessing or refusal fallback. `
      + `Returns the exact entire stdout of ONE normal authorized CLI page, not a verified whole-document receipt. `
      + `For continuation repeat the same request with "cursor" equal to its literal contentPage.nextCursor. `
      + `Complete all contiguous text pages and verify full digest/length; no padding removal or trimming. `
      + `Output <=64KiB, document <=2MiB, 20 seconds; explicit smaller maxOutputBytes/maxMs may fail, never truncate. `
      + `No cache, retry, whole-document fetch loop, Skills or writes. `
      + `Usage is optional; existing CLI reads remain available.\n` : "");
  const guidancePaths = [join(f.root, "AGENTS.md"), join(workspace, "AGENTS.md")];
  for (const path of guidancePaths) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, startupGuidance, { flag: "wx" });
  }
  save(join(output, "startup-guidance.json"), { paths: guidancePaths, body: startupGuidance,
    sha256: hash(startupGuidance), bytes: Buffer.byteLength(startupGuidance),
    source: "fixture-only environment guidance, no answers; installed before first subject input" });
  const foreign = f.client.call(["task", "create", "Framework foreign isolation boundary"], "producer").task.id;
  report.task = task; report.foreignTask = foreign;
  const sources = [];
  const publish = (body, key) => {
    const response = publicSubmission(["operator", "submit", body, "--task", task, "--intent", "record",
      "--request-id", key], key, task);
    sources.push({ taskId: task, id: response.message.id, body });
  };
  if (!scene) publish(plan.materials[0], "source-0");
  for (let stage = 1; stage <= chainStages(scenario); stage++) {
    if (f.collector.exitCode !== null) throw new Failure("infrastructure-failed", "Collector lost before input; no continuation");
    if (scene) {
      if (stage === 2) publicSubmission(["operator", "submit", scene.irrelevant, "--task", task, "--intent", "record",
        "--request-id", "unrelated-archive"], "unrelated-archive", task);
      scene.stages[stage - 1].materials.forEach((body, index) => publish(body, `source-${stage}-${index}`));
    } else if (stage === 2) publish(plan.materials[1], "source-1");
    const input = { kind: "eval-input", stage, effectKey: `framework-stage-${stage}`,
      sources: sources.map(s => ({ taskId: scenario === "cross-task" && stage === 2 ? foreign : task, id: s.id })),
      contract: plan.businessContract,
      ...(scene ? { business: "workshop-allocation", request: scene.stages[stage - 1].request } : {}),
      ...(isSessionRecovery(scenario) && stage === 2 ? { recovery: plan.recoveryContract } : {}) };
    const body = JSON.stringify(input), key = `input-${stage}`, at = now();
    const before = observer.begin();
    let submitted, routeOriginal, routeTerminal, routeObservation;
    if (routesStage(scenario, stage)) {
      const routeBody = JSON.stringify({ kind: "eval-route", taskId: task, input, routeKey: key,
        contract: plan.routingContract });
      const route = f.client.call(["role", "message", "queue", "operator", routeBody,
        "--request-id", `op-${key}`], "producer");
      routeTerminal = await nativeTerminal(at, route.message.id, "operator", undefined, undefined,
        stage === 1 ? state => {
          const routed = values(state, "messages").filter(m => m.taskId === task && m.submissionKey === key);
          if (routed.length === 1) captureInitialPlanning(state, task, routed[0].id);
        } : undefined);
      routeOriginal = values(observer.readState(), "global_role_messages").find(m => m.id === route.message.id);
      submitted = { message: values(observer.readState(), "messages").find(m => m.taskId === task && m.submissionKey === key) };
      const op = evidenceFor(routeTerminal, submitted.message?.createdAt ?? routeTerminal.at, route.message.createdAt, false, stage);
      routeObservation = { stage, evidenceScope: op.scope, terminal: routeTerminal, original: routeOriginal,
        input: gradeRoutedInput(submitted.message, { taskId: task, requestId: key, input }),
        grade: submitted.message ? gradeGlobal(routeOriginal, { id: route.message.id, body: routeBody,
          threadId: routeTerminal.threadId, effectAt: submitted.message.createdAt })
          : { status: "unknown", reason: "No saved routed original; route disposition/effects unresolved" },
        reads: gradeReads(op.bundles, [{ id: route.message.id, body: routeBody, store: "global-role-message" }], op.scope),
        cliIdentity: cliIdentity(routeTerminal, op.scope, { kind: "route", taskId: task,
          id: submitted.message?.id, requestId: key, at: submitted.message?.createdAt }),
        binding: skillBinding(op.bundles, "operator", op.scope),
        loads: instructionGrade(op) };
      report.routes.push(routeObservation);
      report.route ??= routeObservation; // Keep the historical first-route view.
      if (!submitted.message) checkControllerPrerequisite(routeTerminal, stage);
      if (routeObservation.input.status !== "pass")
        throw new Failure(routeObservation.input.status === "fail" ? "quality-fail" : "observation-unknown",
          `Operator routing contract: ${JSON.stringify(routeObservation.input)}; no replay`);
    } else submitted = publicSubmission(["operator", "submit", body, "--task", task, "--intent", "discuss",
      "--request-id", key], key, task);
    if (stage === 1) {
      await until("initial Run processing binding", () => {
        const state = observer.readState();
        return captureInitialPlanning(state, task, submitted.message.id);
      });
    }
    let terminal = await nativeTerminal(at, submitted.message.id, "leader", task);
    const effectTerminal = terminal;
    let predecessor;
    if ((scenario === "recovery" || isSessionRecovery(scenario)) && stage === 2) {
      const old = observer.readState(), retained = values(old, "task_wakes").filter(w => w.taskId === task
        && w.refs.some(r => r.id === submitted.message.id) && w.inbox?.claim
        && (isSessionRecovery(scenario) || !w.inbox?.ack));
      if (retained.length !== 1) throw new Failure(isSessionRecovery(scenario) ? "observation-unknown" : "framework-invalid",
        "Missing/unresolved exact original claim for recovery; no replacement");
      predecessor = terminal.threadId;
      const original = values(old, "messages").find(m => m.taskId === task && m.id === submitted.message.id);
      const decisions = values(old, "decisions").filter(d => d.taskId === task);
      const effect = decisions.find(d => d.title === input.effectKey);
      const preserved = { original, claim: retained[0].inbox.claim, effect };
      if (isSessionRecovery(scenario)) {
        report.recovery = { kind: "session-replacement", checkpoint: preserved, predecessor: terminal,
          simulatedProvider: plan.mode === "fake", nativeCompaction: "not-covered",
          stop: { status: "unknown", reason: "not yet confirmed" }, replacementRequested: false };
        const ev = evidenceFor(terminal, effect?.createdAt, original?.createdAt, false, stage);
        report.recovery.predecessorChecks = {
          predecessorCheckpoint: gradeRecoveryCheckpoint({ taskId: task, terminal, original, wake: retained[0], effect }),
          predecessorBusiness: gradeBusiness(decisions, input.effectKey, stage, scene?.expected[stage - 1]),
          predecessorReads: gradeReads(ev.bundles, sources, ev.scope, { reuse: true }),
          predecessorInputReads: gradeReads(ev.bundles, [{ taskId: task, id: original?.id, body: original?.body }], ev.scope),
          predecessorBinding: skillBinding(ev.bundles, "leader", ev.scope),
          predecessorCliIdentity: cliIdentity(terminal, ev.scope, { kind: "decision", taskId: task,
            id: effect?.id, title: effect?.title, at: effect?.createdAt,
            digest: effect ? hash(JSON.stringify(effect)) : undefined }),
          predecessorLoads: instructionGrade(ev),
        };
        report.recovery.predecessorVerdict = stageVerdict(report.recovery.predecessorChecks);
        save(join(output, "recovery-checkpoint.json"), report.recovery);
        if (!stageAllowsContinuation(report.recovery.predecessorVerdict, nativeAdapter
          ? nativeContinuationProof(rawTransports(), terminal) : { status: "pass" }))
          throw new Failure(report.recovery.predecessorVerdict.status, "Predecessor checkpoint checks failed; successor cannot repair earlier Decision");
        // This CLI waits for exact native/background/writer cleanup. The
        // subsequent ended readback is separate from requesting replacement.
        const stop = f.client.call(["task", "role", "session", "stop", task, "leader",
          "--reason", "Owned evaluation checkpoint: completed predecessor; preserve original claim/effect"], "recovery-stop");
        const inspection = f.client.call(["task", "role", "session", "inspect", task, "leader"], "recovery-inspect");
        report.recovery.stop = { ...gradeRecoveryStop({ taskId: task, terminal, stop, inspection }), response: stop, inspection };
        save(join(output, "recovery-stop.json"), report.recovery.stop);
        if (report.recovery.stop.status !== "pass")
          throw new Failure("observation-unknown", "Exact predecessor stop unknown; no replacement", "group");
      }
      const after = now();
      f.client.call(["task", "role", "session", "new", task, "leader",
        "--reason", isSessionRecovery(scenario)
          ? "Scheduled isolated Session replacement after exact stop; inspect retained original/claim and existing effect, never replay"
          : "Framework simulated lost-response recovery; inspect existing original/effect, never resend"], "recovery");
      if (isSessionRecovery(scenario)) report.recovery.replacementRequested = true;
      let expectedThread;
      if (isSessionRecovery(scenario)) {
        const proof = await until("fresh successor Thread ownership", () =>
          attributeNativeEvents(rawTransports()).proofs.find(p => p.taskId === task && p.role === "leader"
            && p.method === "thread/start" && p.threadId !== predecessor && Date.parse(p.at) >= Date.parse(after)));
        expectedThread = proof.threadId;
        report.recovery.successorStart = proof;
        if (plan.mode === "fake") {
          // Offline regression: let the lifecycle initialization finish first.
          // A NEW public notification then asks the same successor to inspect
          // retained handling; the original input/claim/effect is never replayed.
          const initialized = await until("successor initialization terminal", () =>
            selectTerminal(transports(), { since: after, roleName: "leader", taskId: task, threadId: expectedThread }));
          if (initialized.status !== "completed")
            throw new Failure("infrastructure-failed", "Offline successor initialization did not complete; no continuation");
          report.recovery.initialization = initialized;
          report.recovery.continuation = publicSubmission(["operator", "submit",
            "Continue inspecting the retained previous-Session input/claim and existing effect; no new business Decision.",
            "--task", task, "--intent", "discuss", "--request-id", "recovery-inspection-continuation"],
          "recovery-inspection-continuation", task);
        }
      }
      terminal = await nativeTerminal(after, submitted.message.id, "leader", task, expectedThread);
      if (isSessionRecovery(scenario)) {
        const state = observer.readState();
        const oldWake = values(state, "task_wakes").find(w => w.id === retained[0].id && w.taskId === task);
        report.recovery.successor = terminal;
        report.recovery.ownership = gradeRecoverySuccessor({ taskId: task, predecessor: effectTerminal,
          successor: terminal, after, proofs: attributeNativeEvents(rawTransports()).proofs });
        report.recovery.preservation = gradeRecoveryPreservation({ before: preserved, after: {
          original: values(state, "messages").find(m => m.id === original.id && m.taskId === task),
          claim: oldWake?.inbox?.claim,
          effect: values(state, "decisions").find(d => d.id === effect.id && d.taskId === task),
        } });
        save(join(output, "recovery-successor.json"), report.recovery);
        if (report.recovery.ownership.status !== "pass")
          throw new Failure("observation-unknown", "Fresh successor ownership unknown; no next input", "group");
        if (report.recovery.preservation.status !== "pass")
          throw new Failure("quality-fail", "Recovery changed original/claim/effect; no replay");
      } else report.recovery = { predecessor, successor: terminal.threadId, originalId: submitted.message.id,
        beforeClaim: retained[0].inbox.claim, simulated: true, nativeCompaction: "not-covered" };
    }
    await until("public processing settled", () => {
      const state = observer.readState();
      if (stage === 1) return values(state, "turns").find(r => r.id === initialRun.id && r.taskId === task)?.status === "completed";
      const wake = values(state, "task_wakes").find(w => w.taskId === task && w.refs.some(r => r.id === submitted.message.id));
      return wake && (wake.inbox?.ack || scenario === "missing-ack");
    });
    const observation = observer.finish();
    const state = observation.after.state, original = values(state, "messages").find(m => m.taskId === task && m.id === submitted.message.id);
    const decisions = values(state, "decisions").filter(d => d.taskId === task);
    const effect = decisions.find(d => d.title === input.effectKey);
    // A completed native Turn can correctly stop at an infrastructure boundary.
    // Only classify this exact typed unsent failure when the required effect is
    // absent; a recovered tool error must not invalidate a completed business step.
    if (!effect) checkControllerPrerequisite(terminal, stage);
    const wakes = values(state, "task_wakes"), wake = wakes.find(w => w.taskId === task && w.refs.some(r => r.id === original.id));
    const run = values(state, "turns").find(r => r.id === initialRun.id && r.taskId === task);
    const expected = { taskId: task, messageId: original.id, body: routesStage(scenario, stage) ? original.body : body, requestId: key, agentId: "codex",
      threadId: terminal.threadId, turnId: terminal.turnId, runId: initialRun.id, wakeId: wake?.id };
    if (!protocolApplicable(original, expected))
      throw new Failure("framework-invalid", "Fixture input identity or planning protocol not applicable; not a model ACK failure");
    const protocol = gradeHandling({ original, expected, run, dispatch: initialDispatch, wakes,
      effect: { status: effect ? "confirmed" : "unknown", at: effect?.createdAt },
      recovery: !!predecessor, predecessor, successor: terminal.threadId });
    const business = gradeBusiness(decisions, input.effectKey, stage, scene?.expected[stage - 1]);
    // New effects require reads before that Decision; a successor examining an
    // already committed effect must read before its own ACK, never rewrite it.
    const cutoff = predecessor ? wake?.inbox?.ack?.at : effect?.createdAt;
    const ev = evidenceFor(terminal, cutoff, predecessor ? terminal.startedAt : original.createdAt,
      !!predecessor && isSessionRecovery(scenario), stage);
    const required = sources.map(s => ({ ...s }));
    const reads = gradeReads(ev.bundles, required, ev.scope, { reuse: true });
    const inputReads = gradeReads(ev.bundles, [{ taskId: task, id: original.id, body: original.body }], ev.scope);
    const binding = skillBinding(ev.bundles, "leader", ev.scope);
    const actualCli = cliIdentity(terminal, ev.scope, predecessor
      ? { kind: "ack", id: wake?.id, at: wake?.inbox?.ack?.at }
      : { kind: "decision", taskId: task, id: effect?.id, title: effect?.title, at: effect?.createdAt,
        digest: effect ? hash(JSON.stringify(effect)) : undefined });
    const loads = instructionGrade(ev);
    const recoveryInspection = predecessor && isSessionRecovery(scenario)
      ? gradeRecoveryInspection(ev.bundles, { effect, wake }, ev.scope) : undefined;
    const reuseAvailability = { status: plan.mode === "fake" ? "pass"
      : [reads, loads].some(g => g.contextAvailability === "unknown") ? "unknown" : "pass",
      scope: plan.mode === "fake" ? "Deterministic fixture memory only, not model memory evidence"
        : "Retained full output coverage does not independently establish present model memory; no self-reported receipt accepted" };
    const forbidden = observation.journal.filter(e => /^(artifact\.|brief\.updated|task\.activated|work\.)/.test(e.type));
    const forbiddenFiles = forbiddenFileChanges(observation.before.files, observation.after.files, path => observer.businessFile(path));
    const decisionChanges = gradeDecisionChanges({
      before: values(observation.before.state, "decisions"), after: values(state, "decisions"),
      journal: observation.journal, allowed: effect, terminal: effectTerminal,
    });
    const legal = { status: forbidden.length || forbiddenFiles.length ? "fail" : decisionChanges.status,
      forbidden, forbiddenFiles, decisionChanges,
      scope: "observed CLI/product-event forbidden effects; unjournaled write/restore remains unknown" };
    const row = { stage, submitted, terminal, protocol, business, reads, inputReads, binding, cliIdentity: actualCli, loads, reuseAvailability, legal,
      ...(routeObservation ? { route: routeObservation } : {}),
      ...(recoveryInspection ? { recoveryInspection } : {}),
      evidenceScope: ev.scope, handlingPurpose: predecessor ? "inspect-existing-effect-before-successor-ACK" : "new-decision",
      observation: { status: "unknown", tables: Object.keys(state), limits: observation.observationLimits },
      at: now() };
    save(join(output, `observation-${stage}.json`), observation);
    report.stages.push(row); report.completedStages++;
    // Repeat producer idempotency under the exact same key/body. This is a
    // duplicate submission check, NOT a repeat of an unknown business effect.
    if (stage === 2) {
      const duplicate = publicSubmission(["operator", "submit", original.body, "--task", task, "--intent", "discuss",
        "--request-id", key], key, task);
      report.duplicate = { sameOriginal: duplicate.message.id === submitted.message.id, idempotentReplay: true,
        proof: "one saved original under exact unchanged submissionKey after second public submit" };
      if (!report.duplicate.sameOriginal || !report.duplicate.idempotentReplay)
        throw new Failure("framework-invalid", "Duplicate input did not retain exact original");
    }
    row.verdict = stageVerdict({ protocol, reads, inputReads, binding, cliIdentity: actualCli, loads, reuseAvailability, legal, business,
      ...(predecessor && isSessionRecovery(scenario) ? report.recovery.predecessorChecks : {}),
      ...(recoveryInspection ? { recoveryInspection } : {}),
      ...(routeObservation ? { route: routeObservation.grade, routedInput: routeObservation.input, operatorReads: routeObservation.reads,
        operatorBinding: routeObservation.binding, operatorCliIdentity: routeObservation.cliIdentity, operatorLoads: routeObservation.loads } : {}) });
    // A product result notice can start another Turn between the selected
    // business terminal and this read. Wait within the existing stage budget
    // for actual endpoints; never submit the next input while it is active.
    // Identity/RPC/tool gaps remain immediate unknowns, not retry permission.
    const nativeSafety = nativeAdapter ? await until("exact native continuation endpoints", () => {
      const raw = rawTransports();
      const proofs = [terminal, ...(routeTerminal ? [routeTerminal] : [])]
        .map(t => nativeContinuationProof(raw, t));
      if (proofs.some(p => p.status !== "pass" && !p.pending)) return proofs;
      return proofs.some(p => p.pending) ? false : proofs;
    }) : [{ status: "pass", scope: "deterministic fake fixture only" }];
    const identityProof = g => g?.version?.status === "pass" && g?.effectIdentity?.status === "pass"
      && !g.commands?.some(c => c.status !== "pass");
    row.continuation = { status: nativeSafety.every(p => p.status === "pass") ? "pass" : "unknown", proofs: nativeSafety,
      analyzeReadingFailures: plan.decisionPolicy === "agent-analysis" && isBusinessScenario(scenario)
        && !isSessionRecovery(scenario) && protocol.status === "pass" && legal.status === "pass",
      planningOnlyAnswer: scenario === "business-warm" && protocol.status === "pass" && legal.status === "pass",
      exactEffectIdentities: {
        cliIdentity: identityProof(actualCli), operatorCliIdentity: identityProof(routeObservation?.cliIdentity)
      },
      policy: "Exact native endpoints and existing authority/protocol/effect fences remain required. In agent-analysis non-recovery business runs, reading/load findings are retained for Agent analysis without censoring later inputs. Only business-warm permits the existing known single-Decision planning-answer mismatch. No retry, correction, or promotion of earlier grades." };
    checkpoint();
    if (!stageAllowsContinuation(row.verdict, row.continuation))
      throw new Failure(row.verdict.status === "pass" ? "observation-unknown" : row.verdict.status,
        `Stage checks: ${JSON.stringify(row.verdict)}; continuation: ${JSON.stringify(row.continuation)}; no retry/replay`);
    // before is saved inside observation; do not infer no write from equality.
    void before;
  }
  const qualityFailed = report.stages.some(row => row.verdict.status === "quality-fail");
  report.executionChecks = qualityFailed ? "quality-fail"
    : report.stages.every(row => row.verdict.status === "pass") ? "pass" : "observation-unknown";
  report.status = outcome({ framework: "pass", quality: qualityFailed ? "fail" : "pass", observation: "unknown" });
} catch (e) {
  report.status = e.kind ?? "infrastructure-failed"; report.error = String(e);
  report.stop = { at: now(), kind: report.status, scope: e.scope ?? "condition", noReplay: true };
} finally {
  try { if (observer) { save(join(output, "final-state.json"), observer.capture()); observer.close(); observer = undefined; } }
  catch (e) { report.finalObservationError = String(e); }
  try { report.cleanup = await f.close(); }
  catch (e) { report.cleanup = { status: "retained", root: f.root, error: String(e) }; }
  save(join(output, "cli-trace.json"), f.client.trace);
  let native;
  try {
    const attribution = attributeNativeEvents(rawTransports());
    native = attribution.events;
    report.nativeAttribution = { proofs: attribution.proofs, rejected: attribution.rejected,
      minimizedOwnedNotifications: native.filter(e => e.direction === "native" && e.nativeContent === "unattributed-metadata")
        .map(e => ({ at: e.at, method: e.message?.method, threadId: e.message?.params?.threadId,
          turnId: e.message?.params?.turnId, omittedBody: e.message?.omittedBody })),
      limit: attribution.limit };
  }
  catch (e) {
    report.status = "infrastructure-failed"; report.finalTransportError = String(e);
    native = [{ invalidFrame: { reason: "Unparseable complete transport record; raw file retained", error: String(e) } }];
  }
  const participants = nativeAdapter ? nativeEvidence(native, [...sourceFiles.values()], originalOptions()) : traces();
  report.transportObservation = { status: native.some(e => e.invalidFrame) ? "unknown" : "complete-lines",
    pendingOrInvalid: native.filter(e => e.invalidFrame).map(e => e.invalidFrame),
    scope: "Recorded JSONL line integrity, not lossless native/CLI inventory" };
  const started = native.filter(e => e.direction === "native" && e.binding
    && e.message?.method === "turn/started");
  const identities = native.filter(e => e.direction === "native" && e.binding && e.message?.result?.model)
    .map(e => ({ role: e.binding.roleName, taskId: e.binding.taskId,
      threadId: e.message.result.thread?.id, model: e.message.result.model,
      effort: e.message.result.reasoningEffort, at: e.at }));
  report.modelExecution = { occurred: plan.mode === "fake" ? false : started.length > 0 ? true : "unknown",
    observedNativeTurns: new Set(started.map(e => `${e.message.params.threadId}/${e.message.params.turn.id}`)).size,
    identities, providerRequestCount: plan.mode === "fake" ? 0 : "unknown" };
  const calls = [...f.client.trace, ...participants.flatMap(t => t.trace)];
  const loads = participants.flatMap(t => t.loads ?? []);
  report.skillChecksByTurn = [...report.stages.map(s => ({ stage: s.stage, roleName: "leader",
    scope: s.evidenceScope, binding: s.binding })), ...report.routes.map(s => ({ stage: s.stage, roleName: "operator",
    scope: s.evidenceScope, binding: s.binding }))].map(row => {
      const own = participants.filter(p => ["taskId", "roleName", "threadId", "turnId", "epoch"]
        .every(k => p.scope[k] === row.scope[k]));
      return { ...row, agentMetadataCalls: own.flatMap(p => p.trace).filter(e =>
        e.args.filter(x => x !== "--json").slice(0, 2).join(" ") === "session skills").length,
      observedBodyReads: own.flatMap(p => p.loads ?? []).map(l => ({
        path: l.path, bytes: l.bytes, complete: l.complete, at: l.at, sha256: l.sha256 })),
      host: gradeHostSkillCheck(native, expectedSkillSources(row.roleName), row.scope, [...sourceFiles.values()]),
      limits: "Recognized native reads only; zero attributed calls is not proof of absent hidden calls. Repeats do not prove unnecessary loading; compaction/recovery availability stays unknown." };
    });
  const help = participants.flatMap(p => p.help ?? []);
  const helpUtf8 = help.reduce((n, h) => n + Buffer.byteLength(h.stdout), 0);
  const inventories = participants.flatMap(p => p.inventories ?? []);
  const inventoryUtf8 = inventories.reduce((n, i) => n + Buffer.byteLength(i.stdout), 0);
  const knownOutput = calls.reduce((s, c) => s + Buffer.byteLength(c.stdout ?? "") + Buffer.byteLength(c.stderr ?? ""), helpUtf8 + inventoryUtf8);
  report.cost = { cliCalls: nativeAdapter ? "unknown" : calls.length, parentCliCalls: f.client.trace.length,
    originalTool: { availability: plan.originalToolAvailability ?? "absent",
      actualAudits: originalOptions().originalAudits.length,
      creditedPages: participants.flatMap(t => t.trace.filter(e => e.originalTool).map(e => ({
        ...e.originalTool, at: e.at, nativeItemId: e.nativeItemId, scope: t.scope }))),
      capturedInternalCliCalls: originalOptions().originalAudits.reduce((n, a) => n + a.calls.length, 0),
      capturedInternalWireBytes: originalOptions().originalAudits.flatMap(a => a.calls)
        .reduce((n, c) => n + Buffer.byteLength(c.stdout) + Buffer.byteLength(c.stderr), 0),
      totalInternalCliCalls: "unknown", totalInternalWireBytes: "unknown",
      scope: "Captured helper subprocess lower bounds only, not totals: an unaudited outer failure can hide internal calls. Separate from overlapping outer native tools and parent CLI" },
    startupGuidanceFileUtf8: startupGuidance ? Buffer.byteLength(startupGuidance) : 0,
    startupGuidanceNativeInclusion: "unknown; file bytes are not a native input-token attribution",
    participantCliCalls: nativeAdapter ? "unknown" : calls.length - f.client.trace.length,
    attributedReadCliCalls: nativeAdapter ? calls.length - f.client.trace.length : undefined,
    attributedHelpCliCalls: help.length, observedHelpOutputUtf8: helpUtf8,
    attributedInventoryCalls: inventories.length, observedInventoryOutputUtf8: inventoryUtf8,
    cliOutputUtf8: nativeAdapter ? "unknown" : knownOutput,
    observedCliOutputLowerBoundUtf8: nativeAdapter ? knownOutput : undefined,
    metadataUtf8: calls.filter(c => c.args.includes("skills")).reduce((s, c) => s + Buffer.byteLength(c.stdout), 0),
    manifestUtf8: nativeAdapter ? "unknown" : participants.reduce((s, t) => s + (t.manifest?.bytes ?? 0), 0),
    observedManifestFileUtf8: participants.flatMap(t => t.manifests ?? []).reduce((s, m) => s + m.bytes, 0),
    observedProjectionUtf8: participants.flatMap(t => t.projections ?? []).reduce((s, p) => s + Buffer.byteLength(p.stdout), 0),
    instructionBodies: Object.fromEntries(["core", "topic", "profile"].map(k => [k,
      loads.filter(l => l.kind === k).reduce((s, l) => s + l.bytes, 0)])),
    ...instructionLoadCosts(participants),
    fragmentUtf8: loads.filter(l => !l.complete).reduce((s, l) => s + l.bytes, 0),
    attribution: nativeAdapter ? "Recognized completed native reads only; unsupported/segmented/truncated commands, Manifest and hidden bytes unknown. Body sums are observed lower bounds." : "complete deterministic instrumentation",
    notificationsUtf8: native.filter(e => e.direction === "host" && e.message?.method === "turn/start")
      .reduce((s, e) => s + Buffer.byteLength(JSON.stringify(e.message.params.input)), 0),
    timingScope: "CLI elapsed includes waits; concurrent contention is not context improvement; no A/B saving inferred" };
  report.tokens = tokenTotals(native,
    [...(report.stages ?? []), ...(report.routes ?? [])].map(s => s.terminal?.threadId));
  if (native.some(e => e.direction === "native" && e.nativeContent === "unattributed-metadata"
    && e.message?.method === "thread/tokenUsage/updated"))
    report.tokens = { status: "unknown", observedLowerBound: report.tokens,
      reason: "An owned token notification was metadata-only before ownership confirmation; do not claim a complete total" };
  const limits = native.filter(e => e.direction === "native" && e.message?.method === "account/rateLimits/updated")
    .map(e => ({ at: e.at, role: e.binding?.roleName, rateLimits: e.message.params?.rateLimits }));
  report.account = limits.length ? { status: "observed", rateLimitEvents: limits, billedCost: "unknown" }
    : { status: "unknown", reason: "No attributable native quota observation; no credentials read or account mutation" };
  if (existsSync(join(output, "collector.json.gz"))) {
    const collector = JSON.parse(gunzipSync(readFileSync(join(output, "collector.json.gz"))));
    report.collector = { samples: collector.samples.length, errors: collector.errors, coverage: collector.coverage };
  } else report.collector = { status: "unknown", reason: "No complete collector result" };
  report.finishedAt = now();
  save(join(output, "result.json"), report);
  process.send?.({ status: report.status, cleanup: report.cleanup.status, stop: report.stop });
}
