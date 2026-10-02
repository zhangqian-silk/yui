import type { Json, ToolDefinition, ToolOutcome } from '../index.js';
import type {
  EnvironmentTool, PermissionDecision, ToolBatchRequest, ToolBatchResult, ToolExecutor, ToolExecutorOptions,
  ToolIdentity, ToolSettlement,
} from './index.js';

// Match the existing model/tool wire budgets; all sizes are UTF-8 JSON bytes.
const messageBytes = 512 * 1024;
const argumentBytes = 64 * 1024;
const callsPerBatch = 8;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const identifier = (value: unknown): value is string => nonempty(value) && Buffer.byteLength(value, 'utf8') <= 1024;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
function json(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return Array.from(value).every(v => json(v, depth + 1));
  return object(value) && Object.values(value).every(v => json(v, depth + 1));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function snapshot<T>(value: T, limit: number): T {
  const copy = structuredClone(value);
  if (!json(copy) || bytes(copy) > limit) throw new Error('Invalid or oversized JSON');
  return freeze(copy);
}
function failure(code: string, message: string, effect: 'none' | 'unknown' = 'none'): ToolOutcome {
  return { ok: false, error: { code, message, effect } };
}
function outcome(raw: unknown, identity: ToolIdentity, beforeStart = false): ToolOutcome {
  try {
    const value = snapshot(raw, messageBytes);
    if (!object(value)) throw new Error();
    let normalized: ToolOutcome;
    if (!beforeStart && value.ok === true && typeof value.content === 'string') {
      normalized = { ok: true, content: value.content };
    } else if (value.ok === false && object(value.error) && nonempty(value.error.code)
      && typeof value.error.message === 'string'
      && (value.error.effect === 'none' || (!beforeStart && value.error.effect === 'unknown'))) {
      normalized = { ok: false, error: {
        code: value.error.code, message: value.error.message, effect: value.error.effect,
      } };
    } else throw new Error();
    // Guarantee the consumer can append the paired message without truncation.
    if (bytes({ role: 'tool', toolCallId: identity.toolCallId, name: identity.name, outcome: normalized }) > messageBytes) {
      throw new Error();
    }
    return normalized;
  } catch {
    return failure('tool_protocol', 'Invalid or oversized tool result', beforeStart ? 'none' : 'unknown');
  }
}
function status(started: boolean, value: ToolOutcome): ToolSettlement['status'] {
  if (!started) return 'not_executed';
  if (value.ok) return 'succeeded';
  if (value.error.effect === 'unknown') return 'unknown';
  return value.error.code === 'cancelled' ? 'cancelled' : 'failed';
}

export function buildExecutor<E>(options: ToolExecutorOptions<E>): ToolExecutor {
  if (!options?.environment || typeof options.environment.acquire !== 'function') {
    throw new Error('Tool environment.acquire capability is required');
  }
  if (!options.permission || typeof options.permission.check !== 'function') {
    throw new Error('Tool permission.check capability is required');
  }
  if (!Array.isArray(options.tools)) throw new Error('Tool collection is required');
  const acquire = options.environment.acquire.bind(options.environment);
  const check = options.permission.check.bind(options.permission);
  const registry = new Map<string, EnvironmentTool<E>>();
  for (const tool of options.tools) {
    let definition: ToolDefinition;
    try {
      definition = snapshot(tool.definition, messageBytes);
      if (!identifier(definition.name) || typeof definition.description !== 'string'
        || !object(definition.inputSchema) || typeof tool.validate !== 'function'
        || typeof tool.execute !== 'function') throw new Error();
    } catch { throw new Error('Invalid tool declaration or implementation'); }
    if (registry.has(definition.name)) throw new Error('Tool names must be unique');
    registry.set(definition.name, {
      definition, validate: tool.validate.bind(tool), execute: tool.execute.bind(tool),
    });
  }
  const definitions = snapshot([...registry.values()].map(t => t.definition), messageBytes);
  return Object.freeze({
    definitions,
    async executeBatch(request: ToolBatchRequest): Promise<ToolBatchResult> {
      // Admit the whole immutable batch before acquiring any resource.
      let scope, calls;
      try {
        scope = snapshot(request.scope, 4096);
        calls = snapshot(request.calls, messageBytes);
        if (!identifier(scope.sessionId) || !identifier(scope.turnId) || !Number.isSafeInteger(scope.step)
          || scope.step < 1 || !Array.isArray(calls) || !calls.length || calls.length > callsPerBatch
          || calls.some(c => !object(c) || !identifier(c.id) || !identifier(c.name)
            || !json(c.arguments) || bytes(c.arguments) > argumentBytes)
          || new Set(calls.map(c => c.id)).size !== calls.length) throw new Error();
      } catch { throw new Error('Invalid tool batch: bounded JSON, scope and unique call identities required'); }
      // Missing recording/cancellation capabilities cannot silently become no-ops.
      const signal = request.signal;
      const beforeExecute = request.beforeExecute;
      const afterExecute = request.afterExecute;
      if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
        || typeof beforeExecute !== 'function' || typeof afterExecute !== 'function') {
        throw new Error('Tool batch signal, beforeExecute and afterExecute capabilities are required');
      }
      const results: ToolSettlement[] = [];
      let stopped: ToolBatchResult['stopped'] = null;
      let recordingError: ToolBatchResult['recordingError'];
      for (const call of calls) {
        const identity = freeze({ ...scope, toolCallId: call.id, name: call.name });
        let started = false;
        let cleanup: ToolSettlement['cleanup'] = { status: 'not_acquired' };
        let value = failure('not_started', 'Tool was not started');
        const cancelled = (): boolean => {
          if (!signal.aborted) return false;
          stopped ??= 'cancelled';
          value = failure('cancelled_before_start', 'Cancelled before tool execution');
          return true;
        };
        const attempt = async (): Promise<void> => {
          if (cancelled()) return;
          const tool = registry.get(call.name);
          if (!tool) { value = failure('unknown_tool', 'Unknown tool'); return; }
          try {
            const invalid = tool.validate(call.arguments as Json);
            if (invalid !== null) {
              value = outcome({ ok: false, error: invalid }, identity, true);
              if (!value.ok && value.error.code === 'tool_protocol') stopped = 'capability_failed';
              return;
            }
          } catch {
            value = failure('tool_validation', 'Tool validation capability failed');
            stopped = 'capability_failed';
            return;
          }
          if (cancelled()) return;
          const invocation = freeze({ identity, call, definition: tool.definition });
          let lease;
          try { lease = await acquire(invocation, signal); }
          catch {
            value = failure('environment_failed', 'Environment acquisition failed');
            cleanup = { status: 'acquire_failed', error: {
              code: 'acquire_failed', message: 'Environment provider owns partial-resource cleanup; no lease was returned',
            } };
            stopped = 'capability_failed';
            return;
          }
          // A malformed lease cannot prove acquired resources were released.
          let release: () => Promise<void>;
          try {
            if (!lease || typeof lease.release !== 'function') throw new Error();
            release = lease.release.bind(lease);
          } catch {
            value = failure('environment_protocol', 'Environment returned an invalid resource lease');
            cleanup = { status: 'failed', error: {
              code: 'invalid_lease', message: 'No release capability; resource effects unknown',
            } };
            stopped = 'cleanup_failed';
            return;
          }
          try {
            // Use the same environment for authorization and execution, even if
            // the lease implementation exposes its value through an accessor.
            let environment: E;
            try { environment = lease.value; }
            catch {
              value = failure('environment_failed', 'Environment value is unavailable');
              stopped = 'capability_failed';
              return;
            }
            if (cancelled()) return;
            try { await beforeExecute(identity); }
            catch {
              value = failure('record_failed', 'Required execution-intent recording failed');
              stopped = 'capability_failed';
              return;
            }
            if (cancelled()) return;
            // Permission is the last awaited boundary before tool invocation.
            let decision: PermissionDecision;
            try {
              decision = snapshot(await check(invocation, environment, signal), 4096);
              if (!object(decision) || !(decision.allowed === true
                || (decision.allowed === false && typeof decision.reason === 'string'))) throw new Error();
            } catch {
              value = failure('permission_failed', 'Permission capability failed or returned an invalid decision');
              stopped = 'capability_failed';
              return;
            }
            if (cancelled()) return;
            if (!decision.allowed) { value = failure('permission_denied', decision.reason); return; }
            started = true;
            try { value = outcome(await tool.execute(call.arguments, identity, signal, environment), identity); }
            catch { value = failure('tool_exception', 'Tool threw; actual effects are unknown', 'unknown'); }
          } finally {
            try { await release(); cleanup = { status: 'released' }; }
            catch {
              cleanup = { status: 'failed', error: { code: 'release_failed', message: 'Resource release failed; inspect this invocation' } };
              stopped = 'cleanup_failed';
            }
          }
        };
        if (!stopped) await attempt();
        else if (stopped === 'cancelled') cancelled();
        if (!value.ok && value.error.effect === 'unknown') stopped = 'unknown_effect';
        if (signal.aborted) stopped ??= 'cancelled';
        const settlement = freeze({
          identity, started, status: status(started, value), outcome: value,
          cancellationRequested: signal.aborted, cleanup,
        });
        results.push(settlement);
        if (!recordingError) {
          try { await afterExecute(settlement); }
          catch {
            recordingError = {
              identity, code: 'result_record_failed',
              message: 'Result recording failed; write effect unknown. Reconcile using in-memory receipts',
            };
            stopped ??= 'capability_failed';
          }
        }
      }
      return freeze({ results, stopped, ...(recordingError ? { recordingError } : {}) });
    },
  });
}
