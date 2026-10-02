import type { Tool, ToolExecutor, ToolOutcome } from './contracts.js';
import { snapshot, validOutcome } from './validation.js';

const failed = (code: string, message: string): ToolOutcome => ({ ok: false, error: { code, message, effect: 'none' } });

/** The built-in implementation uses the same contract as an injected executor. */
export function createToolExecutor(tools: readonly Tool[]): ToolExecutor {
  const entries = tools.map(tool => ({ tool, definition: snapshot(tool.definition) }));
  const byName = new Map(entries.map(entry => [entry.definition.name, entry.tool]));
  if (byName.size !== tools.length || [...byName.keys()].some(name => typeof name !== 'string' || !name.trim())) {
    throw new Error('Tool names must be unique and nonempty');
  }
  return {
    definitions: snapshot(entries.map(entry => entry.definition)),
    async execute(call, scope, signal) {
      if (signal.aborted) return failed('cancelled_before_start', 'Tool was not started');
      const tool = byName.get(call.name);
      if (!tool) return failed('unknown_tool', `Unknown tool: ${call.name}`);
      try {
        const invalid = tool.validate(call.arguments);
        if (invalid) {
          const outcome: ToolOutcome = { ok: false, error: invalid };
          // Validation is explicitly effect-free. An unknown effect is not a
          // legal validation response; execution has not been entered.
          return validOutcome(outcome) && invalid.effect === 'none'
            ? outcome : failed('tool_protocol', 'Invalid tool validation result');
        }
      } catch {
        return failed('tool_validation', 'Tool validation failed');
      }
      if (signal.aborted) return failed('cancelled_before_start', 'Tool was not started');
      // The caller (kernel) settles thrown/invalid execution results as unknown.
      return tool.execute(call.arguments, snapshot({ ...scope, toolCallId: call.id }), signal);
    },
  };
}
