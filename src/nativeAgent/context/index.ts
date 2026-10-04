import { createHash } from 'node:crypto';
import type { Message, ModelRequest, StepScope } from '../contracts.js';
import { history, limits, size } from '../validation.js';
import { budgetBounds, measure, validCount, type ContextBudget, type ContextCounter,
  type ContextCapacitySource, type ContextCapacity, type ContextMeasurement } from './budget.js';
export type { ContextBudget, ContextCounter, ContextCapacitySource, ContextCapacity, ContextMeasurement, ContextUnit } from './budget.js';
export { createProviderCompressor } from './providerCompressor.js';
export type { ProviderCompressorOptions } from './providerCompressor.js';

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
  digest?: string;
  toolOutcomes?: readonly { toolCallId: string; name: string; ok: boolean; errorCode?: string; effect?: 'none' | 'unknown' }[];
  action: 'retained' | 'summarized' | 'omitted';
  reason: string;
};
export interface ContextCompressor {
  id: string;
  /** Selected older groups, never trusted guidance or protected anchors. No group may be split. */
  summarize(unit: Readonly<{ entry: ContextEntry; messages: readonly Message[];
    groups?: readonly (readonly Message[])[] }>, signal: AbortSignal): Promise<string>;
}
export type ContextReport = {
  estimator: string;
  compressor?: string;
  capacity: number;
  reserveOutput: number;
  reserveTools: number;
  safetyMargin: number;
  availableInput: number;
  estimatedInput: number;
  measurement: ContextMeasurement;
  model?: ContextCapacity;
  capacitySource?: string;
  historyDigest: string;
  byteInput: number;
  baseReceipt?: ContextInput['baseReceipt'];
  entries: readonly ContextEntry[];
};
export type ContextInput = {
  request: ModelRequest;
  budget: ContextBudget;
  /** In addition to all system messages, first user goal and latest user through the end of history. */
  keepRecentGroups?: number;
  /** Explicit user-selected constraints/anchors, indexed into the original full history. */
  protectedHistoryRanges?: readonly (readonly [number, number])[];
  mode?: 'auto' | 'manual';
  /** Receipt of the stored prefix only; appended live messages are covered by historyDigest. */
  baseReceipt?: { sessionId: string; revision: number; digest: string; messageCount: number };
};
export interface ContextBuilder {
  build(input: ContextInput, signal: AbortSignal): Promise<{ request: ModelRequest; report: ContextReport }>;
  /** Discard only disposable derived data, e.g. when an owner cannot verify a manual projection. */
  discard?(sessionId: string): void;
}
export class ContextBuildError extends Error {
  readonly recovery: string;
  constructor(readonly code: string, message: string, readonly report?: ContextReport) {
    const recovery = code === 'cancelled' ? 'Wait for started summarization to settle; retry explicitly from saved history.'
      : ['storage_failed', 'session_recovery_required', 'history_changed'].includes(code)
        ? 'Inspect the exact SessionStore receipt, unsettled effects and original failure; reload/reconcile saved facts without replaying tools.'
        : code === 'byte_budget_exceeded'
          ? 'Reduce the projected request or use a smaller summary; the independent kernel byte ceiling cannot be raised by model capacity.'
      : ['count_unknown', 'capacity_mismatch', 'capacity_changed', 'invalid_estimate', 'estimation_failed', 'capacity_failed'].includes(code)
        ? 'Refresh model capability and supply a matching complete-request counter with explicit uncertainty; rebuild.'
        : ['budget_exceeded', 'summary_input_exceeded', 'summary_budget_exhausted', 'compression_no_gain'].includes(code)
          ? 'Inspect retained anchors and tool groups; choose a larger authorized capacity or a bounded summary strategy. Do not truncate or replay tools.'
          : 'Inspect the failed source/compressor and authoritative history; correct it and explicitly rebuild. No projection or tool replay was installed.';
    super(`${code}: ${message}. ${recovery}`);
    this.recovery = recovery;
  }
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
const count = validCount;
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
type Unit = { messages: readonly Message[]; required: boolean; entry: ContextEntry };
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Deterministic approximation, not a provider tokenizer. Budgets are UTF-8 JSON bytes. */
export const jsonByteEstimator: ContextEstimator = Object.freeze({
  id: 'utf8-json-bytes',
  estimate: (request: ModelRequest) => Buffer.byteLength(JSON.stringify(request), 'utf8'),
});

function historyUnits(request: ModelRequest, keep: number, ranges: ContextInput['protectedHistoryRanges']): Unit[] {
  const messages = request.messages;
  try { history(messages, Infinity); }
  catch { fail('invalid_history', 'Source history must contain valid, bounded messages and complete tool batches'); }
  const historyRevision = `sha256:${digest(messages)}`;
  const units: Unit[] = [];
  const used = new Set<string>();
  let latestUser = -1;
  let firstUser = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user') {
    latestUser = i;
    if (firstUser < 0) firstUser = i;
  }
  for (const range of ranges ?? []) if (range.length !== 2 || !count(range[0]) || !count(range[1])
    || range[0] >= range[1] || range[1] > messages.length)
    fail('invalid_history', 'Protected history ranges must be valid original [start,end) bounds');
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
        if (!result.outcome.ok && result.outcome.error.effect === 'unknown')
          fail('unresolved_effect', 'Unknown tool effects must be reconciled in authoritative history before projection');
      }
    }
    const required = m.role === 'system' || start === firstUser || (latestUser >= 0 && start >= latestUser)
      || (ranges ?? []).some(([a, b]) => a < i && b > start);
    units.push({ messages: messages.slice(start, i), required, entry: {
      source: `session:${request.sessionId}`, revision: historyRevision,
      digest: digest(messages.slice(start, i)),
      ...(m.role === 'assistant' && m.toolCalls.length ? { toolOutcomes: messages.slice(start + 1, i).map(result => {
        const tool = result as Extract<Message, { role: 'tool' }>;
        return { toolCallId: tool.toolCallId, name: tool.name, ok: tool.outcome.ok,
          ...(!tool.outcome.ok ? { errorCode: tool.outcome.error.code, effect: tool.outcome.error.effect } : {}) };
      }) } : {}),
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
  counter?: ContextCounter;
  capacity?: ContextCapacitySource;
} = {}): ContextBuilder {
  const sources = [...(options.sources ?? [])];
  const estimator = options.estimator ?? jsonByteEstimator;
  const compressor = options.compressor;
  const counter: ContextCounter = options.counter ?? {
    id: estimator.id, count: request => ({ value: estimator.estimate(request),
      unit: estimator.id === jsonByteEstimator.id ? 'bytes' : 'custom',
      source: estimator.id, accuracy: estimator.id === jsonByteEstimator.id ? 'exact' : 'estimated', uncertainty: 0 }),
  };
  if (options.counter && options.estimator) fail('invalid_options', 'Select a counter or a legacy estimator, not both');
  // One bounded, disposable projection. Never a transcript, persistent fact or shared Session authority.
  let cached: { sessionId: string; capability: string; keys: string[]; summary: string } | undefined;
  if (!nonempty(estimator.id) || !nonempty(counter.id) || (compressor && !nonempty(compressor.id))
    || (options.capacity && !nonempty(options.capacity.id))
    || sources.some(s => !nonempty(s.id)) || new Set(sources.map(s => s.id)).size !== sources.length)
    fail('invalid_options', 'Extensions require nonempty unique source identities');
  return {
    discard(sessionId) { if (cached?.sessionId === sessionId) cached = undefined; },
    async build(input, signal) {
      cancelled(signal);
      input = frozen(input);
      const keep = input.keepRecentGroups ?? 2;
      if (!count(keep) || (input.mode !== undefined && !['auto', 'manual'].includes(input.mode)))
        fail('invalid_budget', 'Invalid retention count or projection mode');
      // Snapshot before the first await; extensions never receive caller-owned history.
      const request = frozen(input.request);
      const units = historyUnits(request, keep, input.protectedHistoryRanges);
      const scope = frozen({ sessionId: request.sessionId, turnId: request.turnId, step: request.step });
      const baseReceipt = input.baseReceipt && frozen(input.baseReceipt);
      if (baseReceipt && (baseReceipt.sessionId !== request.sessionId || !count(baseReceipt.revision)
        || !count(baseReceipt.messageCount) || baseReceipt.messageCount > request.messages.length
        || !/^[a-f0-9]{64}$/.test(baseReceipt.digest)))
        fail('invalid_history', 'Invalid stored-prefix receipt');
      let model: ContextCapacity | undefined;
      if (options.capacity) {
        try { model = frozen(await options.capacity.resolve(scope, signal)); }
        catch { cancelled(signal); fail('capacity_failed', `Capacity source failed: ${options.capacity.id}`); }
        cancelled(signal);
        if (!model) fail('capacity_mismatch', 'Capacity source returned no model capability');
      }
      const bounds = budgetBounds(input.budget, model);
      const capability = digest({ model, counter: counter.id });
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
              digest: digest(material),
              materialId: material.id, action: 'retained',
              reason: material.required || material.kind === 'guidance' ? 'required-material' : 'within-budget' },
          });
        }
      }
      // Material order is explicit; history order remains unchanged.
      const all = [...materials, ...units];
      const makeRequest = (): ModelRequest => frozen({ ...request, messages: all.flatMap(u => [...u.messages]) });
      let measurement: ContextMeasurement;
      const estimate = (): number => {
        cancelled(signal);
        const counted = measure(counter, makeRequest(), model);
        measurement = counted.measurement;
        cancelled(signal);
        return counted.upper;
      };
      const { availableInput } = bounds;
      let estimatedInput = estimate();
      const historyDigest = digest(request.messages);
      const report = (): ContextReport => frozen({ estimator: counter.id,
        ...(compressor ? { compressor: compressor.id } : {}), ...bounds, estimatedInput, measurement,
        ...(model ? { model, capacitySource: options.capacity!.id } : {}), historyDigest, byteInput: size(makeRequest()),
        ...(baseReceipt ? { baseReceipt } : {}), entries: all.map(u => u.entry) });
      const candidates = all.filter(u => !u.required);
      const keys = candidates.map(u => digest({ source: u.entry.source, sourceId: u.entry.sourceId,
        materialId: u.entry.materialId, revision: u.entry.sourceId ? u.entry.revision : undefined, digest: u.entry.digest }));
      const reusable = cached?.sessionId === request.sessionId && cached.capability === capability
        && cached.keys.length <= keys.length && cached.keys.every((key, i) => keys[i] === key);
      const install = (summary: string, selected: Unit[]): void => {
        const originals = selected.map(u => u.entry);
        const summaryDigest = digest(originals.map(e => e.digest));
        selected[0].messages = [{ role: 'user', content: JSON.stringify({ contextSummary: {
          trust: 'data', sessionId: request.sessionId, historyDigest, digest: summaryDigest,
          compressor: compressor!.id, sources: originals.map(e => e.historyRange
            ? { historyRange: e.historyRange, digest: e.digest, toolOutcomes: e.toolOutcomes }
            : { source: e.source, revision: e.revision, sourceId: e.sourceId, materialId: e.materialId, digest: e.digest }),
          summary,
        } }) }];
        for (const u of selected.slice(1)) u.messages = [];
        for (const u of selected) { u.entry.action = 'summarized'; u.entry.reason = 'budget-compression'; }
        estimatedInput = estimate();
      };
      const originalEstimate = estimatedInput;
      let usedCache = 0;
      let nextCache: typeof cached;
      if (compressor && reusable && cached!.keys.length) {
        usedCache = cached!.keys.length;
        install(cached!.summary, candidates.slice(0, usedCache));
      }
      if (estimatedInput > availableInput || (input.mode === 'manual' && candidates.length > usedCache)) {
        if (compressor && candidates.length) {
          cancelled(signal);
          let summary: string;
          const groups = candidates.filter(u => u.messages.length).map(u => u.messages);
          try { summary = await compressor.summarize(frozen({
            entry: { source: `session:${request.sessionId}`, revision: `sha256:${historyDigest}`,
              digest: digest(candidates.map(u => u.entry.digest)), action: 'retained', reason: 'summary-input' },
            messages: groups.flatMap(group => [...group]), groups,
          }), signal); }
          catch (error) {
            cancelled(signal);
            if (error instanceof ContextBuildError) throw error;
            const failure = new ContextBuildError('compression_failed', `Context compressor failed: ${compressor.id}`);
            failure.cause = error;
            throw failure;
          }
          cancelled(signal);
          if (!nonempty(summary)) fail('invalid_summary', 'Compressor must return nonempty plain text');
          if (Buffer.byteLength(summary, 'utf8') > 128 * 1024)
            fail('invalid_summary', 'Summary exceeds the bounded projection text limit');
          install(summary, candidates);
          if (estimatedInput >= originalEstimate)
            throw new ContextBuildError('compression_no_gain', 'Summary did not reduce the full request', report());
          if (estimatedInput <= availableInput)
            nextCache = { sessionId: request.sessionId, capability, keys, summary };
        }
      }
      if (estimatedInput > availableInput)
        throw new ContextBuildError('budget_exceeded', 'Preserved context and request overhead exceed available input budget', report());
      if (size(makeRequest()) > limits.historyBytes || makeRequest().messages.some(m => size(m) > limits.messageBytes))
        throw new ContextBuildError('byte_budget_exceeded', 'Projection exceeds the independent request/message byte ceiling', report());
      // Sources/summarization can await long enough for model selection to change. Do not
      // publish an old budget conclusion or install its cache under a new capability.
      if (options.capacity) {
        let current: ContextCapacity;
        try { current = frozen(await options.capacity.resolve(scope, signal)); }
        catch { cancelled(signal); fail('capacity_failed', `Capacity refresh failed: ${options.capacity.id}`); }
        cancelled(signal);
        if (digest(current) !== digest(model))
          throw new ContextBuildError('capacity_changed', 'Model capability changed while projecting; no request admitted', report());
      }
      cancelled(signal);
      if (nextCache) cached = nextCache;
      return frozen({ request: makeRequest(), report: report() });
    },
  };
}
