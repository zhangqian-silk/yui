import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelRequest, ModelResponse, ToolCall } from '../index.js';
import type { ModelAttempt, ModelGateway, ModelGatewayOptions, ModelProfile, ModelProgress, ModelTransport, ModelUsage } from './types.js';
import { ModelGatewayError } from './errors.js';
import { createProtocolAdapter, getProtocolCapabilities } from './protocols.js';

export const fetchTransport: ModelTransport = (endpoint, init) => fetch(endpoint, init);
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
function frozen<T>(v: T): T {
  const copy = structuredClone(v);
  const freeze = (x: unknown): void => {
    if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); }
  };
  freeze(copy);
  return copy;
}
function plain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
function json(v: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  return (Array.isArray(v) || plain(v)) && Object.values(v).every(child => json(child, depth + 1));
}
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
function validCalls(v: unknown): v is ToolCall[] {
  return Array.isArray(v) && v.length <= 8 && v.every(c => plain(c) && nonempty(c.id) && nonempty(c.name)
    && keys(c, ['id', 'name', 'arguments'])
    && plain(c.arguments) && json(c.arguments) && bytes(c.arguments) <= 64 * 1024)
    && new Set(v.map(c => c.id)).size === v.length;
}
function requestSnapshot(input: ModelRequest): ModelRequest {
  try {
    if (!plain(input) || !keys(input, ['sessionId', 'turnId', 'step', 'messages', 'tools'])
      || !json(input) || bytes(input) > 1024 * 1024 || !nonempty(input.sessionId) || !nonempty(input.turnId)
      || !Number.isSafeInteger(input.step) || input.step < 1 || !Array.isArray(input.messages)
      || !Array.isArray(input.tools)) throw 0;
    const used = new Set<string>(), pending = new Map<string, string>();
    for (const m of input.messages) {
      if (!plain(m) || bytes(m) > 512 * 1024) throw 0;
      if (m.role === 'tool') {
        if (!keys(m, ['role', 'toolCallId', 'name', 'outcome'])) throw 0;
        if (!nonempty(m.toolCallId) || !pending.has(m.toolCallId) || pending.get(m.toolCallId) !== m.name || !plain(m.outcome)) throw 0;
        if (m.outcome.ok === true) { if (!keys(m.outcome, ['ok', 'content']) || typeof m.outcome.content !== 'string') throw 0; }
        else if (m.outcome.ok !== false || !keys(m.outcome, ['ok', 'error']) || !plain(m.outcome.error)
          || !keys(m.outcome.error, ['code', 'message', 'effect']) || !nonempty(m.outcome.error.code)
          || typeof m.outcome.error.message !== 'string'
          || (m.outcome.error.effect !== 'none' && m.outcome.error.effect !== 'unknown')) throw 0;
        pending.delete(m.toolCallId);
      } else {
        if (pending.size || typeof m.content !== 'string') throw 0;
        if (m.role === 'assistant') {
          if (!keys(m, ['role', 'content', 'toolCalls'])) throw 0;
          if (!validCalls(m.toolCalls)) throw 0;
          for (const c of m.toolCalls) {
            if (used.has(c.id)) throw 0;
            used.add(c.id); pending.set(c.id, c.name);
          }
        } else if ((m.role !== 'system' && m.role !== 'user') || !keys(m, ['role', 'content'])) throw 0;
      }
    }
    if (pending.size || !input.tools.every(t => plain(t) && nonempty(t.name)
      && keys(t, ['name', 'description', 'inputSchema']) && typeof t.description === 'string' && plain(t.inputSchema))
      || new Set(input.tools.map(t => t.name)).size !== input.tools.length) throw 0;
    return frozen(input);
  } catch { throw new ModelGatewayError('request', 'none'); }
}
function validateResponse(response: ModelResponse, request: ModelRequest): void {
  const used = new Set(request.messages.flatMap(m => m.role === 'assistant' ? m.toolCalls.map(c => c.id) : []));
  const names = new Set(request.tools.map(t => t.name));
  if (!plain(response) || !json(response) || bytes(response) > 512 * 1024 || typeof response.content !== 'string'
    || !(response.kind === 'final' || (response.kind === 'tool_calls' && validCalls(response.calls)
      && response.calls.length > 0 && response.calls.every(c => names.has(c.name) && !used.has(c.id))))) {
    throw new ModelGatewayError('protocol');
  }
}

