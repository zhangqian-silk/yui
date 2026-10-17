import type { GlobalRoleMessage } from "./message.js";

export type GlobalMessageQuery = Readonly<{
  limit: number;
  pending?: boolean;
  handling?: boolean;
  descending?: boolean;
  afterSequence?: number;
  id?: string;
  requestId?: string;
  interruptThen?: boolean;
  operatorNotice?: boolean;
  /** Delivery admission excludes actively consumed originals, not other input. */
  unclaimed?: boolean;
}>;

export type GlobalMessagePage = Readonly<{
  count: number;
  oldestCreatedAt: string | null;
  messages: GlobalRoleMessage[];
}>;
