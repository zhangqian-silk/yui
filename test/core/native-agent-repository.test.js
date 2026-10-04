import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { createTextTools, createSearchTools, createAgent } from '../../dist/nativeAgent/index.js';
import { createToolExecutor } from '../../dist/nativeAgent/toolManager/index.js';

const scope = { sessionId: 's', turnId: 't', step: 1, toolCallId: 'c' };
const invoke = (tool, args) => tool.execute(args, scope, new AbortController().signal);
const hash = text => createHash('sha256').update(text).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-repository-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('read pages preserve BOM, CRLF, multibyte long lines, offsets and cursor preconditions', async t => {
  const root = await fixture(t);
  const text = '\ufefffirst\r\n' + '世"\\'.repeat(25000) + '\r\nlast';
  await writeFile(path.join(root, 'file'), text);
  const [read] = createTextTools({ root, maxOutputBytes: 4096 });
  let cursor;
  let reconstructed = '';
  let end = 0;
  do {
    const result = await invoke(read, { path: 'file', limit: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
    const page = JSON.parse(result.content);
    assert.equal(page.byteStart, end);
    end = page.byteEnd;
    assert.equal(page.sha256, hash(text));
    reconstructed += page.text;
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(reconstructed, text);
  assert.equal(end, Buffer.byteLength(text));
  const first = JSON.parse((await invoke(read, { path: 'file', limit: 1 })).content);
  assert.equal((await invoke(read, { path: 'file', limit: 2, cursor: first.nextCursor })).error.code, 'invalid_cursor');
  await writeFile(path.join(root, 'file'), text + 'changed');
  assert.equal((await invoke(read, { path: 'file', limit: 1, cursor: first.nextCursor })).error.code, 'stale_cursor');
});

test('patch preflights all files, locates edits in original text and produces independently applicable diffs', async t => {
  const root = await fixture(t);
  const before = 'user dirty line\r\none\r\nmiddle\r\ntwo';
  await writeFile(path.join(root, 'a'), before);
  await writeFile(path.join(root, 'b'), 'old\n');
  const patch = createTextTools({ root }).find(tool => tool.definition.name === 'patch');
  assert.ok(patch);
  const files = [{ path: 'a', expectedSha256: hash(before), edits: [
    { oldText: 'one', newText: 'two' }, { oldText: 'two', newText: 'new\nend' },
  ] }, { path: 'b', expectedSha256: hash('wrong'), edits: [{ oldText: 'old', newText: 'new' }] }];
  assert.equal((await invoke(patch, { files })).error.effect, 'none');
  assert.equal(await readFile(path.join(root, 'a'), 'utf8'), before);
  files[1].expectedSha256 = hash('old\n');
  const result = await invoke(patch, { files });
  assert.equal(result.ok, true, JSON.stringify(result));
  const receipt = JSON.parse(result.content);
  const actual = await readFile(path.join(root, 'a'));
  assert.equal(actual.toString(), 'user dirty line\r\ntwo\r\nmiddle\r\nnew\nend');
  const verify = path.join(root, 'verify');
  await mkdir(verify);
  await writeFile(path.join(verify, 'a'), before);
  await writeFile(path.join(verify, 'b'), 'old\n');
  execFileSync('git', ['apply', '--unsafe-paths', '-'], {
    cwd: verify, input: receipt.files.map(file => file.diff).join(''), env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  assert.deepEqual(await readFile(path.join(verify, 'a')), actual);
  assert.deepEqual(await readFile(path.join(verify, 'b')), await readFile(path.join(root, 'b')));
  assert.deepEqual((await readdir(root)).sort(), ['a', 'b', 'verify']);
});

test('discovery separates result pagination from scan/coverage, respects ignore policy and bounds patterns', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'sub'));
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.gitignore'), '*.log\n!keep.log\n');
  for (const name of ['.config', 'a.txt', 'drop.log', 'keep.log', 'sub/b.txt', 'node_modules/x', '.git/config']) {
    await writeFile(path.join(root, name), 'needle [x]\n');
  }
  await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
  const [, find, search] = createSearchTools({ root, maxResults: 1 });
  let cursor;
  const paths = [];
  do {
    const result = await invoke(find, { path: '.', query: '**/*.txt', mode: 'glob', ...(cursor ? { cursor } : {}) });
    assert.equal(result.ok, true, JSON.stringify(result));
    const page = JSON.parse(result.content);
    assert.equal(page.scanComplete, true);
    paths.push(...page.results.map(file => file.path));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(paths, ['a.txt', 'sub/b.txt']);
  const result = await invoke(search, { path: '.', query: 'needle', mode: 'regex' });
  const page = JSON.parse(result.content);
  assert.equal(page.scanComplete, true);
  assert.equal(page.coverage.complete, false);
  assert.equal(page.skipped.binary, 1);
  assert.equal((await invoke(search, { path: '.', query: '(a+)+', mode: 'regex' })).error.code, 'unsupported_pattern');
  assert.equal((await invoke(find, { path: '.', query: 'x', mode: 'glob', cursor: page.nextCursor })).error.code, 'invalid_cursor');
  const first = JSON.parse((await invoke(find, { path: '.', query: '.txt' })).content);
  await writeFile(path.join(root, 'new.txt'), '');
  assert.equal((await invoke(find, { path: '.', query: '.txt', cursor: first.nextCursor })).error.code, 'stale_cursor');
});

test('partial patch receipts survive public ToolManager and Agent loop without replay or evidence loss', async t => {
  const root = await fixture(t);
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(root, name), 'old "世界"\\\n');
  const before = 'old "世界"\\\n';
  const signal = new AbortController().signal;
  const check = signal.throwIfAborted.bind(signal);
  let changed = false;
  signal.throwIfAborted = () => {
    check();
    if (!changed && readFileSync(path.join(root, 'a'), 'utf8').startsWith('new')) {
      changed = true;
      writeFileSync(path.join(root, 'b'), 'external concurrent change\n');
    }
  };
  const files = ['a', 'b', 'c'].map(name => ({ path: name, expectedSha256: hash(before),
    edits: [{ oldText: 'old', newText: 'new' }] }));
  let released = 0;
  const permissions = [];
  const executor = createToolExecutor({
    tools: createTextTools({ root, maxOutputBytes: 4096 }),
    environment: { async acquire() { return { value: null, async release() { released++; } }; } },
    permission: { async check(invocation) { permissions.push(invocation); return { allowed: true }; } },
  });
  let requests = 0;
  const agent = createAgent({ toolExecutor: executor, provider: { async complete() {
    requests++;
    return { kind: 'tool_calls', content: '', calls: [
      { id: 'p', name: 'patch', arguments: { files } },
      { id: 'r', name: 'read', arguments: { path: 'c' } },
    ] };
  } } });
  const result = await agent.runTurn({ sessionId: 's', turnId: 't', input: 'controlled patch', maxSteps: 3, signal });
  assert.equal(requests, 1);
  assert.equal(result.reason, 'error');
  const messages = result.messages.filter(message => message.role === 'tool');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].outcome.error.code, 'edit_conflict');
  assert.equal(messages[0].outcome.error.effect, 'unknown');
  assert.ok(Buffer.byteLength(JSON.stringify(messages[0].outcome)) <= 4096);
  const receipt = JSON.parse(messages[0].outcome.error.message);
  assert.deepEqual(receipt.files.map(file => file.status), ['committed', 'rejected', 'not_attempted']);
  assert.equal(receipt.files[0].sha256, hash(await readFile(path.join(root, 'a'))));
  assert.equal(receipt.files[0].beforeSha256, hash(before));
  assert.equal(receipt.files[1].sha256, null);
  assert.equal(receipt.files[2].sha256, null);
  assert.equal(result.error.message, messages[0].outcome.error.message);
  assert.equal(messages[1].outcome.error.code, 'not_started');
  assert.equal(await readFile(path.join(root, 'b'), 'utf8'), 'external concurrent change\n');
  assert.equal(await readFile(path.join(root, 'c'), 'utf8'), before);
  assert.equal(released, 1);
  assert.equal(permissions.length, 1);
  assert.deepEqual(permissions[0].call.arguments.files, files);
  assert.deepEqual((await readdir(root)).sort(), ['a', 'b', 'c']);
});

