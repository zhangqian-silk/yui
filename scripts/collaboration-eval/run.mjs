import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Fixture } from "./fixture.mjs";
import { digest, createEvidenceWriter } from "./evidence.mjs";
import { persistTaskFacts, readNativeFacts } from "./readback.mjs";
import { definitions, variants, caseSetVersion } from "./cases/catalog.mjs";
import { prepareCase } from "./cases/prepare.mjs";
import { scoreCase } from "./cases/oracle.mjs";
import { observe } from "./cases/business.mjs";
import { selectConditions, parseOptions } from "./selection.mjs";

const options = parseOptions(process.argv.slice(2));
const checkout = resolve(options.version), output = resolve(options.out);
if (existsSync(output)) throw new Error("Output already exists; refusing to overwrite evidence.");
const conditions = selectConditions(options, definitions, variants);
const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
const hashFile = path => digest(readFileSync(path));
const trace = [];
const evidence = {
  schemaVersion: 1, mode: "offline", experiment: randomUUID(), createdAt: new Date().toISOString(),
  version: { checkout, commit: git("rev-parse", "HEAD"), worktreeStatus: git("status", "--porcelain"),
    cliSha256: hashFile(join(checkout, "dist/cli.js")), node: process.version,
    platform: process.platform, architecture: process.arch,
    packageLockSha256: hashFile(join(checkout, "package-lock.json")) },
  caseSet: caseSetVersion, seed: 89, options,
  freezeSha256: hashFile(new URL("./cases/freeze.json", import.meta.url)),
  policySha256: hashFile(new URL("./cases/participant.mjs", import.meta.url)),
  oracleSha256: hashFile(new URL("./cases/oracle.mjs", import.meta.url)),
  harnessSha256: Object.fromEntries(["run", "fixture", "evidence", "readback", "selection", "case-process"]
    .map(name => [name, hashFile(new URL(`./${name}.mjs`, import.meta.url))])),
  trace, conditions
};
// Reserve before fixture setup; never overwrite interrupted or prior records.
const save = createEvidenceWriter(output);
let interrupted;
const abort = signal => { interrupted = signal; };
process.on("SIGINT", abort); process.on("SIGTERM", abort);

