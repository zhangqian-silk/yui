// Maintained framework entry. Offline/fake and real use this SAME worker,
// input order, product CLI, observer, judges, archive and lifecycle.
import { mkdirSync, readFileSync, existsSync, accessSync, constants } from "node:fs";
import { fork, execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOptions, treeHashes, hash, save, now, groupStopFor, executionLimits, planningReferences, currentPlanningContract, isSessionRecovery, recoveryContract, chainStages, routesStage, isBusinessScenario } from "./common.mjs";
import { businessScenarios, businessInstructions } from "./business-scenarios.mjs";
import { fixturePermissionArguments } from "./isolation.mjs";
import { invocationCompletion } from "./completion.mjs";
import { reportingCarrier } from "./obligations.mjs";
import { executionModules, RUN_VERSION } from "./versions.mjs";
import { fixtureShellPolicy } from "./fixture-shell.mjs";
const options = parseOptions(process.argv.slice(2));
const businessOnly = options.scenarios.every(isBusinessScenario);
if (options.scenarios.some(isBusinessScenario) && !businessOnly)
  throw Error("Freeze business scenarios separately from historical arithmetic scenarios");
const scenes = businessOnly ? Object.fromEntries(options.scenarios.map(name => [name, businessScenarios[name]])) : undefined;
const product = resolve(options.product), output = resolve(options.out);
if (existsSync(output)) throw Error("Output already exists; inspect original receipts, never overwrite/replay");
let providerIdentity;
if (options.mode === "real") {
  accessSync(options["provider-bin"], constants.X_OK);
  providerIdentity = { path: options["provider-bin"], sha256: hash(readFileSync(options["provider-bin"])),
    compatibility: "unknown; executable metadata only, not a live Provider probe" };
}
const here = fileURLToPath(new URL(".", import.meta.url)), root = resolve(here, "../../..");
const launcher = join(product, "output/dev/bin/yui");
for (const file of [launcher, join(product, "dist/cli.js"), join(product, "package-lock.json")])
  if (!existsSync(file)) throw Error(`Missing build/local launcher: ${file}; run make install-local`);
const git = (...args) => execFileSync("git", ["-C", product, ...args], { encoding: "utf8" }).trim();
const snapshot = existsSync(join(product, ".eval-source.json")) ? JSON.parse(readFileSync(join(product, ".eval-source.json"))) : null;
let productCommit, productDirty;
if (snapshot) {
  if (snapshot.kind !== "git-archive" || snapshot.src !== hash(JSON.stringify(treeHashes(join(product, "src"))))
    || snapshot.skills !== hash(JSON.stringify(treeHashes(join(product, "skills"))))) throw Error("Product snapshot provenance mismatch");
  productCommit = snapshot.commit; productDirty = "verified-archive-src-and-skills";
} else {
  if (resolve(git("rev-parse", "--show-toplevel")) !== product)
    throw Error("Product is not its own checkout; use prepare-product.mjs for a provenance-bound archive");
  productCommit = git("rev-parse", "HEAD"); productDirty = git("status", "--porcelain");
}
const buildAt = now(), sourceBeforeBuild = treeHashes(join(product, "src"));
// One build per invocation, never per condition. This establishes provenance
// for the actual src/dist identities below rather than trusting a stale receipt.
const buildOutput = execFileSync(process.execPath, [join(product, "node_modules/typescript/bin/tsc"), "-p", join(product, "tsconfig.json")],
  { cwd: product, encoding: "utf8", timeout: 120000 });
execFileSync(process.execPath, [join(product, "scripts/build-runtime-native.mjs")],
  { cwd: product, encoding: "utf8", timeout: 120000 });
if (hash(JSON.stringify(sourceBeforeBuild)) !== hash(JSON.stringify(treeHashes(join(product, "src")))))
  throw Error("Source changed during preflight build");
