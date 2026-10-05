import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const localLauncher = join(packageRoot, 'output/dev/bin/yui');
const directory = await mkdtemp(join(tmpdir(), 'native-agent-offline-'));
const secret = 'dummy-offline-example-token';
const executable = realpathSync(process.execPath);
// Trusted fixture code reviewed here, not arbitrary text supplied by the model.
const argv = ['-e',
  'const fs=require("node:fs");if(fs.readFileSync("input.txt","utf8")!=="after\\n"||process.env.EXAMPLE_CREDENTIAL)process.exit(1);console.log("local check passed");'];
const commandConfig = JSON.stringify({ env: {}, specs: [{ executable, argv, effect: 'read' }] });
let phase = 'read', step = 0, active;
let initialSkillBody = false, loadedSkillBody = false;
const server = createServer(async (request, response) => {
  let source = '';
  for await (const part of request) source += part;
  const input = JSON.parse(source);
  assert.equal(request.headers.authorization, `Bearer ${secret}`);
  const call = (id, name, args) => ({ id, type: 'function',
    function: { name, arguments: JSON.stringify(args) } });
  let calls;
  assert.equal(input.messages.filter(message => message.role === 'system').length, 1);
  if (phase === 'read' && step++ === 0) calls = [call('read-example', 'read', { path: 'input.txt' })];
  else if (phase === 'edit' && step++ === 0) {
    const previousRead = input.messages.find(message => message.role === 'tool');
    const sha256 = JSON.parse(JSON.parse(previousRead.content).content).sha256;
    calls = [call('edit-example', 'edit',
      { path: 'input.txt', expectedSha256: sha256, oldText: 'before', newText: 'after' })];
  } else if (phase === 'edit' && step === 2) calls = [call('check-example', 'command', {
    command: executable, cwd: directory, argv })];
  else if (phase === 'reopen' && step++ === 0) calls = [call('reopen-check', 'command', {
    command: executable, cwd: directory, argv })];
  else if (phase === 'skill') {
    const loaded = input.messages.some(message => message.content.includes('COMPLETE_OFFLINE_SKILL_BODY'));
    if (step++ === 0) {
      initialSkillBody = loaded;
      calls = [call('skill-example', 'project_context', {
        action: 'load_skill', locator: '.agents/skills/check/SKILL.md' })];
    } else loadedSkillBody = loaded;
    assert.ok(input.messages.filter(message => message.content.includes('COMPLETE_OFFLINE_SKILL_BODY'))
      .every(message => message.role === 'user'));
  } else if (['memory-denied', 'memory-write', 'memory-reopen'].includes(phase) && step++ === 0)
    calls = [call(phase, 'project_memory', {
      action: 'replace', expectedSha256: null, content: 'offline confirmed experience' })];
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Offline facts saved',
    ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }] }));
});
try {
  await writeFile(join(directory, 'input.txt'), 'before\n');
  await mkdir(join(directory, '.agents/skills/check'), { recursive: true });
  await writeFile(join(directory, '.agents/skills/check/SKILL.md'),
    '---\nname: check\ndescription: Offline check.\nallowed-tools: command\n---\nCOMPLETE_OFFLINE_SKILL_BODY');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const shared = ['--allow-http', '--endpoint', `http://127.0.0.1:${server.address().port}/chat`,
    '--model', 'offline-fixture', '--credential-ref', 'env:EXAMPLE_CREDENTIAL',
    '--cwd', directory, '--state-dir', join(directory, 'state')];
  const execute = (args, expectedCode = 0) => new Promise((resolve, reject) => {
    // Installed package uses its public bin; source checkout uses the required absolute local launcher.
    active = spawn(existsSync(localLauncher) ? localLauncher : process.execPath,
      [...(existsSync(localLauncher) ? [] : [join(packageRoot, 'dist/cli.js')]), 'agent', 'run', ...shared, ...args],
      { env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: tmpdir(),
        YUI_HOME: join(directory, 'unused-control-home'), EXAMPLE_CREDENTIAL: secret },
        stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    active.stdout.on('data', data => { output += data; });
    active.stderr.on('data', data => { error += data; });
    active.on('error', reject);
    active.on('close', code => {
      active = undefined;
      if (code !== expectedCode) reject(new Error(`Offline entry failed (${code}): ${error}`));
      else resolve(JSON.parse(output));
    });
  });
  const first = await execute(['--input', 'Read input.txt']);
  phase = 'edit'; step = 0;
  const second = await execute(['--session', first.receipt.sessionId,
    '--tools', 'read,edit,command', '--allow-write', '--allow-command', '--command-config', commandConfig,
    '--input', 'Edit and check']);
  assert.equal(await readFile(join(directory, 'input.txt'), 'utf8'), 'after\n');
  assert.equal(second.receipt.sessionId, first.receipt.sessionId);
  assert.equal(second.receipt.source.durability, 'persistent');
  const checked = second.result.messages.find(message => message.role === 'tool' && message.name === 'command');
  assert.equal(JSON.parse(checked.outcome.content).exitCode, 0);
  assert.equal(JSON.parse(checked.outcome.content).processGroup, 'absent');
  assert.ok(second.receipt.revision > first.receipt.revision);
  assert.ok(!JSON.stringify(second).includes(secret));
  assert.ok(!(await readFile(join(directory, 'state', 'sessions.sqlite'))).includes(Buffer.from(secret)));
  assert.ok(!existsSync(join(directory, 'unused-control-home')));
  phase = 'reopen'; step = 0;
  const third = await execute(['--session', first.receipt.sessionId, '--input', 'Reopen without granting command'], 1);
  assert.equal(third.result.reason, 'error');
  assert.equal(third.binding.allowCommand, false);
  assert.equal(third.binding.allowWrite, false);
  assert.equal(third.receipt.sessionId, first.receipt.sessionId);
  assert.ok(third.receipt.revision > second.receipt.revision);
  const resume = ['--session', first.receipt.sessionId];
  phase = 'skill'; step = 0;
  await execute([...resume, '--input', 'Load the relevant check Skill completely']);
  assert.equal(initialSkillBody, false);
  assert.equal(loadedSkillBody, true);
  phase = 'memory-denied'; step = 0;
  const denied = await execute([...resume, '--allow-write', '--input', 'Try memory without its grant']);
  assert.equal(denied.result.messages.filter(message => message.role === 'tool'
    && message.name === 'project_memory').at(-1).outcome.error.code, 'permission_denied');
  assert.ok(!existsSync(join(directory, '.agents/MEMORY.md')));
  phase = 'memory-write'; step = 0;
  await execute([...resume, '--allow-memory-write', '--input', 'Save confirmed experience']);
  assert.equal(await readFile(join(directory, '.agents/MEMORY.md'), 'utf8'), 'offline confirmed experience');
  phase = 'memory-reopen'; step = 0;
  const ungranted = await execute([...resume, '--input', 'Reopen without memory grant']);
  assert.equal(ungranted.result.messages.filter(message => message.role === 'tool'
    && message.name === 'project_memory').at(-1).outcome.error.code, 'permission_denied');
  assert.equal(ungranted.projectAuthority.allowMemoryWrite, false);
  console.log(JSON.stringify({ offline: true, editedAndChecked: true, resumedExactId: true,
    persistentReceiptVerified: true, exactCommandAuthority: true, reopenDefaultsReadOnly: true,
    progressiveCompleteSkill: true, memoryRequiresSeparateInvocationGrant: true,
    controlHomeCreated: false, remaining: 'Persistent catalog/cwd metadata producer integration' }));
} finally {
  if (active) {
    const stopped = new Promise(resolve => active.once('close', resolve));
    active.kill('SIGTERM');
    await stopped;
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
