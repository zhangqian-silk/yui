import { createToolExecutor, type LocalToolBinding, type LocalToolEnvironment,
  type ProjectGuidance, type EnvironmentTool } from '../index.js';
import type { ProductArguments } from './config.js';

/** Compose public capabilities, not producer-private registries.
 * Coding calls retain the original factory's exact live lease and permission.
 * Ordinary project tools acquire no coding resource/authority. */
export function createProductTools(binding: LocalToolBinding, guidance: ProjectGuidance,
  invocation: ProductArguments, sessionId: string) {
  type Environment = LocalToolEnvironment | undefined;
  const codingNames = new Set(binding.tools.map(tool => tool.definition.name));
  const tools: EnvironmentTool<Environment>[] = binding.tools.map(tool => ({
    definition: tool.definition,
    validate: args => tool.validate(args),
    async execute(args, scope, signal, lease) {
      if (lease === undefined) return { ok: false, error: {
        code: 'missing_coding_environment', message: 'Coding resource was not acquired', effect: 'none' } };
      return tool.execute(args, scope, signal, lease);
    },
  }));
  tools.push(...guidance.tools);
  return createToolExecutor<Environment>({
    tools: tools.filter(tool => invocation.config.tools.includes(tool.definition.name)),
    environment: {
      async acquire(call, signal) {
        if (codingNames.has(call.call.name)) return binding.environment.acquire(call, signal);
        return { value: undefined, async release() {} };
      },
    },
    permission: {
      async check(call, lease, signal) {
        if (codingNames.has(call.call.name)) {
          return lease === undefined ? { allowed: false, reason: 'Coding resource required' }
            : binding.permission.check(call, lease, signal);
        }
        if (signal.aborted || lease !== undefined || call.identity.sessionId !== sessionId)
          return { allowed: false, reason: 'Project Session scope does not match' };
        const args = call.call.arguments;
        const action = args !== null && typeof args === 'object' && !Array.isArray(args) ? args.action : undefined;
        if (call.call.name === 'project_context' && ['inspect', 'load_skill', 'reference'].includes(String(action)))
          return { allowed: true };
        if (call.call.name === 'project_memory' && (action === 'read'
          || (invocation.allowMemoryWrite && (action === 'replace' || action === 'delete'))))
          return { allowed: true };
        return { allowed: false, reason: 'Project memory modification requires --allow-memory-write on this invocation' };
      },
    },
  });
}
