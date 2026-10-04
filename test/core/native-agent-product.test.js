import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import test from 'node:test';
import { createSessionStore, createSqliteSessionBackend } from '../../dist/nativeAgent/index.js';

const launcher = resolve('output/dev/bin/yui');
const secret = 'dummy-product-secret-never-persist';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-product-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: tmpdir(),
    YUI_HOME: join(root, 'unused-control-home'), AGENT_TEST_TOKEN: secret };
  return { root, env };
}
function cli(args, env, input, t, onStart, prefix = []) {
  const child = spawn(launcher, [...prefix, 'agent', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const done = new Promise((done, reject) => {
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', code => done({ code, stdout, stderr }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await done;
  });
  onStart?.(child);
  child.stdin.end(input);
  return done;
}

test('product config fails safely before control Home or product state initialization', async t => {
  const { root, env } = await fixture(t);
  const result = await cli(['check-config', '--endpoint', `https://user:${secret}@bad.invalid/chat`], env, undefined, t);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /agent_config/);
  assert.ok(!result.stderr.includes(secret));
  await assert.rejects(access(env.YUI_HOME));
  await assert.rejects(access(join(root, 'state')));
  const help = await cli(['--help'], env, undefined, t);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /check-config/);
  const jsonHelp = await cli(['--help'], env, undefined, t, undefined, ['--json']);
  assert.equal(jsonHelp.code, 0, jsonHelp.stderr);
  assert.match(JSON.parse(jsonHelp.stdout).help, /check-config/);
  await assert.rejects(access(env.YUI_HOME));
});