test('encoded diff budgets reject before writes; original overlaps and duplicate aliases reject atomically', async t => {
  const root = await fixture(t);
  const before = ('"\\世'.repeat(1000)) + '\n';
  await writeFile(path.join(root, 'a'), before);
  const patch = createTextTools({ root, maxOutputBytes: 1024 }).at(-1);
  const target = { path: 'a', expectedSha256: hash(before), edits: [{ oldText: before, newText: 'short' }] };
  const denied = await invoke(patch, { files: [target] });
  assert.equal(denied.error.code, 'output_limit');
  assert.equal(denied.error.effect, 'none');
  assert.equal(await readFile(path.join(root, 'a'), 'utf8'), before);
  assert.equal((await invoke(patch, { files: [target, { ...target, path: './a' }] })).error.code, 'edit_conflict');
  await writeFile(path.join(root, 'a'), 'abcdef');
  assert.equal((await invoke(patch, { files: [{ path: 'a', expectedSha256: hash('abcdef'), edits: [
    { oldText: 'abcd', newText: '' }, { oldText: 'cdef', newText: '' },
  ] }] })).error.code, 'edit_conflict');
  assert.deepEqual(await readdir(root), ['a']);
});

test('hierarchical ignore, nested repository reset, policy overrides and long-line search are explicit', async t => {
  const root = await fixture(t);
  for (const directory of ['sub', 'other', 'repo', 'repo/.git', '.git', 'node_modules']) await mkdir(path.join(root, directory));
  await writeFile(path.join(root, '.gitignore'), '*.log\n');
  await writeFile(path.join(root, 'sub/.gitignore'), '!show.log\n');
  for (const name of ['sub/show.log', 'sub/hide.log', 'other/show.log', 'repo/show.log',
    '.hidden', '.git/secret', 'node_modules/package', 'x😀.txt']) await writeFile(path.join(root, name), 'needle\n');
  const [, find, search] = createSearchTools({ root });
  const all = async args => JSON.parse((await invoke(find, { path: '.', query: '', ...args })).content);
  const normal = await all({ query: 'show' });
  assert.deepEqual(normal.results.map(file => file.path), ['repo/show.log', 'sub/show.log']);
  const hidden = await all({ query: '.hidden' });
  assert.deepEqual(hidden.results.map(file => file.path), ['.hidden']);
  assert.deepEqual((await all({ query: '.hidden', hidden: false })).results, []);
  const override = await all({ query: 'package', generated: false });
  assert.deepEqual(override.results.map(file => file.path), ['node_modules/package']);
  assert.deepEqual((await all({ query: 'secret', ignore: false, generated: false })).results, []);
  assert.equal((await invoke(search, { path: '.git/secret', query: 'needle', ignore: false })).error.code, 'git_metadata_denied');
  assert.deepEqual((await all({ query: 'show', ignore: false, exclude: ['sub/**'] })).results.map(file => file.path),
    ['other/show.log', 'repo/show.log']);
  assert.deepEqual((await all({ query: '**/x😀.txt', mode: 'glob' })).results.map(file => file.path), ['x😀.txt']);
  const text = 'first\r\n' + '世"\\'.repeat(20000) + 'needle\r\nlast';
  await writeFile(path.join(root, 'long'), text);
  const boundedSearch = createSearchTools({ root, maxOutputBytes: 4096 }).at(-1);
  const result = await invoke(boundedSearch, { path: 'long', query: 'needle' });
  assert.equal(result.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
  const page = JSON.parse(result.content);
  assert.equal(page.complete, true);
  assert.equal(page.results[0].line, 2);
  assert.equal(page.results[0].byteStart, 7);
  assert.equal(page.results[0].textTruncated, true);
  assert.equal(page.results[0].sha256, hash(text));
  const literal = await invoke(search, { path: 'x😀.txt', query: '^needle$' });
  assert.deepEqual(JSON.parse(literal.content).results, []);
  assert.equal(JSON.parse((await invoke(search, { path: 'x😀.txt', query: '^n[e]+dle$', mode: 'regex' })).content).results.length, 1);
  const limited = createSearchTools({ root, maxPatternWork: 1 }).at(-1);
  assert.equal((await invoke(limited, { path: 'long', query: '.*needle', mode: 'regex', ignore: false })).error.code, 'pattern_limit');
  const longPath = [...Array(5).fill('世"'.repeat(40)), '--flag-like.txt'].join('/');
  await mkdir(path.dirname(path.join(root, longPath)), { recursive: true });
  await writeFile(path.join(root, longPath), text);
  const executor = createToolExecutor({
    tools: createSearchTools({ root, maxOutputBytes: 8192 }),
    environment: { async acquire() { return { value: null, async release() {} }; } },
    permission: { async check() { return { allowed: true }; } },
  });
  const batch = await executor.executeBatch({
    scope: { sessionId: 's', turnId: 't', step: 1 }, signal: new AbortController().signal,
    calls: [{ id: 'long', name: 'search', arguments: { path: longPath, query: 'needle' } }],
    async beforeExecute() {}, async afterExecute() {},
  });
  const evidence = batch.results[0].outcome;
  assert.equal(evidence.ok, true, JSON.stringify(evidence));
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 8192);
  assert.equal(JSON.parse(evidence.content).results[0].path, longPath);
  assert.equal(JSON.parse(evidence.content).results[0].line, 2);
});

