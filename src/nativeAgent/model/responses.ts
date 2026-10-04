import { isDeepStrictEqual } from 'node:util';
import type { ModelResponse, ToolCall } from '../index.js';
import type { ModelProtocolAdapter, ModelUsage } from './types.js';
import { createChatCompletionsAdapter } from './chatCompletions.js';
import { ModelGatewayError, object, parse, protocol } from './errors.js';
import { argumentsObject, bounded, counts, id, index, jsonBody, result, sseFrames, text } from './wire.js';

const classify = createChatCompletionsAdapter().classify;
function failure(error: unknown): never {
  const e = object(error);
  const code = classify(429, { error: { code: e.code, type: e.type === 'error' ? undefined : e.type } });
  // A 200/in-band failure is not a proven rejection; the gateway never replays it.
  throw new ModelGatewayError(code === 'http' ? 'incomplete' : code);
}
function itemSemantics(item: Record<string, unknown>): void {
  if (item.type === 'function_call') {
    if (Object.keys(item).some(k => !['type', 'id', 'status', 'call_id', 'name', 'arguments',
      'async', 'caller', 'namespace', 'created_by'].includes(k))) return protocol();
    if ((item.async !== undefined && item.async !== false) || item.namespace != null
      || (item.caller != null && object(item.caller).type !== 'direct')) return protocol();
  } else if (item.type !== 'message' || item.phase != null
    || Object.keys(item).some(k => !['type', 'id', 'status', 'role', 'content', 'phase', 'created_by'].includes(k))) {
    // The kernel does not store assistant phase or server execution context.
    return protocol();
  }
}
function usage(value: unknown): ModelUsage | undefined {
  const base = counts(value, { input_tokens: 'inputTokens', output_tokens: 'outputTokens', total_tokens: 'totalTokens' });
  if (value == null) return base;
  const details = counts(object(value).input_tokens_details,
    { cached_tokens: 'cachedInputTokens', cache_write_tokens: 'cacheWriteInputTokens' });
  return base || details ? { ...base, ...details } : undefined;
}
function outputText(value: unknown): string {
  const part = object(value);
  if (Object.keys(part).some(k => !['type', 'text', 'annotations', 'logprobs'].includes(k))
    || part.type !== 'output_text' || (part.annotations != null
    && (!Array.isArray(part.annotations) || part.annotations.length))) return protocol();
  return bounded(text(part.text));
}
function itemValue(raw: unknown): { content: string; call?: ToolCall } {
  const item = object(raw);
  id(item.id);
  itemSemantics(item);
  if (item.status !== 'completed') throw new ModelGatewayError('incomplete');
  if (item.type === 'function_call') {
    return { content: '', call: { id: id(item.call_id), name: id(item.name),
      arguments: argumentsObject(text(item.arguments)) } };
  }
  if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)
    || !item.content.length) return protocol();
  return { content: bounded(item.content.map(outputText).join('')) };
}
function finish(root: Record<string, unknown>): ModelResponse {
  if (root.error != null) failure(root.error);
  if (root.status !== 'completed') throw new ModelGatewayError('incomplete');
  if (root.error != null || root.incomplete_details != null || !Array.isArray(root.output) || !root.output.length) return protocol();
  id(root.id);
  const ids = new Set<string>(), calls: ToolCall[] = [];
  let content = '';
  for (const raw of root.output) {
    const item = object(raw), key = id(item.id);
    if (ids.has(key)) return protocol();
    ids.add(key);
    const value = itemValue(item);
    content = bounded(content + value.content);
    if (value.call) calls.push(value.call);
  }
  return result(content, calls);
}
type Part = { text: string; textDone: boolean; done: boolean };
type Slot = { item: Record<string, unknown>; done?: Record<string, unknown>;
  arguments: string; argumentsDone: boolean; parts: Map<number, Part> };

