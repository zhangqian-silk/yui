// Reporting only. Never replaces the original oracle, safety fences or verdict.
export { invocationCompletion } from "./completion.mjs";
const checks = {
  business: "business", handling: "protocol", observedConstraints: "legal",
  dispositionOriginalCoverage: "inputReads", materialOutputCoverage: "reads",
  skillSourceBinding: "binding", instructionOutputCoverage: "loads",
  reuseAvailability: "reuseAvailability",
};
const status = grade => ["pass", "fail", "unknown"].includes(grade?.status) ? grade.status : "unknown";
export function resultCoverage(result) {
  return {
    plannedStages: result.plannedStages ?? "unknown",
    completedStages: result.completedStages ?? "unknown",
    routes: (result.routes ?? (result.route ? [result.route] : [])).map((route, index) => ({
      role: "operator", stage: route.stage ?? "unknown", inputOrdinal: index + 1,
      inputPhase: index ? "later-input" : "first-input",
      threadId: route.terminal?.threadId, turnId: route.terminal?.turnId,
      evidenceScope: route.evidenceScope,
      handling: route.grade, fidelity: route.input, reads: route.reads,
      loads: route.loads, binding: route.binding,
    })),
    coverageLimit: "Input order is not proof of current model memory; inspect Thread/epoch continuity separately",
  };
}
export function observedDimensions(stage) {
  const terminal = Boolean(stage?.terminal?.threadId && stage.terminal.turnId);
  return Object.fromEntries(Object.entries(checks).map(([dimension, check]) => [dimension, {
    status: !terminal || check === "reuseAvailability" && status(stage[check]) === "pass" ? "unknown" : status(stage[check]),
    sourceStatus: status(stage?.[check]), sourceCheck: check, scope: stage?.[check]?.scope,
    limit: dimension === "observedConstraints"
      ? "Observed events/endpoints only; arbitrary unjournaled write-and-restore remains unknown"
      : dimension === "reuseAvailability"
        ? "Source pass can mean no reused output was identified. It is not memory proof; same Thread, metadata, self-report and fake memory never establish real availability"
        : "This dimension alone is not overall quality or proof of comprehension",
  }]));
}
function stageMap(result) {
  const stages = new Map();
  for (const stage of result?.stages ?? []) {
    if (!Number.isSafeInteger(stage.stage) || stage.stage < 1) throw Error("Invalid stage identity");
    if (stages.has(stage.stage)) throw Error("Duplicate stage identity");
    stages.set(stage.stage, stage);
  }
  return stages;
}
export function compareObservedStages(a, b) {
  const identities = ["inputIdentity", "harnessIdentity", "configurationIdentity"];
  const sameFreeze = identities.every(key => typeof a.plan?.[key] === "string"
    && a.plan[key].length > 0 && a.plan[key] === b.plan?.[key]);
  const sameScenario = typeof a.result?.scenario === "string" && a.result.scenario === b.result?.scenario;
  const A = stageMap(a.result), B = stageMap(b.result);
  const stages = sameFreeze && sameScenario ? [...A].filter(([n]) => B.has(n)).map(([stage, left]) => {
    const da = observedDimensions(left), db = observedDimensions(B.get(stage));
    return { stage, dimensions: Object.fromEntries(Object.keys(checks).map(key => [key, {
      A: da[key].status, B: db[key].status,
      comparable: da[key].status !== "unknown" && db[key].status !== "unknown",
    }])) };
  }) : [];
  return {
    sameFreeze, sameScenario, stages,
    originalStatus: { A: a.result?.status ?? "unknown", B: b.result?.status ?? "unknown" },
    stageCounts: { A: A.size, B: B.size },
    fullQualityComparable: false, savingsEstablished: false,
    limit: "Descriptive recorded dimensions only, including failures. Product/model identity, route and cleanup require separate inspection; no causal, current-memory or lossless-effects claim.",
  };
}
