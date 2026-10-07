import type { ModelProvider } from '../index.js';
import type { EvaluationCase } from './cases.js';
import { solution } from './cases.js';
import type { LocalObserver } from '../observability/index.js';
export type EvaluationProviderContext = Readonly<{
  case: EvaluationCase;
  root: string;
  node: string;
  observer: LocalObserver;
}>;
/** A provider fixture, never an evaluation verdict or a second Agent loop. */
export function createEvaluationFixture(context: EvaluationProviderContext, variant: 'good' | 'bad' = 'good'): ModelProvider {
  const change = solution(context.case.id, variant === 'good');
  return {
    async complete(request) {
      if (request.step === 1) return { kind: 'tool_calls', content: '', calls: [
        { id: 'read-source', name: 'read', arguments: { path: 'math.cjs' } },
      ] };
      if (request.step === 2) {
        if (context.case.id === 'tests') return { kind: 'tool_calls', content: '', calls: [
          { id: 'add-tests', name: 'write', arguments: { path: change.path, content: change.content } },
        ] };
        const read = [...request.messages].reverse().find(m => m.role === 'tool' && m.name === 'read');
        if (!read || read.role !== 'tool' || !read.outcome.ok) return { kind: 'final', content: 'Claimed complete' };
        const value = JSON.parse(read.outcome.content) as { sha256: string; text: string };
        return { kind: 'tool_calls', content: '', calls: [
          { id: 'edit-source', name: 'edit', arguments: {
            path: change.path, expectedSha256: value.sha256, oldText: value.text, newText: change.content,
          } },
        ] };
      }
      if (request.step === 3) return { kind: 'tool_calls', content: '', calls: [
        { id: 'syntax-check', name: 'command', arguments: {
          command: context.node, argv: ['--check', change.path], cwd: context.root,
        } },
      ] };
      // Deliberately identical claims: independent checks must reject the bad one.
      return { kind: 'final', content: 'All work complete; tests pass.' };
    },
  };
}
