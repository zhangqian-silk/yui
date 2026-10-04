import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgent, createMockProvider, createTextTools, createContextBuilder, type AgentEvent } from './index.js';

const root = await mkdtemp(path.join(tmpdir(), 'independent-agent-demo-'));
try {
  const text = 'An independent Agent copied this text through tool results.\n';
  await writeFile(path.join(root, 'input.txt'), text);
  const samples = [0.1, 0.2, 0.9];
  // This is deliberately an in-memory fixture, not a durable session store.
  const recorded: AgentEvent[] = [];
  const observed: AgentEvent[] = [];
  const agent = createAgent({
    tools: createTextTools({ root }),
    provider: createMockProvider({ toolCallProbability: 0.5, random: () => {
      const sample = samples.shift();
      if (sample === undefined) throw new Error('Demo random sequence exhausted');
      return sample;
    } }),
    contextBuilder: createContextBuilder({ sources: [{ id: 'demo', async load() {
      return [{ id: 'guide', kind: 'guidance', content: 'Use only the explicitly supplied tools.',
        source: 'demo', revision: '1', required: true }];
    } }] }),
    recorder: { async record(event) { recorded.push(event); } },
    observer: { observe(event) { observed.push(event); } },
  });
  const result = await agent.runTurn({
    sessionId: 'demo-session', turnId: 'demo-turn', input: 'Copy input.txt to output.txt', maxSteps: 3,
  });
  assert.equal(result.reason, 'completed');
  assert.deepEqual(recorded, result.events);
  assert.deepEqual(observed, result.events);
  assert.equal(await readFile(path.join(root, 'output.txt'), 'utf8'), text);
  console.log(JSON.stringify({ ...result, fileVerified: true }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
