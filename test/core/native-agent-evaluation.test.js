import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { runEvaluation, createEvaluationFixture, evaluationCases } from '../../dist/nativeAgent/evaluation/index.js';

test('independent checks distinguish actual good/bad repair, refactor and test additions', async () => {
  for (const caseId of ['repair', 'refactor', 'tests']) {
    const good = await runEvaluation({ caseId });
    const bad = await runEvaluation({ caseId, provider: {
      source: { kind: 'deterministic-fixture', id: 'negative-control', revision: '1' },
      create: context => createEvaluationFixture(context, 'bad'),
    } });
    assert.equal(good.verdict, 'pass', JSON.stringify(good));
    assert.equal(bad.verdict, 'fail', JSON.stringify(bad));
    assert.equal(good.execution.reason, 'completed');
    assert.equal(bad.execution.reason, 'completed'); // final claims success in both
    assert.equal(good.baseline.digest, bad.baseline.digest);
    assert.ok(good.checks.every(c => c.processGroup === 'absent'));
    assert.ok(good.checks.some(c => c.stage === 'baseline'));
    assert.ok(good.session.reopenedVerified);
    assert.equal(good.session.retained, false);
    assert.equal(good.cleanup.directory, 'removed');
    assert.equal(good.cleanup.store, 'closed');
    assert.equal(good.cleanup.processes, 'absent');
    assert.equal(good.usage.tokens, null);
    assert.equal(good.usage.cost, null);
    assert.equal(good.usage.source, 'synthetic');
    assert.notEqual(good.runId, bad.runId);
    assert.notEqual(good.session.reference, bad.session.reference);
    if (caseId === 'repair') {
      assert.equal(good.checks.find(c => c.stage === 'baseline' && c.id === 'behavior').exitCode, 1);
      assert.equal(bad.checks.find(c => c.stage === 'candidate' && c.id === 'behavior').exitCode, 1);
    }
    if (caseId === 'refactor') {
      assert.equal(bad.checks.find(c => c.stage === 'candidate' && c.id === 'structure').exitCode, 1);
    }
    if (caseId === 'tests') {
      assert.equal(good.checks.find(c => c.id === 'tests-mutant' && c.stage === 'candidate').exitCode, 1);
      assert.equal(bad.checks.find(c => c.id === 'tests-normal' && c.stage === 'candidate').exitCode, 1);
      assert.ok(good.changes.every(c => c.path === 'math.test.cjs'));
    }
  }
});

test('budgets, cancellation after confirmed effect, denied writes and fingerprint conflict never pass', async () => {
  const budget = await runEvaluation({ caseId: 'repair', maxSteps: 2 });
  assert.equal(budget.execution.reason, 'budget_exhausted');
  assert.equal(budget.verdict, 'fail');
  assert.ok(budget.changes.length);
  assert.ok(budget.execution.settlements.some(s => s.started && s.status === 'succeeded'));
  const contextBudget = await runEvaluation({ caseId: 'repair', contextCapacity: 1 });
  assert.equal(contextBudget.verdict, 'fail');
  assert.equal(contextBudget.execution.reason, 'error');
  assert.equal(contextBudget.execution.context[0].status, 'failed');
  assert.equal(contextBudget.execution.steps, 1);

  const denied = await runEvaluation({ caseId: 'repair', permission: {
    async check(invocation) { return invocation.call.name !== 'edit'
      ? { allowed: true } : { allowed: false, reason: 'Fixture denies edits' }; },
  } });
  assert.equal(denied.verdict, 'fail');
  assert.deepEqual(denied.changes, []);
  assert.equal(denied.scope.unchanged, true);
  assert.ok(denied.execution.settlements.some(s => s.errorCode === 'permission_denied' && !s.started));

  const controller = new AbortController();
  const cancelled = await runEvaluation({ caseId: 'repair', signal: controller.signal,
    provider: {
      source: { kind: 'deterministic-fixture', id: 'cancel-after-edit', revision: '1' },
      create(context) {
        const fixture = createEvaluationFixture(context);
        return { async complete(request, signal) {
          if (request.step === 3) controller.abort();
          return fixture.complete(request, signal);
        } };
      },
    },
  });
  assert.equal(cancelled.verdict, 'fail');
  assert.equal(cancelled.execution.reason, 'cancelled');
  assert.ok(cancelled.changes.length);
  assert.ok(cancelled.execution.settlements.some(s => s.started && s.status === 'succeeded'
    && s.cleanup === 'released'));

  let candidateRoot;
  const conflict = await runEvaluation({ caseId: 'repair', provider: {
    source: { kind: 'deterministic-fixture', id: 'user-edit-conflict', revision: '1' },
    create(context) {
      candidateRoot = context.root;
      const fixture = createEvaluationFixture(context);
      return { async complete(request, signal) {
        if (request.step === 2) await writeFile(path.join(context.root, 'math.cjs'), 'USER EDIT MUST SURVIVE\n');
        if (request.step === 3) assert.equal(await readFile(path.join(context.root, 'math.cjs'), 'utf8'),
          'USER EDIT MUST SURVIVE\n');
        return fixture.complete(request, signal);
      } };
    },
  } });
  assert.equal(conflict.verdict, 'fail');
  assert.ok(conflict.execution.settlements.some(s => s.errorCode === 'edit_conflict'));
  await assert.rejects(access(candidateRoot), { code: 'ENOENT' });
});

