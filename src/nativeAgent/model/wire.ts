import type { Json, ModelResponse, ToolCall } from '../index.js';
import type { ModelUsage } from './types.js';
import { object, parse, protocol } from './errors.js';

export function text(value: unknown): string { return typeof value === 'string' ? value : protocol(); }
export function id(value: unknown): string { const s = text(value); return s.trim() ? s : protocol(); }
export function index(value: unknown, limit = 1024): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < limit ? value : protocol();
}
export function bounded(value: string, limit = 512 * 1024): string {
  return Buffer.byteLength(value) <= limit ? value : protocol();
}
export function argumentsObject(value: unknown): Json {
  const args = object(typeof value === 'string' ? parse(bounded(value, 64 * 1024)) : value);
  // The gateway additionally validates depth, JSON values and total response size.
  if (Buffer.byteLength(JSON.stringify(args)) > 64 * 1024) return protocol();
  return args as Json;
}
export function result(content: string, calls: ToolCall[]): ModelResponse {
  if (calls.length > 8 || new Set(calls.map(c => c.id)).size !== calls.length) return protocol();
  return calls.length ? { kind: 'tool_calls', content, calls } : { kind: 'final', content };
}
export function counts(value: unknown, mapping: Readonly<Record<string, keyof ModelUsage>>): ModelUsage | undefined {
  if (value == null) return undefined;
  const source = object(value), usage: ModelUsage = {};
  for (const [wire, key] of Object.entries(mapping)) {
    const n = source[wire];
    if (n == null) continue;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return protocol();
    usage[key] = n;
  }
  return Object.keys(usage).length ? usage : undefined;
}
export async function jsonBody(body: AsyncIterable<string>): Promise<Record<string, unknown>> {
  let source = '';
  for await (const part of body) source = bounded(source + part, 4 * 1024 * 1024);
  return object(parse(source));
}
/** Framing only: native lifecycle remains the responsibility of each codec. */
export async function* sseFrames(body: AsyncIterable<string>): AsyncGenerator<{ event?: string; data: string }> {
  let line = '', data: string[] = [], event: string | undefined, afterCR = false;
  for await (const part of body) {
    for (const char of part) {
      if (afterCR) { afterCR = false; if (char === '\n') continue; }
      if (char === '\r' || char === '\n') {
        if (!line) {
          if (data.length) yield { ...(event ? { event } : {}), data: data.join('\n') };
          data = []; event = undefined;
        } else if (line === 'data') data.push('');
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
        line = ''; afterCR = char === '\r';
      } else line += char;
    }
  }
  // Unterminated frames are not a native completion.
}
