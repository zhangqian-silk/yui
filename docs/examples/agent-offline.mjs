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
const workingDirectory = join(directory, 'child');
const launchDirectory = join(directory, 'different-launch');
const secret = 'dummy-offline-example-token';
const executable = realpathSync(process.execPath);
// Trusted fixture code reviewed here, not arbitrary text supplied by the model.
const argv = ['-e',
  'const fs=require("node:fs");if(fs.readFileSync("../input.txt","utf8")!=="after\\n"||process.env.EXAMPLE_CREDENTIAL)process.exit(1);console.log("local check passed");'];
const commandConfig = JSON.stringify({ env: {}, specs: [{ executable, argv, effect: 'read' }] });
let phase = 'read', step = 0, active;
let initialSkillBody = false, loadedSkillBody = false, commandFromCurrentFacts = false;
const server = createServer(async (request, response) => {
  let source = '';
  for await (const part of request) source += part;
  const input = JSON.parse(source);
  assert.equal(request.headers.authorization, `Bearer ${secret}`);
  const call = (id, name, args) => ({ id, type: 'function',
    function: { name, arguments: JSON.stringify(args) } });
  let calls;
  assert.equal(input.messages.filter(message => message.role === 'system').length, 1);
  const material = input.messages.filter(message => message.role === 'user')
    .map(message => { try { return JSON.parse(message.content).contextMaterial; } catch { return undefined; } })
    .find(material => material?.loader === 'product-runtime');
  assert.ok(material, 'The actual model request must include current runtime facts');
  const currentFacts = JSON.parse(material.content);
  assert.deepEqual({ root: currentFacts.root, cwd: currentFacts.cwd },
    { root: directory, cwd: workingDirectory });
  assert.ok(!source.includes(secret));
  const configuredCheck = id => {
    const spec = currentFacts.commands[0];
    assert.ok(spec, 'Choose the configured check from the actual model request');
    commandFromCurrentFacts = true;
    return call(id, 'command', { command: spec.executable, argv: spec.argv, cwd: currentFacts.cwd });
  };
  if (phase === 'read' && step++ === 0) calls = [call('read-example', 'read', { path: 'input.txt' })];
  else if (phase === 'edit' && step++ === 0) {
    const previousRead = input.messages.find(message => message.role === 'tool');
    const sha256 = JSON.parse(JSON.parse(previousRead.content).content).sha256;
    calls = [call('edit-example', 'edit',
      { path: 'input.txt', expectedSha256: sha256, oldText: 'before', newText: 'after' })];
  } else if (phase === 'edit' && step === 2) calls = [configuredCheck('check-example')];
  else if (phase === 'reopen' && step++ === 0) {
    assert.deepEqual(currentFacts.commands, []);
    assert.equal(currentFacts.grants.allowCommand, false);
    // Deliberately replay the old command as a negative authorization probe.
    calls = [call('reopen-check', 'command', { command: executable, cwd: workingDirectory, argv })];
  }
  else if (phase === 'restored' && step++ === 0) calls = [call('restored-read', 'read', { path: 'input.txt' })];
  else if (phase === 'restored' && step === 2) calls = [configuredCheck('restored-check')];
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
  await mkdir(workingDirectory);
  await mkdir(launchDirectory);
  await writeFile(join(directory, 'input.txt'), 'before\n');
  await mkdir(join(directory, '.agents/skills/check'), { recursive: true });
  await writeFile(join(directory, '.agents/skills/check/SKILL.md'),
    '---\nname: check\ndescription: Offline check.\nallowed-tools: command\n---\nCOMPLETE_OFFLINE_SKILL_BODY');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const shared = ['--allow-http', '--endpoint', `http://127.0.0.1:${server.address().port}/chat`,
    '--model', 'offline-fixture', '--credential-ref', 'env:EXAMPLE_CREDENTIAL',
    '--state-dir', join(directory, 'state')];
  const execute = (args, expectedCode = 0, command = 'run') => new Promise((resolve, reject) => {
    // Installed package uses its public bin; source checkout uses the required absolute local launcher.
    active = spawn(existsSync(localLauncher) ? localLauncher : process.execPath,
      [...(existsSync(localLauncher) ? [] : [join(packageRoot, 'dist/cli.js')]), 'agent', command,
        ...(command === 'run' ? [...shared,
          ...(args.includes('--session') ? [] : ['--root', directory, '--cwd', workingDirectory])]
          : ['--state-dir', join(directory, 'state'), '--credential-ref', 'env:EXAMPLE_CREDENTIAL']),
        ...args],
      { env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: tmpdir(),
        YUI_HOME: join(directory, 'unused-control-home'), EXAMPLE_CREDENTIAL: secret },
        cwd: launchDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    active.stdout.on('data', data => { output += data; });
    active.stderr.on('data', data => { error += data; });
    active.on('error', reject);
    active.on('close', code => {
      active = undefined;
      if (code !== expectedCode) reject(new Error(`Offline entry failed (${code}): ${error}`));
      else resolve(JSON.parse(output || error));
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
  phase = 'read'; step = 0;
  const another = await execute(['--input', 'Create another explicitly separate Session']);
  for (const saved of [first, another]) await execute(['--session', saved.receipt.sessionId,
    '--title', '"Same title"', '--expected-metadata-revision', '0'], 0, 'rename');
  const page = await execute(['--limit', '1'], 0, 'sessions');
  const next = await execute(['--limit', '1', '--cursor', page.nextCursor], 0, 'sessions');
  assert.notEqual(page.items[0].sessionId, next.items[0].sessionId);
  assert.equal(page.items[0].title, next.items[0].title);
  assert.ok([page.items[0], next.items[0]].some(item => item.sessionId === first.receipt.sessionId));
  const facts = await execute([...resume, '--limit', '2'], 0, 'history');
  assert.equal(facts.records.length, 2);
  const detail = await execute(resume, 0, 'session-info');
  assert.equal(detail.sessionId, first.receipt.sessionId);
  assert.deepEqual(detail.location, { root: directory, cwd: workingDirectory });
  await execute([...resume, '--title', '"Chosen exact ID"', '--expected-metadata-revision', '1'], 0, 'rename');
  const stale = await execute(['--limit', '1', '--cursor', page.nextCursor], 1, 'sessions');
  assert.equal(stale.field, 'cursor_stale');
  await execute(['--limit', '1'], 0, 'sessions'); // Explicit refresh, no automatic cursor fallback.
  await execute([...resume, '--limit', '2', '--cursor', facts.nextCursor], 0, 'history');
  phase = 'restored'; step = 0;
  const restored = await execute([...resume, '--tools', 'read,command', '--allow-command',
    '--command-config', commandConfig, '--input', 'Continue by exact catalog ID with fresh command authority']);
  assert.equal(restored.binding.root, directory);
  assert.equal(restored.binding.cwd, workingDirectory);
  assert.equal(restored.receipt.sessionId, detail.sessionId);
  assert.ok(restored.receipt.revision > detail.revision);
  const restoredCheck = restored.result.messages.filter(message => message.role === 'tool' && message.name === 'command').at(-1);
  assert.equal(JSON.parse(restoredCheck.outcome.content).exitCode, 0);
  console.log(JSON.stringify({ offline: true, editedAndChecked: true, resumedExactId: true,
    persistentReceiptVerified: true, exactCommandAuthority: true, reopenDefaultsReadOnly: true,
    progressiveCompleteSkill: true, memoryRequiresSeparateInvocationGrant: true,
    persistentCatalogDiscovered: true, duplicateTitlesSelectedById: true, boundedHistoryRead: true,
    explicitStaleCursorRefresh: true, controlHomeCreated: false,
    originalRootCwdRestoredAcrossLaunchDirectories: true, rootDiffersFromCwd: true,
    freshCommandAuthorizationAfterCatalogSelection: true,
    commandChosenFromCurrentModelRequest: commandFromCurrentFacts }));
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