const modules = executionModules(here);
const materials = businessOnly ? [] : [
  JSON.stringify({ records: [{ units: 3 }, { units: 8 }], padding: "完整原文 synthetic ".repeat(2600), end: "END-A" }),
  JSON.stringify({ records: [{ units: 5 }, { units: 13 }], padding: "第二版原文 synthetic ".repeat(2600), end: "END-B" }),
];
const instructions = businessOnly ? businessInstructions : "Only isolated planning discussion. Read current full Skills/profile on first entry/recovery, exact Run input and originals. Operator only routes. Leader reads complete Task-local sources and records one planning Decision per effectKey. JSON count,total,unknown with unknown always literal string 'unknown'. No delivery/activation/Brief/artifact writes. Later inputs require exact claim/handle/ACK. Unknown effect: inspect original and existing effect, never resend. No autonomous account/model changes.";
const sourceReadContract = options["source-contract"] === "original"
  ? "Read every exact local source original completely."
  : "Before the planning Decision, establish complete exact-original evidence for every listed source. An unchanged source already read completely in this same Thread/context may be reused when still available; a new, changed or unavailable source must be read completely through its authorized original, including every required page. Do not reread solely because this is a new Turn. Inspect an existing effect before recording; never duplicate or replay an uncertain effect.";
const businessContract = businessOnly ? `${sourceReadContract} ${Object.values(scenes)[0].contract}` : `${sourceReadContract} Record exactly one planning Decision: its title must equal effectKey verbatim; its rationale must be only a JSON object with count (number of records across all listed source originals), total (sum of their units), and unknown (always the literal string 'unknown'). No prose or extra keys inside rationale. Inspect an existing effect before recording, never duplicate/replay an uncertain effect. No artifacts, Brief changes, activation or delivery. Later inputs require exact claim/handle/ACK.`;
const routingContract = "Claim this exact Global original. Route the nested input JSON object unchanged to taskId with intent discuss, using routeKey verbatim as the submission request-id; then ACK this original with the routed reference. Do not compute or record the business Decision.";
const recovery = options.scenarios.some(isSessionRecovery) ? recoveryContract : undefined;
mkdirSync(output);
const preflight = {
  at: now(), mode: options.mode, product, commit: productCommit, dirty: productDirty, snapshot,
  providerIdentity,
  actualSource: treeHashes(join(product, "src")), actualBuild: treeHashes(join(product, "dist")),
  skills: treeHashes(join(product, "skills")), harness: modules,
  ...(scenes ? { businessScenariosHash: hash(JSON.stringify(scenes)) } : {}),
  lockfile: hash(readFileSync(join(product, "package-lock.json"))), launcher: hash(readFileSync(launcher)),
  node: process.version, platform: process.platform, actualCli: {}, materialHashes: materials.map(hash),
  instructionsHash: hash(instructions), businessContractHash: hash(businessContract),
  originalToolAvailability: options["original-tool"],
  sourceContractVariant: options["source-contract"], sourceReadContractHash: hash(sourceReadContract),
  routingContractHash: hash(routingContract), missing: [], limitations: [],
  ...(recovery ? { recoveryContractHash: hash(recovery) } : {}),
  build: { startedAt: buildAt, finishedAt: now(), output: buildOutput, sourceIdentity: hash(JSON.stringify(sourceBeforeBuild)) },
};
// Help/version discovery is read-only and does not setup a Home or call a
// Provider. Match the checkout's current CLI, not a historical output build.
const cleanEnv = { PATH: `${resolve(process.execPath, "..")}:/usr/bin:/bin`, HOME: process.env.HOME, NO_COLOR: "1" };
for (const args of [["version"], ["--json", "version"], ["--json", "help", "operator", "submit"],
  ["--json", "help", "role", "message", "queue"], ["--json", "help", "session", "stop"]]) {
  try { preflight.actualCli[args.join(" ")] = execFileSync(launcher, args, { env: cleanEnv, encoding: "utf8", timeout: 10000 }); }
  catch (e) { preflight.missing.push({ command: args, code: e.status, stderr: String(e.stderr ?? "") }); }
}
preflight.limitations.push("Public help intentionally hides managed inbox operations; actual managed capability is checked in each Provider Turn before business handling.");
if (options.mode === "real") preflight.limitations.push(
  "Human/Leader authorization reference is provenance only, not an automatic semantic grant.",
  "This entry grants no real execution authority; use only under a separately authorized exact frozen resource scope.",
  "Real autonomous full-read attribution requires native tool evidence; absent evidence stays unknown.",
  "Provider proxy compatibility and stop support must be separately established for the explicit binary.");
