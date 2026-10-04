import type { ToolCall } from '../index.js';
import type { ModelProtocolAdapter, ModelUsage } from './types.js';
import { ModelGatewayError, object, parse, protocol } from './errors.js';
import { argumentsObject, bounded, counts, id, index, jsonBody, result, sseFrames, text } from './wire.js';

const usageKeys = { input_tokens: 'inputTokens', output_tokens: 'outputTokens',
  cache_read_input_tokens: 'cachedInputTokens', cache_creation_input_tokens: 'cacheWriteInputTokens' } as const;
function classify(status: number, body: unknown): 'authentication' | 'rate_limit' | 'http' {
  if (status === 401 || status === 403) return 'authentication';
  const root = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const e = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : {};
  if (e.type === 'authentication_error' || e.type === 'permission_error') return 'authentication';
  // No documented Messages quota discriminator: do not guess from message text.
  return status === 429 && e.type === 'rate_limit_error' ? 'rate_limit' : 'http';
}
function failure(root: Record<string, unknown>): never {
  const code = classify(429, root);
  throw new ModelGatewayError(code === 'http' ? 'incomplete' : code);
}
function blockValue(value: unknown): { content: string; call?: ToolCall } {
  const b = object(value);
  if (b.type === 'text') {
    if (Object.keys(b).some(k => !['type', 'text', 'citations'].includes(k))
      || (b.citations != null && (!Array.isArray(b.citations) || b.citations.length))) return protocol();
    return { content: bounded(text(b.text)) };
  }
  if (b.type !== 'tool_use' || Object.keys(b).some(k => !['type', 'id', 'name', 'input', 'caller', 'toolset_name'].includes(k))
    || (b.caller != null && object(b.caller).type !== 'direct') || b.toolset_name != null) return protocol();
  return { content: '', call: { id: id(b.id), name: id(b.name), arguments: argumentsObject(object(b.input)) } };
}
function finish(root: Record<string, unknown>) {
  if (root.type === 'error' || root.error != null) failure(root);
  if (root.stop_reason !== 'end_turn' && root.stop_reason !== 'tool_use') throw new ModelGatewayError('incomplete');
  if (root.type !== 'message' || root.role !== 'assistant' || !Array.isArray(root.content)
    || !root.content.length || root.stop_sequence != null || root.container != null || root.stop_details != null) return protocol();
  id(root.id);
  const calls: ToolCall[] = [];
  let content = '';
  for (const raw of root.content) {
    const value = blockValue(raw);
    content = bounded(content + value.content);
    if (value.call) calls.push(value.call);
  }
  if ((root.stop_reason === 'tool_use') !== (calls.length > 0)) return protocol();
  return result(content, calls);
}
type Block = { value: Record<string, unknown>; arguments: string; done: boolean };

