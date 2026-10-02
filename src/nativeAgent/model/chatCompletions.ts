import type { Json, ModelResponse, ToolCall } from '../index.js';
import type { ModelProtocolAdapter, ModelProgress, ModelUsage } from './types.js';
import { ModelGatewayError, object, parse, protocol } from './errors.js';

const maxResponse = 512 * 1024;
const maxArguments = 64 * 1024;
function text(value: unknown): string { if (typeof value !== 'string') return protocol(); return value; }
function id(value: unknown): string { const s = text(value); if (!s.trim()) return protocol(); return s; }
function json(value: unknown, depth = 0): value is Json {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(v => json(v, depth + 1));
}
function usage(value: unknown): ModelUsage | undefined {
  if (value === undefined || value === null) return undefined;
  const u = object(value);
  const values = [u.prompt_tokens, u.completion_tokens, u.total_tokens];
  if (!values.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return protocol();
  return { inputTokens: u.prompt_tokens as number, outputTokens: u.completion_tokens as number, totalTokens: u.total_tokens as number };
}
function finish(content: string, rawCalls: unknown, reason: unknown): ModelResponse {
  if (reason !== 'stop' && reason !== 'tool_calls') throw new ModelGatewayError('incomplete');
  const list = rawCalls ?? [];
  if (!Array.isArray(list) || list.length > 8 || (reason === 'stop') !== (list.length === 0)) return protocol();
  const calls: ToolCall[] = list.map(raw => {
    const c = object(raw), f = object(c.function);
    if (c.type !== 'function') return protocol();
    const encoded = text(f.arguments);
    if (Buffer.byteLength(encoded) > maxArguments) return protocol();
    const args = object(parse(encoded));
    if (!json(args) || Buffer.byteLength(JSON.stringify(args)) > maxArguments) return protocol();
    return { id: id(c.id), name: id(f.name), arguments: args as Json };
  });
  if (new Set(calls.map(c => c.id)).size !== calls.length) return protocol();
  const response: ModelResponse = calls.length ? { kind: 'tool_calls', content, calls } : { kind: 'final', content };
  if (Buffer.byteLength(JSON.stringify(response)) > maxResponse) return protocol();
  return response;
}
function messageFields(m: Record<string, unknown>): void {
  // Refusal/legacy calls and other modalities must not silently become an empty success.
  if (m.refusal != null || m.function_call != null || m.audio != null) return protocol();
  if (m.role !== undefined && m.role !== 'assistant') return protocol();
}

/** SSE lines across arbitrary byte/text chunks, including CR, LF and CRLF boundaries. */
async function* frames(body: AsyncIterable<string>): AsyncGenerator<string> {
  let line = '', data: string[] = [], afterCR = false;
  for await (const part of body) {
    for (const char of part) {
      if (afterCR) { afterCR = false; if (char === '\n') continue; }
      if (char === '\r' || char === '\n') {
        if (line === '') { if (data.length) yield data.join('\n'); data = []; }
        else if (line === 'data') data.push('');
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        line = '';
        afterCR = char === '\r';
      } else line += char;
    }
  }
  // An unterminated event is not an authoritative completion marker.
}

export function createChatCompletionsAdapter(): ModelProtocolAdapter {
  return {
    encode(request, model, stream) {
      return {
        model, stream, store: false, n: 1,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
        messages: request.messages.map(m => {
          if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: JSON.stringify(m.outcome) };
          if (m.role === 'assistant') return {
            role: m.role, content: m.content,
            ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map(c => ({
              id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            })) } : {}),
          };
          return { role: m.role, content: m.content };
        }),
        ...(request.tools.length ? { tools: request.tools.map(t => ({
          type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })) } : {}),
      };
    },
    classify(status, body) {
      if (status === 401 || status === 403) return 'authentication';
      const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
      const fields = e && typeof e === 'object' ? e as Record<string, unknown> : {};
      if (fields.code === 'insufficient_quota' || fields.type === 'insufficient_quota') return 'quota';
      if (['invalid_api_key', 'authentication_error', 'permission_error'].includes(String(fields.code))
        || ['authentication_error', 'permission_error'].includes(String(fields.type))) return 'authentication';
      // Status alone is insufficient; never infer temporary from a free-form message.
      return status === 429 && fields.code === 'rate_limit_exceeded'
        && [undefined, null, 'rate_limit_error', 'tokens', 'requests'].includes(fields.type as string | null | undefined)
        ? 'rate_limit' : 'http';
    },
    async decode(body, streaming, emit) {
      if (!streaming) {
        let source = '';
        for await (const part of body) source += part;
        const root = object(parse(source));
        if (root.error != null || !Array.isArray(root.choices) || root.choices.length !== 1) return protocol();
        const c = object(root.choices[0]), m = object(c.message);
        if (c.index !== 0 || m.role !== 'assistant') return protocol();
        messageFields(m);
        const response = finish(m.content === null ? '' : text(m.content), m.tool_calls, c.finish_reason);
        const reported = usage(root.usage);
        return { response, ...(reported ? { usage: reported } : {}) };
      }
      let content = '', reason: unknown, reported: ModelUsage | undefined;
      let responseId: string | undefined, responseModel: string | undefined;
      const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
      for await (const frame of frames(body)) {
        if (frame === '[DONE]') {
          if (reason === undefined) throw new ModelGatewayError('incomplete');
          const ordered = [...calls.entries()].sort(([a], [b]) => a - b);
          if (ordered.some(([index], i) => index !== i)) return protocol();
          return { response: finish(content, ordered.map(([, c]) => c), reason), ...(reported ? { usage: reported } : {}) };
        }
        const root = object(parse(frame));
        if (root.error != null || !Array.isArray(root.choices) || root.choices.length > 1) return protocol();
        if (root.id !== undefined) {
          const current = id(root.id);
          if (responseId !== undefined && current !== responseId) return protocol();
          responseId = current;
        }
        if (root.model !== undefined) {
          const current = id(root.model);
          if (responseModel !== undefined && current !== responseModel) return protocol();
          responseModel = current;
        }
        if (root.usage != null) {
          if (reported) return protocol();
          reported = usage(root.usage);
          if (reported) emit({ type: 'usage', usage: reported });
        }
        if (root.choices.length === 0) continue;
        if (reason !== undefined) return protocol();
        const c = object(root.choices[0]), delta = object(c.delta);
        if (c.index !== 0) return protocol();
        messageFields(delta);
        if (delta.content != null) {
          const piece = text(delta.content);
          content += piece;
          emit({ type: 'text_delta', text: piece });
        }
        if (delta.tool_calls != null) {
          if (!Array.isArray(delta.tool_calls)) return protocol();
          for (const raw of delta.tool_calls) {
            const d = object(raw), i = d.index;
            if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= 8) return protocol();
            const prior = calls.get(i) ?? { id: '', type: '', function: { name: '', arguments: '' } };
            if (d.type !== undefined) {
              if (d.type !== 'function' || (prior.type && prior.type !== d.type)) return protocol();
              prior.type = 'function';
            }
            if (d.id !== undefined) {
              if (prior.id) return protocol();
              prior.id = id(d.id);
            }
            const f = d.function === undefined ? {} : object(d.function);
            const progress: ModelProgress = { type: 'tool_delta', index: i };
            if (d.id !== undefined) progress.id = prior.id;
            if (f.name !== undefined) { const piece = text(f.name); prior.function.name += piece; progress.name = piece; }
            if (f.arguments !== undefined) {
              const piece = text(f.arguments); prior.function.arguments += piece; progress.arguments = piece;
              if (Buffer.byteLength(prior.function.arguments) > maxArguments) return protocol();
            }
            calls.set(i, prior);
            emit(progress);
          }
        }
        if (Buffer.byteLength(content) > maxResponse) return protocol();
        if (c.finish_reason != null) reason = c.finish_reason;
      }
      throw new ModelGatewayError('incomplete');
    },
  };
}
