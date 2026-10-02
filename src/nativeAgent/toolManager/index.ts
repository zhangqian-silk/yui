import type { Json, StepScope, Tool, ToolCall, ToolDefinition, ToolOutcome } from '../index.js';
import { buildExecutor } from './executor.js';

/** Tools using no environment remain ordinary three-argument Tools. */
export type EnvironmentTool<E> = Omit<Tool, 'execute'> & {
  execute(args: Json, scope: StepScope & { toolCallId: string }, signal: AbortSignal, environment: E): Promise<ToolOutcome>;
};
export type ToolIdentity = StepScope & { toolCallId: string; name: string };
export type ToolInvocation = { identity: ToolIdentity; call: ToolCall; definition: ToolDefinition };
export type PermissionDecision = { allowed: true } | { allowed: false; reason: string };
export interface ToolPermission<E> {
  /** No target-tool effects. Rejecting/throwing never authorizes execution. */
  check(invocation: ToolInvocation, environment: E, signal: AbortSignal): Promise<PermissionDecision>;
}
export interface ToolEnvironment<E> {
  /** Acquire resources only, never execute the target effect. On rejection,
   * the implementation owns cleanup of any partially acquired resources. */
  acquire(invocation: ToolInvocation, signal: AbortSignal): Promise<{
    value: E;
    /** Called exactly once after acquisition, without the aborted signal.
     * Must settle owned resources on both success and failure. */
    release(): Promise<void>;
  }>;
}
export type ToolSettlement = {
  identity: ToolIdentity;
  started: boolean;
  /** Derived from actual execution and outcome; not a second writable state. */
  status: 'succeeded' | 'not_executed' | 'cancelled' | 'failed' | 'unknown';
  outcome: ToolOutcome;
  cancellationRequested: boolean;
  /** Failure here never overwrites a confirmed tool outcome. */
  cleanup: { status: 'not_acquired' | 'released' } | {
    status: 'failed' | 'acquire_failed'; error: { code: string; message: string };
  };
};
export type ToolBatchRequest = {
  scope: StepScope;
  calls: readonly ToolCall[];
  signal: AbortSignal;
  /** Required recording barrier, not telemetry. Persist the execution intent
   * before this resolves. A rejection prevents execution. Permission and
   * cancellation are checked afterwards: intent is not proof of execution. */
  beforeExecute(identity: ToolIdentity): Promise<void>;
  /** Required result barrier, awaited before the next tool. On rejection the
   * write's effect is unknown: stop calling this sink, return every receipt in
   * memory, and stop new effects. Caller reconciles; neither write nor tool is
   * automatically retried. Optional telemetry must use a separate channel. */
  afterExecute(settlement: ToolSettlement): Promise<void>;
};
export type ToolBatchResult = {
  results: readonly ToolSettlement[];
  stopped: 'cancelled' | 'unknown_effect' | 'capability_failed' | 'cleanup_failed' | null;
  recordingError?: { identity: ToolIdentity; code: 'result_record_failed'; message: string };
};
export interface ToolExecutor {
  readonly definitions: readonly ToolDefinition[];
  /** One sequential batch, no automatic retry or cross-request replay ledger.
   * The caller owns global call-ID uniqueness, durable pairing and recovery.
   * Invalid batches reject before any effects; admitted calls all get receipts.
   * Do not overlap batches sharing a session/environment. */
  executeBatch(request: ToolBatchRequest): Promise<ToolBatchResult>;
}
export type ToolExecutorOptions<E> = {
  tools: readonly EnvironmentTool<E>[];
  environment: ToolEnvironment<E>;
  permission: ToolPermission<E>;
};

export function createToolExecutor<E>(options: ToolExecutorOptions<E>): ToolExecutor {
  return buildExecutor(options);
}
