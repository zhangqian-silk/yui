import type { AgentEvent, EndReason, Message, ToolCall, ToolOutcome, ToolSettlementEvidence } from '../index.js';

/** Separate from Yui Home storage. Version 2 adds exact settlement evidence. */
export type SessionDocument = {
  schemaVersion: 2;
  sessionId: string;
  events: readonly AgentEvent[];
};
export type SaveSource = {
  /** Backend identity, not a claim that another backend has this data. */
  id: string;
  durability: 'volatile' | 'persistent';
};
/** Caller-resolved native absolute paths, not permission or execution authority. */
export type SessionLocation = { readonly root: string; readonly cwd: string };
/**
 * Replacement backends must provide atomic compare-and-swap and acknowledge only
 * after their advertised durability boundary. Throws may mean unknown commit.
 * read returns a detached complete current document, never a stale cache.
 */
export interface SessionBackend {
  readonly source: SaveSource;
  /** Built-ins implement this bounded port; no full-document fallback for catalogs. */
  readonly catalog?: SessionCatalog;
  /** Optional bounded incremental fact query, with the existing numeric semantics. */
  query?(sessionId: string, options: { after: number; limit: number }): Promise<SessionPage>;
  read(sessionId: string): Promise<unknown | null>;
  write(document: SessionDocument, expectedRevision: number | null): Promise<void>;
  /** Optional capability: atomically create an empty document AND immutable location.
   * Must also expose location through catalog.getSessionInfo; never drop it.
   * A throw may mean unknown commit; callers reconcile by the same Session ID. */
  createWithLocation?(document: SessionDocument, location: SessionLocation): Promise<void>;
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
  settlement?: ToolSettlementEvidence;
};
export type TurnRecovery = {
  turnId: string;
  lastSequence: number;
  lastStep: number;
  openStep?: number;
  terminal?: { reason: EndReason; errorCode?: string; revision: number };
};
export type Recovery = {
  disposition: 'ready' | 'interrupted' | 'unknown-effects' | 'cleanup-required';
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
export type SessionInfo = {
  sessionId: string;
  title: string | null;
  metadataRevision: number;
};
export type SessionDetail = SessionInfo & SaveReceipt & {
  storeId: string;
  /** null explicitly means missing (including all migrated Sessions). */
  location: SessionLocation | null;
};
export type PageOptions = { limit?: number; cursor?: string };
export type SessionCatalogPage = {
  storeId: string;
  catalogRevision: number;
  items: readonly SessionInfo[];
  nextCursor: string | null;
};
export type SessionHistoryPage = SaveReceipt & {
  storeId: string;
  records: SessionPage['records'];
  nextCursor: string | null;
};
/** Reads have no execution/notification effects. Cursors are opaque, bound to
 * store, query, limit and revision; changed data requires a fresh first page.
 * Titles are not unique. Metadata CAS is independent of document CAS.
 * Replacement implementations must enforce the same bounded-read contract.
 * renameSession's revision_conflict/not_found/closed errors must be pre-write
 * refusals; any other thrown write error may have an unknown commit outcome. */
export interface SessionCatalog {
  listSessions(options?: PageOptions): Promise<SessionCatalogPage>;
  getSessionInfo(sessionId: string): Promise<SessionDetail>;
  renameSession(sessionId: string, title: string | null, expectedMetadataRevision: number): Promise<SessionDetail>;
  readHistory(sessionId: string, options?: PageOptions): Promise<SessionHistoryPage>;
}
/** A store-owned handle; structurally usable as the kernel's required recorder. */
export interface SessionRecording {
  record(event: AgentEvent): Promise<void>;
  readonly lastReceipt: SaveReceipt;
  readonly failure: Error | undefined;
}
export interface SessionStore extends SessionCatalog {
  create(sessionId: string, location?: SessionLocation): Promise<SaveReceipt>;
  load(sessionId: string): Promise<SessionSnapshot>;
  /** Exact next fact; never an automatic replay or upsert of an old fact. */
  append(event: AgentEvent, expectedRevision: number): Promise<SaveReceipt>;
  query(sessionId: string, options?: { after?: number; limit?: number }): Promise<SessionPage>;
  /** Local handle notifications, no replay or cross-process delivery guarantee. */
  subscribe(sessionId: string, observer: (receipt: SaveReceipt) => void | Promise<void>): () => void;
  /** Only a ready Session can acquire a new sequential recorder. */
  recorder(sessionId: string): Promise<SessionRecording>;
  /** Store takes ownership of backend; caller must stop execution before close. */
  close(): Promise<void>;
}