test('product cancellation drains a real model body and preserves a verifiable terminal', { timeout: 5000 }, async t => {
  const { root, env } = await fixture(t);
  let cancel = () => {};
  const server = createServer(async (request, response) => {
    for await (const _part of request) { /* Consume only this dummy request. */ }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"choices":');
    cancel();
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const state = join(root, 'state');
  const result = await cli(['run', '--allow-http',
    '--endpoint', `http://127.0.0.1:${server.address().port}/chat`, '--model', 'offline',
    '--credential-ref', 'env:AGENT_TEST_TOKEN', '--cwd', root, '--state-dir', state, '--input', 'Wait'],
  env, undefined, t, child => { cancel = () => child.kill('SIGINT'); });
  assert.equal(result.code, 130, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.result.reason, 'cancelled');
  const store = createSessionStore(createSqliteSessionBackend(join(state, 'sessions.sqlite')));
  try {
    const saved = await store.load(evidence.receipt.sessionId);
    assert.equal(saved.digest, evidence.receipt.digest);
    assert.equal(saved.recovery.disposition, 'ready');
    assert.equal(saved.document.events.at(-1).data.reason, 'cancelled');
  } finally { await store.close(); }
  await assert.rejects(access(env.YUI_HOME));
});

test('real product entry reads, explicitly edits/checks, saves and resumes exact SQLite session', { timeout: 15000 }, async t => {
  const { root, env } = await fixture(t);
  await writeFile(join(root, 'input.txt'), 'before\n');
  const executable = realpathSync(process.execPath);
  const argv = ['-e',
    'const fs=require("node:fs");if(fs.readFileSync("input.txt","utf8")!=="after\\n"||process.env.AGENT_TEST_TOKEN)process.exit(1);console.log("checked");'];
  const reviewed = JSON.stringify({ env: {}, specs: [{ executable, argv, effect: 'read' }] });
  let mode = 'read', calls = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const request = JSON.parse(body);
    requests.push(request);
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    const call = (id, name, args) => ({ id, type: 'function',
      function: { name, arguments: JSON.stringify(args) } });
    let tool_calls, content = 'Saved response';
    if (mode === 'read' && calls++ === 0) tool_calls = [call('r', 'read', { path: 'input.txt' })];
    if (mode === 'denied') tool_calls = [call('denied', 'write', { path: 'forbidden.txt', content: 'must not happen' })];
    if (mode === 'edit' && calls++ === 0) {
      const read = request.messages.find(m => m.role === 'tool');
      const fingerprint = JSON.parse(JSON.parse(read.content).content).sha256;
      tool_calls = [call('e', 'edit', { path: 'input.txt', expectedSha256: fingerprint, oldText: 'before', newText: 'after' })];
    } else if (mode === 'edit' && calls === 2) tool_calls = [call('c', 'command', {
      command: executable, cwd: root, argv })];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content,
      ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }] }));
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const args = ['--allow-http', '--endpoint', `http://127.0.0.1:${server.address().port}/chat`, '--model', 'offline',
    '--credential-ref', 'env:AGENT_TEST_TOKEN', '--cwd', root, '--state-dir', join(root, 'state')];
  const first = await cli(['run', ...args, '--input', 'Read input'], env, undefined, t);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const saved = JSON.parse(first.stdout);
  assert.equal(saved.receipt.source.durability, 'persistent');
  assert.equal(saved.result.reason, 'completed');
  assert.deepEqual(requests[0].tools.map(t => t.function.name), ['read', 'list', 'find', 'search']);
  mode = 'edit'; calls = 0;
  const second = await cli(['run', ...args, '--session', saved.receipt.sessionId,
    '--tools', 'read,edit,command', '--allow-write', '--allow-command', '--command-config', reviewed,
    '--input', 'Edit and check'], env, undefined, t);
  assert.equal(second.code, 0, second.stderr);
  const continued = JSON.parse(second.stdout);
  assert.equal(continued.receipt.sessionId, saved.receipt.sessionId);
  assert.ok(continued.receipt.revision > saved.receipt.revision);
  assert.equal(await readFile(join(root, 'input.txt'), 'utf8'), 'after\n');
  const command = continued.result.messages.find(m => m.role === 'tool' && m.name === 'command');
  assert.equal(JSON.parse(command.outcome.content).exitCode, 0);
  assert.equal(continued.binding.root, root);
  assert.equal(continued.binding.cwd, root);
  assert.equal(continued.binding.commandCount, 1);
  assert.ok(!JSON.stringify(continued.configuration).includes(argv[1]));
  assert.ok(!first.stdout.includes(secret) && !second.stdout.includes(secret));
  assert.ok(!(await readFile(join(root, 'state', 'sessions.sqlite'))).includes(Buffer.from(secret)));
  mode = 'denied';
  const denied = await cli(['run', ...args, '--session', saved.receipt.sessionId,
    '--input', 'Attempt an unselected write'], env, undefined, t);
  assert.equal(denied.code, 1);
  assert.equal(JSON.parse(denied.stdout).result.reason, 'error');
  assert.ok(!requests.at(-1).tools.some(tool => ['write', 'edit', 'command'].includes(tool.function.name)));
  await assert.rejects(access(join(root, 'forbidden.txt')));
  await assert.rejects(access(env.YUI_HOME));
});

