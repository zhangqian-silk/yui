import type { AgentEvent } from '../index.js';
import type { SaveReceipt, SessionBackend, SessionCatalog, SessionDocument, SessionLocation, SessionRecording, SessionStore } from './contracts.js';
import { digest } from './backends.js';
import { copyEvent, identity, immutable, inspectDocument, revision, SessionError, sessionLimits } from './format.js';
import { metadataRevision, normalizeTitle, queryBounds } from './catalog.js';
import { copyLocation } from './location.js';

export class SessionSaveError extends SessionError {
  /** Conservative: a thrown backend write is not proof that no commit occurred. */
  readonly effect = 'unknown';
  constructor(
    readonly sessionId: string,
    readonly expectedRevision: number | null,
    readonly event: AgentEvent | undefined,
    cause: unknown,
    readonly location?: SessionLocation,
  ) {
    super('save_failed', 'Necessary Session save failed; stop new effects and inspect exact saved facts', { cause });
    this.name = 'SessionSaveError';
  }
}
export class SessionMetadataSaveError extends SessionError {
  readonly effect = 'unknown';
  constructor(
    readonly sessionId: string,
    readonly title: string | null,
    readonly expectedMetadataRevision: number,
    cause: unknown,
  ) {
    super('metadata_save_failed', 'Metadata save confirmation failed; inspect exact title/revision before another write', { cause });
    this.name = 'SessionMetadataSaveError';
  }
}
type Observer = {
  sessionId: string;
  callback: (receipt: SaveReceipt) => void | Promise<void>;
  pending?: SaveReceipt;
  busy: boolean;
  active: boolean;
};

