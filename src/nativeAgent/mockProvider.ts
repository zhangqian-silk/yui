import type { ModelProvider, ModelRequest, ToolCall } from './contracts.js';

export type MockOptions = {
  toolCallProbability: number;
  random?: () => number;
  readPath?: string;
  writePath?: string;
};

/** A deliberately small read/write mock, not a semantic planner. */
export function createMockProvider(options: MockOptions): ModelProvider {
  const { toolCallProbability: p, random = Math.random, readPath = 'input.txt', writePath = 'output.txt' } = options;
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('toolCallProbability must be in [0, 1]');
  const latestRead = (request: ModelRequest): string | undefined => {
    for (const m of [...request.messages].reverse()) {
      if (m.role === 'tool' && m.name === 'read' && m.outcome.ok) {
        try {
          const data: unknown = JSON.parse(m.outcome.content);
          if (data && typeof data === 'object' && 'text' in data && typeof data.text === 'string') return data.text;
        } catch { /* Other read implementations need not use the text-tools payload. */ }
      }
    }
    return undefined;
  };
  return {
    async complete(request, signal) {
      signal.throwIfAborted();
      const u = random();
      if (!Number.isFinite(u) || u < 0 || u >= 1) throw new Error('random must return a number in [0, 1)');
      if (u >= p) {
        const outcomes = request.messages.filter(m => m.role === 'tool');
        const success = outcomes.filter(m => m.role === 'tool' && m.outcome.ok).length;
        return { kind: 'final', content: `Observed ${success} successful and ${outcomes.length - success} failed tool results.` };
      }
      const content = latestRead(request);
      const write = request.step % 2 === 0 && content !== undefined;
      const used = new Set(request.messages.flatMap(m => m.role === 'assistant' ? m.toolCalls.map(c => c.id) : []));
      let suffix = 1;
      while (used.has(`mock-${suffix}`)) suffix++;
      const call: ToolCall = { id: `mock-${suffix}`, name: write ? 'write' : 'read',
        arguments: write ? { path: writePath, content } : { path: readPath } };
      if (!request.tools.some(t => t.name === call.name)) throw new Error(`Mock requires the ${call.name} tool`);
      return { kind: 'tool_calls', content: '', calls: [call] };
    },
  };
}
