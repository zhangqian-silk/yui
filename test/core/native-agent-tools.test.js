import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolExecutor } from '../../dist/nativeAgent/toolManager/index.js';

const scope = { sessionId: 'session', turnId: 'turn', step: 1 };
const call = (id, name = 'effect', args = {}) => ({ id, name, arguments: args });
const success = { ok: true, content: 'confirmed' };
const tool = (execute, validate = () => null) => ({
  definition: { name: 'effect', description: 'fixture', inputSchema: { type: 'object' } },
  validate, execute,
});
function fixture(extra = {}) {
  const trace = [];
  const options = {
    tools: [tool(async (_args, identity, _signal, env) => {
      assert.ok(Object.isFrozen(_args));
      trace.push(`execute:${identity.toolCallId}:${env.root}`);
      return success;
    })],
    environment: { async acquire() {
      trace.push('acquire');
      return { value: { root: 'controlled' }, async release() { trace.push('release'); } };
    } },
    permission: { async check() { trace.push('permission'); return { allowed: true }; } },
    ...extra,
  };
  return {
    options, trace, executor: createToolExecutor(options),
    request: (calls, extra = {}) => ({
      scope, calls, signal: new AbortController().signal,
      async beforeExecute(identity) { trace.push(`record:${identity.toolCallId}`); },
      async afterExecute(receipt) { trace.push(`settled:${receipt.identity.toolCallId}`); },
      ...extra,
    }),
  };
}

test('tool executor freezes registry, injects environment and pairs sequential settlements', async () => {
  const f = fixture();
  f.options.tools[0].definition.name = 'changed';
  f.options.tools[0].execute = async () => assert.fail('mutable registry escaped');
  assert.equal(f.executor.definitions[0].name, 'effect');
  assert.ok(Object.isFrozen(f.executor.definitions[0].inputSchema));
  const result = await f.executor.executeBatch(f.request([call('a'), call('b')]));
  assert.equal(result.stopped, null);
  assert.deepEqual(result.results.map(r => [r.identity, r.status, r.started, r.outcome, r.cleanup]), [
    [{ ...scope, toolCallId: 'a', name: 'effect' }, 'succeeded', true, success, { status: 'released' }],
    [{ ...scope, toolCallId: 'b', name: 'effect' }, 'succeeded', true, success, { status: 'released' }],
  ]);
  assert.deepEqual(f.trace, [
    'acquire', 'record:a', 'permission', 'execute:a:controlled', 'release', 'settled:a',
    'acquire', 'record:b', 'permission', 'execute:b:controlled', 'release', 'settled:b',
  ]);
  assert.ok(Object.isFrozen(result.results[0].outcome));
  assert.throws(() => createToolExecutor({ ...f.options, tools: [tool(() => {}), tool(() => {})] }), /unique/);
  assert.throws(() => createToolExecutor({ ...f.options, permission: undefined }), /permission/i);
  assert.throws(() => createToolExecutor({ ...f.options, environment: undefined }), /environment/i);
  assert.throws(() => createToolExecutor({ ...f.options, tools: [{
    ...tool(() => {}), definition: { name: '', description: '', inputSchema: {} },
  }] }), /declaration/i);
});

test('batch admission and argument validation cause no tool effects; permission denies before execution', async () => {
  const f = fixture({ tools: [tool(() => assert.fail('must not execute'), args =>
    args.reject ? { code: 'invalid_arguments', message: 'bad args', effect: 'none' } : null)],
  permission: { async check() { return { allowed: false, reason: 'not granted' }; } } });
  for (const calls of [[call('x'), call('x')], [call('x', 'effect', NaN)],
    [call('x', 'effect', 'x'.repeat(65537))], [call('x'.repeat(1025))],
    [call('x', 'x'.repeat(1025))]]) {
    await assert.rejects(() => f.executor.executeBatch(f.request(calls)), /batch/i);
  }
  assert.deepEqual(f.trace, []);
  const result = await f.executor.executeBatch(f.request([
    call('a', 'missing'), call('b', 'effect', { reject: true }), call('c'),
  ]));
  assert.deepEqual(result.results.map(r => r.outcome.error.code),
    ['unknown_tool', 'invalid_arguments', 'permission_denied']);
  assert.ok(result.results.every(r => r.status === 'not_executed' && !r.started));
  assert.deepEqual(f.trace, ['settled:a', 'settled:b', 'acquire', 'record:c', 'release', 'settled:c']);
  assert.equal(result.stopped, null);
});