export function createSessionStore(backend: SessionBackend): SessionStore {
  identity(backend.source.id);
  const source = immutable(structuredClone(backend.source));
  if (!['volatile', 'persistent'].includes(source.durability)) {
    throw new SessionError('invalid_backend', 'Backend must advertise its persistence boundary');
  }
  let closed = false;
  let backendClosed = false;
  const observers = new Set<Observer>();
  const check = (): void => { if (closed) throw new SessionError('closed', 'Session store is closed'); };
  const catalog = (): SessionCatalog => {
    check();
    if (!backend.catalog) throw new SessionError('unsupported_catalog', 'Backend does not implement the bounded SessionCatalog port');
    return backend.catalog;
  };
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    check();
    try {
      const value = await operation();
      check();
      return immutable(value);
    } catch (cause) {
      if (cause instanceof SessionError) throw cause;
      throw new SessionError('read_failed', 'Session query failed; no empty-page fallback', { cause });
    }
  };
  const receipt = (document: SessionDocument): SaveReceipt => immutable({
    sessionId: document.sessionId, revision: revision(document), digest: digest(document), source,
  });
  const dispatch = (observer: Observer): void => {
    if (observer.busy || !observer.active || !observer.pending) return;
    observer.busy = true;
    queueMicrotask(() => {
      const next = observer.pending;
      observer.pending = undefined;
      if (!observer.active || !next) { observer.busy = false; return; }
      // An observer has at most one in-flight callback and one coalesced receipt.
      // A hung UI never blocks a commit or creates an unbounded notification queue.
      void Promise.resolve().then(() => {
        if (observer.active) return observer.callback(next);
      }).catch(() => {
        observer.active = false;
        observers.delete(observer);
      }).finally(() => {
        observer.busy = false;
        dispatch(observer);
      });
    });
  };
  const notify = (saved: SaveReceipt): void => {
    for (const observer of observers) {
      if (observer.sessionId === saved.sessionId) { observer.pending = saved; dispatch(observer); }
    }
  };
  const save = async (document: SessionDocument, expected: number | null, location?: SessionLocation): Promise<SaveReceipt> => {
    check();
    try {
      if (location === undefined) await backend.write(immutable(document), expected);
      else await backend.createWithLocation!(immutable(document), location);
    }
    catch (cause) {
      throw new SessionSaveError(document.sessionId, expected, document.events.at(-1), cause, location);
    }
    const saved = receipt(document);
    notify(saved);
    return saved;
  };
  const store: SessionStore = {
    async listSessions(options = {}) { return read(() => catalog().listSessions(options)); },
    async getSessionInfo(sessionId) {
      identity(sessionId);
      return read(() => catalog().getSessionInfo(sessionId));
    },
    async readHistory(sessionId, options = {}) {
      identity(sessionId);
      return read(() => catalog().readHistory(sessionId, options));
    },
    async renameSession(sessionId, title, expected) {
      check(); identity(sessionId);
      const normalized = normalizeTitle(title);
      metadataRevision(expected);
      const port = catalog();
      try { return immutable(await port.renameSession(sessionId, normalized, expected)); }
      catch (cause) {
        // These port errors are confirmed precondition refusals, not ambiguous saves.
        if (cause instanceof SessionError && ['revision_conflict', 'not_found', 'closed'].includes(cause.code)) throw cause;
        throw new SessionMetadataSaveError(sessionId, normalized, expected, cause);
      }
    },
    async create(sessionId, location) {
      check(); identity(sessionId);
      const selected = location === undefined ? undefined : immutable(copyLocation(location));
      if (selected !== undefined && (!backend.createWithLocation || !backend.catalog)) {
        throw new SessionError('unsupported_location', 'Backend lacks atomic location creation and bounded detail reconciliation');
      }
      return save({ schemaVersion: 2, sessionId, events: [] }, null, selected);
    },
    async load(sessionId) {
      check(); identity(sessionId);
      const raw = await backend.read(sessionId);
      check();
      if (raw === null) throw new SessionError('not_found', 'Session not found');
      const state = inspectDocument(raw);
      if (state.document.sessionId !== sessionId) throw new SessionError('invalid_session', 'Backend returned another Session');
      return immutable({ ...receipt(state.document), ...state });
    },
    async append(event, expectedRevision) {
      check();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new SessionError('revision_conflict', 'Expected revision must be a nonnegative integer');
      }
      const next = copyEvent(event);
      const previous = await store.load(next.sessionId);
      if (previous.revision !== expectedRevision) {
        throw new SessionError('revision_conflict', 'Session revision conflict; read current facts');
      }
      const state = inspectDocument({ ...previous.document, events: [...previous.document.events, next] });
      return save(state.document, expectedRevision);
    },
    async query(sessionId, options = {}) {
      const after = options.after ?? 0;
      const limit = options.limit ?? 50;
      queryBounds(after, limit);
      if (backend.query) {
        identity(sessionId);
        return read(() => backend.query!(sessionId, { after, limit }));
      }
      const loaded = await store.load(sessionId);
      if (after > loaded.revision) throw new SessionError('invalid_query', 'Cursor exceeds the saved revision');
      const end = Math.min(after + limit, loaded.revision);
      return immutable({ ...receipt(loaded.document),
        records: loaded.document.events.slice(after, end).map((event, offset) => ({ revision: after + offset + 1, event })),
        nextCursor: end < loaded.revision ? end : null,
      });
    },
    subscribe(sessionId, callback) {
      check(); identity(sessionId);
      if (typeof callback !== 'function' || observers.size >= sessionLimits.subscribers) {
        throw new SessionError('invalid_subscription', 'Expected observer within subscription limit');
      }
      const observer: Observer = { sessionId, callback, active: true, busy: false };
      observers.add(observer);
      return () => { observer.active = false; observer.pending = undefined; observers.delete(observer); };
    },
    async recorder(sessionId): Promise<SessionRecording> {
      const saved = await store.load(sessionId);
      if (saved.recovery.disposition !== 'ready') {
        throw new SessionError('recovery_required', 'Session requires explicit recovery; automatic replay is forbidden');
      }
      let lastReceipt = receipt(saved.document);
      let failure: Error | undefined;
      let busy = false;
      return {
        get lastReceipt() { return lastReceipt; },
        get failure() { return failure; },
        async record(event) {
          if (failure) throw new SessionError('recorder_failed', 'Session recorder is stopped after failure', { cause: failure });
          if (busy) throw new SessionError('recorder_busy', 'Session recorder requires sequential facts');
          busy = true;
          try {
            if (event.sessionId !== sessionId) throw new SessionError('invalid_session', 'Recorder Session mismatch');
            lastReceipt = await store.append(event, lastReceipt.revision);
          } catch (cause) {
            failure = cause instanceof Error ? cause : new Error(String(cause));
            throw failure;
          } finally { busy = false; }
        },
      };
    },
    async close() {
      if (backendClosed) return;
      closed = true;
      for (const observer of observers) { observer.active = false; observer.pending = undefined; }
      observers.clear();
      await backend.close();
      backendClosed = true;
    },
  };
  return store;
}
