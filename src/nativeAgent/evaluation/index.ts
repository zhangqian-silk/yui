import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgent, createCodingTools, createContextBuilder, createToolExecutor, createLocalObserver,
  createSessionStore, createSqliteSessionBackend } from '../index.js';
import type { ModelProvider, TurnResult, SessionStore, ToolPermission, SaveReceipt } from '../index.js';
import type { ToolInvocation } from '../toolManager/index.js';
import type { Usage } from '../observability/index.js';
import { baselineFiles, getCase } from './cases.js';
import type { CaseId } from './cases.js';
import { createEvaluationFixture } from './fixture.js';
import type { EvaluationProviderContext } from './fixture.js';
import { checkIds, runCheck, verifierDigest } from './checks.js';
import type { CheckEvidence } from './checks.js';
import { compareFiles, filesDigest, inspectFiles, sha256 } from './files.js';

export { evaluationCases } from './cases.js';
export type { CaseId, EvaluationCase } from './cases.js';
export { createEvaluationFixture } from './fixture.js';
export type { EvaluationProviderContext } from './fixture.js';
export type { CheckEvidence } from './checks.js';
export type ExecutionSource = Readonly<{
  /** Opaque non-sensitive labels supplied by the caller, never account details. */
  kind: 'deterministic-fixture' | 'caller-provider';
  id: string;
  revision: string;
  model?: string;
}>;
export type EvaluationOptions = {
  caseId: CaseId;
  /** Injection is NOT authorization for real accounts or untrusted code. */
  provider?: { source: ExecutionSource; create(context: EvaluationProviderContext): ModelProvider };
  maxSteps?: number;
  contextCapacity?: number;
  signal?: AbortSignal;
  /** Additional restriction, never overrides the fixed executable/argv policy. */
  permission?: ToolPermission<Readonly<{ root: string }>>;
};
export type EvaluationReport = {
  schemaVersion: 1;
  runtime: { node: string; platform: string; arch: string; verifierDigest: string };
  runId: string;
  case: { id: CaseId; revision: string; category: string; inputDigest: string };
  baseline: { digest: string; fileCount: number };
  source: ExecutionSource;
  verdict: 'pass' | 'fail';
  gates: { baseline: boolean; scope: boolean; target: boolean; execution: boolean; cleanup: boolean };
  scope: { allowed: boolean; unchanged: boolean; inspected: boolean; candidateDigest: string | null };
  changes: { path: string; pathDigest: string; kind: 'added' | 'deleted' | 'modified'; before: string | null; after: string | null }[];
  checks: CheckEvidence[];
  execution: {
    reason: TurnResult['reason'] | 'harness_error';
    steps: number;
    maxSteps: number;
    contextCapacity: number;
    cancellationRequested: boolean;
    errorCode: string | null;
    recording: TurnResult['recording'] | null;
    context: { step: number; status: string; estimatedInput: number; capacity: number; estimator: string }[];
    settlements: { callReference: string; name: string; started: boolean; status: string; cleanup: string;
      cancellationRequested: boolean; errorCode?: string; effect?: string }[];
    commands: { callReference: string; exitCode: number | null; processGroup: string; directChildExited: boolean }[];
  };
  session: {
    /** Logical owned-store reference, not an exposed filesystem path. */
    reference: string;
    receipt: { sessionId: string; revision: number; digest: string; durability: string } | null;
    reopenedVerified: boolean;
    retained: boolean;
  };
  usage: { source: 'synthetic' | 'producer-reported'; tokens: readonly Usage[] | null; cost: null;
    missingReason: string; models: { requestId: string; step?: number; elapsedMs?: number; durationMs?: number }[] };
  observation: { count: number; evicted: number; rejected: number; observedTurnDurationMs: number | null };
  cleanup: { directory: 'removed' | 'retained'; store: 'closed' | 'unknown'; processes: 'absent' | 'unknown';
    /** Only on failed cleanup; preserve exact owned path for authorized recovery. */
    retainedDirectory?: string };
  elapsedMs: number;
};
function sourceOf(source: ExecutionSource): ExecutionSource {
  if (!['deterministic-fixture', 'caller-provider'].includes(source.kind)
    || [source.id, source.revision, ...(source.model === undefined ? [] : [source.model])]
      .some(label => typeof label !== 'string' || !label.length || Buffer.byteLength(label) > 256)) {
    throw Error('Non-sensitive bounded source labels required');
  }
  // Ignore extra caller properties (tokens, credentials, endpoint, errors).
  return Object.freeze({ kind: source.kind, id: source.id, revision: source.revision,
    ...(source.model === undefined ? {} : { model: source.model }) });
}
function receiptOf(receipt: SaveReceipt) {
  return { sessionId: receipt.sessionId, revision: receipt.revision, digest: receipt.digest,
    durability: receipt.source.durability };
}
function checkPassed(check: CheckEvidence | undefined): boolean {
  return !!check && check.toolOk && check.directChildExited && check.processGroup === 'absent'
    && check.exitCode === 0;
}
function trustedMutantFailure(check: CheckEvidence | undefined): boolean {
  return !!check && check.toolOk && check.directChildExited && check.processGroup === 'absent'
    && check.exitCode === 1 && check.assertionKilledMutant;
}
/** Unknown tool/call labels originate in model output, not in trusted metadata. */
const publicToolName = (name: string) =>
  ['read', 'write', 'edit', 'list', 'find', 'search', 'command'].includes(name) ? name : 'unregistered';
