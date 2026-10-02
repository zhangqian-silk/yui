import type { ModelAttempt, ModelErrorCode } from './types.js';

const messages: Record<ModelErrorCode, string> = {
  configuration: 'Invalid explicit model configuration',
  request: 'Invalid or oversized model request',
  protocol: 'Invalid or oversized model response',
  incomplete: 'Model response did not finish completely',
  authentication: 'Model request authentication or access rejected',
  quota: 'Model account quota rejected',
  rate_limit: 'Temporary model rate limit rejection',
  http: 'Model HTTP request failed; not eligible for automatic replay',
  transport: 'Model transport failed; remote effects unknown',
  cancelled: 'Model request cancelled; remote cancellation is not rollback',
  deadline: 'Model request deadline exceeded; remote effects may be unknown',
};
/** No raw cause, URL, request/response bodies, headers, credentials or provider message. */
export class ModelGatewayError extends Error {
  readonly attempts: readonly ModelAttempt[];
  constructor(
    readonly code: ModelErrorCode,
    readonly effect: 'none' | 'unknown' = 'unknown',
    attempts: readonly ModelAttempt[] = [],
    readonly stopReason?: 'attempt_limit' | 'time_limit',
  ) {
    super(messages[code]);
    this.name = 'ModelGatewayError';
    this.attempts = Object.freeze(attempts.map(a => Object.freeze({ ...a })));
  }
}
export function protocol(): never { throw new ModelGatewayError('protocol'); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return protocol();
  return value as Record<string, unknown>;
}
export function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return protocol(); }
}
