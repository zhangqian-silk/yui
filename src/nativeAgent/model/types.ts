import type { ModelProvider, ModelRequest, ModelResponse, StepScope } from '../index.js';

export type ModelUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
export type ModelProgress =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'attempt_finished'; record: ModelAttempt }
  | { type: 'retry'; delayMs: number };
/** Display-only, never an executable call, stored message, or durable terminal. */
export type ModelObservation = StepScope & {
  /** Gateway-generated logical call identity; never presented as a server ID. */
  requestId: string; source: 'live'; attempt: number; data: ModelProgress;
};
/** Body-free projection for optional diagnostic consumers, not an AgentEvent. */
export type ModelDiagnostic = Omit<ModelObservation, 'data'> & {
  data: Extract<ModelProgress, { type: 'attempt_finished' | 'retry' }>;
};
export type ModelErrorCode = 'configuration' | 'request' | 'protocol' | 'incomplete'
  | 'authentication' | 'quota' | 'rate_limit' | 'http' | 'transport' | 'cancelled' | 'deadline';
export type ModelAttempt = {
  attempt: number;
  /** Cumulative since this logical generate began, including earlier attempts/backoff. */
  elapsedMs: number;
  status?: number;
  /** Exact X-Client-Request-Id sent for this HTTP attempt. */
  clientRequestId: string;
  /** Bounded x-request-id response header when supplied; absent is not synthesized. */
  providerRequestId?: string;
  /** Reported usage, including when a later stream error prevents success. */
  usage?: ModelUsage;
  outcome: 'success' | ModelErrorCode;
  /** Rejection is known; transport errors/cancellation do not prove remote rollback. */
  effect: 'none' | 'unknown' | 'completed';
};
export type ModelGeneration = {
  requestId: string; source: 'live';
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