test('scope includes forbidden additions/deletions, command authority and body-free reports', async () => {
  const secret = 'SECRET-provider-error-and-transcript';
  const report = await runEvaluation({ caseId: 'repair', provider: {
    source: { kind: 'deterministic-fixture', id: 'scope-negative', revision: '1' },
    create(context) {
      const fixture = createEvaluationFixture(context);
      return { async complete(request, signal) {
        if (request.step === 3) return { kind: 'tool_calls', content: secret, calls: [
          { id: 'forbidden-add', name: 'write', arguments: { path: secret, content: secret } },
          { id: 'forbidden-command', name: 'command',
            arguments: { command: process.execPath, argv: ['-e', `throw Error("${secret}")`], cwd: context.root } },
          { id: secret, name: secret, arguments: {} },
        ] };
        if (request.step === 4) throw Error(secret);
        return fixture.complete(request, signal);
      } };
    },
  } });
  assert.equal(report.verdict, 'fail');
  assert.equal(report.scope.allowed, false);
  assert.ok(report.changes.some(c => c.kind === 'added' && c.path.startsWith('unapproved-entry-')));
  assert.ok(report.execution.settlements.some(s => s.errorCode === 'permission_denied'));
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(report.cleanup.directory, 'removed');
  const deletion = await runEvaluation({ caseId: 'tests', provider: {
    source: { kind: 'deterministic-fixture', id: 'protected-deletion', revision: '1' },
    create(context) {
      const fixture = createEvaluationFixture(context);
      return { async complete(request, signal) {
        if (request.step === 4) await unlink(path.join(context.root, 'README.md'));
        return fixture.complete(request, signal);
      } };
    },
  } });
  assert.equal(deletion.verdict, 'fail');
  assert.equal(deletion.gates.target, true);
  assert.equal(deletion.scope.allowed, false);
  assert.ok(deletion.changes.some(c => c.kind === 'deleted' && c.path === 'README.md'));
  assert.equal(evaluationCases.length, 3);
});

test('no-op claims fail and producer usage stays synthetic without inventing cost', async () => {
  const noop = await runEvaluation({ caseId: 'refactor', provider: {
    source: { kind: 'deterministic-fixture', id: 'no-op', revision: '1' },
    create: () => ({ async complete() { return { kind: 'final', content: 'Refactored successfully' }; } }),
  } });
  assert.equal(noop.verdict, 'fail');
  assert.equal(noop.execution.reason, 'completed');
  assert.deepEqual(noop.changes, []);
  assert.equal(noop.scope.unchanged, true);
  const measured = await runEvaluation({ caseId: 'repair', provider: {
    source: { kind: 'deterministic-fixture', id: 'observed-fixture', revision: '1', ignoredSecret: 'DO-NOT-EXPORT' },
    create(context) {
      const fixture = createEvaluationFixture(context);
      return { async complete(request, signal) {
        const response = await fixture.complete(request, signal);
        context.observer.observeModel({ sessionId: request.sessionId, turnId: request.turnId, step: request.step,
          requestId: `fixture-${request.step}`, attempt: 1, phase: 'ended', status: 'completed',
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 }, elapsedMs: 2 });
        return response;
      } };
    },
  } });
  assert.equal(measured.verdict, 'pass');
  assert.equal(measured.usage.source, 'synthetic');
  assert.equal(measured.usage.tokens.length, 4);
  assert.equal(measured.usage.tokens[0].totalTokens, 15);
  assert.equal(measured.usage.cost, null);
  assert.equal(measured.usage.models[0].elapsedMs, 2);
  assert.equal(measured.usage.models[0].durationMs, undefined); // no started observation
  assert.equal(JSON.stringify(measured).includes('DO-NOT-EXPORT'), false);
});
