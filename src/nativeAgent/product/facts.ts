import { createHash } from 'node:crypto';
import type { ContextSource } from '../context/index.js';
import type { LocalToolDescription } from '../localSafety.js';
import { containsCredential, ProductError, type ProductArguments } from './config.js';

/** Only validated current-invocation facts. No env values, credentials, account,
 * persisted grants or command authority tokens. The real 82 check still rules. */
export function createRuntimeFacts(invocation: ProductArguments, binding: LocalToolDescription,
  sessionId: string, credential?: string): ContextSource {
  const facts = {
    type: 'runtime-facts', sessionId, root: binding.root, cwd: binding.cwd,
    tools: [...invocation.config.tools],
    grants: { allowWrite: binding.allowWrite, allowCommand: binding.allowCommand,
      allowMemoryWrite: invocation.allowMemoryWrite },
    commands: binding.allowCommand ? (invocation.config.command?.specs ?? [])
      .filter(spec => spec.effect === 'read' || binding.allowWrite)
      .map(spec => ({ executable: spec.executable, argv: [...spec.argv], effect: spec.effect })) : [],
  };
  if (credential && containsCredential(facts, credential))
    throw new ProductError('agent_config', 'runtimeFacts', 'Keep the configured credential separate from runtime facts.');
  const content = JSON.stringify(facts);
  const revision = createHash('sha256').update(content).digest('hex');
  return {
    id: 'product-runtime',
    async load(scope, signal) {
      if (signal.aborted || scope.sessionId !== sessionId) throw new Error('Runtime fact scope unavailable');
      // Data -> user material: configuration arguments never become system
      // instructions. Required budget admission cannot silently drop these facts.
      return [{ id: 'current-invocation', kind: 'data', source: 'product-runtime',
        content, revision, required: true }];
    },
  };
}
