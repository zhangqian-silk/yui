import type { Message, ModelRequest, StepScope } from '../index.js';

export type ContextMaterial = {
  id: string;
  kind: 'guidance' | 'file' | 'data';
  content: string;
  source: string;
  revision: string;
  required: boolean;
};
/** Sources load only caller-selected material; they own authorization and resource cleanup. */
export interface ContextSource {
  id: string;
  load(scope: Readonly<StepScope>, signal: AbortSignal): Promise<readonly ContextMaterial[]>;
}
export interface ContextEstimator {
  id: string;
  /** Includes messages, tool definitions and request overhead. Capacity must use these same units. */
  estimate(request: ModelRequest): number;
}
export type ContextEntry = {
  source: string;
  revision: string;
  sourceId?: string;
  materialId?: string;
  historyRange?: readonly [number, number];
  action: 'retained' | 'summarized' | 'omitted';
  reason: string;
};
export interface ContextCompressor {
  id: string;
  /** Only optional atomic units are passed. Return plain summary text, never protocol messages. */
  summarize(unit: Readonly<{ entry: ContextEntry; messages: readonly Message[] }>, signal: AbortSignal): Promise<string>;
}
export type ContextReport = {
  estimator: string;
  compressor?: string;
  capacity: number;
  reserveOutput: number;
  availableInput: number;
  estimatedInput: number;
  entries: readonly ContextEntry[];
};
export type ContextInput = {
  request: ModelRequest;
  budget: { capacity: number; reserveOutput: number };
  /** In addition to all system messages and the latest user message through the end of history. */
  keepRecentGroups?: number;
};
export interface ContextBuilder {
  build(input: ContextInput, signal: AbortSignal): Promise<{ request: ModelRequest; report: ContextReport }>;
}
export class ContextBuildError extends Error {
  constructor(readonly code: string, message: string, readonly report?: ContextReport) { super(message); }
}