export function createAnthropicMessagesAdapter(): ModelProtocolAdapter {
  return {
    protocol: 'anthropic-messages',
    encode(request, model, stream, options) {
      if (options?.maxOutputTokens === undefined) throw new ModelGatewayError('request', 'none');
      const system: unknown[] = [], messages: { role: string; content: unknown[] }[] = [];
      let leading = true, lastWasTool = false;
      for (const m of request.messages) {
        if (m.role === 'system') {
          if (!leading) throw new ModelGatewayError('request', 'none');
          system.push({ type: 'text', text: m.content }); continue;
        }
        leading = false;
        if (m.role === 'tool') {
          const block = { type: 'tool_result', tool_use_id: m.toolCallId,
            content: JSON.stringify(m.outcome), is_error: !m.outcome.ok };
          if (lastWasTool) messages[messages.length - 1]!.content.push(block);
          else messages.push({ role: 'user', content: [block] });
          lastWasTool = true;
        } else {
          lastWasTool = false;
          const content: unknown[] = m.content ? [{ type: 'text', text: m.content }] : [];
          if (m.role === 'assistant') for (const c of m.toolCalls) {
            content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
          }
          if (!content.length) throw new ModelGatewayError('request', 'none');
          messages.push({ role: m.role, content });
        }
      }
      if (!messages.length || messages[0]!.role !== 'user' || messages[messages.length - 1]!.role === 'assistant') {
        // Assistant prefill is a different semantic contract, not ordinary caller history.
        throw new ModelGatewayError('request', 'none');
      }
      return { model, stream, max_tokens: options.maxOutputTokens, messages,
        ...(system.length ? { system } : {}),
        ...(request.tools.length ? { tools: request.tools.map(t => ({
          name: t.name, description: t.description, input_schema: t.inputSchema,
        })) } : {}) };
    },
    classify,
    async decode(body, streaming, emit) {
      if (!streaming) {
        const root = await jsonBody(body), usage = counts(root.usage, usageKeys);
        if (usage) emit({ type: 'usage', usage });
        return { response: finish(root), ...(usage ? { usage } : {}) };
      }
      let root: Record<string, unknown> | undefined, usage: ModelUsage | undefined;
      let deltaPhase = false;
      const blocks = new Map<number, Block>();
      const updateUsage = (value: unknown): void => {
        const next = counts(value, usageKeys);
        if (!next) return;
        for (const key of Object.keys(next) as (keyof ModelUsage)[]) {
          if (usage?.[key] !== undefined && next[key]! < usage[key]!) return protocol();
        }
        usage = { ...usage, ...next };
        emit({ type: 'usage', usage });
      };
      for await (const frame of sseFrames(body)) {
        const e = object(parse(frame.data)), type = text(e.type);
        if (frame.event !== type) return protocol();
        if (type === 'ping') continue;
        if (type === 'error') failure(e);
        if (type === 'message_start') {
          if (root) return protocol();
          root = object(e.message);
          if (root.type !== 'message' || root.role !== 'assistant' || root.stop_reason != null
            || root.stop_sequence != null || root.container != null || root.stop_details != null
            || !Array.isArray(root.content) || root.content.length) return protocol();
          id(root.id);
          updateUsage(root.usage);
          continue;
        }
        if (!root) return protocol();
        if (type === 'content_block_start') {
          const i = index(e.index), value = object(e.content_block);
          if (deltaPhase || i !== blocks.size) return protocol();
          blockValue(value);
          if (value.type === 'tool_use') emit({ type: 'tool_delta', index: i, id: id(value.id), name: id(value.name) });
          blocks.set(i, { value, arguments: '', done: false });
        } else if (type === 'content_block_delta' || type === 'content_block_stop') {
          const i = index(e.index), block = blocks.get(i);
          if (deltaPhase || !block || block.done) return protocol();
          if (type === 'content_block_stop') {
            if (block.value.type === 'tool_use' && block.arguments) {
              block.value = { ...block.value, input: argumentsObject(block.arguments) };
            }
            blockValue(block.value); block.done = true;
          } else {
            const d = object(e.delta);
            if (d.type === 'text_delta' && block.value.type === 'text') {
              const piece = text(d.text);
              block.value = { ...block.value, text: bounded(text(block.value.text) + piece) };
              emit({ type: 'text_delta', text: piece });
            } else if (d.type === 'input_json_delta' && block.value.type === 'tool_use') {
              if (Object.keys(object(block.value.input)).length) return protocol();
              const piece = text(d.partial_json);
              block.arguments = bounded(block.arguments + piece, 64 * 1024);
              emit({ type: 'tool_delta', index: i, arguments: piece });
            } else return protocol();
          }
        } else if (type === 'message_delta') {
          if (!blocks.size || [...blocks.values()].some(b => !b.done) || root.stop_reason != null) return protocol();
          deltaPhase = true;
          const d = object(e.delta);
          if (d.container != null || d.stop_details != null || d.stop_sequence != null) return protocol();
          root = { ...root, stop_reason: d.stop_reason, stop_sequence: d.stop_sequence };
          updateUsage(e.usage);
        } else if (type === 'message_stop') {
          if (!deltaPhase || !blocks.size || [...blocks.values()].some(b => !b.done)) return protocol();
          return { response: finish({ ...root, content: [...blocks.values()].map(b => b.value) }),
            ...(usage ? { usage } : {}) };
        } else return protocol();
      }
      throw new ModelGatewayError('incomplete');
    },
  };
}
