// Saved evidence only. Never imports runner/fixture or contacts any Home.
import { openEvidence, readSavedInvocation, ANALYSIS_VERSION } from "./saved-evidence.mjs";
import { observedDimensions, compareObservedStages, resultCoverage, invocationCompletion } from "./dimensions.mjs";
import { quantifyInvocation } from "./quantify.mjs";
function readInvocation(path) {
  const store = openEvidence(path);
  let saved, measurements;
  try {
    saved = readSavedInvocation(store);
    // Use existing owned native accounting, not a second usage algorithm.
    // No current product files are substituted for absent frozen sources.
    const q = quantifyInvocation(saved, { files: [], missing: [] });
    measurements = {
      evidence: { source: store.source, identity: saved.identity,
        inventory: q.inventory, duplicateNativeItems: q.duplicates },
      totals: { ...q.totals, recognizedBodies: "not-measured-without-frozen-source-bundle" },
      rows: q.rows.map(r => ({
        role: r.role, threadId: r.threadId, turnId: r.turnId, stage: r.stage,
        phase: r.phase, inputOrdinal: r.inputOrdinal, startedAt: r.startedAt, completedAt: r.completedAt,
        tokens: r.tokens, usageObservations: r.usageObservations,
        toolCount: r.toolCount, failedToolCount: r.failedToolCount,
        toolOutputUtf8: r.toolOutputUtf8, observedToolOutputLowerBoundUtf8: r.observedToolOutputLowerBoundUtf8,
        wallMs: r.wallMs, tokenAttribution: r.tokenAttribution,
      })),
      instrumentedCli: q.instrumentedCli,
      limitations: [...q.limitations, "No frozen source bundle supplied: instruction/body classification and repeated-body bytes are not measured here. The existing history.mjs analyze indexed-archive flow resolves exact frozen sources for those metrics."],
    };
  } finally { store.close(); }
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
    measurements,
    analysis: { owner: "agent", status: "not-assessed",
      questions: [
        "Did each arm complete equivalent work with acceptable business behavior and authority/handling?",
        "Which combined changes were actually used? Cite exact Role/Thread/Turn commands and outputs.",
        "Separate fewer bytes, fewer round trips, carried history, compaction, errors and unrelated Role variation.",
        "Retain failed/incomplete cases; do not count early termination as savings or discard unfavorable trajectories.",
        "Recommend keep/revise/drop with uncertainty; new execution only for a bounded decision-changing gap, not small wording/KB changes.",
      ] },
    limitation: "Engineering statistics and recorded checks only. Agent owns semantic quality, causal attribution and adoption; original evidence/grades are unchanged." } };
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
