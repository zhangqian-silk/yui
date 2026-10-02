import type { AgentEvent, Message, Scope } from '../index.js';

/** Consumer-side display contract, not a second Agent/session domain model. */
export type DisplayRecord =
  | { cursor: number; kind: 'event'; event: AgentEvent }
  | (Scope & { cursor: number; kind: 'text_delta'; text: string });
export type SessionSummary = { id: string; title: string };
export interface InteractionSessionPort {
  create(title: string): Promise<SessionSummary>;
  list(offset: number, limit: number): Promise<{ sessions: readonly SessionSummary[]; nextOffset: number | null }>;
  /** Accept a turn without waiting for execution; reject if already running. Never auto-replay errors. */
  submit(sessionId: string, input: string): Promise<Scope>;
  /** Exact turn cancellation request, not a claim that effects have stopped. */
  cancel(scope: Scope): Promise<boolean>;
  /**
   * Ordered session-local cursor, stable across observers. Required facts must be
   * recorded before notification. Page sizes <=20; each event <=1 MiB.
   * cursor is the last returned record (or after for an empty page).
   * hasMore requires forward progress. activeTurnId is a current observation.
   * Missing/expired cursors must fail explicitly; never silently skip history.
   * Provisional deltas may be omitted on replay; committed facts may not.
   */
  read(sessionId: string, after: number, limit: number): Promise<{
    records: readonly DisplayRecord[]; cursor: number; hasMore: boolean; activeTurnId: string | null;
    /** Operational diagnostic, not a fabricated execution terminal. */
    diagnostic?: string;
  }>;
  /** Stable append-only message offsets; bounded page, same payload bound as read. */
  history(sessionId: string, offset: number, limit: number): Promise<{
    messages: readonly Message[]; nextOffset: number | null;
  }>;
  /** Invalidation only; synchronous installation, detachable and failure-isolated. */
  subscribe(sessionId: string, changed: () => void): () => void;
}
export interface InteractionRenderer {
  record(record: DisplayRecord): string;
  message(message: Message): string;
}
/** Optional live-only text. Never a history cursor or execution fact. */
export interface InteractionTextProgress {
  subscribe(listener: (progress: Scope & { text: string }) => void): () => void;
}

/**
 * Optional display projection supplied by an observation adapter. Strings retain
 * the producer's source/gap/rejected/dropped/inFlight facts, not session state.
 * No telemetry domain types or execution authority are defined here.
 */
export interface InteractionDiagnosticsPort {
  query(sessionId: string, offset: number, limit: number): Promise<{
    lines: readonly string[]; nextOffset: number | null;
  }>;
  health(): Promise<string>;
  subscribe(changed: () => void): () => void;
}
