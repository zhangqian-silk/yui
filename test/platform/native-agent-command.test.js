import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createAgent } from '../../dist/nativeAgent/index.js';
import { createCommandTool } from '../../dist/nativeAgent/commandTool.js';

const scope = { sessionId: 'command-test', turnId: 'turn', step: 1, toolCallId: 'call' };
function absent(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}
async function waitAbsent(pid) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (absent(pid)) return;
    await pause(10);
  }
  assert.fail(`Owned process identity remains after cleanup: ${pid}`);
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'native-command-'));
  const controllers = [];
  const pending = [];
  const ownedGroups = new Set();
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(pending);
    // Backstop every assertion/error path using only pids returned by this
    // fixture's detached children, never another test's process namespace.
    for (const pid of ownedGroups) {
      try { process.kill(-pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await waitAbsent(-pid);
    }
    await rm(root, { recursive: true, force: true });
  });
  const tool = createCommandTool({ root, env: {}, timeoutMs: 1500, killGraceMs: 25, ...options });
  function invoke(args, controller = new AbortController()) {
    controllers.push(controller);
    const result = tool.execute(args, scope, controller.signal).then(outcome => {
      const text = outcome.ok ? outcome.content : outcome.error.message;
      if (text.startsWith('{')) {
        const evidence = JSON.parse(text);
        if (evidence.pid && evidence.processGroup !== 'absent') ownedGroups.add(evidence.pid);
      }
      return outcome;
    });
    pending.push(result);
    return result;
  }
  const command = code => ({ command: process.execPath, argv: ['-e', code], cwd: root });
  return { root, tool, invoke, command };
}

test('command: explicit argv/environment, real exit status and execution-boundary validation', async t => {
  const sentinel = 'NATIVE_COMMAND_PARENT_SENTINEL';
  const previous = process.env[sentinel];
  t.after(() => {
    if (previous === undefined) delete process.env[sentinel];
    else process.env[sentinel] = previous;
  });
  process.env[sentinel] = 'must-not-inherit';
  const { root, invoke, command } = await fixture(t, { env: { VISIBLE: 'chosen' } });
  const result = await invoke(command(`console.log(JSON.stringify({cwd:process.cwd(),env:process.env,args:process.argv.slice(1)})); process.exitCode=7;`));
  assert.equal(result.ok, true);
  const output = JSON.parse(result.content);
  assert.equal(output.exitCode, 7);
  assert.equal(output.signal, null);
  const observed = JSON.parse(output.stdout);
  assert.equal(Object.hasOwn(observed.env, sentinel), false);
  // The macOS Node fixture may add this platform field after launch.
  // Ignore only that field there; every other unexpected variable still fails.
  if (process.platform === 'darwin') delete observed.env.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(observed, { cwd: root, env: { VISIBLE: 'chosen' }, args: [] });
  for (const args of [
    { ...command(''), shell: true },
    { ...command(''), command: 'node' },
    { ...command(''), cwd: path.dirname(root) },
    { ...command(''), argv: ['bad\0arg'] },
  ]) {
    const failed = await invoke(args);
    assert.equal(failed.ok, false);
    assert.equal(failed.error.effect, 'none');
  }
  const controller = new AbortController();
  controller.abort();
  assert.equal((await invoke(command('throw Error("must not run")'), controller)).error.effect, 'none');
  const missing = await invoke({ ...command(''), command: path.join(root, 'missing') });
  assert.equal(missing.error.effect, 'none');
  const signalled = await invoke(command('process.kill(process.pid, "SIGTERM")'));
  assert.equal(signalled.ok, true);
  assert.equal(JSON.parse(signalled.content).exitCode, null);
  assert.equal(JSON.parse(signalled.content).signal, 'SIGTERM');
  assert.equal(JSON.parse(signalled.content).processGroup, 'absent');
});

