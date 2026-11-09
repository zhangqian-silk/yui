import type { SchedulerStorePort } from "../scheduler/ports.js";
import type { AsyncTaskStoreClient } from "../storage/storeRpc.js";

/**
 * Keep maintenance read/check/write closures together on the persistence
 * worker. These operations recheck their exact durable condition in one
 * transaction and are idempotent under the worker's existing replay contract.
 * Do not add admission/claim operations here: their result and unknown-effect
 * contracts need a separate audit before moving across this boundary.
 */
const WORKER_MAINTENANCE = new Set<PropertyKey>([
  "resolveExpiredInputRecommendations",
  "recordRoleRunProgress",
  "recordRoleRunDiagnostic",
  "recordRoleRunStall"
]);

export function workerSchedulerStore(
  store: SchedulerStorePort,
  client: Pick<AsyncTaskStoreClient, "invokeObserver">
): SchedulerStorePort {
  return new Proxy(store, {
    get(target, property) {
      if (WORKER_MAINTENANCE.has(property)) {
        return (...args: unknown[]) => client.invokeObserver(String(property), args);
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
