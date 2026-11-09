import type { GlobalRoleMessage } from "./message.js";

export type GlobalMessageQuery = Readonly<{
  limit: number;
  pending?: boolean;
  handling?: boolean;
  /** Filter retained claims without loading the full historical message set. */
  handlingExceptSession?: Readonly<{ agentId: string; nativeSessionId: string }>;
  descending?: boolean;
  afterSequence?: number;
  id?: string;
  requestId?: string;
  interruptThen?: boolean;
  /** An undelivered then handoff owned by this exact writer, including claims. */
  reservedThen?: Readonly<{
    nativeSessionId: string;
    agentId: string;
    authorityEpoch: number;
    holderId: string;
  }>;
  operatorNotice?: boolean;
  /** Read-only health projection; includes retained explicit nondelivery. */
  awaitingDelivery?: boolean;
  excludeHealthNotices?: boolean;
  systemBodyPrefix?: string;
  /** Delivery admission excludes actively consumed originals, not other input. */
  unclaimed?: boolean;
}>;

export type GlobalMessagePage = Readonly<{
  count: number;
  oldestCreatedAt: string | null;
  messages: GlobalRoleMessage[];
}>;
