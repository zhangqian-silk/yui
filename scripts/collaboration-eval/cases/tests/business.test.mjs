import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definitions, variants } from '../catalog.mjs';
import { prepareCase } from '../prepare.mjs';
import { executeCase } from '../participant.mjs';
import { scoreCase } from '../oracle.mjs';
import { observe, mutate } from '../business.mjs';
import { materials } from '../materials.mjs';

test('static freeze covers holdout inputs and modules, without scoring holdout', async () => {
  const frozen = JSON.parse(await readFile(new URL('../freeze.json', import.meta.url), 'utf8'));
  const hash = text => createHash('sha256').update(text).digest('hex');
  for (const [id, sha] of Object.entries(frozen.holdout)) assert.equal(hash(JSON.stringify(materials[id])), sha);
  for (const [file, sha] of Object.entries(frozen.modules))
    assert.equal(hash(await readFile(new URL('../' + file, import.meta.url))), sha, file);
});

async function fixture(t, id, variant = 'base') {
  const root = await mkdtemp(join(tmpdir(), 'yui-case-business-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prepared = await prepareCase(id, variant, root);
  // Unit evidence only. Production runner must create these from actual Yui reads.
  const readback = { origin: 'unit-fixture', records: prepared.facts.map(fact => ({
    ref: `unit:${fact.key}`, digest: fact.digest, value: structuredClone(fact),
  })) };
  return { root, prepared, readback };
}

test('frozen allocation and condition counts, without executing holdout', () => {
  assert.equal(definitions.length, 24);
  assert.equal(definitions.filter(d => d.split === 'dev').length, 18);
  assert.deepEqual(definitions.filter(d => d.split === 'holdout').map(d => d.id),
    ['C04', 'C07', 'W04', 'R04', 'A04', 'O04']);
  assert.deepEqual(definitions.filter(d => d.modes.includes('P')).map(d => d.id),
    ['C05', 'W01', 'R02', 'A03', 'O02']);
  assert.equal(variants.length, 4);
  for (const [category, count] of Object.entries({ code: 8, docs: 4, research: 4, data: 4, operations: 4 })) {
    assert.equal(definitions.filter(d => d.category === category).length, count);
    assert.equal(new Set(definitions.filter(d => d.category === category).map(d => d.difficulty)).size, 2);
  }
});

test('development outcomes and four frozen variants use business state', async t => {
  for (const d of definitions.filter(d => d.split === 'dev')) {
    for (const variant of ['base', ...variants.filter(v => v.base === d.id).map(v => v.id)]) {
      await t.test(`${d.id}/${variant}`, async st => {
        const f = await fixture(st, d.id, variant);
        const result = await executeCase({ root: f.root, readback: f.readback });
        const scored = await scoreCase(d.id, { root: f.root, result, variant, manifest: f.prepared.manifest });
        assert.deepEqual(scored.failures, [], JSON.stringify(scored));
        assert.equal(scored.status, ['docs', 'research'].includes(d.category) ? 'pending-human' : 'scripted-pass');
      });
    }
  }
});

test('O02 is produced by a real effect and duplicate send fails independent oracle', async t => {
  const f = await fixture(t, 'O02');
  const before = await observe(f.root);
  assert.equal(before.ledger.length, 1);
  assert.equal(before.ledger[0].action, 'send');
  const result = await executeCase({ root: f.root, readback: f.readback });
  assert.equal((await observe(f.root)).ledger.length, 1);
  assert.equal((await scoreCase('O02', { root: f.root, result, manifest: f.prepared.manifest })).status, 'scripted-pass');
  await mutate(f.root, { actor: 'predecessor', action: 'send', target: 'notice-7',
    key: 'different-key', payload: { recipient: 'sandbox-user', text: 'export ready' } });
  assert.ok((await scoreCase('O02', { root: f.root, result, manifest: f.prepared.manifest })).failures.includes('duplicate-or-wrong-effect'));
});

test('alternative prose and legal full/incremental paths are not fixed-answer matching', async t => {
  for (const id of ['A03', 'W01', 'R03']) {
    const f = await fixture(t, id);
    const result = await executeCase({ root: f.root, readback: f.readback, strategy: 'full', style: 'brief' });
    result.summary = '同一事实，另一种表达；需要人工审阅的语义仍未判定。';
    result.sources.reverse();
    assert.deepEqual((await scoreCase(id, { root: f.root, result, manifest: f.prepared.manifest })).failures, []);
  }
});

test('no original preparation variables or missing readback accepted', async t => {
  const f = await fixture(t, 'O02');
  await assert.rejects(executeCase({ root: f.root, facts: f.prepared.facts }), /readback/);
  f.readback.records[0].value.body.kind = 'publish';
  await assert.rejects(executeCase({ root: f.root, readback: f.readback }), /digest/);
});