function metadataProject(fixture) {
  const path = join(fixture.root, "knowledge-project");
  mkdirSync(path);
  writeFileSync(join(path, "README"), "Artificial knowledge scope. No remote.\n");
  const env = { ...fixture.environment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  for (const args of [["init", "-b", "main", "--quiet"], ["add", "README"],
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Artificial knowledge scope"]]) {
    execFileSync("git", args, { cwd: path, env, timeout: 5000 });
  }
  const added = fixture.call(["project", "add", "Synthetic knowledge", path,
    "--stable", "main", "--development", "main"], "prepare");
  return added.project?.id ?? added.projectId ?? added.id;
}

function envelope(fact) { return JSON.stringify({ kind: "collaboration-eval-fact", value: fact }); }

function onlyPreparedRecord(fixture, task, store) {
  const page = fixture.call(["task", "context", "list", task, "--store", store], "prepare");
  if (!page.complete || page.items.length !== 1) throw new Error(`Ambiguous prepared ${store} identity`);
  const { ref } = page.items[0];
  return fixture.detail(["task", "context", "inspect", task, "--store", store,
    "--ref", ref.refId, "--digest", ref.digest], "prepare").value;
}

function seedNative(fixture, task, prepared, project) {
  const find = key => prepared.facts.find(fact => fact.key === key);
  // Active native Decision is not WorkItem acceptance.
  fixture.call(["task", "decision", "record", task, "--title", "Historical decision",
    "--rationale", JSON.stringify({ kind: "historical-eval-statement", status: "obsolete" })], "prepare");
  // Some successful CLI mutations have a text receipt, not a structured ID.
  // Discover the persisted object; never parse prose or replay the mutation.
  const staleId = onlyPreparedRecord(fixture, task, "task-decision").id;
  if (!staleId) throw new Error("Missing native historical Decision identity");
  fixture.call(["task", "decision", "supersede", task, staleId, "--reason", "Current evaluation cutoff"], "prepare");
  fixture.call(["task", "decision", "record", task, "--title", "Effective business decision",
    "--rationale", envelope(find("decision"))], "prepare");
  if (project) {
    fixture.call(["project", "knowledge", "add", project, "Retired artificial guidance",
      "--body", "Historical guidance; not applicable at this cutoff."], "prepare");
    const oldId = onlyPreparedRecord(fixture, task, "project-knowledge").id;
    if (!oldId) throw new Error("Missing native historical Knowledge identity");
    fixture.call(["project", "knowledge", "retire", project, oldId], "prepare");
    fixture.call(["project", "knowledge", "add", project, "Applicable business evidence",
      "--body", envelope(find("evidence"))], "prepare");
  }
  persistTaskFacts(fixture, task, prepared.facts.filter(f =>
    f.key !== "decision" && !(project && f.key === "evidence")));
}

function captureArtifacts(root) {
  const artifacts = [];
  function visit(directory) {
    if (!existsSync(join(root, directory))) return;
    for (const item of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (item.name === ".git") continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile()) {
        const content = readFileSync(join(root, path), "utf8");
        artifacts.push({ path, content, digest: digest(content) });
      }
    }
  }
  for (const directory of ["output", "repo", "A", "B"]) visit(directory);
  return artifacts;
}

async function runCondition(condition) {
  const started = performance.now(), firstTrace = trace.length;
  const fixture = new Fixture(checkout, trace);
  const root = join(fixture.root, "business-case");
  condition.understanding = "unverified";
  try {
    fixture.prepare();
    condition.runtime = fixture.call(["controller", "status"], "prepare").identity;
    mkdirSync(root);
    const prepared = await prepareCase(condition.id, condition.variant, root);
    condition.manifest = prepared.manifest;
    condition.budget = prepared.budget;
    fixture.deadline = started + prepared.budget.wallSeconds * 1000;
    fixture.maxReads = prepared.budget.reads;
    fixture.maxBytes = prepared.budget.bytes;
    const knowledge = definitions.find(d => d.id === condition.id).tags.includes("K");
    const project = knowledge ? metadataProject(fixture) : undefined;
    if (knowledge && !project) throw new Error("Missing native Project identity");
    const { task } = fixture.call(["task", "create", "Artificial collaboration evaluation",
      ...(project ? ["--project", project] : [])], "prepare");
    condition.task = task.id;
    seedNative(fixture, task.id, prepared, project);
    condition.stages = { saved: true, discovered: false, understood: "unverified", acted: false };
    condition.context = fixture.call(["task", "context", task.id]);
    const readback = readNativeFacts(fixture, task.id, { knowledge });
    // Evaluator-only comparison; expected digests never enter the participant.
    if (!isDeepStrictEqual(Object.fromEntries(readback.records.map(r => [r.value.key, r.digest])),
      prepared.manifest.factDigests)) throw new Error("Persisted fact set differs from prepared material");
    condition.readback = readback;
    condition.stages.discovered = true;
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./case-process.mjs", import.meta.url))], {
      input: JSON.stringify({ root, readback }), encoding: "utf8", env: fixture.environment,
      timeout: Math.max(1, Math.ceil(fixture.deadline - performance.now())), maxBuffer: 4 * 1024 * 1024
    });
    condition.participantProcess = { status: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr };
    if (result.error?.code === "ETIMEDOUT") throw new Error("budget-exceeded: participant deadline");
    if (result.status !== 0 || result.error) throw new Error(`Participant failure: ${result.error ?? result.stderr}`);
    const businessResult = JSON.parse(result.stdout);
    condition.result = businessResult;
    condition.stages.acted = true;
    condition.business = await observe(root);
    condition.artifacts = captureArtifacts(root);
    if (condition.business.ledger.length > prepared.budget.maxTotalEffects)
      throw new Error("effect-budget-exceeded");
    fixture.call(["task", "message", "send", task.id,
      JSON.stringify({ kind: "collaboration-eval-result", result: businessResult }),
      "--intent", "record", "--request-id", "business-result"], "write");
    const persisted = fixture.messages(task.id).find(m => {
      try {
        const parsed = JSON.parse(m.body);
        return parsed.kind === "collaboration-eval-result" && isDeepStrictEqual(parsed.result, businessResult);
      } catch { return false; }
    });
    if (!persisted) throw new Error("Business result was not persisted exactly");
    condition.resultMessage = persisted.id;
    condition.score = await scoreCase(condition.id, {
      root, result: businessResult, manifest: prepared.manifest, variant: condition.variant
    });
    if (performance.now() >= fixture.deadline) throw new Error("budget-exceeded: scoring deadline");
    condition.businessStatus = condition.score.status;
    // Message/Decision/Knowledge readback does not prove managed lifecycle.
    condition.status = condition.score.status === "fail" ? "fail" : "partial-evidence";
    condition.boundaries = {
      persistence: "verified", originalDiscovery: "verified", activeDecision: "verified",
      activeKnowledge: knowledge ? "verified" : "not-applicable",
      managedAcceptance: "not-exercised", frozenAssignment: "not-exercised",
      nativePermissions: "not-exercised", sessionHandoff: "not-exercised",
      businessExecution: "deterministic-outside-managed-role", semanticQuality: condition.score.semantic
    };
  } catch (error) {
    condition.status = String(error).includes("budget-exceeded") ? "budget-exceeded" : "environment-error";
    condition.error = String(error);
    condition.attribution = "unknown";
  } finally {
    if (existsSync(root)) {
      try {
        condition.artifacts = captureArtifacts(root);
        condition.business = await observe(root);
      } catch (error) {
        condition.captureError = String(error);
        if (!["fail", "budget-exceeded"].includes(condition.status)) condition.status = "environment-error";
      }
    }
    condition.cleanup = await fixture.close();
    condition.elapsedMs = performance.now() - started;
    condition.traceRange = [firstTrace, trace.length];
    for (const entry of trace.slice(firstTrace)) entry.condition = `${condition.id}/${condition.variant}/${condition.mode}`;
  }
}

try {
  for (const condition of conditions) {
    if (interrupted) { condition.reason = `cancelled: ${interrupted}`; continue; }
    if (condition.mode === "P") {
      condition.reason = "Genuine managed predecessor/successor adapter not implemented; not substituted with restart.";
      continue;
    }
    await runCondition(condition);
    process.stdout.write(JSON.stringify({ id: condition.id, variant: condition.variant, mode: condition.mode,
      status: condition.status, businessStatus: condition.businessStatus, cleanup: condition.cleanup.status }) + "\n");
  }
} finally {
  evidence.cleanup = { status: conditions.some(c => c.cleanup?.status === "retained") ? "retained" : "released",
    conditions: conditions.filter(c => c.cleanup).map(c => ({ id: c.id, ...c.cleanup })) };
  evidence.interrupted = interrupted ?? null;
  save(evidence);
  process.off("SIGINT", abort); process.off("SIGTERM", abort);
}
console.log(JSON.stringify({ output, experiment: evidence.experiment, cleanup: evidence.cleanup.status }));
if (interrupted || conditions.some(c => ["environment-error", "budget-exceeded", "fail", "not-run"].includes(c.status))
  || evidence.cleanup.status !== "released") process.exitCode = 1;
