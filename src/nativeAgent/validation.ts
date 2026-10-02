import type { Message, ModelResponse, ToolCall, ToolOutcome } from './contracts.js';

// JSON escaping can expand a 64 KiB text result to almost 384 KiB.
export const limits = { messageBytes: 512 * 1024, argumentBytes: 64 * 1024, historyBytes: 1024 * 1024, callsPerStep: 8 } as const;
export class AgentFault extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function snapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string'; }
function id(value: unknown): value is string { return text(value) && value.trim().length > 0; }
function json(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || text(value) || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return Array.from(value).every(v => json(v, depth + 1));
  return object(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.values(value).every(v => json(v, depth + 1));
}
export function size(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function bounded(value: unknown): boolean { return json(value) && size(value) <= limits.messageBytes; }
function calls(value: unknown): value is ToolCall[] {
  return Array.isArray(value) && value.length <= limits.callsPerStep
    && value.every(c => object(c) && id(c.id) && id(c.name) && bounded(c.arguments)
      && size(c.arguments) <= limits.argumentBytes)
    && new Set(value.map(c => c.id)).size === value.length;
}
export function validOutcome(value: unknown): value is ToolOutcome {
  return object(value) && bounded(value) && (value.ok === true ? text(value.content)
    : value.ok === false && object(value.error) && id(value.error.code) && text(value.error.message)
      && (value.error.effect === 'none' || value.error.effect === 'unknown'));
}
export function response(value: unknown, usedIds: ReadonlySet<string>): ModelResponse {
  if (!object(value) || !bounded(value) || !text(value.content)
    || !(value.kind === 'final' || (value.kind === 'tool_calls' && calls(value.calls)
      && value.calls.length > 0 && value.calls.every(c => !usedIds.has(c.id))))) {
    throw new AgentFault('provider_protocol', 'Invalid, oversized or duplicate model response');
  }
  return snapshot(value as ModelResponse);
}
export function history(value: readonly Message[]): Message[] {
  const pending = new Map<string, string>();
  const used = new Set<string>();
  if (!Array.isArray(value) || !json(value) || size(value) > limits.historyBytes) {
    throw new AgentFault('invalid_history', 'History must be bounded JSON messages');
  }
  for (const m of value) {
    if (!object(m) || !bounded(m)) throw new AgentFault('invalid_history', 'Invalid history message');
    if (m.role === 'tool') {
      if (!id(m.toolCallId) || !id(m.name) || !validOutcome(m.outcome)
        || pending.get(m.toolCallId) !== m.name || !pending.has(m.toolCallId)) {
        throw new AgentFault('invalid_history', 'Tool results must match exactly one pending call');
      }
      pending.delete(m.toolCallId);
    } else {
      if (pending.size || !text(m.content)) throw new AgentFault('invalid_history', 'Unsettled calls or invalid content');
      if (m.role === 'assistant' && calls(m.toolCalls)) {
        for (const c of m.toolCalls) {
          if (used.has(c.id)) throw new AgentFault('invalid_history', 'Duplicate tool call identity');
          used.add(c.id);
          pending.set(c.id, c.name);
        }
      } else if (m.role !== 'system' && m.role !== 'user') {
        throw new AgentFault('invalid_history', 'Invalid message role or assistant calls');
      }
    }
  }
  if (pending.size) throw new AgentFault('invalid_history', 'History contains unsettled calls');
  return snapshot([...value]);
}
