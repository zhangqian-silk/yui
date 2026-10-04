import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgent, createCodingTools } from '../../dist/nativeAgent/index.js';

test('coding pack runs through the public Tool loop and exposes actual edits to the next step', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-coding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'input.txt'), 'before\n');
  const tools = createCodingTools({ root });
  assert.deepEqual(tools.map(tool => tool.definition.name), ['read', 'write', 'edit', 'patch', 'list', 'find', 'search']);
  assert.equal(createCodingTools({ root, command: { env: {} } }).at(-1).definition.name, 'command');
  const result = await createAgent({ tools, provider: {
    async complete(request) {
      if (request.step === 1) return { kind: 'tool_calls', content: '', calls: [
        { id: 'r', name: 'read', arguments: { path: 'input.txt' } },
      ] };
      if (request.step === 2) {
        const read = JSON.parse(request.messages.at(-1).outcome.content);
        return { kind: 'tool_calls', content: '', calls: [
          { id: 'e', name: 'edit', arguments: {
            path: 'input.txt', oldText: 'before', newText: 'after', expectedSha256: read.sha256,
          } },
        ] };
      }
      assert.equal(request.messages.at(-1).outcome.ok, true);
      return { kind: 'final', content: 'Edit confirmed by tool result' };
    },
  } }).runTurn({ sessionId: 's', turnId: 't', input: 'Edit fixture', maxSteps: 3 });
  assert.equal(result.reason, 'completed');
  assert.equal(await readFile(path.join(root, 'input.txt'), 'utf8'), 'after\n');
  assert.deepEqual(result.messages.filter(m => m.role === 'tool').map(m => m.toolCallId), ['r', 'e']);
});
