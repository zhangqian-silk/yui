import type { AgentEvent, EndReason, Message, ToolCall, ToolOutcome } from '../index.js';

/** Separate from Yui Home storage. No earlier persistent format exists. */
export type SessionDocument = {
  schemaVersion: 1;
  sessionId: string;
  events: readonly AgentEvent[];
};
export type SaveSource = {
  /** Backend identity, not a claim that another backend has this data. */
  id: string;
  durability: 'volatile' | 'persistent';
};
/**
 * Replacement backends must provide atomic compare-and-swap and acknowledge only
 * after their advertised durability boundary. Throws may mean unknown commit.
 * read returns a detached complete current document, never a stale cache.
 */
export interface SessionBackend {
  readonly source: SaveSource;
  read(sessionId: string): Promise<unknown | null>;
  write(document: SessionDocument, expectedRevision: number | null): Promise<void>;
  close(): Promise<void>;
}
export type SaveReceipt = {
  sessionId: string;
  revision: number;
  digest: string;
  source: SaveSource;
};
export type CallRecovery = {
  turnId: string;
  step: number;
  call: ToolCall;
  status: 'not-started' | 'settled' | 'unknown';
  callRevision: number;
  startRevision?: number;
  resultRevision?: number;
  outcome?: ToolOutcome;
};
export type TurnRecovery = {
  turnId: string;
  lastSequence: number;
  lastStep: number;
  openStep?: number;
  terminal?: { reason: EndReason; errorCode?: string; revision: number };
};
export type Recovery = {
  disposition: 'ready' | 'interrupted' | 'unknown-effects';
  turns: readonly TurnRecovery[];
  calls: readonly CallRecovery[];
};
export type SessionSnapshot = SaveReceipt & {
  document: SessionDocument;
  /** May be incomplete when recovery is not ready; never fabricated/repaired. */
  messages: readonly Message[];
  recovery: Recovery;
};
export type SessionPage = SaveReceipt & {
  records: readonly { revision: number; event: AgentEvent }[];
  nextCursor: number | null;
};
export interface SessionRecorder {
  record(event: AgentEvent): Promise<SaveReceipt>;
  readonly lastReceipt: SaveReceipt;
  readonly failure: Error | undefined;
}
export interface SessionStore {
  create(sessionId: string): Promise<SaveReceipt>;
  load(sessionId: string): Promise<SessionSnapshot>;
  /** Exact next fact; never an automatic replay or upsert of an old fact. */
  append(event: AgentEvent, expectedRevision: number): Promise<SaveReceipt>;
  query(sessionId: string, options?: { after?: number; limit?: number }): Promise<SessionPage>;
  /** Local handle notifications, no replay or cross-process delivery guarantee. */
  subscribe(sessionId: string, observer: (receipt: SaveReceipt) => void | Promise<void>): () => void;
  /** Only a ready Session can acquire a new sequential recorder. */
  recorder(sessionId: string): Promise<SessionRecorder>;
  /** Store takes ownership of backend; caller must stop execution before close. */
  close(): Promise<void>;
}
