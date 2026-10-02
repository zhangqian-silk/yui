import { randomUUID } from 'node:crypto';
import type { Agent, Scope, TurnResult } from './contracts.js';
import type { InteractionSessionPort, SessionSummary } from './interaction/index.js';
import type { SessionStore, SessionRecording, SaveReceipt } from './session/index.js';
import type { LocalObserver } from './observability/index.js';

export type ExecutionEvidence = {
  scope: Scope; result?: TurnResult; receipt?: SaveReceipt; failure?: unknown;
};
export interface ExecutionOwner extends InteractionSessionPort {
  /** Current or most recent local execution only; never reconstructed on restart. */
  settle(sessionId: string): Promise<ExecutionEvidence | undefined>;
  /** Cancels and waits for owned executions, detaches listeners; does not close injected store. */
  close(): Promise<void>;
}

/** One local execution owner per Session. Storage remains the sole history
 * authority; this object owns only live handles and current-process receipts.
 * The explicit catalog is a selection view, not persistent Session discovery. */
export function createExecutionOwner(options: {
  store: SessionStore;
  agent(recording: SessionRecording): Agent;
  sessions?: readonly SessionSummary[];
  maxSteps: number;
  observer?: LocalObserver;
}): ExecutionOwner {
  if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1) throw new Error('Positive maxSteps required');
  const catalog = new Map((options.sessions ?? []).map(item => [item.id, { ...item }]));
  const active = new Map<string, { scope: Scope; abort: AbortController; done: Promise<ExecutionEvidence> }>();
  const completed = new Map<string, ExecutionEvidence>();
  const listeners = new Map<string, Set<() => void>>();
  const subscriptions = new Set<() => void>();
  let closed = false;
  const check = () => { if (closed) throw new Error('Execution owner closed'); };
  const notify = (id: string) => {
    for (const listener of listeners.get(id) ?? []) {
      try { void Promise.resolve(listener()).catch(() => {}); } catch { /* Invalidation is optional. */ }
    }
  };
  const bounds = (offset: number, limit: number, length?: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && offset > length)
      || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid page bounds');
  };
  return {
    async create(title) {
      check();
      const summary = { id: randomUUID(), title: title.slice(0, 200) };
      await options.store.create(summary.id);
      catalog.set(summary.id, summary);
      return { ...summary };
    },
    async list(offset, limit) {
      check(); bounds(offset, limit, catalog.size);
      return { sessions: [...catalog.values()].slice(offset, offset + limit).map(item => ({ ...item })),
        nextOffset: offset + limit < catalog.size ? offset + limit : null };
    },
    async submit(sessionId, input) {
      check();
      if (active.has(sessionId)) throw new Error('Session already running');
      if (completed.get(sessionId)?.result?.recording.status === 'failed' || completed.get(sessionId)?.failure)
        throw new Error('Prior execution requires explicit inspection; no automatic retry');
      const scope = Object.freeze({ sessionId, turnId: randomUUID() });
      const abort = new AbortController();
      let accept!: () => void, reject!: (error: unknown) => void;
      const accepted = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail; });
      // Install the handle before loading history or acquiring a recorder.
      const done = Promise.resolve().then(async (): Promise<ExecutionEvidence> => {
        let recording: SessionRecording | undefined;
        let evidence: ExecutionEvidence = { scope };
        try {
          const saved = await options.store.load(sessionId);
          recording = await options.store.recorder(sessionId);
          // A concurrent outside writer is unsupported; never mix two revisions.
          if (recording.lastReceipt.revision !== saved.revision) throw new Error('Session changed during admission');
          check();
          const agent = options.agent(recording);
          accept();
          const result = await agent.runTurn({ ...scope, input, history: saved.messages,
            maxSteps: options.maxSteps, signal: abort.signal });
          evidence = { scope, result, receipt: recording.lastReceipt,
            ...(recording.failure ? { failure: recording.failure } : {}) };
          // A returned result is live evidence, not a reconstituted persisted result.
          try { options.observer?.observeSnapshot(result); } catch { /* Optional diagnostics. */ }
        } catch (failure) {
          reject(failure);
          evidence = { scope, ...(recording ? { receipt: recording.lastReceipt } : {}), failure };
        } finally {
          completed.set(sessionId, evidence);
          active.delete(sessionId);
          notify(sessionId);
        }
        return evidence;
      });
      active.set(sessionId, { scope, abort, done });
      notify(sessionId);
      await accepted;
      return scope;
    },
    async cancel(scope) {
      const turn = active.get(scope.sessionId);
      if (!turn || turn.scope.turnId !== scope.turnId) return false;
      turn.abort.abort();
      return true;
    },
    async read(id, after, limit) {
      check(); bounds(after, limit);
      const page = await options.store.query(id, { after, limit });
      const diagnostic = completed.get(id)?.failure ? 'Recording/execution failed; inspect owner evidence and saved facts; no automatic retry'
        : (await options.store.load(id)).recovery.disposition !== 'ready' && !active.has(id)
          ? 'Saved execution needs explicit recovery; not evidence of a live Turn' : undefined;
      return {
        records: page.records.map(({ revision, event }) => ({ cursor: revision, kind: 'event' as const, event })),
        cursor: page.records.at(-1)?.revision ?? after, hasMore: page.nextCursor !== null,
        activeTurnId: active.get(id)?.scope.turnId ?? null, ...(diagnostic ? { diagnostic } : {}),
      };
    },
    async history(id, offset, limit) {
      check();
      const saved = await options.store.load(id);
      bounds(offset, limit, saved.messages.length);
      return { messages: saved.messages.slice(offset, offset + limit),
        nextOffset: offset + limit < saved.messages.length ? offset + limit : null };
    },
    subscribe(id, listener) {
      check();
      let group = listeners.get(id);
      if (!group) { group = new Set(); listeners.set(id, group); }
      group.add(listener);
      const detach = options.store.subscribe(id, () => {
        try { void Promise.resolve(listener()).catch(() => {}); } catch { /* Optional invalidation. */ }
      });
      const unsubscribe = () => { detach(); group!.delete(listener); subscriptions.delete(unsubscribe); };
      subscriptions.add(unsubscribe);
      return unsubscribe;
    },
    async settle(id) { return active.get(id)?.done ?? completed.get(id); },
    async close() {
      closed = true;
      const owned = [...active.values()];
      for (const turn of owned) turn.abort.abort();
      await Promise.all(owned.map(turn => turn.done));
      for (const unsubscribe of subscriptions) unsubscribe();
      listeners.clear();
    },
  };
}
