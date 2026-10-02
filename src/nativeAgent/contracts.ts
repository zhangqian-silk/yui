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
export type EndReason = 'completed' | 'cancelled' | 'budget_exhausted' | 'error';
export type EventData =
  | { type: 'turn_started' }
  | { type: 'step_started'; step: number }
  | { type: 'message_appended'; step?: number; message: Message }
  | { type: 'tool_started'; step: number; toolCallId: string; name: string }
  | { type: 'step_ended'; step: number }
  | { type: 'turn_ended'; reason: EndReason; errorCode?: string };
export type AgentEvent = Scope & { seq: number; data: EventData };
export type TurnResult = Scope & {
  reason: EndReason;
  /** Only messages added in this Turn; prior history is not repeated. */
  messages: readonly Message[];
  events: readonly AgentEvent[];
  steps: number;
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
  tools: readonly Tool[];
  /** Ordered fact sink. A rejection stops new effects, not already-started effects. */
  onEvent?: (event: AgentEvent) => Promise<void>;
};
export interface Agent {
  runTurn(input: TurnInput): Promise<TurnResult>;
}
