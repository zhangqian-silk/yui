import { enqueueWork, type WorkMailboxQueueStore } from "../coordination/workMailboxQueue.js";
import type { PendingWakeup } from "./pendingWakeup.js";

/** The caller's TaskStore transaction owns this read/merge/write operation. */
export function queueLeaderWakeup(
  store: WorkMailboxQueueStore,
  taskId: string,
  reason: string,
  now: Date
): PendingWakeup | null {
  if (store.getTask(taskId)?.status === "archived") return null;
  // The scheduler's pending-wakeup projection may expose an already-owned
  // processing prefix. Append to the actual suffix, never write that read
  // projection back over independent inputs.
  const pending = enqueueWork(store, { kind: "role", taskId, roleName: "leader" }, reason, now).pending!;
  return {
    schemaVersion: 1, taskId, reasons: [...pending.reasons],
    requestCount: pending.requestCount,
    firstRequestedAt: pending.firstQueuedAt, lastRequestedAt: pending.lastQueuedAt
  };
}
