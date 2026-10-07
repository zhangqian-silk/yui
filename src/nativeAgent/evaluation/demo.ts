import { runEvaluation, createEvaluationFixture, evaluationCases } from './index.js';

async function main(): Promise<void> {
  let verified = true;
  for (const spec of evaluationCases) {
    for (const variant of ['good', 'bad'] as const) {
      const report = await runEvaluation({ caseId: spec.id, provider: {
        source: { kind: 'deterministic-fixture', id: `known-${variant}`, revision: '1' },
        create: context => createEvaluationFixture(context, variant),
      } });
      console.log(JSON.stringify(report));
      verified &&= report.verdict === (variant === 'good' ? 'pass' : 'fail')
        && report.cleanup.directory === 'removed';
    }
  }
  // A rejected negative control is harness success, never task success.
  if (!verified) process.exitCode = 1;
}
void main().catch(() => { console.error('Evaluation demo failed; no raw diagnostic body exported'); process.exitCode = 1; });
