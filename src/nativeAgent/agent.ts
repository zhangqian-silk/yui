import type { Agent, AgentEvent, AgentOptions, EndReason, EventData, Message, ToolOutcome, TurnResult } from './contracts.js';
import { AgentFault, history, limits, response, size, snapshot, validOutcome } from './validation.js';

const failed = (code: string, message: string, effect: 'none' | 'unknown' = 'none'): ToolOutcome =>
  ({ ok: false, error: { code, message, effect } });

export function createAgent(options: AgentOptions): Agent {
  const tools = new Map(options.tools.map(t => [t.definition.name, t]));
  if (tools.size !== options.tools.length || [...tools.keys()].some(name => !name.trim())) {
    throw new Error('Tool names must be unique and nonempty');
  }
  const definitions = snapshot(options.tools.map(t => t.definition));
  return {
    async runTurn(input): Promise<TurnResult> {
      const scope = { sessionId: input.sessionId, turnId: input.turnId };
      const signal = input.signal ?? new AbortController().signal;
      const messages: Message[] = [];
      const events: AgentEvent[] = [];
      let steps = 0;
      let reason: EndReason = 'error';
      let error: TurnResult['error'];
      let sinkFailed = false;
      const emit = async (data: EventData): Promise<void> => {
        const event = snapshot({ ...scope, seq: events.length + 1, data });
        events.push(event);
        if (options.onEvent && !sinkFailed) {
          try { await options.onEvent(event); }
          catch {
            sinkFailed = true;
            error = { code: 'event_sink_failed', message: 'Event sink rejected a fact; inspect in-memory evidence' };
          }
        }
      };
      const append = async (message: Message, step?: number): Promise<void> => {
        const saved = snapshot(message);
        messages.push(saved);
        await emit({ type: 'message_appended', step, message: saved });
      };
      await emit({ type: 'turn_started' });
      try {
        if (!scope.sessionId?.trim() || !scope.turnId?.trim()
          || !Number.isSafeInteger(input.maxSteps) || input.maxSteps < 1 || typeof input.input !== 'string'
          || size({ role: 'user', content: input.input }) > limits.messageBytes) {
          throw new AgentFault('invalid_input', 'Nonempty identities, bounded input and positive integer maxSteps required');
        }
        const prior = history(input.history ?? []);
        const usedIds = new Set(prior.flatMap(m => m.role === 'assistant' ? m.toolCalls.map(c => c.id) : []));
        await append({ role: 'user', content: input.input });
        while (!sinkFailed) {
          if (signal.aborted) { reason = 'cancelled'; break; }
          if (steps >= input.maxSteps) { reason = 'budget_exhausted'; break; }
          const all = [...prior, ...messages];
          if (size(all) > limits.historyBytes) throw new AgentFault('context_limit', 'History exceeds context byte limit');
          steps++;
          await emit({ type: 'step_started', step: steps });
          try {
            if (sinkFailed) break;
            if (signal.aborted) { reason = 'cancelled'; break; }
            const request = snapshot({ ...scope, step: steps, messages: all, tools: definitions });
            let raw;
            try { raw = await options.provider.complete(request, signal); }
            catch (cause) {
              if (signal.aborted) { reason = 'cancelled'; break; }
              throw new AgentFault('provider_error', cause instanceof Error ? cause.message : String(cause));
            }
            if (signal.aborted) { reason = 'cancelled'; break; }
            const model = response(raw, usedIds);
            if (model.kind === 'final') {
              await append({ role: 'assistant', content: model.content, toolCalls: [] }, steps);
              reason = signal.aborted ? 'cancelled' : 'completed';
              break;
            }
            await append({ role: 'assistant', content: model.content, toolCalls: model.calls }, steps);
            let uncertain = false;
            for (const call of model.calls) {
              usedIds.add(call.id);
              let outcome: ToolOutcome;
              if (sinkFailed || uncertain || signal.aborted) {
                outcome = failed(signal.aborted ? 'cancelled_before_start' : 'not_started', 'Tool was not started');
              } else {
                const tool = tools.get(call.name);
                if (!tool) outcome = failed('unknown_tool', `Unknown tool: ${call.name}`);
                else {
                  // Validation has no effects. Unexpected execution failures conservatively
                  // preserve uncertainty and stop the batch; never retry a write.
                  try {
                    const invalid = tool.validate(call.arguments);
                    if (invalid) {
                      outcome = { ok: false, error: invalid };
                      if (!validOutcome(outcome)) outcome = failed('tool_protocol', 'Invalid tool validation result');
                    }
                    else {
                      await emit({ type: 'tool_started', step: steps, toolCallId: call.id, name: call.name });
                      if (sinkFailed || signal.aborted) outcome = failed('not_started', 'Tool was not started');
                      else {
                        try {
                          outcome = await tool.execute(call.arguments, { ...scope, step: steps, toolCallId: call.id }, signal);
                          if (!validOutcome(outcome)) outcome = failed('tool_protocol', 'Invalid tool result', 'unknown');
                        } catch (cause) {
                          outcome = failed('tool_exception', cause instanceof Error ? cause.message : String(cause), 'unknown');
                        }
                      }
                    }
                  } catch {
                    outcome = failed('tool_validation', 'Tool validation failed');
                  }
                }
              }
              if (!validOutcome(outcome)) outcome = failed('tool_protocol', 'Invalid tool failure result', 'unknown');
              if (!outcome.ok && outcome.error.effect === 'unknown') {
                uncertain = true;
                error ??= { code: outcome.error.code, message: outcome.error.message };
              }
              await append({ role: 'tool', toolCallId: call.id, name: call.name, outcome }, steps);
            }
            if (uncertain || sinkFailed) { reason = 'error'; break; }
            if (signal.aborted) { reason = 'cancelled'; break; }
          } finally {
            await emit({ type: 'step_ended', step: steps });
          }
        }
      } catch (cause) {
        error ??= { code: cause instanceof AgentFault ? cause.code : 'internal_error',
          message: cause instanceof Error ? cause.message : String(cause) };
        reason = 'error';
      }
      if (sinkFailed) reason = 'error';
      // If the sink rejects the terminal itself, replace that one in-memory
      // terminal with the truthful failure. Never recursively retry the sink.
      await emit({ type: 'turn_ended', reason, ...(error ? { errorCode: error.code } : {}) });
      if (sinkFailed) {
        reason = 'error';
        const last = events[events.length - 1];
        events[events.length - 1] = snapshot({ ...last, data: { type: 'turn_ended', reason, errorCode: error!.code } });
      }
      return snapshot({ ...scope, reason, messages, events, steps, ...(error ? { error } : {}) });
    },
  };
}
