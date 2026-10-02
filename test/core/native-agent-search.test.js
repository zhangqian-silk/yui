import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSearchTools } from '../../dist/nativeAgent/index.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'sub'));
  await writeFile(path.join(root, 'a.txt'), 'first\nneedle [x]\nlast\n');
  await writeFile(path.join(root, 'sub', 'b.txt'), 'needle [x]\n');
  return root;
}
const scope = { sessionId: 's', turnId: 't', step: 1, toolCallId: 'c' };
async function run(root, name, args, limits = {}, signal = new AbortController().signal) {
  const tool = createSearchTools({ root, ...limits }).find(t => t.definition.name === name);
  return tool.execute(args, scope, signal);
}
function content(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return JSON.parse(result.content);
}
function fault(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.equal(result.error.effect, 'none');
}

test('bounded directory browsing, recursive filenames and literal line evidence', async t => {
  const root = await fixture(t);
  const listed = content(await run(root, 'list', { path: '.' }));
  assert.deepEqual(listed.results.sort((a, b) => a.path.localeCompare(b.path)),
    [{ path: 'a.txt', type: 'file' }, { path: 'sub', type: 'directory' }]);
  const found = content(await run(root, 'find', { path: '.', query: '.txt' }));
  assert.deepEqual(found.results.map(r => r.path).sort(), ['a.txt', 'sub/b.txt']);
  const searched = content(await run(root, 'search', { path: '.', query: 'needle [x]' }));
  assert.deepEqual(searched.results.sort((a, b) => a.path.localeCompare(b.path)),
    [{ path: 'a.txt', line: 2, text: 'needle [x]' }, { path: 'sub/b.txt', line: 1, text: 'needle [x]' }]);
  assert.equal(searched.complete, true);
  assert.deepEqual(content(await run(root, 'search', { path: 'sub', query: 'missing' })).results, []);
});

test('scan, file, result and output budgets fail truthfully without false complete results', async t => {
  const root = await fixture(t);
  for (const limits of [{ maxEntries: 1 }, { maxFileBytes: 1 }, { maxResults: 1 },
    { maxOutputBytes: 64 }, { maxTotalBytes: 1 }, { maxDepth: 1 }]) {
    if (limits.maxDepth) await mkdir(path.join(root, 'sub', 'deep'));
    fault(await run(root, 'search', { path: '.', query: 'needle' }, limits), 'limit_exceeded');
  }
  await writeFile(path.join(root, 'sub', 'binary'), Buffer.from([0xff]));
  fault(await run(root, 'search', { path: 'sub', query: 'absent' }), 'invalid_utf8');
});

test('execute validates scope and rejects links; cancellation remains read-only', async t => {
  const root = await fixture(t);
  assert.throws(() => createSearchTools({ root: '.' }), /absolute/);
  fault(await run(root, 'list', { path: '../' }), 'path_out_of_scope');
  fault(await run(root, 'search', { path: '.', query: '' }), 'invalid_arguments');
  fault(await run(root, 'list', { path: '.', extra: true }), 'invalid_arguments');
  await symlink(path.join(root, 'sub'), path.join(root, 'alias'));
  fault(await run(root, 'list', { path: 'alias' }), 'symlink_denied');
  fault(await run(root, 'find', { path: '.', query: 'nothing' }), 'symlink_denied');
  await link(path.join(root, 'a.txt'), path.join(root, 'sub', 'hard'));
  fault(await run(root, 'search', { path: 'sub', query: 'absent' }), 'not_regular_file');
  const controller = new AbortController();
  controller.abort();
  fault(await run(root, 'list', { path: '.' }, {}, controller.signal), 'cancelled');
});
