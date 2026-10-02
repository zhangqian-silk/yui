import type { Agent, AgentEvent, AgentOptions, EndReason, EventData, Message, ModelRequest, RecordingStatus, ToolOutcome, TurnResult } from './contracts.js';
import { createToolExecutor, type ToolSettlement } from './toolManager/index.js';
import { createContextBuilder, ContextBuildError } from './context/index.js';
import { AgentFault, history, limits, response, size, snapshot, validOutcome } from './validation.js';

const failed = (code: string, message: string, effect: 'none' | 'unknown' = 'none'): ToolOutcome =>
  ({ ok: false, error: { code, message, effect } });

export function createAgent(options: AgentOptions): Agent {
  if (!options.provider || typeof options.provider.complete !== 'function'
    || (options.tools === undefined) === (options.toolExecutor === undefined)) {
    throw new Error('A provider and exactly one of tools or toolExecutor are required');
  }
  // tools is an explicitly preauthorized, prebound capability set. This lease
  // owns no resources and does not pretend to narrow those tools' authority.
  const executor = options.toolExecutor ?? createToolExecutor({
    tools: options.tools!,
    environment: { async acquire() { return { value: undefined, async release() {} }; } },
    permission: { async check() { return { allowed: true }; } },
  });
  const definitions = snapshot(executor.definitions);
  if (typeof executor.executeBatch !== 'function' || !Array.isArray(definitions)
    || definitions.some(d => !d || typeof d.name !== 'string' || !d.name.trim())
    || new Set(definitions.map(d => d.name)).size !== definitions.length) {
    throw new Error('An executor with unique nonempty tool definitions is required');
  }
  const { provider, recorder, observer } = options;
  const contextBuilder = options.contextBuilder ?? createContextBuilder();
  const contextBudget = snapshot(options.contextBudget ?? { capacity: limits.historyBytes, reserveOutput: 0 });
  return {
    async runTurn(input): Promise<TurnResult> {
      const scope = { sessionId: input.sessionId, turnId: input.turnId };
      const signal = input.signal ?? new AbortController().signal;
      const { maxSteps, input: userInput } = input;
      const messages: Message[] = [];
      const events: AgentEvent[] = [];
      const contextReports: Array<TurnResult['contextReports'][number]> = [];
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
      const append = async (message: Message, step?: number, settlement?: ToolSettlement): Promise<void> => {
        const saved = snapshot(message);
        messages.push(saved);
        await emit({ type: 'message_appended', step, message: saved, ...(settlement ? { settlement } : {}) });
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
            let request: ModelRequest;
            try {
              const built = await contextBuilder.build({ request: source, budget: contextBudget }, signal);
              if (signal.aborted) { reason = 'cancelled'; break; }
              if (built.request.sessionId !== scope.sessionId || built.request.turnId !== scope.turnId
                || built.request.step !== steps || JSON.stringify(built.request.tools) !== JSON.stringify(definitions)) {
                throw new Error('Context builder changed execution identity or tool definitions');
              }
              request = snapshot({ ...built.request, messages: history(built.request.messages, Infinity) });
              contextReports.push(snapshot({ step: steps, status: 'prepared', report: built.report }));
            } catch (cause) {
              if (cause instanceof ContextBuildError && cause.report) {
                contextReports.push(snapshot({ step: steps, status: 'failed', report: cause.report }));
              }
              if (signal.aborted) { reason = 'cancelled'; break; }
              throw new AgentFault('context_error', cause instanceof Error ? cause.message : String(cause));
            }
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
            const settled = new Map<string, ToolSettlement>();
            let batchFailed = false;
            const acceptSettlement = async (settlement: ToolSettlement): Promise<void> => {
              const call = model.calls[settled.size];
              if (!call || settlement.identity.sessionId !== scope.sessionId
                || settlement.identity.turnId !== scope.turnId || settlement.identity.step !== steps
                || settlement.identity.toolCallId !== call.id || settlement.identity.name !== call.name
                || !validOutcome(settlement.outcome) || typeof settlement.started !== 'boolean'
                || !['not_acquired', 'released', 'failed', 'acquire_failed'].includes(settlement.cleanup?.status)) {
                throw new Error('Executor returned an invalid or out-of-order settlement');
              }
              const saved = snapshot(settlement);
              settled.set(call.id, saved);
              await append({ role: 'tool', toolCallId: call.id, name: call.name, outcome: saved.outcome }, steps, saved);
            };
            if (!recordingFailed && !signal.aborted) {
              try {
                const batch = await executor.executeBatch({
                  calls: model.calls, scope: snapshot({ ...scope, step: steps }), signal,
                  async beforeExecute(identity) {
                    const call = model.calls[settled.size];
                    if (!call || identity.sessionId !== scope.sessionId || identity.turnId !== scope.turnId
                      || identity.step !== steps || identity.toolCallId !== call.id || identity.name !== call.name)
                      throw new Error('Executor intent identity does not match the next call');
                    if (recordingFailed || signal.aborted) throw new Error('Turn no longer permits a new tool effect');
                    await emit({ type: 'tool_started', step: steps, toolCallId: call.id, name: call.name });
                    if (recordingFailed || signal.aborted) throw new Error('Required intent recording or cancellation stopped execution');
                  },
                  async afterExecute(settlement) {
                    await acceptSettlement(settlement);
                    if (recordingFailed) throw new Error('Required settlement recording failed; do not start further effects');
                  },
                });
                if (batch.results.length !== model.calls.length) throw new Error('Executor omitted settlements');
                for (const settlement of batch.results) {
                  const recorded = settled.get(settlement.identity.toolCallId);
                  if (recorded) {
                    if (JSON.stringify(recorded) !== JSON.stringify(settlement)) throw new Error('Executor changed a recorded settlement');
                  } else await acceptSettlement(settlement);
                }
                batchFailed = !!batch.recordingError || (batch.stopped !== null && batch.stopped !== 'cancelled');
                if (batchFailed) {
                  const unknown = batch.results.find(r => !r.outcome.ok && r.outcome.error.effect === 'unknown')?.outcome;
                  error ??= unknown && !unknown.ok ? unknown.error : {
                    code: batch.recordingError?.code ?? batch.stopped!,
                    message: batch.recordingError?.message ?? `Tool batch stopped: ${batch.stopped}; inspect settlement evidence`,
                  };
                }
              } catch (cause) {
                batchFailed = true;
                error ??= { code: 'tool_protocol', message: cause instanceof Error ? cause.message : String(cause) };
              }
            }
            for (const call of model.calls) {
              usedIds.add(call.id);
              const receipt = settled.get(call.id);
              const outcome = receipt?.outcome ?? (batchFailed
                ? failed('tool_protocol', 'Executor did not return a confirmed settlement', 'unknown')
                : failed(signal.aborted ? 'cancelled_before_start' : 'not_started', 'Tool was not started'));
              if (!outcome.ok && outcome.error.effect === 'unknown') {
                uncertain = true;
                error ??= { code: outcome.error.code, message: outcome.error.message };
              }
              if (!receipt) await append({ role: 'tool', toolCallId: call.id, name: call.name, outcome }, steps);
            }
            if (uncertain || recordingFailed || batchFailed) { reason = 'error'; break; }
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
      return snapshot({ ...scope, reason, messages, events, steps, recording, observerErrors, contextReports, ...(error ? { error } : {}) });
    },
  };
}
