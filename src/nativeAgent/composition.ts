import { createModelObservationAdapter, type ModelObservation } from './model/index.js';
import type { LocalObserver } from './observability/index.js';
import type { InteractionDiagnosticsPort } from './interaction/index.js';

/** Connect actual model evidence; never synthesize starts, usage or AgentEvent sequences. */
export function connectModelObservations(observer: LocalObserver, display?: (event: ModelObservation) => void) {
  return createModelObservationAdapter({
    display(event) {
      if (event.data.type === 'text_delta') observer.observeStream({ ...event, text: event.data.text }, event.source);
      display?.(event);
    },
    diagnostics(event) {
      const { sessionId, turnId, step, requestId, attempt, source, data } = event;
      const identity = { sessionId, turnId, step, requestId, attempt };
      if (data.type === 'retry') {
        observer.observeModel({ ...identity, phase: 'retry', retryAfterMs: data.delayMs }, source);
      } else {
        const r = data.record;
        observer.observeModel({
          ...identity, phase: 'ended',
          status: r.outcome === 'success' ? 'completed' : r.outcome === 'cancelled' ? 'cancelled'
            : r.effect === 'unknown' ? 'unknown' : 'error',
          ...(r.effect !== 'completed' ? { effect: r.effect } : {}),
          ...(r.outcome !== 'success' ? { errorCode: r.outcome } : {}),
          ...(r.usage ? { usage: r.usage } : {}),
          clientRequestId: r.clientRequestId,
          ...(r.providerRequestId ? { providerRequestId: r.providerRequestId } : {}),
          ...(r.status === undefined ? {} : { httpStatus: r.status }),
          elapsedMs: r.elapsedMs,
        }, source);
      }
    },
  });
}

/** UI offsets are opaque observation cursors, never message or session revisions. */
export function createInteractionDiagnostics(observer: LocalObserver): InteractionDiagnosticsPort {
  return {
    async query(sessionId, after, limit) {
      const page = observer.query({ sessionId, after, limit });
      const metadata = { gap: page.gap, evicted: page.evicted, closed: page.closed };
      const lines = page.records.map((record, i) => JSON.stringify(i ? record : { ...record, ...metadata }));
      if (!lines.length) lines.push(JSON.stringify(metadata));
      return { lines, nextOffset: page.nextCursor < page.throughCursor ? page.nextCursor : null };
    },
    async health() { return JSON.stringify(observer.health()); },
    subscribe(changed) { return observer.subscribe({ export() { changed(); } }); },
  };
}
