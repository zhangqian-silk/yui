// Saved evidence only. Never imports runner/fixture or contacts any Home.
import { openEvidence, readSavedInvocation, ANALYSIS_VERSION } from "./saved-evidence.mjs";
import { observedDimensions, compareObservedStages, resultCoverage, invocationCompletion } from "./dimensions.mjs";
function readInvocation(path) {
  const store = openEvidence(path);
  let saved;
  try { saved = readSavedInvocation(store); } finally { store.close(); }
  const { plan, preflight, ledger } = saved;
  return { plan, ledger, summary: { analysisVersion: ANALYSIS_VERSION, seal: "verified", product: preflight.commit, harness: plan.harnessIdentity,
    historicalPerformanceConditions: ledger.historicalPerformanceConditions, frameworkScenarioCount: ledger.frameworkScenarioCount,
    realModelConditionsAdded: ledger.realModelConditionsAdded, stop: ledger.stop,
    completion: invocationCompletion(ledger.results),
    results: ledger.results.map(r => ({ scenario: r.scenario, status: r.status,
      ...resultCoverage(r),
      executionChecks: r.executionChecks, stages: r.completedStages, error: r.error,
    cleanup: r.cleanup?.status, rootAbsent: r.cleanup?.rootAbsent, cost: r.cost, tokens: r.tokens,
    account: { ...(r.account ?? { status: "unknown" }), billedCost: r.account?.billedCost ?? "unknown" },
    skillChecksByTurn: r.skillChecksByTurn ?? "unknown",
    recovery: r.recovery ?? "not-recorded",
    nativeOwnership: r.nativeAttribution ?? { status: "legacy-unverified",
      limit: "Connection labels may include foreign broadcasts. Replay raw request/response ownership before relying on legacy native costs or attribution." },
      dimensions: r.stages?.map((s, index) => ({ stage: s.stage, role: "leader",
        inputPhase: index ? "later-input" : "first-input", threadId: s.terminal?.threadId,
        turnId: s.terminal?.turnId, evidenceScope: s.evidenceScope, ...observedDimensions(s) })),
      route: r.route ? { handling: r.route.grade, fidelity: r.route.input, reads: r.route.reads,
        loads: r.route.loads, binding: r.route.binding } : undefined })),
    comparable: false, limitation: "Saved framework evidence; no model/performance claim or historical regrade" } };
}
if (!process.argv[2] || process.argv.length > 4)
  throw Error("Usage: analyze.mjs <saved invocation> [paired saved invocation]");
const a = readInvocation(process.argv[2]);
const b = process.argv[3] ? readInvocation(process.argv[3]) : undefined;
const pairs = b ? a.ledger.results.flatMap(result => b.ledger.results
  .filter(other => other.scenario === result.scenario)
  .map(other => ({ scenario: result.scenario, ...compareObservedStages(
    { plan: a.plan, result }, { plan: b.plan, result: other }) }))) : undefined;
console.log(JSON.stringify(b ? { A: a.summary, B: b.summary, pairs } : a.summary, null, 2));
