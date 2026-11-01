// Execution exit projection, separate from supplemental analysis and reviews.
import { routesStage } from "./common.mjs";
export function invocationCompletion(results) {
  const failed = results.some(r => r.error || r.status === "infrastructure-failed"
    || r.status === "framework-invalid" || r.status !== "not-run"
      && (r.processTerminal?.code !== 0 || r.processTerminal?.signal));
  const complete = results.length > 0 && results.every(r => {
    if (r.status === "not-run" || !Number.isSafeInteger(r.plannedStages) || r.plannedStages < 1
      || r.completedStages !== r.plannedStages) return false;
    const expected = Array.from({ length: r.plannedStages }, (_, i) => i + 1);
    const exact = (rows, stages) => rows?.length === stages.length && stages.every(n =>
      rows.filter(row => row.stage === n && row.terminal?.status === "completed").length === 1);
    return exact(r.stages, expected)
      && exact(r.routes ?? [], expected.filter(n => routesStage(r.scenario, n)));
  });
  const grades = [...new Set(results.map(r => r.executionChecks ?? "unknown"))];
  const execution = failed ? "failed" : complete ? "completed" : "incomplete";
  const cleanup = results.length && results.every(r => r.cleanup?.status === "released") ? "released" : "unknown";
  const grading = grades.length === 1 ? grades[0] : grades.length ? "mixed" : "unknown";
  return { execution, grading, cleanup,
    exitCode: execution === "completed" && grading === "pass" && cleanup === "released" ? 0 : 1,
    limit: "Execution completion is separate from unchanged original grading; nonpass and uncertain cleanup remain nonzero" };
}