preflight.status = preflight.missing.length ? "invalid"
  : options.mode === "real" ? "real-resource-unverified" : "ready-for-isolated-framework";
save(join(output, "preflight.json"), preflight);
if (preflight.missing.length) { process.exitCode = 1; }
else {
  const plan = { schemaVersion: 1, runVersion: RUN_VERSION, product, mode: options.mode, scenarios: options.scenarios,
    chains: Object.fromEntries(options.scenarios.map(scenario => [scenario,
      Array.from({ length: chainStages(scenario) }, (_, i) => ({
        stage: i + 1, operatorRoute: routesStage(scenario, i + 1),
      }))])),
    concurrency: options.concurrency, providerBin: options["provider-bin"], authorizationRef: options.authorization,
    limits: executionLimits(options.mode),
    materials, instructions, businessContract, routingContract, ...(scenes ? { businessScenarios: scenes } : {}), createdAt: now(),
    sourceContractVariant: options["source-contract"], sourceReadContract,
    ...(recovery ? { recoveryContract: recovery } : {}),
    inputIdentity: hash(JSON.stringify({ materials, businessContract, routingContract, ...(scenes ? { businessScenarios: scenes } : {}), ...(recovery ? { recoveryContract: recovery } : {}) })),
    harnessRoot: resolve(here, ".."), harnessFiles: modules,
    harnessIdentity: hash(JSON.stringify(modules)),
    permissionMode: options["permission-mode"],
    cliEntryMode: options["cli-entry-mode"],
    originalToolAvailability: options["original-tool"],
    originalToolFiles: Object.fromEntries(["original-tool.mjs", "original-reader.mjs", "../core/io.mjs"]
      .map(name => [name, modules[name.startsWith("../") ? name.slice(3) : `context/${name}`]])),
    osIsolation: options["permission-mode"] === "session-only" ? "explicitly-disabled; not evaluated" : "unproven",
    permissionArguments: fixturePermissionArguments(options["permission-mode"]),
    subjectShell: fixtureShellPolicy,
    controllerPreflight: "native-workspace-rpc-before-model-v1",
    controllerBridge: "linux-fixed-home-file-relay-v1",
    configurationIdentityVersion: 5,
    configurationIdentity: hash(JSON.stringify({ instructions, routingContract,
      subjectShell: fixtureShellPolicy,
      controllerPreflight: "native-workspace-rpc-before-model-v1",
      controllerBridge: "linux-fixed-home-file-relay-v1",
      permissionMode: options["permission-mode"],
      cliEntryMode: options["cli-entry-mode"],
      permissionArguments: fixturePermissionArguments(options["permission-mode"]), ...(recovery ? { recoveryContract: recovery } : {}) })),
    preflightIdentity: hash(readFileSync(join(output, "preflight.json"))),
    gradingContract: { originals: "Exact immutable source output may be reused in the same owner/Thread/context epoch; disposition originals remain current-Turn",
      instructions: "Full frozen bytes may be assembled from exact cat/sed slices; metadata is not loading",
      mandatoryReferences: { leader: planningReferences("leader", preflight.skills), operator: planningReferences("operator", preflight.skills) },
      reportingCarrier: reportingCarrier(preflight.skills),
      currentActionContract: currentPlanningContract(preflight.skills) ?? { status: "unmapped", note: "Historical mappings may still apply; never infer a current contract from VERSION alone" },
      conditionalReferences: { taskContext: "Any Role's recognized actual Task-fact read triggers task-context.md before exact command start; unsupported actions remain unknown.",
        contextExpansion: "For the reviewed current action contract, recognized context expansion triggers context-reads.md before its command start. Ordinary complete original reads and warm Turns alone do not. Unsupported/hidden paths remain unassessed.",
        contextOrdering: "Only actual intent conflict, stage handoff or incremental maintenance; Session-recovery handoff explicitly adds it. Frozen business scenarios require Leader reconciliation of changed facts/requirements at stages 2 onward, not cold stage 1 or Operator forwarding. A warm turn alone is not a trigger.",
        reporting: "Declared exact carrier checked before native item/started of product-persisted Leader report or earlier durable Message command; Operator durable Message command start. No terminal-time fallback; missing/ambiguous start or equal-time ordering stays unknown. Actual Task-fact reads tighten task-context to their command start; other base files retain business-effect deadline." },
      applicability: "Fixed normal planning/dispatched-Run/incremental-source scenario; not all conditional product references. No delivery, recovery or identity anomaly is injected in normal.",
      availability: "Prior-Turn output coverage is distinct from present model memory, which remains unknown for real reuse" },
    ...(recovery ? { recoveryScenario: { kind: "session-replacement", nativeCompaction: "not-covered",
      checkpoint: "stage-2 committed effect and retained claim; deliberate end without ACK",
      stop: "exact completed predecessor, synchronous session stop, ended readback BEFORE session new",
      successor: "distinct connection and fresh Thread/start; full current recovery load before retained ACK",
      references: ["yui-runtime/references/recovery.md"], realExecution: "requires a separate new freeze/authority" } } : {}),
    historicalPerformanceConditions: 59, newRealConditions: 0, oracleAccess: "evaluator-only module; never in input/configuration" };
  plan.decisionPolicy = "agent-analysis";
  const planFile = join(output, "plan.json"); save(planFile, plan);
  if (options.preflight === "true") console.log(JSON.stringify({ preflight: preflight.status, output, execution: "not-started" }));
  else {
    const results = [], active = new Map(); let next = 0, stop;
    const signal = name => {
      stop = { kind: "interrupted", scope: "group", at: now(), reason: name };
      for (const child of active.values()) child.kill("SIGTERM");
    };
    process.on("SIGINT", () => signal("SIGINT")); process.on("SIGTERM", () => signal("SIGTERM"));
    async function slot() {
      while (next < plan.scenarios.length && !stop) {
        const scenario = plan.scenarios[next++], directory = join(output, scenario), startedAt = now();
        const child = fork(new URL("./worker.mjs", import.meta.url), [planFile, scenario, directory],
          { stdio: ["ignore", "inherit", "inherit", "ipc"] });
        active.set(scenario, child);
        await new Promise(resolve => child.once("exit", (code, signal) => {
          active.delete(scenario);
          const result = existsSync(join(directory, "result.json")) ? JSON.parse(readFileSync(join(directory, "result.json")))
            : { scenario, status: "infrastructure-failed", cleanup: { status: "unknown" }, error: "worker exited without evidence" };
          results.push({ ...result, processTerminal: { code, signal }, startedAt });
          const groupStop = groupStopFor(result);
          if (groupStop) {
            stop = groupStop;
            for (const peer of active.values()) peer.kill("SIGTERM");
          }
          resolve();
        }));
      }
    }
    await Promise.all(Array.from({ length: plan.concurrency }, slot));
    for (const scenario of plan.scenarios.slice(next)) results.push({ scenario, status: "not-run", reason: stop });
    const ledger = { schemaVersion: 1, finishedAt: now(), mode: plan.mode,
      historicalPerformanceConditions: 59, frameworkScenarioCount: results.filter(r => r.processTerminal).length,
      realModelConditionsAdded: plan.mode === "fake" ? 0 : "unknown", stop, results,
      parallel: `at most ${plan.concurrency} isolated condition workers`,
      serial: "within each chain: sources → input → terminal → receipts/quality → next; cleanup/physical exit before root release",
      analysis: { owner: "agent", status: "not-assessed",
        scope: "Engineering records measurements and objective checks. Agent inspects trajectories, quality, confounders and combined-candidate benefit; no automatic adoption or model review." } };
    const completion = invocationCompletion(results);
    ledger.completion = completion;
    save(join(output, "ledger.json"), ledger);
    save(join(output, "completion.json"), completion);
    save(join(output, "seal.json"), treeHashes(output));
    console.log(JSON.stringify({ output, results: results.map(r => ({ scenario: r.scenario, status: r.status,
      completedStages: r.completedStages, cleanup: r.cleanup?.status })), stop, completion }));
    // Exit is collection/lifecycle status, not a quality verdict. Fault and
    // objective checks remain visible in results and asserted by wiring checks.
    process.exitCode = completion.exitCode;
  }
}