function syntaxCommandAllowed(invocation: ToolInvocation, root: string): boolean {
  if (invocation.call.name !== 'command') return true;
  const args = invocation.call.arguments;
  return !!args && typeof args === 'object' && !Array.isArray(args)
    && args.command === process.execPath && args.cwd === root
    && Array.isArray(args.argv) && args.argv.length === 2 && args.argv[0] === '--check'
    && ['math.cjs', 'math.test.cjs'].includes(String(args.argv[1]));
}
/** One thin composition of the real modules; no loop, history DB or scoring service. */
export async function runEvaluation(options: EvaluationOptions): Promise<EvaluationReport> {
  const spec = getCase(options.caseId);
  const maxSteps = options.maxSteps ?? 4, capacity = options.contextCapacity ?? 100_000;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 32
    || !Number.isSafeInteger(capacity) || capacity < 0) throw Error('Invalid evaluation budget');
  const source = sourceOf(options.provider?.source ?? { kind: 'deterministic-fixture', id: 'known-good', revision: '1' });
  const start = performance.now();
  const runId = randomUUID(), sessionId = `evaluation-${runId}`, turnId = 'candidate';
  const observer = createLocalObserver();
  let owned: string | undefined, store: SessionStore | undefined;
  // Teardown is registered structurally before the first allocation.
  const report: EvaluationReport = {
    schemaVersion: 1, runId,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, verifierDigest },
    case: { id: spec.id, revision: spec.revision, category: spec.category, inputDigest: sha256(spec.input) },
    baseline: { digest: '', fileCount: 0 }, source, verdict: 'fail',
    gates: { baseline: false, scope: false, target: false, execution: false, cleanup: false },
    scope: { allowed: false, unchanged: false, inspected: false, candidateDigest: null }, changes: [], checks: [],
    execution: { reason: 'harness_error', steps: 0, maxSteps, contextCapacity: capacity, cancellationRequested: false,
      errorCode: null, recording: null, context: [], settlements: [], commands: [] },
    session: { reference: `owned-session-store:${runId}/${sessionId}`, receipt: null, reopenedVerified: false, retained: false },
    usage: { source: source.kind === 'deterministic-fixture' ? 'synthetic' : 'producer-reported',
      tokens: null, cost: null, missingReason: 'No token or cost observation was supplied', models: [] },
    observation: { count: 0, evicted: 0, rejected: 0, observedTurnDurationMs: null },
    cleanup: { directory: 'retained', store: 'closed', processes: 'absent' }, elapsedMs: 0,
  };
  let result: TurnResult | undefined;
  try {
    owned = await mkdtemp(path.join(tmpdir(), 'native-agent-evaluation-'));
    const root = path.join(owned, 'repo'), db = path.join(owned, 'session.sqlite');
    await mkdir(root);
    for (const [name, text] of Object.entries(baselineFiles(spec.id))) {
      await writeFile(path.join(root, name), text, { flag: 'wx', mode: 0o600 });
    }
    const before = await inspectFiles(root);
    report.baseline = { digest: filesDigest(before), fileCount: before.size };
    for (const id of checkIds(spec.id)) {
      report.checks.push(await runCheck(root, spec.id, before.get('math.cjs')?.text,
        before.get('math.test.cjs')?.text, id, 'baseline'));
    }
    const baselineCheck = (id: CheckEvidence['id']) => report.checks.find(c => c.stage === 'baseline' && c.id === id);
    const baselineBehavior = baselineCheck('behavior');
    report.gates.baseline = spec.id === 'repair'
      ? !!baselineBehavior?.toolOk && baselineBehavior.exitCode === 1
        && baselineBehavior.directChildExited && baselineBehavior.processGroup === 'absent'
      : checkPassed(baselineBehavior);
    if (!report.checks.every(c => c.processGroup === 'absent')) throw Error('Unsettled baseline check');
    store = createSessionStore(createSqliteSessionBackend(db));
    report.cleanup.store = 'unknown';
    await store.create(sessionId);
    const recording = await store.recorder(sessionId);
    const context = Object.freeze({ case: spec, root, node: process.execPath, observer });
    const provider = options.provider?.create(context) ?? createEvaluationFixture(context);
    const tools = createCodingTools({ root, command: { env: {}, timeoutMs: 2000 } });
    const executor = createToolExecutor({
      tools,
      environment: { async acquire() { return { value: Object.freeze({ root }), async release() {} }; } },
      permission: { async check(invocation, environment, signal) {
        if (!syntaxCommandAllowed(invocation, root)) {
          return { allowed: false, reason: 'Only fixed local syntax checks are authorized' };
        }
        return options.permission ? options.permission.check(invocation, environment, signal) : { allowed: true };
      } },
    });
    result = await createAgent({ provider, toolExecutor: executor, recorder: recording, observer,
      contextBuilder: createContextBuilder({ sources: [{ id: 'fixed-case', async load() {
        return [{ id: spec.id, kind: 'guidance', source: 'evaluation-case', revision: spec.revision,
          required: true, content: spec.input }];
      } }] }), contextBudget: { capacity, reserveOutput: 0 },
    }).runTurn({ sessionId, turnId, input: spec.input, maxSteps, signal: options.signal });
    observer.observeSnapshot(result);
    report.execution.reason = result.reason;
    report.execution.steps = result.steps;
    report.execution.errorCode = result.error?.code ?? null;
    report.execution.recording = result.recording;
    report.execution.context = result.contextReports.map(c => ({ step: c.step, status: c.status,
      estimatedInput: c.report.estimatedInput, capacity: c.report.capacity, estimator: c.report.estimator }));
    for (const event of result.events) {
      if (event.data.type !== 'message_appended' || event.data.message.role !== 'tool') continue;
      const message = event.data.message, settlement = event.data.settlement;
      if (settlement) report.execution.settlements.push({
        callReference: sha256(message.toolCallId), name: publicToolName(message.name),
        started: settlement.started, status: settlement.status,
        cleanup: settlement.cleanup.status, cancellationRequested: settlement.cancellationRequested,
        ...(!message.outcome.ok ? { errorCode: message.outcome.error.code, effect: message.outcome.error.effect } : {}),
      });
      if (message.name === 'command' && settlement?.started) {
        let evidence: { exitCode: number | null; processGroup: string; directChildExited: boolean } | undefined;
        try { evidence = JSON.parse(message.outcome.ok ? message.outcome.content : message.outcome.error.message); } catch { /* unknown */ }
        report.execution.commands.push({ callReference: sha256(message.toolCallId), exitCode: evidence?.exitCode ?? null,
          processGroup: evidence?.processGroup ?? 'unknown', directChildExited: evidence?.directChildExited ?? false });
      }
    }
    report.session.receipt = receiptOf(recording.lastReceipt);
    const saved = await store.load(sessionId);
    if (saved.digest !== recording.lastReceipt.digest) throw Error('Receipt mismatch');
    await store.close(); store = undefined; report.cleanup.store = 'closed';
    store = createSessionStore(createSqliteSessionBackend(db)); report.cleanup.store = 'unknown';
    const reopened = await store.load(sessionId);
    report.session.reopenedVerified = reopened.digest === saved.digest && reopened.revision === saved.revision;
    report.gates.execution = result.reason === 'completed' && result.recording.status === 'recorded'
      && report.session.reopenedVerified && saved.recovery.disposition === 'ready'
      && report.execution.settlements.every(s => s.status === 'succeeded' && s.cleanup === 'released')
      && report.execution.commands.every(c => c.exitCode === 0 && c.directChildExited && c.processGroup === 'absent');
    const after = await inspectFiles(root);
    const changes = compareFiles(before, after);
    report.scope = {
      inspected: true, candidateDigest: filesDigest(after), unchanged: changes.length === 0,
      allowed: changes.every(c => spec.allowedChanges.includes(c.path) && c.regular),
    };
    report.changes = changes.map((c, i) => ({
      path: before.has(c.path) || spec.allowedChanges.includes(c.path) ? c.path : `unapproved-entry-${i + 1}`,
      pathDigest: sha256(c.path), kind: c.kind, before: c.before, after: c.after,
    }));
    report.gates.scope = report.scope.allowed && !report.scope.unchanged;
    // Snapshot checks cannot be redirected to a candidate-authored verifier.
    for (const id of checkIds(spec.id)) {
      report.checks.push(await runCheck(root, spec.id, after.get('math.cjs')?.text,
        after.get('math.test.cjs')?.text, id, 'candidate'));
    }
    const checked = (id: CheckEvidence['id']) => report.checks.find(c => c.stage === 'candidate' && c.id === id);
    report.gates.target = checkPassed(checked('behavior')) && (spec.id === 'refactor'
      ? checkPassed(checked('structure')) : spec.id === 'tests'
        ? checkPassed(checked('tests-normal')) && trustedMutantFailure(checked('tests-mutant')) : true);
  } catch {
    // The original failure remains in the sole SessionStore when recorded.
    // Never copy exception bodies, stack, transcripts or environment into stdout.
    report.execution.errorCode ??= 'evaluation_failed';
  } finally {
    report.execution.cancellationRequested = options.signal?.aborted ?? false;
    const page = observer.query({ limit: 1000 }), health = observer.health();
    const models = page.records.filter(r => r.kind === 'model' && r.type === 'ended');
    const usage = models.flatMap(r => r.usage ? [r.usage] : []);
    report.usage.tokens = usage.length ? usage : null;
    report.usage.models = models.map(r => ({ requestId: r.requestId!, step: r.step,
      ...(r.elapsedMs === undefined ? {} : { elapsedMs: r.elapsedMs }),
      ...(r.durationMs === undefined ? {} : { durationMs: r.durationMs }) }));
    report.usage.missingReason = usage.length ? 'Token observations are per attempt; cost was not supplied'
      : 'No token or cost observation was supplied';
    report.observation = { count: health.retained, evicted: health.evicted, rejected: health.rejected,
      observedTurnDurationMs: page.records.find(r => r.type === 'turn_ended')?.durationMs ?? null };
    observer.close();
    if (store) {
      try { await store.close(); report.cleanup.store = 'closed'; }
      catch { report.cleanup.store = 'unknown'; }
    }
    report.cleanup.processes = report.checks.every(c => c.processGroup === 'absent')
      && report.execution.commands.every(c => c.processGroup === 'absent') ? 'absent' : 'unknown';
    if (owned) {
      // Do not erase diagnostic ownership when resources are not confirmed settled.
      if (report.cleanup.store === 'closed' && report.cleanup.processes === 'absent') {
        try {
          await rm(owned, { recursive: true, force: true });
          try { await lstat(owned); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') report.cleanup.directory = 'removed';
          }
        } catch { /* retain exact owned recovery target */ }
      }
      if (report.cleanup.directory !== 'removed') report.cleanup.retainedDirectory = owned;
    }
    report.gates.cleanup = report.cleanup.directory === 'removed' && report.cleanup.store === 'closed'
      && report.cleanup.processes === 'absent';
    report.session.retained = report.cleanup.directory === 'retained' && report.session.receipt !== null;
    // Any infrastructure exception is a failure, even if earlier gates passed.
    report.verdict = !report.execution.errorCode && !report.execution.cancellationRequested
      && Object.values(report.gates).every(Boolean) ? 'pass' : 'fail';
    report.elapsedMs = performance.now() - start;
  }
  return report;
}

/** Source identity for reviewers without exposing the checker body in reports. */
export const evaluationVerifierDigest = verifierDigest;