test('cancel settles actual started effects, releases resources, and prevents the next call', async () => {
  const abort = new AbortController();
  const f = fixture({ tools: [tool(async () => { abort.abort(); return success; })] });
  const result = await f.executor.executeBatch(f.request([call('a'), call('b')], { signal: abort.signal }));
  assert.equal(result.results[0].status, 'succeeded');
  assert.deepEqual(result.results[0].outcome, success);
  assert.equal(result.results[0].cancellationRequested, true);
  assert.equal(result.results[1].status, 'not_executed');
  assert.equal(result.results[1].outcome.error.code, 'cancelled_before_start');
  assert.equal(result.stopped, 'cancelled');
  assert.deepEqual(f.trace, ['acquire', 'record:a', 'permission', 'release', 'settled:a', 'settled:b']);

  const cancelled = fixture({ tools: [tool(async () => ({
    ok: false, error: { code: 'cancelled', message: 'no write', effect: 'none' },
  }))] });
  assert.equal((await cancelled.executor.executeBatch(cancelled.request([call('x')]))).results[0].status, 'cancelled');

  const permissionAbort = new AbortController();
  const denied = fixture({
    tools: [tool(async () => assert.fail('cancelled before invocation'))],
    permission: { async check() { permissionAbort.abort(); return { allowed: true }; } },
  });
  const beforeStart = await denied.executor.executeBatch(denied.request([call('a')], {
    signal: permissionAbort.signal,
  }));
  assert.equal(beforeStart.results[0].started, false);
  assert.equal(beforeStart.results[0].cleanup.status, 'released');
  assert.equal(beforeStart.stopped, 'cancelled');
});

test('unknown effects and malformed or oversized results stop once without replay', async () => {
  for (const execute of [
    async () => { throw new Error('unconfirmed write'); },
    async () => ({ ok: true, content: 'x'.repeat(512 * 1024) }),
    async () => ({ ok: false, error: { code: 'uncertain', message: '', effect: 'unknown' } }),
    async () => undefined,
  ]) {
    let attempts = 0;
    const f = fixture({ tools: [tool(async (...args) => { attempts++; return execute(...args); })] });
    const result = await f.executor.executeBatch(f.request([call('a'), call('b')]));
    assert.equal(attempts, 1);
    assert.equal(result.stopped, 'unknown_effect');
    assert.equal(result.results[0].status, 'unknown');
    assert.equal(result.results[0].outcome.error.effect, 'unknown');
    assert.equal(result.results[0].cleanup.status, 'released');
    assert.equal(result.results[1].started, false);
    assert.equal(result.results[1].outcome.error.code, 'not_started');
  }
});

test('capability failures stop effects; cleanup failure preserves confirmed success and exact identity', async () => {
  for (const boundary of ['environment', 'permission', 'record']) {
    const options = { tools: [tool(async () => assert.fail('must not execute'))] };
    if (boundary === 'environment') options.environment = { async acquire() { throw new Error('offline'); } };
    if (boundary === 'permission') options.permission = { async check() { throw new Error('offline'); } };
    const f = fixture(options);
    const result = await f.executor.executeBatch(f.request([call('a'), call('b')],
      boundary === 'record' ? { async beforeExecute() { throw new Error('storage offline'); } } : {}));
    assert.ok(result.results.every(r => !r.started));
    assert.equal(result.stopped, 'capability_failed');
    assert.equal(result.results[0].outcome.error.effect, 'none');
    assert.equal(result.results[0].cleanup.status, boundary === 'environment' ? 'acquire_failed' : 'released');
    assert.equal(result.results[1].outcome.error.code, 'not_started');
  }
  let closes = 0;
  const f = fixture({ tools: [tool(async () => success)], environment: { async acquire() {
    return { value: {}, async release() { closes++; throw new Error('still open'); } };
  } } });
  const result = await f.executor.executeBatch(f.request([call('a'), call('b')]));
  assert.equal(closes, 1);
  assert.deepEqual(result.results[0].outcome, success);
  assert.equal(result.results[0].status, 'succeeded');
  assert.equal(result.results[0].cleanup.status, 'failed');
  assert.equal(result.results[0].identity.toolCallId, 'a');
  assert.equal(result.results[1].started, false);
  assert.equal(result.stopped, 'cleanup_failed');
});

test('required result recording gates the next effect; final permission observes changes during intent recording', async () => {
  let allowed = true;
  const denied = fixture({
    tools: [tool(async () => assert.fail('revoked permission'))],
    permission: { async check() { return allowed ? { allowed: true } : { allowed: false, reason: 'revoked' }; } },
  });
  const deniedResult = await denied.executor.executeBatch(denied.request([call('a')], {
    async beforeExecute() { allowed = false; },
  }));
  assert.equal(deniedResult.results[0].outcome.error.code, 'permission_denied');
  assert.equal(deniedResult.results[0].cleanup.status, 'released');

  const f = fixture();
  let writes = 0;
  const result = await f.executor.executeBatch(f.request([call('a'), call('b')], {
    async afterExecute(receipt) {
      writes++;
      assert.equal(receipt.status, 'succeeded');
      assert.equal(receipt.cleanup.status, 'released');
      throw new Error('write may have committed');
    },
  }));
  assert.equal(writes, 1);
  assert.equal(result.recordingError.identity.toolCallId, 'a');
  assert.deepEqual(result.results[0].outcome, success);
  assert.equal(result.results[1].started, false);
  assert.equal(result.stopped, 'capability_failed');
  assert.deepEqual(f.trace, ['acquire', 'record:a', 'permission', 'execute:a:controlled', 'release']);
});
