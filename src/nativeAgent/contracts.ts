/** Independent Agent contracts: no Yui runtime or third-party Agent types. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ToolCall = { id: string; name: string; arguments: Json };
export type ToolError = { code: string; message: string; effect: 'none' | 'unknown' };
export type ToolOutcome = { ok: true; content: string } | { ok: false; error: ToolError };
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: readonly ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; outcome: ToolOutcome };
export type Scope = { sessionId: string; turnId: string };
export type StepScope = Scope & { step: number };
export type ToolDefinition = { name: string; description: string; inputSchema: Readonly<Record<string, Json>> };
export type ModelRequest = StepScope & { messages: readonly Message[]; tools: readonly ToolDefinition[] };
export type ModelResponse =
  | { kind: 'final'; content: string }
  | { kind: 'tool_calls'; content: string; calls: readonly ToolCall[] };
export interface ModelProvider {
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}
export interface Tool {
  definition: ToolDefinition;
  validate(args: Json): ToolError | null;
  execute(args: Json, scope: StepScope & { toolCallId: string }, signal: AbortSignal): Promise<ToolOutcome>;
}
/** Owns tool authorization/validation and settlement; never retry unknown effects. */
export interface ToolExecutor {
  readonly definitions: readonly ToolDefinition[];
  execute(call: ToolCall, scope: StepScope, signal: AbortSignal): Promise<ToolOutcome>;
}
/** Produces model-only context, not a replacement for authoritative session history. */
export interface ContextBuilder {
  build(request: ModelRequest, signal: AbortSignal): Promise<readonly Message[]>;
}
export type EndReason = 'completed' | 'cancelled' | 'budget_exhausted' | 'error';
export type EventData =
  | { type: 'turn_started' }
  | { type: 'step_started'; step: number }
  | { type: 'message_appended'; step?: number; message: Message }
  | { type: 'tool_started'; step: number; toolCallId: string; name: string }
  | { type: 'step_ended'; step: number }
  | { type: 'turn_ended'; reason: EndReason; errorCode?: string };
export type AgentEvent = Scope & { seq: number; data: EventData };
/** A resolved call confirms recording this exact fact. Rejections are never retried. */
export interface SessionRecorder {
  record(event: AgentEvent): Promise<void>;
}
/** Synchronous, nonblocking notification. Queue transport in the consumer, not here. */
export interface AgentObserver {
  observe(event: AgentEvent): void;
}
export type RecordingStatus =
  | { status: 'memory'; lastRecordedSeq: 0 }
  | { status: 'recorded'; lastRecordedSeq: number }
  | { status: 'failed'; lastRecordedSeq: number; failedSeq: number };
export type TurnResult = Scope & {
  reason: EndReason;
  /** Only messages added in this Turn; prior history is not repeated. */
  messages: readonly Message[];
  events: readonly AgentEvent[];
  steps: number;
  recording: RecordingStatus;
  /** A failed observer is disconnected for the rest of this Turn, not retried. */
  observerErrors: readonly { seq: number; message: string }[];
  error?: { code: string; message: string };
};
export type TurnInput = Scope & {
  input: string;
  history?: readonly Message[];
  maxSteps: number;
  signal?: AbortSignal;
};
export type AgentOptions = {
  provider: ModelProvider;
  contextBuilder?: ContextBuilder;
  /** If omitted, facts exist only in the returned in-memory events. */
  recorder?: SessionRecorder;
  observer?: AgentObserver;
} & (
  | { tools: readonly Tool[]; toolExecutor?: never }
  | { toolExecutor: ToolExecutor; tools?: never }
);
export interface Agent {
  runTurn(input: TurnInput): Promise<TurnResult>;
}