test('command: cwd symlink outside explicit root is rejected', async t => {
  const { root, invoke, command } = await fixture(t);
  await symlink(path.dirname(root), path.join(root, 'outside'));
  const result = await invoke({ ...command(''), cwd: path.join(root, 'outside') });
  assert.equal(result.error.code, 'path_out_of_scope');
  assert.equal(result.error.effect, 'none');
});

test('command: bounded output retains evidence and stops the owned process', async t => {
  const { invoke, command } = await fixture(t, { maxOutputBytes: 32 });
  const result = await invoke(command('process.stdout.write("x".repeat(10000)); setInterval(()=>{}, 1000);'));
  assert.equal(result.error.code, 'output_limit');
  assert.equal(result.error.effect, 'unknown');
  const evidence = JSON.parse(result.error.message);
  assert.equal(evidence.stdout.length, 32);
  assert.equal(evidence.outputTruncated, true);
  assert.equal(evidence.directChildExited, true);
  assert.equal(evidence.processGroup, 'absent');
  assert.equal(evidence.descendantsMayHaveEscaped, true);
});

test('command: timeout and cancellation settle with explicit uncertain effects', async t => {
  const { invoke, command } = await fixture(t, { timeoutMs: 120 });
  const timeout = await invoke(command('setInterval(()=>{}, 1000)'));
  assert.equal(timeout.error.code, 'timeout');
  assert.equal(JSON.parse(timeout.error.message).directChildExited, true);
  assert.equal(JSON.parse(timeout.error.message).processGroup, 'absent');
  const controller = new AbortController();
  const pending = invoke(command('setInterval(()=>{}, 1000)'), controller);
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    const cancelled = await pending;
    assert.equal(cancelled.error.code, 'cancelled');
    assert.equal(cancelled.error.effect, 'unknown');
    assert.equal(JSON.parse(cancelled.error.message).directChildExited, true);
    assert.equal(JSON.parse(cancelled.error.message).processGroup, 'absent');
  } finally { clearTimeout(timer); }
});

test('command: leader exit does not falsely prove background descendants stopped', async t => {
  const { invoke, command } = await fixture(t);
  const result = await invoke(command(`
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
    console.log(child.pid);
    child.unref();
  `));
  assert.equal(result.error.code, 'background_processes');
  const evidence = JSON.parse(result.error.message);
  assert.equal(evidence.directChildExited, true);
  assert.equal(evidence.descendantsMayHaveEscaped, true);
  await waitAbsent(Number(evidence.stdout.trim()));
  await waitAbsent(-evidence.pid);
});

test('command: worst-case escaped output remains valid through the public Agent contract', async t => {
  const { tool, invoke, command } = await fixture(t);
  const args = { ...command('require("node:fs").writeSync(1, Buffer.alloc(65536, 1))') };
  args.argv.push('--', '"'.repeat(7000));
  const rejected = { ...args, argv: [...args.argv.slice(0, -1), '"'.repeat(28000)] };
  assert.equal(tool.validate(rejected)?.code, 'invalid_arguments');
  const agent = createAgent({
    tools: [{ ...tool, execute: args => invoke(args) }],
    provider: { async complete(request) {
      return request.step === 1
        ? { kind: 'tool_calls', content: '', calls: [{ id: 'size-bound', name: 'command', arguments: args }] }
        : { kind: 'final', content: 'observed' };
    } },
  });
  const result = await agent.runTurn({ sessionId: 'size-test', turnId: 'turn', input: 'run', maxSteps: 2 });
  assert.equal(result.reason, 'completed');
  const outcome = result.messages.find(message => message.role === 'tool').outcome;
  assert.equal(outcome.ok, true);
  assert.equal(JSON.parse(outcome.content).capturedBytes, 65536);
  assert.equal(JSON.parse(outcome.content).stdout, '\u0001'.repeat(65536));
  assert.ok(Buffer.byteLength(JSON.stringify(outcome)) < 512 * 1024);
});
