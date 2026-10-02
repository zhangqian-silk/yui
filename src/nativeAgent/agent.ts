import type { Agent, AgentEvent, AgentOptions, EndReason, EventData, Message, RecordingStatus, ToolOutcome, TurnResult } from './contracts.js';
import { createToolExecutor } from './toolExecutor.js';
import { AgentFault, history, limits, response, size, snapshot, validOutcome } from './validation.js';

const failed = (code: string, message: string, effect: 'none' | 'unknown' = 'none'): ToolOutcome =>
  ({ ok: false, error: { code, message, effect } });

export function createAgent(options: AgentOptions): Agent {
  if (!options.provider || typeof options.provider.complete !== 'function'
    || (options.tools === undefined) === (options.toolExecutor === undefined)) {
    throw new Error('A provider and exactly one of tools or toolExecutor are required');
  }
  const executor = options.toolExecutor ?? createToolExecutor(options.tools!);
  const definitions = snapshot(executor.definitions);
  if (typeof executor.execute !== 'function' || !Array.isArray(definitions)
    || definitions.some(d => !d || typeof d.name !== 'string' || !d.name.trim())
    || new Set(definitions.map(d => d.name)).size !== definitions.length) {
    throw new Error('An executor with unique nonempty tool definitions is required');
  }
  const names = new Set(definitions.map(d => d.name));
  const { provider, contextBuilder, recorder, observer } = options;
  return {
    async runTurn(input): Promise<TurnResult> {
      const scope = { sessionId: input.sessionId, turnId: input.turnId };
      const signal = input.signal ?? new AbortController().signal;
      const { maxSteps, input: userInput } = input;
      const messages: Message[] = [];
      const events: AgentEvent[] = [];
      let steps = 0;
      let reason: EndReason = 'error';
      let error: TurnResult['error'];
      let recording: RecordingStatus = recorder
        ? { status: 'recorded', lastRecordedSeq: 0 } : { status: 'memory', lastRecordedSeq: 0 };
      let recordingFailed = false;
      const observerErrors: { seq: number; message: string }[] = [];
      const emit = async (data: EventData): Promise<void> => {
        let event = snapshot({ ...scope, seq: events.length + 1, data });
        events.push(event);
        if (recorder && !recordingFailed) {
          try {
            await recorder.record(event);
            recording = { status: 'recorded', lastRecordedSeq: event.seq };
          }
          catch (cause) {
            recordingFailed = true;
            recording = { status: 'failed', lastRecordedSeq: recording.lastRecordedSeq, failedSeq: event.seq };
            error = { code: 'recording_failed',
              message: `Required recording failed: ${cause instanceof Error ? cause.message : String(cause)}; inspect recorder before recovery` };
          }
        }
        // A failed terminal write has unknown external persistence. Publish
        // exactly one truthful local terminal to observers and the caller.
        if (data.type === 'turn_ended' && recordingFailed) {
          reason = 'error';
          event = snapshot({ ...event, data: { type: 'turn_ended', reason, errorCode: error!.code } });
          events[events.length - 1] = event;
        }
        // Observers enqueue synchronously. Never await display/telemetry delivery.
        // Detach an invalid async consumer and observe its rejection without
        // misrepresenting notification as transport or persistence confirmation.
        if (observer && !observerErrors.length) {
          try {
            const returned: unknown = observer.observe(event);
            if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
              void Promise.resolve(returned).catch(() => {});
              throw new Error('Observer must return synchronously; enqueue asynchronous transport in the consumer');
            }
          } catch (cause) {
            observerErrors.push({ seq: event.seq, message: cause instanceof Error ? cause.message : String(cause) });
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
          || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || typeof userInput !== 'string'
          || size({ role: 'user', content: userInput }) > limits.messageBytes) {
          throw new AgentFault('invalid_input', 'Nonempty identities, bounded input and positive integer maxSteps required');
        }
        // Canonical history can exceed the model request budget. The context
        // builder may project it, but must not hide unresolved effects or IDs.
        const prior = history(input.history ?? [], Infinity);
        if (prior.some(m => m.role === 'tool' && !m.outcome.ok && m.outcome.error.effect === 'unknown')) {
          throw new AgentFault('unresolved_effect', 'History contains an unknown tool effect; reconcile it explicitly before continuing');
        }
        const usedIds = new Set(prior.flatMap(m => m.role === 'assistant' ? m.toolCalls.map(c => c.id) : []));
        await append({ role: 'user', content: userInput });
        while (!recordingFailed) {
          if (signal.aborted) { reason = 'cancelled'; break; }
          if (steps >= maxSteps) { reason = 'budget_exhausted'; break; }
          const all = [...prior, ...messages];
          steps++;
          await emit({ type: 'step_started', step: steps });
          try {
            if (recordingFailed) break;
            if (signal.aborted) { reason = 'cancelled'; break; }
            const source = snapshot({ ...scope, step: steps, messages: all, tools: definitions });
            let context;
            try {
              const built = contextBuilder ? await contextBuilder.build(source, signal) : source.messages;
              if (signal.aborted) { reason = 'cancelled'; break; }
              context = history(built, Infinity);
            } catch (cause) {
              if (signal.aborted) { reason = 'cancelled'; break; }
              throw new AgentFault('context_error', cause instanceof Error ? cause.message : String(cause));
            }
            const request = snapshot({ ...source, messages: context });
            if (size(request) > limits.historyBytes) {
              throw new AgentFault('context_limit', 'Model request exceeds context byte limit');
            }
            let raw;
            try { raw = await provider.complete(request, signal); }
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
              if (recordingFailed || uncertain || signal.aborted) {
                outcome = failed(signal.aborted ? 'cancelled_before_start' : 'not_started', 'Tool was not started');
              } else {
                if (!names.has(call.name)) outcome = failed('unknown_tool', `Unknown tool: ${call.name}`);
                else {
                  await emit({ type: 'tool_started', step: steps, toolCallId: call.id, name: call.name });
                  if (recordingFailed || signal.aborted) outcome = failed('not_started', 'Tool was not started');
                  else {
                    try {
                      outcome = await executor.execute(call, snapshot({ ...scope, step: steps }), signal);
                      if (!validOutcome(outcome)) outcome = failed('tool_protocol', 'Invalid tool result', 'unknown');
                    } catch (cause) {
                      outcome = failed('tool_exception', cause instanceof Error ? cause.message : String(cause), 'unknown');
                    }
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
            if (uncertain || recordingFailed) { reason = 'error'; break; }
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
      if (recordingFailed) reason = 'error';
      await emit({ type: 'turn_ended', reason, ...(error ? { errorCode: error.code } : {}) });
      return snapshot({ ...scope, reason, messages, events, steps, recording, observerErrors, ...(error ? { error } : {}) });
    },
  };
}
