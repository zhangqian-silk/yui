import type { ModelDiagnostic, ModelObservation } from './types.js';

/** Independent, optional UI/diagnostic wiring. No import or required dependency on observability. */
export function createModelObservationAdapter(sinks: {
  display?: (event: ModelObservation) => void | Promise<void>;
  diagnostics?: (event: ModelDiagnostic) => void | Promise<void>;
}): (event: ModelObservation) => void {
  const { display, diagnostics } = sinks;
  return event => {
    const invoke = (sink: (() => void | Promise<void>) | undefined): void => {
      try { if (sink) void Promise.resolve(sink()).catch(() => {}); } catch { /* Optional consumer. */ }
    };
    if (event.data.type === 'text_delta' || event.data.type === 'tool_delta') {
      invoke(display && (() => display(event)));
    } else if (event.data.type === 'attempt_finished' || event.data.type === 'retry') {
      const projected: ModelDiagnostic = { ...event, data: event.data };
      invoke(diagnostics && (() => diagnostics(projected)));
    }
    // Provisional usage frames are not separately counted; each attempt carries its reported usage.
  };
}
