import { createAgent } from '../index.js';
import type { AgentEvent, Message, ModelProvider, Scope, Tool } from '../index.js';
import type { DisplayRecord, InteractionSessionPort, SessionSummary } from './contracts.js';

type MemorySession = {
  summary: SessionSummary; messages: Message[]; records: DisplayRecord[];
  listeners: Set<() => void>;
  active?: { scope: Scope; abort: AbortController; done: Promise<void> };
};

/** Disposable fixture adapter, NOT the production session/persistence module. */
export function createMemoryDemoSessions(options: { provider: ModelProvider; tools: readonly Tool[]; maxSteps?: number }):
  InteractionSessionPort & { close(): Promise<void>; readonly activeCount: number } {
  const sessions = new Map<string, MemorySession>();
  const failures = new Map<string, string>();
  let nextSession = 0;
  let nextTurn = 0;
  let closing = false;
  const get = (id: string) => {
    const session = sessions.get(id);
    if (!session) throw new Error(`Unknown demo session: ${id}`);
    return session;
  };
  const pageBounds = (offset: number, limit: number, length: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > length
      || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid page bounds');
  };
  const notify = (session: MemorySession) => {
    for (const listener of session.listeners) {
      try { listener(); } catch { /* Optional observer cannot reject recording or execution. */ }
    }
  };
  const append = (session: MemorySession, event: AgentEvent) => {
    const snapshot = structuredClone(event);
    session.records.push({ cursor: session.records.length + 1, kind: 'event', event: snapshot });
    if (snapshot.data.type === 'message_appended') session.messages.push(snapshot.data.message);
    notify(session);
  };
  return {
    get activeCount() { return [...sessions.values()].filter(session => session.active).length; },
    async create(title) {
      if (closing) throw new Error('Demo sessions closed');
      const summary = { id: `demo-session-${++nextSession}`, title: title.slice(0, 200) };
      sessions.set(summary.id, { summary, messages: [], records: [], listeners: new Set() });
      return { ...summary };
    },
    async list(offset, limit) {
      const all = [...sessions.values()];
      pageBounds(offset, limit, all.length);
      return { sessions: all.slice(offset, offset + limit).map(session => ({ ...session.summary })),
        nextOffset: offset + limit < all.length ? offset + limit : null };
    },
    async submit(sessionId, input) {
      if (closing) throw new Error('Demo sessions closed');
      const session = get(sessionId);
      if (session.active) throw new Error('Session already running; cancel or select another session');
      const scope = { sessionId, turnId: `demo-turn-${++nextTurn}` };
      const abort = new AbortController();
      const agent = createAgent({ ...options, onEvent: async event => { append(session, event); } });
      const history = structuredClone(session.messages);
      // Defer execution until the active handle is installed, even for immediate providers.
      const done = Promise.resolve().then(async () => {
        try {
          await agent.runTurn({ ...scope, input, history, maxSteps: options.maxSteps ?? 8, signal: abort.signal });
        } catch (error) {
          // Unexpected/preflight rejection has no trustworthy execution terminal.
          // Preserve an explicit diagnostic, never fabricate an AgentEvent or replay.
          failures.set(sessionId, `Execution rejected; terminal unconfirmed; no automatic replay: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          session.active = undefined;
          notify(session);
        }
      });
      failures.delete(sessionId);
      session.active = { scope, abort, done };
      return { ...scope };
    },
    async cancel(scope) {
      const active = get(scope.sessionId).active;
      if (!active || active.scope.turnId !== scope.turnId) return false;
      active.abort.abort();
      return true;
    },
    async read(id, after, limit) {
      const session = get(id);
      pageBounds(after, limit, session.records.length);
      const records = structuredClone(session.records.slice(after, after + limit));
      return { records, cursor: records.at(-1)?.cursor ?? after,
        hasMore: after + records.length < session.records.length, activeTurnId: session.active?.scope.turnId ?? null,
        diagnostic: failures.get(id) };
    },
    async history(id, offset, limit) {
      const session = get(id);
      pageBounds(offset, limit, session.messages.length);
      return { messages: structuredClone(session.messages.slice(offset, offset + limit)),
        nextOffset: offset + limit < session.messages.length ? offset + limit : null };
    },
    subscribe(id, listener) {
      const session = get(id);
      session.listeners.add(listener);
      return () => { session.listeners.delete(listener); };
    },
    async close() {
      closing = true;
      const active = [...sessions.values()].flatMap(session => session.active ? [session.active] : []);
      for (const turn of active) turn.abort.abort();
      await Promise.all(active.map(turn => turn.done));
      for (const session of sessions.values()) session.listeners.clear();
    },
  };
}