function frozen<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(item: unknown): void {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  }
  freeze(copy);
  return copy;
}
function fail(code: string, message: string): never { throw new ContextBuildError(code, message); }
function cancelled(signal: AbortSignal): void {
  if (signal.aborted) fail('cancelled', 'Context construction cancelled; no request produced');
}
function count(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
type Unit = { messages: readonly Message[]; required: boolean; entry: ContextEntry };

/** Deterministic approximation, not a provider tokenizer. Budgets are UTF-8 JSON bytes. */
export const jsonByteEstimator: ContextEstimator = Object.freeze({
  id: 'utf8-json-bytes',
  estimate: (request: ModelRequest) => Buffer.byteLength(JSON.stringify(request), 'utf8'),
});

function historyUnits(request: ModelRequest, keep: number): Unit[] {
  const messages = request.messages;
  const units: Unit[] = [];
  const used = new Set<string>();
  let latestUser = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user') latestUser = i;
  for (let i = 0; i < messages.length;) {
    const start = i;
    const m = messages[i++];
    if (!m || !['system', 'user', 'assistant'].includes(m.role) || !('content' in m)
      || typeof m.content !== 'string') fail('invalid_history', 'Unexpected or unpaired history message');
    if (m.role === 'assistant') {
      if (!Array.isArray(m.toolCalls)) fail('invalid_history', 'Missing assistant tool calls');
      const pending = new Map<string, string>();
      for (const call of m.toolCalls) {
        if (!nonempty(call.id) || !nonempty(call.name) || used.has(call.id))
          fail('invalid_history', 'Duplicate or invalid tool call identity');
        used.add(call.id);
        pending.set(call.id, call.name);
      }
      while (pending.size) {
        const result = messages[i++];
        if (!result || result.role !== 'tool' || !pending.has(result.toolCallId)
          || pending.get(result.toolCallId) !== result.name || !result.outcome
          || (result.outcome.ok !== true && result.outcome.ok !== false))
          fail('invalid_history', 'Tool batch requires exactly one matching result per call');
        pending.delete(result.toolCallId);
      }
    }
    const required = m.role === 'system' || (latestUser >= 0 && start >= latestUser);
    units.push({ messages: messages.slice(start, i), required, entry: {
      source: 'history', revision: `${request.sessionId}/${request.turnId}/${request.step}`,
      historyRange: [start, i], action: 'retained', reason: required ? 'system-or-current-input' : 'within-budget',
    } });
  }
  for (const unit of units.slice(Math.max(0, units.length - keep))) {
    unit.required = true;
    unit.entry.reason = 'recent-group';
  }
  return units;
}

export function createContextBuilder(options: {
  sources?: readonly ContextSource[];
  estimator?: ContextEstimator;
  compressor?: ContextCompressor;
} = {}): ContextBuilder {
  const sources = [...(options.sources ?? [])];
  const estimator = options.estimator ?? jsonByteEstimator;
  const compressor = options.compressor;
  if (!nonempty(estimator.id) || (compressor && !nonempty(compressor.id))
    || sources.some(s => !nonempty(s.id)) || new Set(sources.map(s => s.id)).size !== sources.length)
    fail('invalid_options', 'Extensions require nonempty unique source identities');
  return {
    async build(input, signal) {
      cancelled(signal);
      const { capacity, reserveOutput } = input.budget;
      const keep = input.keepRecentGroups ?? 2;
      if (!count(capacity) || !count(reserveOutput) || reserveOutput > capacity || !count(keep))
        fail('invalid_budget', 'Capacity, output reserve and retention must be nonnegative safe integers');
      // Snapshot before the first await; extensions never receive caller-owned history.
      const request = frozen(input.request);
      const units = historyUnits(request, keep);
      const scope = frozen({ sessionId: request.sessionId, turnId: request.turnId, step: request.step });
      const materials: Unit[] = [];
      for (const source of sources) {
        cancelled(signal);
        let loaded: readonly ContextMaterial[];
        try { loaded = frozen(await source.load(scope, signal)); }
        catch { cancelled(signal); fail('source_failed', `Context source failed: ${source.id}`); }
        cancelled(signal);
        if (!Array.isArray(loaded)) fail('invalid_material', `Invalid source output: ${source.id}`);
        const ids = new Set<string>();
        for (const material of loaded) {
          if (!material || !nonempty(material.id) || ids.has(material.id) || !nonempty(material.source)
            || !nonempty(material.revision) || typeof material.content !== 'string'
            || typeof material.required !== 'boolean' || !['guidance', 'file', 'data'].includes(material.kind))
            fail('invalid_material', `Invalid material from source: ${source.id}`);
          ids.add(material.id);
          materials.push({
            messages: [{ role: material.kind === 'guidance' ? 'system' : 'user',
              content: JSON.stringify({ contextMaterial: { ...material, loader: source.id } }) }],
            required: material.required || material.kind === 'guidance',
            entry: { source: material.source, revision: material.revision, sourceId: source.id,
              materialId: material.id, action: 'retained',
              reason: material.required || material.kind === 'guidance' ? 'required-material' : 'within-budget' },
          });
        }
      }
      // Material order is explicit; history order remains unchanged.
      const all = [...materials, ...units];
      const makeRequest = (): ModelRequest => frozen({ ...request, messages: all.flatMap(u => [...u.messages]) });
      const estimate = (): number => {
        cancelled(signal);
        let n: number;
        try { n = estimator.estimate(makeRequest()); }
        catch { cancelled(signal); fail('estimation_failed', `Context estimator failed: ${estimator.id}`); }
        cancelled(signal);
        if (!count(n)) fail('invalid_estimate', 'Estimator must return a nonnegative safe integer');
        return n;
      };
      const availableInput = capacity - reserveOutput;
      let estimatedInput = estimate();
      // Old history is sacrificed first, then optional materials in caller order.
      for (const unit of [...units, ...materials]) {
        if (estimatedInput <= availableInput) break;
        if (unit.required) continue;
        if (compressor) {
          cancelled(signal);
          let summary: string;
          try { summary = await compressor.summarize(frozen({ entry: unit.entry, messages: unit.messages }), signal); }
          catch { cancelled(signal); fail('compression_failed', `Context compressor failed: ${compressor.id}`); }
          cancelled(signal);
          if (!nonempty(summary)) fail('invalid_summary', 'Compressor must return nonempty plain text');
          unit.messages = [{ role: 'user', content: JSON.stringify({
            contextSummary: { source: unit.entry.source, revision: unit.entry.revision, sourceId: unit.entry.sourceId,
              historyRange: unit.entry.historyRange, materialId: unit.entry.materialId,
              compressor: compressor.id, summary },
          }) }];
          const summarizedEstimate = estimate();
          if (summarizedEstimate < estimatedInput) {
            unit.entry.action = 'summarized';
            unit.entry.reason = 'budget-compression';
            estimatedInput = summarizedEstimate;
            if (estimatedInput <= availableInput) break;
          }
        }
        unit.messages = [];
        unit.entry.action = 'omitted';
        unit.entry.reason = 'budget-oldest-optional';
        estimatedInput = estimate();
      }
      const report = frozen({ estimator: estimator.id, ...(compressor ? { compressor: compressor.id } : {}),
        capacity, reserveOutput, availableInput, estimatedInput, entries: all.map(u => u.entry) });
      if (estimatedInput > availableInput)
        throw new ContextBuildError('budget_exceeded', 'Required context and request overhead exceed available input budget', report);
      cancelled(signal);
      return frozen({ request: makeRequest(), report });
    },
  };
}
