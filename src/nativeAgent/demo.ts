import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgent, createMockProvider, createTextTools } from './index.js';

const root = await mkdtemp(path.join(tmpdir(), 'independent-agent-demo-'));
try {
  const text = 'An independent Agent copied this text through tool results.\n';
  await writeFile(path.join(root, 'input.txt'), text);
  const samples = [0.1, 0.2, 0.9];
  const agent = createAgent({
    tools: createTextTools({ root }),
    provider: createMockProvider({ toolCallProbability: 0.5, random: () => {
      const sample = samples.shift();
      if (sample === undefined) throw new Error('Demo random sequence exhausted');
      return sample;
    } }),
  });
  const result = await agent.runTurn({
    sessionId: 'demo-session', turnId: 'demo-turn', input: 'Copy input.txt to output.txt', maxSteps: 3,
  });
  assert.equal(result.reason, 'completed');
  assert.equal(await readFile(path.join(root, 'output.txt'), 'utf8'), text);
  console.log(JSON.stringify({ ...result, fileVerified: true }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
