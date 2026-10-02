import type { ModelProvider, ModelRequest, ModelResponse, StepScope } from '../index.js';

export type ModelUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
export type ModelProgress =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'retry'; delayMs: number };
/** Display-only, never an executable call, stored message, or durable terminal. */
export type ModelObservation = StepScope & { attempt: number; data: ModelProgress };
export type ModelErrorCode = 'configuration' | 'request' | 'protocol' | 'incomplete'
  | 'authentication' | 'quota' | 'rate_limit' | 'http' | 'transport' | 'cancelled' | 'deadline';
export type ModelAttempt = {
  attempt: number; elapsedMs: number; status?: number;
  outcome: 'success' | ModelErrorCode;
  /** Rejection is known; transport errors/cancellation do not prove remote rollback. */
  effect: 'none' | 'unknown' | 'completed';
};
export type ModelGeneration = {
  response: ModelResponse; usage?: ModelUsage; attempts: readonly ModelAttempt[];
};
export interface ModelGateway extends ModelProvider {
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelGeneration>;
}
/** Implementations must honor signal, settle before resolving, and not follow redirects. */
export type ModelTransport = (endpoint: string, init: {
  method: 'POST'; headers: Readonly<Record<string, string>>; body: string;
  signal: AbortSignal; redirect: 'error';
}) => Promise<Response>;
export interface ModelProtocolAdapter {
  encode(request: ModelRequest, model: string, stream: boolean): unknown;
  decode(body: AsyncIterable<string>, stream: boolean, emit: (data: ModelProgress) => void):
    Promise<{ response: ModelResponse; usage?: ModelUsage }>;
  /** Only explicit, known rejection classifications may enable a retry. */
  classify(status: number, body: unknown): 'authentication' | 'quota' | 'rate_limit' | 'http';
}
export type ModelGatewayOptions = {
  /** Exact complete URL, never inferred/appended; HTTPS or loopback HTTP only. */
  endpoint: string;
  model: string;
  account: { kind: 'bearer'; token: string } | { kind: 'none' };
  stream?: boolean;
  adapter?: ModelProtocolAdapter;
  transport?: ModelTransport;
  /** Best-effort display. Failures are isolated; promises are not awaited. */
  onObservation?: (event: ModelObservation) => void | Promise<void>;
  retry?: { maxAttempts?: number; maxElapsedMs?: number; baseDelayMs?: number };
  /** Explicit deterministic test seam; sleep must cooperate with signal. */
  clock?: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
};