test('distant original edits and creation diffs apply as bytes; reversed batches serialize without deadlock', async t => {
  const root = await fixture(t);
  const before = Array.from({ length: 80 }, (_, i) => `line ${i}\n`).join('');
  await writeFile(path.join(root, 'a'), before);
  await writeFile(path.join(root, 'b'), 'old');
  const [, write, , patch] = createTextTools({ root });
  const a = { path: 'a', expectedSha256: hash(before), edits: [
    { oldText: 'line 5\n', newText: 'line five\nextra\n' },
    { oldText: 'line 70\n', newText: 'line seventy\n' },
  ] };
  const b = { path: 'b', expectedSha256: hash('old'), edits: [{ oldText: 'old', newText: 'new' }] };
  const attempts = await Promise.all([invoke(patch, { files: [a, b] }), invoke(patch, { files: [b, a] })]);
  assert.equal(attempts.filter(result => result.ok).length, 1);
  assert.equal(attempts.find(result => !result.ok).error.code, 'edit_conflict');
  const receipt = JSON.parse(attempts.find(result => result.ok).content);
  assert.equal((receipt.files.find(file => file.path === 'a').diff.match(/^@@ /gm) ?? []).length, 2);
  const creation = await invoke(write, { path: 'created', content: 'hello 😀' });
  assert.equal(creation.ok, true);
  const empty = await invoke(write, { path: 'empty', content: '' });
  assert.equal(empty.ok, true);
  const verify = path.join(root, 'verify');
  await mkdir(verify);
  await writeFile(path.join(verify, 'a'), before);
  await writeFile(path.join(verify, 'b'), 'old');
  execFileSync('git', ['apply', '-'], { cwd: verify,
    input: receipt.files.map(file => file.diff).join('') + JSON.parse(creation.content).diff + JSON.parse(empty.content).diff,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  for (const name of ['a', 'b', 'created', 'empty']) assert.deepEqual(await readFile(path.join(root, name)), await readFile(path.join(verify, name)));
});