export function createResponsesAdapter(): ModelProtocolAdapter {
  return {
    protocol: 'responses',
    classify,
    encode(request, model, stream, options) {
      const input: unknown[] = [];
      for (const m of request.messages) {
        if (m.role === 'tool') input.push({ type: 'function_call_output', call_id: m.toolCallId,
          output: JSON.stringify(m.outcome) });
        else if (m.role === 'assistant') {
          if (m.content) input.push({ role: 'assistant', content: m.content });
          for (const c of m.toolCalls) input.push({ type: 'function_call', call_id: c.id, name: c.name,
            arguments: JSON.stringify(c.arguments) });
        } else input.push({ role: m.role, content: [{ type: 'input_text', text: m.content }] });
      }
      return { model, stream, store: false, truncation: 'disabled', input,
        ...(options?.maxOutputTokens !== undefined ? { max_output_tokens: options.maxOutputTokens } : {}),
        ...(request.tools.length ? { tools: request.tools.map(t => ({
          type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false,
        })) } : {}) };
    },
    async decode(body, streaming, emit) {
      if (!streaming) {
        const root = await jsonBody(body);
        const reported = usage(root.usage);
        if (reported) emit({ type: 'usage', usage: reported });
        return { response: finish(root), ...(reported ? { usage: reported } : {}) };
      }
      let responseId: string | undefined, sequence: number | undefined;
      const slots = new Map<number, Slot>();
      const slotFor = (e: Record<string, unknown>): Slot => {
        const slot = slots.get(index(e.output_index));
        if (!slot || slot.done || (e.item_id !== undefined && e.item_id !== slot.item.id)) return protocol();
        return slot;
      };
      for await (const frame of sseFrames(body)) {
        const e = object(parse(frame.data)), type = text(e.type);
        if (frame.event !== undefined && frame.event !== type) return protocol();
        if (e.sequence_number !== undefined) {
          const n = index(e.sequence_number, Number.MAX_SAFE_INTEGER);
          if (sequence !== undefined && n !== sequence + 1) return protocol();
          sequence = n;
        }
        if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') {
          if (type !== 'error' && (!responseId || object(e.response).id !== responseId)) return protocol();
          const reported = type === 'error' ? undefined : usage(object(e.response).usage);
          if (reported) emit({ type: 'usage', usage: reported });
          if (type === 'error') failure(e);
          if (object(e.response).error != null) failure(object(e.response).error);
          throw new ModelGatewayError('incomplete');
        }
        if (type === 'response.created') {
          if (responseId) return protocol();
          const r = object(e.response);
          if (r.status !== 'in_progress' || !Array.isArray(r.output) || r.output.length || r.error != null) return protocol();
          responseId = id(r.id);
          continue;
        }
        if (!responseId || (e.response_id !== undefined && e.response_id !== responseId)) return protocol();
        if (type === 'response.in_progress') {
          const r = object(e.response);
          if (r.id !== responseId || r.status !== 'in_progress' || r.error != null) return protocol();
        } else if (type === 'response.output_item.added') {
          const i = index(e.output_index), item = object(e.item);
          if (i !== slots.size || slots.has(i) || [...slots.values()].some(s => s.item.id === item.id)) return protocol();
          id(item.id);
          itemSemantics(item);
          if (item.status !== 'in_progress') return protocol();
          if (item.type === 'function_call') {
            id(item.call_id); id(item.name); bounded(text(item.arguments), 64 * 1024);
            emit({ type: 'tool_delta', index: i, id: item.call_id as string, name: item.name as string });
          } else if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content) || item.content.length) return protocol();
          slots.set(i, { item, arguments: item.type === 'function_call' ? text(item.arguments) : '',
            argumentsDone: false, parts: new Map() });
        } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
          const slot = slotFor(e);
          if (slot.item.type !== 'function_call' || slot.argumentsDone) return protocol();
          if (type.endsWith('.delta')) {
            const delta = text(e.delta);
            slot.arguments = bounded(slot.arguments + delta, 64 * 1024);
            emit({ type: 'tool_delta', index: index(e.output_index), arguments: delta });
          } else {
            if (slot.arguments !== text(e.arguments)) return protocol();
            slot.argumentsDone = true;
          }
        } else if (type === 'response.content_part.added') {
          const slot = slotFor(e), i = index(e.content_index);
          if (slot.item.type !== 'message' || i !== slot.parts.size) return protocol();
          slot.parts.set(i, { text: outputText(e.part), textDone: false, done: false });
        } else if (type === 'response.output_text.delta' || type === 'response.output_text.done' || type === 'response.content_part.done') {
          const slot = slotFor(e), part = slot.parts.get(index(e.content_index));
          if (slot.item.type !== 'message' || !part || part.done) return protocol();
          if (type === 'response.output_text.delta') {
            if (part.textDone) return protocol();
            const delta = text(e.delta);
            part.text = bounded(part.text + delta);
            emit({ type: 'text_delta', text: delta });
          } else if (type === 'response.output_text.done') {
            if (part.textDone || part.text !== text(e.text)) return protocol();
            part.textDone = true;
          } else {
            if (!part.textDone || part.text !== outputText(e.part)) return protocol();
            part.done = true;
          }
        } else if (type === 'response.output_item.done') {
          const slot = slotFor(e), item = object(e.item);
          if (slot.item.id !== item.id || slot.item.type !== item.type) return protocol();
          itemValue(item);
          if (item.type === 'function_call') {
            if (!slot.argumentsDone || slot.arguments !== item.arguments
              || slot.item.call_id !== item.call_id || slot.item.name !== item.name) return protocol();
          } else {
            if (!slot.parts.size || [...slot.parts.values()].some(p => !p.done)
              || !Array.isArray(item.content) || item.content.length !== slot.parts.size
              || item.content.some((p, i) => outputText(p) !== slot.parts.get(i)?.text)) return protocol();
          }
          slot.done = item;
        } else if (type === 'response.completed') {
          const root = object(e.response);
          if (root.id !== responseId) return protocol();
          const reported = usage(root.usage);
          if (reported) emit({ type: 'usage', usage: reported });
          if (root.id !== responseId || !slots.size || !Array.isArray(root.output)
            || root.output.length !== slots.size || root.output.some((item, i) => {
              const done = slots.get(i)?.done;
              return !done || !isDeepStrictEqual(itemValue(item), itemValue(done))
                || object(item).id !== done.id;
            })) return protocol();
          return { response: finish(root), ...(reported ? { usage: reported } : {}) };
        } else return protocol();
      }
      throw new ModelGatewayError('incomplete');
    },
  };
}
