import type { AgentEvent, Message, ToolCall, ToolOutcome } from '../index.js';
import type { CallRecovery, Recovery, SessionDocument, TurnRecovery } from './contracts.js';

export const sessionLimits = Object.freeze({
  documentBytes: 16 * 1024 * 1024, eventBytes: 1024 * 1024,
  events: 10_000, pageSize: 100, subscribers: 64,
});
export class SessionError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionError';
  }
}
function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SessionError('invalid_session', message);
}
export function identity(value: unknown): asserts value is string {
  requireFact(typeof value === 'string' && value.trim().length > 0 && value.length <= 256,
    'Session, Turn and call identities must be nonempty and at most 256 characters');
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  requireFact(object(value) && Object.keys(value).every(key => names.includes(key)), 'Invalid record fields');
}
function json(value: unknown, depth = 0): void {
  requireFact(depth <= 64, 'JSON nesting limit exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { requireFact(Number.isFinite(value), 'Nonfinite JSON number'); return; }
  if (Array.isArray(value)) { for (const entry of value) json(entry, depth + 1); return; }
  requireFact(object(value) && Object.getPrototypeOf(value) === Object.prototype, 'Expected plain JSON');
  for (const entry of Object.values(value)) json(entry, depth + 1);
}
export function immutable<T>(value: T): T {
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(value);
  return value;
}
export function encode(document: SessionDocument): string { return JSON.stringify(document); }
export function revision(document: SessionDocument): number { return document.events.length; }
export function copyEvent(value: AgentEvent): AgentEvent {
  // The public skeleton emits the optional step as undefined before a Step.
  const candidate = value && object(value.data) && value.data.type === 'message_appended'
    && value.data.step === undefined
    ? { ...value, data: Object.fromEntries(Object.entries(value.data).filter(([key]) => key !== 'step')) }
    : value;
  json(candidate);
  const text = JSON.stringify(candidate);
  requireFact(Buffer.byteLength(text) <= sessionLimits.eventBytes, 'Event byte limit exceeded');
  return JSON.parse(text) as AgentEvent;
}
function outcome(value: unknown): asserts value is ToolOutcome {
  requireFact(object(value), 'Invalid tool outcome');
  if (value.ok === true) {
    fields(value, ['ok', 'content']);
    requireFact(typeof value.content === 'string', 'Missing tool content');
  } else {
    fields(value, ['ok', 'error']);
    requireFact(value.ok === false, 'Invalid tool outcome status');
    fields(value.error, ['code', 'message', 'effect']);
    identity(value.error.code);
    requireFact(typeof value.error.message === 'string'
      && ['none', 'unknown'].includes(value.error.effect as string), 'Invalid tool error');
  }
}
function message(value: unknown): asserts value is Message {
  requireFact(object(value), 'Invalid message');
  if (value.role === 'tool') {
    fields(value, ['role', 'toolCallId', 'name', 'outcome']);
    identity(value.toolCallId); identity(value.name); outcome(value.outcome);
    return;
  }
  requireFact(typeof value.content === 'string', 'Missing message content');
  if (value.role === 'assistant') {
    fields(value, ['role', 'content', 'toolCalls']);
    requireFact(Array.isArray(value.toolCalls) && value.toolCalls.length <= 8, 'Invalid tool batch');
    for (const call of value.toolCalls) {
      fields(call, ['id', 'name', 'arguments']);
      identity(call.id); identity(call.name);
      requireFact('arguments' in call && Buffer.byteLength(JSON.stringify(call.arguments)) <= 64 * 1024,
        'Missing or oversized tool arguments');
    }
  } else {
    fields(value, ['role', 'content']);
    requireFact(value.role === 'system' || value.role === 'user', 'Invalid message role');
  }
}

/**
 * Central current-format admission and projection. No heuristic normalization,
 * synthesized results or historical-shape fallback. Future versions migrate here.
 */
export function inspectDocument(value: unknown): {
  document: SessionDocument; messages: Message[]; recovery: Recovery;
} {
  json(value);
  fields(value, ['schemaVersion', 'sessionId', 'events']);
  requireFact(value.schemaVersion === 1, 'Unsupported Session format; expected version 1');
  identity(value.sessionId);
  requireFact(Array.isArray(value.events) && value.events.length <= sessionLimits.events, 'Event count limit exceeded');
  requireFact(Buffer.byteLength(JSON.stringify(value)) <= sessionLimits.documentBytes, 'Session byte limit exceeded');
  // Detached input protects validation and async backend calls from caller mutation.
  const document = JSON.parse(JSON.stringify(value)) as SessionDocument;
  const messages: Message[] = [];
  const turns: TurnRecovery[] = [];
  const calls: CallRecovery[] = [];
  const turnIds = new Set<string>();
  const callIds = new Set<string>();
  let active: TurnRecovery | undefined;
  let pending: CallRecovery[] = [];
  let userSeen = false;
  let responseSeen = false;
  let finalSeen = false;
  let uncertain = false;
  for (const [index, event] of document.events.entries()) {
    fields(event, ['sessionId', 'turnId', 'seq', 'data']);
    identity(event.turnId);
    requireFact(event.sessionId === document.sessionId && Number.isSafeInteger(event.seq), 'Event identity or sequence mismatch');
    requireFact(Buffer.byteLength(JSON.stringify(event)) <= sessionLimits.eventBytes, 'Event byte limit exceeded');
    const data = event.data;
    requireFact(object(data), 'Missing event data');
    const at = index + 1;
    if (data.type === 'turn_started') {
      fields(data, ['type']);
      requireFact(!active && !turnIds.has(event.turnId) && event.seq === 1 && !uncertain,
        'Cannot start Turn: active, repeated, noninitial sequence or unknown effects require recovery');
      active = { turnId: event.turnId, lastSequence: 1, lastStep: 0 };
      turns.push(active); turnIds.add(event.turnId);
      userSeen = false; finalSeen = false;
      continue;
    }
    requireFact(active && active.turnId === event.turnId && event.seq === active.lastSequence + 1,
      'Fact must extend the active Turn sequence');
    active.lastSequence = event.seq;
    switch (data.type) {
      case 'step_started':
        fields(data, ['type', 'step']);
        requireFact(userSeen && !finalSeen && !uncertain && active.openStep === undefined && !pending.length
          && data.step === active.lastStep + 1, 'Invalid Step start or unsettled calls');
        active.lastStep = data.step; active.openStep = data.step; responseSeen = false;
        break;
      case 'message_appended': {
        fields(data, ['type', 'step', 'message']);
        message(data.message);
        const msg = data.message;
        if (msg.role === 'system' || msg.role === 'user') {
          requireFact(data.step === undefined && !active.lastStep && !userSeen,
            'Input messages must precede Steps and occur only once per Turn');
          if (msg.role === 'user') userSeen = true;
        } else {
          requireFact(active.openStep !== undefined && data.step === active.openStep,
            'Model/tool message must belong to the open Step');
          if (msg.role === 'assistant') {
            requireFact(!responseSeen && !pending.length, 'Repeated model response or unsettled calls');
            responseSeen = true; finalSeen = msg.toolCalls.length === 0;
            for (const call of msg.toolCalls) {
              requireFact(!callIds.has(call.id), 'Repeated tool call identity');
              callIds.add(call.id);
              const record: CallRecovery = {
                turnId: event.turnId, step: data.step!, call: call as ToolCall,
                callRevision: at, status: 'not-started',
              };
              calls.push(record); pending.push(record);
            }
          } else if (msg.role === 'tool') {
            const call = pending[0];
            requireFact(call && call.call.id === msg.toolCallId && call.call.name === msg.name,
              'Tool result must pair with exactly the next pending call');
            requireFact((!msg.outcome.ok && msg.outcome.error.effect === 'none') || call.startRevision !== undefined,
              'Effectful result requires a confirmed write-ahead start');
            requireFact(!uncertain || (!msg.outcome.ok && msg.outcome.error.effect === 'none'
              && call.startRevision === undefined), 'Cannot report new effects after uncertainty');
            call.resultRevision = at; call.outcome = msg.outcome;
            call.status = !msg.outcome.ok && msg.outcome.error.effect === 'unknown' ? 'unknown' : 'settled';
            uncertain ||= call.status === 'unknown';
            pending.shift();
          }
        }
        messages.push(msg);
        break;
      }
      case 'tool_started': {
        fields(data, ['type', 'step', 'toolCallId', 'name']);
        const call = pending[0];
        requireFact(!uncertain && active.openStep !== undefined && data.step === active.openStep && call
          && call.call.id === data.toolCallId && call.call.name === data.name && call.startRevision === undefined,
        'Tool start must match the next unstarted call in the open Step');
        call.startRevision = at; call.status = 'unknown';
        break;
      }
      case 'step_ended':
        fields(data, ['type', 'step']);
        requireFact(active.openStep !== undefined && data.step === active.openStep && !pending.length,
          'Cannot end Step with unsettled calls or without an open Step');
        delete active.openStep;
        break;
      case 'turn_ended':
        fields(data, ['type', 'reason', 'errorCode']);
        requireFact(active.openStep === undefined && !pending.length, 'Cannot end Turn with open Step or unsettled calls');
        requireFact(['completed', 'cancelled', 'budget_exhausted', 'error'].includes(data.reason)
          && (data.errorCode === undefined || typeof data.errorCode === 'string'), 'Invalid terminal');
        requireFact(data.reason !== 'completed' || finalSeen, 'Completed Turn requires final model response');
        requireFact(!uncertain || data.reason === 'error', 'Unknown effects require error terminal');
        active.terminal = { reason: data.reason, revision: at,
          ...(data.errorCode === undefined ? {} : { errorCode: data.errorCode }) };
        active = undefined;
        break;
      default:
        throw new SessionError('invalid_session', 'Unsupported event type');
    }
  }
  return { document, messages, recovery: {
    disposition: calls.some(c => c.status === 'unknown') ? 'unknown-effects' : active ? 'interrupted' : 'ready',
    turns, calls,
  } };
}
