/** Optional, derived observations. Never a session store or recovery input. */
import type { AgentEvent, Scope, StepScope, TurnResult } from '../index.js';

export type ObservationSource = 'live' | 'replay' | 'cached';
export type Usage = Readonly<{ inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; totalTokens?: number }>;
export type ModelObservation = StepScope & {
  requestId: string;
  attempt: number;
  phase: 'started' | 'ended' | 'retry';
  status?: 'completed' | 'error' | 'cancelled' | 'unknown';
  effect?: 'none' | 'unknown';
  usage?: Usage;
  errorCode?: string;
  retryAfterMs?: number;
  clientRequestId?: string;
  providerRequestId?: string;
  httpStatus?: number;
  /** Producer's cumulative logical-call elapsed time, not observation duration. */
  elapsedMs?: number;
};
export type Observation = Readonly<Scope & {
  cursor: number;
  observedAt: number;
  source: ObservationSource;
  kind: 'event' | 'snapshot' | 'model' | 'stream';
  completeness: 'event' | 'snapshot' | 'provisional';
  type: string;
  eventSeq?: number;
  step?: number;
  requestId?: string;
  attempt?: number;
  toolCallId?: string;
  name?: string;
  role?: string;
  status?: string;
  effect?: 'none' | 'unknown';
  errorCode?: string;
  usage?: Usage;
  retryAfterMs?: number;
  clientRequestId?: string;
  providerRequestId?: string;
  httpStatus?: number;
  elapsedMs?: number;
  durationMs?: number;
  messageCount?: number;
  unknownEffects?: number;
  /** Content is never retained. This count is not a token or usage estimate. */
  textCharacters?: number;
}>;
export interface ObservationConsumer {
  /** Cooperative cancellation only. Consumer owns and closes its resources. */
  export(record: Observation, signal: AbortSignal): void | Promise<void>;
}
export type ObservationQuery = Partial<Scope> & {
  requestId?: string;
  toolCallId?: string;
  after?: number;
  limit?: number;
};
export interface LocalObserver {
  observeEvent(event: AgentEvent, source?: ObservationSource): boolean;
  observeSnapshot(result: TurnResult, source?: ObservationSource): boolean;
  observeModel(model: ModelObservation, source?: ObservationSource): boolean;
  observeStream(stream: StepScope & { requestId?: string; text: string }, source?: ObservationSource): boolean;
  /** Optional synchronous AgentObserver port; exporters are never awaited. */
  observe(event: AgentEvent): void;
  query(query?: ObservationQuery): {
    records: readonly Observation[]; nextCursor: number; throughCursor: number;
    evicted: number; gap: boolean; closed: boolean;
  };
  health(): Readonly<{
    retained: number; evicted: number; rejected: number; closed: boolean;
    subscribers: number; inFlight: number; consumerDropped: number; consumerFailures: number;
  }>;
  subscribe(consumer: ObservationConsumer): () => void;
  close(): void;
}

type Draft = Omit<Observation, 'cursor' | 'observedAt' | 'source' | 'durationMs'>;
const integer = (value: number, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('Invalid observation number');
  return value;
};
const label = (value: string): string => {
  // Opaque correlation labels, never user text, paths, credentials or error details.
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 256) {
    throw new Error('Invalid observation label');
  }
  return value;
};
function choice<T extends string>(value: T, allowed: readonly T[]): T {
  if (!allowed.includes(value)) throw new Error('Invalid observation tag');
  return value;
}
const statuses = ['completed', 'error', 'cancelled', 'unknown'] as const;
const reasons = ['completed', 'error', 'cancelled', 'budget_exhausted'] as const;
const effects = ['none', 'unknown'] as const;
const scopeOf = (value: Scope): Scope => ({ sessionId: label(value.sessionId), turnId: label(value.turnId) });
function usageOf(usage: Usage): Usage {
  const result: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; totalTokens?: number } = {};
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens'] as const) {
    if (usage[key] !== undefined) result[key] = integer(usage[key]);
  }
  return Object.freeze(result);
}

/**
 * A bounded local projection, not a durable database. The injected clock should
 * be monotonic milliseconds; durations describe observation arrival, not provider
 * wall time. Replay/cache never acquire synthetic durations.
 */