/** Owns the reader on every exit, including early DONE, parse failure, cancellation and size limit. */
async function* readBody(response: Response, signal: AbortSignal, limit: number): AsyncGenerator<string> {
  if (!response.body) throw new ModelGatewayError('protocol');
  const reader = response.body.getReader();
  const abort = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let count = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      count += part.value.byteLength;
      if (count > limit) throw new ModelGatewayError('protocol');
      let decoded: string;
      try { decoded = decoder.decode(part.value, { stream: true }); }
      catch { throw new ModelGatewayError('protocol'); }
      yield decoded;
    }
    try { yield decoder.decode(); }
    catch { throw new ModelGatewayError('protocol'); }
  } finally {
    signal.removeEventListener('abort', abort);
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
function retryAfter(value: string | null): number {
  if (value === null) return 0;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}
function reportedUsage(value: unknown): ModelUsage {
  if (!plain(value)) throw new ModelGatewayError('protocol');
  const usage: ModelUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteInputTokens'] as const) {
    const n = value[key];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new ModelGatewayError('protocol');
    usage[key] = n;
  }
  if (!Object.keys(usage).length || !keys(value, Object.keys(usage))) throw new ModelGatewayError('protocol');
  return usage;
}

export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  let endpoint: string, headers: Record<string, string>;
  const adapter = options.adapter ?? createProtocolAdapter(options.protocol ?? 'chat-completions');
  const protocol = adapter.protocol ?? 'custom';
  const capabilities = { ...(protocol === 'custom' ? { text: true, functionTools: true, streaming: true }
    : getProtocolCapabilities(protocol)), ...options.modelCapabilities };
  let generation: NonNullable<ModelGatewayOptions['generation']>;
  const retry = { maxAttempts: 3, maxElapsedMs: 30_000, baseDelayMs: 250, ...options.retry };
  try {
    if (!plain(options) || !keys(options, ['endpoint', 'model', 'account', 'stream', 'adapter', 'transport',
      'onObservation', 'retry', 'clock', 'protocol', 'generation', 'capacity', 'modelCapabilities'])
      || (options.protocol !== undefined && options.protocol !== protocol)
      || (options.generation !== undefined && (!plain(options.generation) || !keys(options.generation, ['maxOutputTokens'])))
      || (options.capacity !== undefined && (!plain(options.capacity)
        || !keys(options.capacity, ['contextWindowTokens', 'maxOutputTokens'])))
      || (options.modelCapabilities !== undefined && (!plain(options.modelCapabilities)
        || !keys(options.modelCapabilities, ['text', 'functionTools', 'streaming'])))
      || !Object.values(capabilities).every(v => typeof v === 'boolean')
      || !capabilities.text || (options.stream && !capabilities.streaming)
      || !plain(options.account) || !keys(options.account, options.account.kind === 'none' ? ['kind'] : ['kind', 'token'])) throw 0;
    const bounds = [...Object.values(options.generation ?? {}), ...Object.values(options.capacity ?? {})];
    if (!bounds.every(n => n === undefined || (typeof n === 'number' && Number.isSafeInteger(n) && n > 0))) throw 0;
    generation = frozen(options.generation ?? {});
    if ((protocol === 'custom' && Object.keys(generation).length)
      || (protocol === 'anthropic-messages' && generation.maxOutputTokens === undefined)
      || (generation.maxOutputTokens !== undefined && options.capacity?.maxOutputTokens !== undefined
        && generation.maxOutputTokens > options.capacity.maxOutputTokens)) throw 0;
    const url = new URL(options.endpoint);
    if (url.username || url.password || url.hash || url.search
      || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      || !nonempty(options.model) || options.model.length > 256
      || (options.stream !== undefined && typeof options.stream !== 'boolean')
      || !Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > 10
      || !Number.isInteger(retry.maxElapsedMs) || retry.maxElapsedMs < 1 || retry.maxElapsedMs > 300_000
      || !Number.isInteger(retry.baseDelayMs) || retry.baseDelayMs < 1 || retry.baseDelayMs > 30_000) throw 0;
    headers = { 'content-type': 'application/json', accept: options.stream ? 'text/event-stream' : 'application/json' };
    if (options.account.kind === 'bearer') {
      if (!nonempty(options.account.token) || /[\r\n]/.test(options.account.token)) throw 0;
      if (protocol === 'anthropic-messages') throw 0;
      headers.authorization = `Bearer ${options.account.token}`;
    } else if (options.account.kind === 'api-key') {
      if (protocol !== 'anthropic-messages' || !nonempty(options.account.token) || /[\r\n]/.test(options.account.token)) throw 0;
      headers['x-api-key'] = options.account.token;
    } else if (options.account.kind !== 'none') throw 0;
    if (protocol === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
    endpoint = url.href;
  } catch { throw new ModelGatewayError('configuration', 'none'); }
  const model = options.model, streaming = options.stream ?? false;
  const profile = frozen<ModelProfile>({ protocol, model, capabilities, ...(options.capacity ? { capacity: options.capacity } : {}) });
  const transport = options.transport ?? fetchTransport;
  const observe = options.onObservation;
  const credential = options.account.kind !== 'none' ? options.account.token : undefined;
  const clock = options.clock ?? { now: () => performance.now(), sleep: async (ms: number, signal: AbortSignal) => {
    await delay(ms, undefined, { signal });
  } };
  async function generate(input: ModelRequest, external: AbortSignal) {
    const requestId = randomUUID(), attempts: ModelAttempt[] = [];
    let request: ModelRequest;
    try {
      request = requestSnapshot(input);
      if (!capabilities.functionTools && (request.tools.length
        || request.messages.some(m => m.role === 'tool' || (m.role === 'assistant' && m.toolCalls.length)))) throw 0;
    }
    catch { throw new ModelGatewayError('request', 'none', [], undefined, requestId); }
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    external.addEventListener('abort', cancel, { once: true });
    if (external.aborted) cancel();
    const start = clock.now();
    const timer = setTimeout(cancel, retry.maxElapsedMs);
    let sent = false;
    const elapsed = () => Math.max(0, clock.now() - start);
    const check = (): void => {
      if (external.aborted) throw new ModelGatewayError('cancelled', sent ? 'unknown' : 'none');
      if (controller.signal.aborted || elapsed() >= retry.maxElapsedMs) {
        controller.abort();
        throw new ModelGatewayError('deadline', sent ? 'unknown' : 'none');
      }
    };
    const emit = (attempt: number, data: ModelProgress): void => {
      if (!observe) return;
      try {
        void Promise.resolve(observe(frozen({ sessionId: request.sessionId, turnId: request.turnId,
          step: request.step, requestId, source: 'live' as const, attempt, data }))).catch(() => {});
      } catch { /* Optional display is not a required storage boundary. */ }
    };
    try {
      check();
      let body: string;
      try {
        const encoded = adapter.encode(request, model, streaming, generation);
        if (!json(encoded) || bytes(encoded) > 2 * 1024 * 1024) throw 0;
        body = JSON.stringify(encoded);
      } catch { throw new ModelGatewayError('request', 'none'); }
      for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
        check();
        let status: number | undefined;
        let wait = 0;
        let rejectedForRateLimit = false;
        let classifiedRejection = false;
        let acquiredResponse: Response | undefined;
        const clientRequestId = `${requestId}-${attempt}`;
        let providerRequestId: string | undefined, usage: ModelUsage | undefined;
        try {
          sent = true;
          const response = await transport(endpoint, { method: 'POST',
            headers: { ...headers, 'x-client-request-id': clientRequestId }, body,
            signal: controller.signal, redirect: 'error' });
          acquiredResponse = response;
          status = response.status;
          const remoteId = response.headers.get(protocol === 'anthropic-messages' ? 'request-id' : 'x-request-id');
          if (remoteId && /^[A-Za-z0-9_-]{1,128}$/.test(remoteId)
            && !(credential && remoteId.includes(credential))) providerRequestId = remoteId;
          // A transport returning after cancellation still transfers body ownership here.
          if (controller.signal.aborted || external.aborted || elapsed() >= retry.maxElapsedMs) {
            await response.body?.cancel();
            check();
          }
          if (!response.ok) {
            let text = '';
            for await (const part of readBody(response, controller.signal, 64 * 1024)) text += part;
            check();
            let errorBody: unknown;
            try { errorBody = JSON.parse(text); } catch { errorBody = undefined; }
            const code = adapter.classify(status, errorBody);
            // Even a custom classifier cannot turn accepted output/server uncertainty into safe replay.
            const safe = status >= 400 && status < 500;
            const classified = code === 'rate_limit' && status !== 429 ? 'http' : code;
            classifiedRejection = safe;
            rejectedForRateLimit = classified === 'rate_limit' && status === 429;
            wait = Math.max(retry.baseDelayMs * 2 ** (attempt - 1), retryAfter(response.headers.get('retry-after')));
            throw new ModelGatewayError(classified, safe ? 'none' : 'unknown');
          }
          const bodyStream = readBody(response, controller.signal, 4 * 1024 * 1024);
          let decoded;
          try {
            decoded = await adapter.decode(bodyStream, streaming, data => {
              if (data.type === 'usage') usage = reportedUsage(data.usage);
              // Attempts and retries are gateway facts, not adapter-created observations.
              if (data.type !== 'attempt_finished' && data.type !== 'retry') emit(attempt, data);
            });
          } finally {
            await bodyStream.return(undefined);
          }
          check();
          validateResponse(decoded.response, request);
          if (decoded.usage !== undefined) usage = reportedUsage(decoded.usage);
          const record: ModelAttempt = { attempt, clientRequestId, elapsedMs: elapsed(), status,
            ...(providerRequestId ? { providerRequestId } : {}), ...(usage ? { usage } : {}),
            outcome: 'success', effect: 'completed' };
          attempts.push(record);
          emit(attempt, { type: 'attempt_finished', record });
          const cleanResponse: ModelResponse = decoded.response.kind === 'final'
            ? { kind: 'final', content: decoded.response.content }
            : { kind: 'tool_calls', content: decoded.response.content, calls: decoded.response.calls.map(c => ({
              id: c.id, name: c.name, arguments: c.arguments,
            })) };
          return frozen({ requestId, source: 'live' as const, response: cleanResponse,
            ...(usage ? { usage } : {}), attempts });
        } catch (error) {
          let fault = error instanceof ModelGatewayError ? error : new ModelGatewayError('transport');
          if (!classifiedRejection && fault.effect === 'none') {
            fault = new ModelGatewayError(fault.code, 'unknown');
          }
          try { check(); } catch (cancelled) { fault = cancelled as ModelGatewayError; }
          const record: ModelAttempt = { attempt, clientRequestId, elapsedMs: elapsed(),
            ...(status !== undefined ? { status } : {}), ...(providerRequestId ? { providerRequestId } : {}),
            ...(usage ? { usage } : {}), outcome: fault.code, effect: fault.effect };
          attempts.push(record);
          emit(attempt, { type: 'attempt_finished', record });
          if (fault.code !== 'rate_limit' || fault.effect !== 'none' || !rejectedForRateLimit) {
            throw new ModelGatewayError(fault.code, fault.effect, attempts);
          }
          const stop = attempt >= retry.maxAttempts ? 'attempt_limit'
            : elapsed() + wait >= retry.maxElapsedMs ? 'time_limit' : undefined;
          if (stop) throw new ModelGatewayError(fault.code, fault.effect, attempts, stop);
        } finally {
          // The gateway owns acquired bodies even when a replacement adapter does not read them.
          if (acquiredResponse?.body && !acquiredResponse.body.locked) await acquiredResponse.body.cancel();
        }
        emit(attempt, { type: 'retry', delayMs: wait });
        check();
        await clock.sleep(wait, controller.signal);
      }
      throw new ModelGatewayError('deadline', 'unknown', attempts);
    } catch (error) {
      if (error instanceof ModelGatewayError) {
        throw new ModelGatewayError(error.code, error.effect,
          error.attempts.length ? error.attempts : attempts, error.stopReason, requestId);
      }
      try { check(); } catch (cancelled) {
        const fault = cancelled as ModelGatewayError;
        throw new ModelGatewayError(fault.code, fault.effect, attempts, undefined, requestId);
      }
      throw new ModelGatewayError('transport', sent ? 'unknown' : 'none', attempts, undefined, requestId);
    } finally {
      clearTimeout(timer);
      external.removeEventListener('abort', cancel);
    }
  }
  return { profile, generate, complete: async (request, signal) => (await generate(request, signal)).response };
}
