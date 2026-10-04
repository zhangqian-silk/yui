import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as api from '../../dist/nativeAgent/index.js';

const scope = { sessionId: 'local', turnId: 'turn', step: 1 };
const call = (id, name, args) => ({ id, name, arguments: args });
const request = calls => ({
  scope, calls, signal: new AbortController().signal,
  async beforeExecute() {}, async afterExecute() {},
});
const executor = binding => api.createToolExecutor(binding);
async function fixture(t) {
  const root = await mkdtemp(path.join(realpathSync(tmpdir()), 'native-local-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'input.txt'), 'fixture-secret');
  return { root, cwd: root };
}

test('provider → Agent → local ToolManager accepts reordered ToolCall fields', async t => {
  const options = await fixture(t);
  const binding = api.createLocalToolBinding(options);
  const calls = [
    { id: 'id-first', name: 'read', arguments: { path: 'input.txt' } },
    { name: 'read', arguments: { path: 'input.txt' }, id: 'name-first' },
    { arguments: { path: 'input.txt' }, id: 'arguments-first', name: 'read' },
  ];
  let requests = 0;
  const result = await api.createAgent({
    toolExecutor: executor(binding),
    provider: { async complete() {
      return ++requests === 1
        ? { kind: 'tool_calls', content: '', calls }
        : { kind: 'final', content: 'Read results received' };
    } },
  }).runTurn({ sessionId: 'field-order', turnId: 'read', input: 'Read input', maxSteps: 2 });
  assert.equal(result.reason, 'completed');
  const messages = result.messages.filter(message => message.role === 'tool');
  assert.deepEqual(messages.map(message => message.outcome.ok), [true, true, true]);
  assert.ok(messages.every(message => JSON.parse(message.outcome.content).text === 'fixture-secret'));
  const recordedCalls = result.messages.find(message => message.role === 'assistant' && message.toolCalls).toolCalls;
  assert.deepEqual(recordedCalls.map(call => Object.keys(call)), calls.map(call => Object.keys(call)));
});

test('local binding defaults to real reads; switches are independent and leases cannot be forged or mixed', async t => {
  const options = await fixture(t);
  const binding = api.createLocalToolBinding(options);
  const result = await executor(binding).executeBatch(request([
    call('read', 'read', { path: 'input.txt' }),
    call('write', 'write', { path: 'output.txt', content: 'forbidden' }),
    call('command', 'command', { command: realpathSync(process.execPath), argv: [], cwd: options.cwd }),
  ]));
  assert.equal(result.results[0].outcome.ok, true);
  assert.deepEqual(result.results.slice(1).map(r => r.outcome.error.code), ['unknown_tool', 'unknown_tool']);
  await assert.rejects(readFile(path.join(options.root, 'output.txt')), { code: 'ENOENT' });
  const writable = api.createLocalToolBinding({ ...options, allowWrite: true });
  assert.equal(writable.tools.some(t => t.definition.name === 'command'), false);
  const mixed = api.createToolExecutor({ tools: writable.tools, environment: binding.environment, permission: writable.permission });
  assert.equal((await mixed.executeBatch(request([call('x', 'write', { path: 'output.txt', content: 'no' })])))
    .results[0].outcome.error.code, 'environment_failed');
  const write = writable.tools.find(t => t.definition.name === 'write');
  const forged = await write.execute({ path: 'output.txt', content: 'no' },
    { ...scope, toolCallId: 'direct' }, new AbortController().signal, { ...writable.binding });
  assert.equal(forged.error.effect, 'none');
  const readCall = call('cross', 'read', { path: 'input.txt' });
  const crossBinding = api.createToolExecutor({
    tools: writable.tools, environment: binding.environment, permission: { async check() { return { allowed: true }; } },
  });
  assert.equal((await crossBinding.executeBatch(request([readCall]))).results[0].outcome.error.code, 'binding_mismatch');
  const invocation = {
    identity: { ...scope, toolCallId: 'lease', name: 'write' },
    call: call('lease', 'write', { path: 'expired.txt', content: 'no' }),
    definition: write.definition,
  };
  const lease = await writable.environment.acquire(invocation, new AbortController().signal);
  await lease.release();
  assert.equal((await write.execute(invocation.call.arguments, invocation.identity,
    new AbortController().signal, lease.value)).error.code, 'binding_mismatch');
  // Reordered contract fields/JSON members are equal, but changed values are not.
  const liveInvocation = {
    definition: {
      inputSchema: { ...write.definition.inputSchema,
        properties: Object.fromEntries(Object.entries(write.definition.inputSchema.properties).reverse()) },
      description: write.definition.description, name: write.definition.name,
    },
    call: { name: 'write', arguments: { content: 'live', path: 'live.txt' }, id: 'live' },
    identity: { name: 'write', toolCallId: 'live', step: 1, turnId: 'turn', sessionId: 'local' },
  };
  const signal = new AbortController().signal;
  const liveLease = await writable.environment.acquire(liveInvocation, signal);
  try {
    assert.equal((await writable.permission.check(liveInvocation, liveLease.value, signal)).allowed, true);
    for (const changedIdentity of [
      { sessionId: 'other' }, { turnId: 'other' }, { step: 2 }, { toolCallId: 'other' },
    ]) {
      const outcome = await write.execute(liveInvocation.call.arguments,
        { ...liveInvocation.identity, ...changedIdentity }, signal, liveLease.value);
      assert.equal(outcome.error.code, 'binding_mismatch');
    }
    liveInvocation.call.arguments.content = 'changed';
    assert.equal((await writable.permission.check(liveInvocation, liveLease.value, signal)).allowed, false);
    assert.equal((await write.execute(liveInvocation.call.arguments, liveInvocation.identity,
      signal, liveLease.value)).error.code, 'binding_mismatch');
    liveInvocation.call.arguments.content = 'live';
    assert.equal((await writable.permission.check({
      ...liveInvocation, definition: { ...liveInvocation.definition, description: 'changed' },
    }, liveLease.value, signal)).allowed, false);
    await assert.rejects(readFile(path.join(options.root, 'live.txt')), { code: 'ENOENT' });
    const written = await write.execute({ path: 'live.txt', content: 'live' },
      { ...scope, toolCallId: 'live' }, signal, liveLease.value);
    assert.equal(written.ok, true);
    assert.equal(await readFile(path.join(options.root, 'live.txt'), 'utf8'), 'live');
  } finally { await liveLease.release(); }
  const allowed = await executor(writable).executeBatch(request([call('yes', 'write', { path: 'output.txt', content: 'yes' })]));
  assert.equal(allowed.results[0].outcome.ok, true);
  assert.equal(await readFile(path.join(options.root, 'output.txt'), 'utf8'), 'yes');
});

test('real local writes keep intent/result/cleanup barriers and confirmed success on failure or cancellation', async t => {
  const options = await fixture(t);
  for (const boundary of ['before', 'after', 'release', 'cancel']) {
    const binding = api.createLocalToolBinding({ ...options, allowWrite: true });
    const abort = new AbortController();
    const managed = api.createToolExecutor({
      ...binding,
      environment: { async acquire(...args) {
        const lease = await binding.environment.acquire(...args);
        return { value: lease.value, async release() {
          await lease.release();
          if (boundary === 'release') throw Error('injected release failure');
          if (boundary === 'cancel') abort.abort();
        } };
      } },
    });
    const receipts = [];
    const result = await managed.executeBatch({
      ...request([
        call('first', 'write', { path: `${boundary}.txt`, content: boundary }),
        call('next', 'write', { path: `${boundary}-next.txt`, content: 'never' }),
      ]),
      signal: abort.signal,
      async beforeExecute() { if (boundary === 'before') throw Error('intent failure'); },
      async afterExecute(receipt) {
        receipts.push(receipt);
        if (boundary === 'after') throw Error('result failure');
      },
    });
    assert.equal(result.results[1].started, false);
    await assert.rejects(readFile(path.join(options.root, `${boundary}-next.txt`)), { code: 'ENOENT' });
    if (boundary === 'before') {
      assert.equal(result.results[0].outcome.error.effect, 'none');
      await assert.rejects(readFile(path.join(options.root, `${boundary}.txt`)), { code: 'ENOENT' });
    } else {
      assert.equal(result.results[0].outcome.ok, true);
      assert.equal(await readFile(path.join(options.root, `${boundary}.txt`), 'utf8'), boundary);
    }
    if (boundary === 'after') {
      assert.equal(result.recordingError.code, 'result_record_failed');
      assert.equal(receipts.length, 1);
    }
    if (boundary === 'release') {
      assert.equal(result.stopped, 'cleanup_failed');
      assert.equal(result.results[0].cleanup.status, 'failed');
    }
    if (boundary === 'cancel') assert.equal(result.stopped, 'cancelled');
  }
});

test('local commands require exact reviewed argv/cwd and deliberate env; read commands do not need write', async t => {
  const options = await fixture(t);
  const command = realpathSync(process.execPath);
  const argv = ['-e', 'console.log(JSON.stringify(process.env)); console.log("fixture-secret")'];
  const binding = api.createLocalToolBinding({
    ...options, allowCommand: true, redact: ['fixture-secret'],
    command: { env: { LANG: 'C' }, specs: [{ executable: command, argv, effect: 'read' }] },
  });
  assert.equal(binding.tools.some(t => t.definition.name === 'write'), false);
  const results = (await executor(binding).executeBatch(request([
    call('bad', 'command', { command, argv: ['-e', 'require("fs").writeFileSync("bad","bad")'], cwd: options.cwd }),
    call('ok', 'command', { command, argv, cwd: options.cwd }),
  ]))).results;
  assert.equal(results[0].outcome.error.effect, 'none');
  assert.equal(results[1].outcome.ok, true);
  const evidence = JSON.parse(results[1].outcome.content);
  const [envText, secretText] = evidence.stdout.trim().split('\n');
  const env = JSON.parse(envText);
  if (process.platform === 'darwin') delete env.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(env, { LANG: 'C' });
  assert.equal(secretText, '[REDACTED]');
  assert.equal(JSON.stringify(binding.binding).includes('fixture-secret'), false);
  await assert.rejects(readFile(path.join(options.root, 'bad')), { code: 'ENOENT' });
  const writeArgv = ['-e', 'require("fs").writeFileSync("command.txt","reviewed")'];
  const writeOptions = {
    ...options, allowCommand: true,
    command: { env: {}, specs: [{ executable: command, argv: writeArgv, effect: 'write' }] },
  };
  const writeCommand = api.createLocalToolBinding(writeOptions);
  assert.equal((await executor(writeCommand).executeBatch(request([
    call('no', 'command', { command, argv: writeArgv, cwd: options.cwd }),
  ]))).results[0].outcome.error.effect, 'none');
  await assert.rejects(readFile(path.join(options.root, 'command.txt')), { code: 'ENOENT' });
  const enabledWriteCommand = api.createLocalToolBinding({ ...writeOptions, allowWrite: true });
  assert.equal((await executor(enabledWriteCommand).executeBatch(request([
    call('yes', 'command', { command, argv: writeArgv, cwd: options.cwd }),
  ]))).results[0].outcome.ok, true);
  assert.equal(await readFile(path.join(options.root, 'command.txt'), 'utf8'), 'reviewed');
  assert.throws(() => api.createLocalToolBinding({
    ...options, allowCommand: true, command: { env: { NODE_OPTIONS: 'secret' }, specs: [] },
  }), /environment/i);
});

test('local binding rejects invalid declarations, paths, symlinks and stale restored directories before effects', async t => {
  const options = await fixture(t);
  assert.throws(() => api.createLocalToolBinding({ ...options, allowWrite: 'true' }), /configuration/i);
  await symlink(options.root, path.join(options.root, 'link'));
  assert.throws(() => api.createLocalToolBinding({ root: path.join(options.root, 'link'), cwd: options.root }), /directory/i);
  const binding = api.createLocalToolBinding({ ...options, allowWrite: true });
  for (const args of [{ path: '../escape', content: 'no' }, { path: 'link/escape', content: 'no' },
    { path: 'output', content: 'no', extra: true }]) {
    const result = await executor(binding).executeBatch(request([call('bad', 'write', args)]));
    assert.equal(result.results[0].outcome.error.effect, 'none');
  }
  const tool = binding.tools[0];
  await assert.rejects(binding.environment.acquire({
    identity: { ...scope, toolCallId: 'fake', name: tool.definition.name },
    call: call('fake', tool.definition.name, { path: 'input.txt' }),
    definition: { ...tool.definition, description: 'forged' },
  }, new AbortController().signal));
  await rm(options.root, { recursive: true });
  await symlink(tmpdir(), options.root);
  const stale = await executor(binding).executeBatch(request([call('stale', 'write', { path: 'output', content: 'no' })]));
  assert.equal(stale.results[0].started, false);
  assert.equal(stale.results[0].outcome.error.effect, 'none');
  assert.throws(() => api.createLocalToolBinding(options), /directory/i);
});