export function createLocalObserver(options: { capacity?: number; clock?: () => number } = {}): LocalObserver {
  const capacity = integer(options.capacity ?? 512, 10_000);
  if (!capacity) throw new Error('Observation capacity must be positive');
  const clock = options.clock ?? (() => performance.now());
  const records: Observation[] = [];
  const subscribers = new Set<{ consumer: ObservationConsumer; controller: AbortController; busy: boolean }>();
  const pending = new Set<AbortController>();
  let cursor = 0, evicted = 0, rejected = 0, consumerDropped = 0, consumerFailures = 0;
  let closed = false;

  function duration(draft: Draft, source: ObservationSource, now: number): number | undefined {
    if (source !== 'live') return;
    const startType = draft.type === 'turn_ended' ? 'turn_started'
      : draft.type === 'step_ended' ? 'step_started'
        : draft.kind === 'model' && draft.type === 'ended' ? 'started'
          : draft.kind === 'event' && draft.type === 'message_appended' && draft.role === 'tool' ? 'tool_started' : undefined;
    if (!startType) return;
    for (let i = records.length - 1; i >= 0; i--) {
      const prior = records[i];
      if (prior.source !== 'live' || prior.kind !== draft.kind ||
          prior.sessionId !== draft.sessionId || prior.turnId !== draft.turnId ||
          prior.step !== draft.step || prior.requestId !== draft.requestId || prior.attempt !== draft.attempt ||
          prior.toolCallId !== draft.toolCallId) continue;
      // Repeated terminal reports cannot create another measured interval.
      if (prior.type === draft.type) return;
      if (prior.type === startType) return now >= prior.observedAt ? now - prior.observedAt : undefined;
    }
  }
  function append(make: () => Draft, source: ObservationSource): boolean {
    if (closed) return false;
    try {
      if (!['live', 'replay', 'cached'].includes(source)) throw new Error('Invalid source');
      const draft = make();
      const now = clock();
      if (!Number.isFinite(now)) throw new Error('Invalid clock');
      const elapsed = duration(draft, source, now);
      const record: Observation = Object.freeze({
        ...draft, source, observedAt: now, cursor: ++cursor,
        ...(elapsed === undefined ? {} : { durationMs: elapsed }),
      });
      if (records.length === capacity) { records.shift(); evicted++; }
      records.push(record);
      for (const subscriber of subscribers) {
        if (subscriber.busy || pending.size >= 32) { consumerDropped++; continue; }
        subscriber.busy = true;
        pending.add(subscriber.controller);
        void Promise.resolve().then(() => {
          if (!subscriber.controller.signal.aborted) {
            return subscriber.consumer.export(record, subscriber.controller.signal);
          }
        }).catch(() => { consumerFailures++; }).finally(() => {
          subscriber.busy = false;
          pending.delete(subscriber.controller);
        });
      }
      return true;
    } catch {
      // Never leak exception text (which may contain credentials), nor reject the
      // kernel's required fact sink. Failure remains visible in health().
      rejected++;
      return false;
    }
  }
  const observer: LocalObserver = {
    observeEvent(event, source = 'live') {
      return append(() => {
        const data = event.data;
        const record: Draft = {
          ...scopeOf(event), kind: 'event', completeness: 'event',
          type: choice(data.type, ['turn_started', 'step_started', 'message_appended', 'tool_started', 'step_ended', 'turn_ended']),
          eventSeq: integer(event.seq),
          ...('step' in data && data.step !== undefined ? { step: integer(data.step) } : {}),
        };
        if (data.type === 'turn_ended') {
          return { ...record, status: choice(data.reason, reasons), ...(data.errorCode ? { errorCode: label(data.errorCode) } : {}) };
        }
        if (data.type === 'tool_started') {
          return { ...record, toolCallId: label(data.toolCallId), name: label(data.name) };
        }
        if (data.type === 'message_appended') {
          const message = data.message;
          if (message.role === 'tool') {
            return { ...record, role: message.role, toolCallId: label(message.toolCallId), name: label(message.name),
              ...(message.outcome.ok ? { status: 'completed' } : {
                status: 'error', effect: choice(message.outcome.error.effect, effects), errorCode: label(message.outcome.error.code),
              }) };
          }
          return { ...record, role: choice(message.role, ['system', 'user', 'assistant']) };
        }
        return record;
      }, source);
    },
    observeSnapshot(result, source = 'live') {
      return append(() => ({
        ...scopeOf(result), kind: 'snapshot', completeness: 'snapshot', type: 'turn_result',
        status: choice(result.reason, reasons), messageCount: result.messages.length,
        unknownEffects: result.messages.filter(m => m.role === 'tool' && !m.outcome.ok && m.outcome.error.effect === 'unknown').length,
        ...(result.error ? { errorCode: label(result.error.code) } : {}),
      }), source);
    },
    observeModel(model, source = 'live') {
      return append(() => ({
        ...scopeOf(model), kind: 'model', completeness: 'event', type: choice(model.phase, ['started', 'ended', 'retry']),
        step: integer(model.step), requestId: label(model.requestId), attempt: integer(model.attempt),
        ...(model.status ? { status: choice(model.status, statuses) } : {}),
        ...(model.effect ? { effect: choice(model.effect, effects) } : {}),
        ...(model.errorCode ? { errorCode: label(model.errorCode) } : {}),
        ...(model.usage ? { usage: usageOf(model.usage) } : {}),
        ...(model.retryAfterMs === undefined ? {} : { retryAfterMs: integer(model.retryAfterMs) }),
        ...(model.clientRequestId === undefined ? {} : { clientRequestId: label(model.clientRequestId) }),
        ...(model.providerRequestId === undefined ? {} : { providerRequestId: label(model.providerRequestId) }),
        ...(model.httpStatus === undefined ? {} : { httpStatus: integer(model.httpStatus, 599) }),
        ...(model.elapsedMs === undefined ? {} : { elapsedMs: (() => {
          if (!Number.isFinite(model.elapsedMs) || model.elapsedMs < 0) throw new Error('Invalid elapsed time');
          return model.elapsedMs;
        })() }),
      }), source);
    },
    observeStream(stream, source = 'live') {
      return append(() => ({
        ...scopeOf(stream), kind: 'stream', completeness: 'provisional', type: 'text_delta',
        step: integer(stream.step), textCharacters: stream.text.length,
        ...(stream.requestId ? { requestId: label(stream.requestId) } : {}),
      }), source);
    },
    observe(event) { observer.observeEvent(event); },
    query(query = {}) {
      const after = integer(query.after ?? 0);
      const limit = integer(query.limit ?? 100, 1000);
      if (!limit) throw new Error('Query limit must be positive');
      const matches = records.filter(record => record.cursor > after &&
        (query.sessionId === undefined || record.sessionId === query.sessionId) &&
        (query.turnId === undefined || record.turnId === query.turnId) &&
        (query.requestId === undefined || record.requestId === query.requestId) &&
        (query.toolCallId === undefined || record.toolCallId === query.toolCallId));
      const page = Object.freeze(matches.slice(0, limit));
      return { records: page, nextCursor: matches.length > limit ? page[page.length - 1].cursor : Math.max(cursor, after),
        throughCursor: cursor, evicted, gap: after < (records[0]?.cursor ?? 1) - 1, closed };
    },
    health() {
      return Object.freeze({ retained: records.length, evicted, rejected, closed, subscribers: subscribers.size,
        inFlight: pending.size, consumerDropped, consumerFailures });
    },
    subscribe(consumer) {
      if (closed || subscribers.size >= 32) throw new Error('Observer closed or subscriber limit reached');
      const subscriber = { consumer, controller: new AbortController(), busy: false };
      subscribers.add(subscriber);
      return () => { subscribers.delete(subscriber); subscriber.controller.abort(); };
    },
    close() {
      closed = true;
      for (const subscriber of subscribers) subscriber.controller.abort();
      subscribers.clear();
      // Unsubscribed but unsettled consumers are still owned cancellation targets.
      for (const controller of pending) controller.abort();
    },
  };
  return observer;
}

/** Caller owns the destination and its lifecycle; errors are isolated by subscribe. */
export function createJsonlExporter(
  write: (line: string, signal: AbortSignal) => void | Promise<void>,
): ObservationConsumer {
  return { async export(record, signal) {
    if (!signal.aborted) await write(`${JSON.stringify(record)}\n`, signal);
  } };
}
