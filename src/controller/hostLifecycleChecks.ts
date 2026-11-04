import { createNonBlockingChecks } from "../runtime/lifecycleChecks.js";
import type { HostUpgradeCoordinator } from "./hostUpgrade.js";

export type ControllerLifecycleHint = "startup" | "host-observed" | "signal" | "events-persisted" | "periodic";

/** Checks produce a recommendation; only the separately fenced coordinator
 * can admit/execute it. Hints contain no target identity or restart authority. */
export function createHostLifecycleChecks(
  coordinator: Pick<HostUpgradeCoordinator, "status" | "hasPending" | "request" | "stop">,
  onError: (error: unknown) => void = () => {}
) {
  const checks = createNonBlockingChecks<ControllerLifecycleHint>([{
    id: "host-version",
    run: async (_hint, signal) => {
      const observations = await coordinator.status();
      if (signal.aborted) return;
      const recommended = coordinator.hasPending() || observations.some(entry =>
        entry.status === "waiting" || entry.status === "unknown" || entry.status === "failed");
      if (!recommended) return;
      // This await belongs exclusively to this optional check lane. Neither
      // Host transitions nor Controller event folding wait for this operation.
      const results = await coordinator.request();
      for (const entry of results) {
        if (entry.status === "failed" || entry.status === "unknown") {
          onError(new Error(`Host upgrade ${entry.owner.roleName}/${entry.nativeSessionId}: ${entry.detail}`));
        }
      }
    }
  }], onError);
  const close = checks.close;
  checks.close = () => { close(); coordinator.stop(); };
  return checks;
}