test('product exact command authority is rebuilt on reopen, never recovered from history', { timeout: 10000 }, async t => {
  const { root, env } = await fixture(t);
  const executable = realpathSync(process.execPath);
  await writeFile(join(root, 'secret.txt'), secret);
  const argv = ['-e', 'const fs=require("node:fs");fs.writeFileSync("reviewed.txt","yes");console.log(JSON.stringify(process.env));console.log(fs.readFileSync("secret.txt","utf8"))'];
  const policy = { env: { LANG: 'C' }, specs: [{ executable, argv, effect: 'write' }] };
  let actual = argv, requests = 0, runId = 0;
  let declared = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    declared = JSON.parse(body).tools.map(tool => tool.function.name);
    const tool_calls = requests++ % 2 === 0 ? [{ id: `c-${runId}-${requests}`, type: 'function',
      function: { name: 'command', arguments: JSON.stringify({ command: executable, argv: actual, cwd: root }) } }] : undefined;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Inspect actual outcome',
      ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }] }));
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const args = ['--allow-http', '--endpoint', `http://127.0.0.1:${server.address().port}/chat`, '--model', 'offline',
    '--credential-ref', 'env:AGENT_TEST_TOKEN', '--cwd', root, '--state-dir', join(root, 'state')];
  const authorized = ['--tools', 'command', '--allow-command', '--command-config', JSON.stringify(policy)];
  const run = async (extra = [], code = 0) => {
    requests = 0; runId++;
    const result = await cli(['run', ...args, ...extra, '--input', 'Use the selected reviewed command'], env, undefined, t);
    assert.equal(result.code, code, result.stderr || result.stdout);
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    return JSON.parse(result.stdout);
  };
  const deniedWrite = await run(authorized);
  assert.equal(deniedWrite.result.messages.find(m => m.role === 'tool').outcome.error.code, 'command_not_authorized');
  await assert.rejects(access(join(root, 'reviewed.txt')));
  const allowed = await run([...authorized, '--allow-write']);
  const id = allowed.receipt.sessionId;
  assert.equal(await readFile(join(root, 'reviewed.txt'), 'utf8'), 'yes');
  const outcome = JSON.parse(allowed.result.messages.find(m => m.role === 'tool').outcome.content);
  assert.equal(outcome.exitCode, 0);
  const [environmentLine, redactedLine] = outcome.stdout.trim().split('\n');
  const childEnv = JSON.parse(environmentLine);
  delete childEnv.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(childEnv, { LANG: 'C' });
  assert.equal(redactedLine, '[REDACTED]');
  await rm(join(root, 'reviewed.txt'));
  const reopened = await run(['--session', id], 1);
  assert.equal(reopened.result.reason, 'error');
  assert.ok(!declared.includes('command'));
  assert.equal(reopened.binding.allowCommand, false);
  assert.equal(reopened.binding.allowWrite, false);
  await assert.rejects(access(join(root, 'reviewed.txt')));
  actual = [...argv, 'unreviewed-extra'];
  const changed = await run([...authorized, '--allow-write', '--session', id]);
  assert.equal(changed.result.messages.find(m => m.role === 'tool').outcome.error.code, 'command_not_authorized');
  await assert.rejects(access(join(root, 'reviewed.txt')));
  const store = createSessionStore(createSqliteSessionBackend(join(root, 'state', 'sessions.sqlite')));
  try {
    const saved = await store.load(id);
    assert.equal(saved.digest, changed.receipt.digest);
    assert.equal(saved.recovery.disposition, 'ready');
    assert.ok(saved.document.events.filter(e => e.data.settlement)
      .every(e => e.data.settlement.cleanup.status === 'released' || !e.data.settlement.started));
  } finally { await store.close(); }
  for (const badPolicy of [{ env: { HOME: root }, specs: policy.specs }, { env: {}, specs: [{ ...policy.specs[0], effect: 'guess' }] }]) {
    const bad = await cli(['check-config', ...args, '--tools', 'command', '--allow-command',
      '--command-config', JSON.stringify(badPolicy)], env, undefined, t);
    assert.equal(bad.code, 2, bad.stderr);
    assert.ok(!bad.stderr.includes(argv[1]));
  }
  await assert.rejects(access(env.YUI_HOME));
});

test('explicit config precedence, capability opt-ins and field bounds are data-only', async t => {
  const { root, env } = await fixture(t);
  const file = join(root, 'agent.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, endpoint: 'https://fixture.invalid/chat',
    model: 'file-model', credentialRef: 'env:AGENT_TEST_TOKEN', cwd: '.', stateDir: 'state',
    maxSteps: 3 }));
  const result = await cli(['check-config', '--config', file, '--model', 'cli-model'],
    { ...env, NATIVE_AGENT_MODEL: 'environment-model', NATIVE_AGENT_MAX_STEPS: '4' }, undefined, t);
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(result.stdout).configuration;
  assert.equal(config.model, 'cli-model');
  assert.equal(config.maxSteps, 4);
  assert.equal(config.sources.model, 'cli');
  assert.equal(config.sources.maxSteps, 'environment');
  assert.equal(config.cwd, root);
  assert.equal(config.stateDir, join(root, 'state'));
  for (const extra of [['--tools', 'write'], ['--tools', 'command'], ['--max-steps', '0'],
    ['--credential-ref', 'env:MISSING_TOKEN'], ['--endpoint', 'https://fixture.invalid/chat?key=secret']]) {
    const failed = await cli(['check-config', '--config', file, ...extra], env, undefined, t);
    assert.equal(failed.code, 2);
    assert.ok(!failed.stderr.includes(secret));
  }
  await assert.rejects(access(join(root, 'state')));
  await assert.rejects(access(env.YUI_HOME));
});
