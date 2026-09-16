/**
 * Automatic Resource GC for terminal Tasks (Issue 10).
 *
 * The Controller may call this on a low-frequency timer to quarantine
 * resources owned by terminal Tasks. It is always opt-in: the
 * `resources.gcAutoQuarantine` config defaults to false, and permanent
 * deletion remains a manual, delayed step.
 *
 * The auto-GC pass reuses the same plan/apply engine as the manual command,
 * so every safety guarantee (live-ref re-scan, cleanliness proof, fail-closed
 * sources) applies identically.
 */

import type { TaskStore } from "../storage/taskStore.js";
import {
  applyResourceGc,
  planResourceGc,
  readResourceGcState,
} from "./resourceGc.js";
import {
  resolveResourcesGcAutoQuarantine,
  resolveResourcesGcMode,
  resolveResourcesQuarantineTtlHours
} from "../config/yuiConfig.js";

export type ResourceAutoGcHook = () => Promise<Readonly<{
  skipped: boolean;
  applied: number;
  failed: number;
  restored: number;
}>>;

/**
 * Create the Controller's automatic Resource GC hook. The hook self-skips
 * unless `resourcesGcMode=quarantine` and `resourcesGcAutoQuarantine=true`.
 */
export function createResourceAutoGc(options: {
  home: string;
  store: TaskStore;
  environment?: NodeJS.ProcessEnv;
}): ResourceAutoGcHook {
  const { home, store, environment } = options;
  return async () => {
    const config = store.getConfig();
    const autoQuarantine = resolveResourcesGcAutoQuarantine(config.resourcesGcAutoQuarantine);
    if (!autoQuarantine || resolveResourcesGcMode(config.resourcesGcMode) !== "quarantine") {
      return { skipped: true, applied: 0, failed: 0, restored: 0 };
    }
    const now = new Date();
    const input = {
      home,
      ...readResourceGcState(store),
      mode: "quarantine" as const,
      now,
      quarantineTtlHours: resolveResourcesQuarantineTtlHours(
        config.resourcesQuarantineTtlHours
      ),
      environment
    };
    const plan = await planResourceGc(input);
    const result = await applyResourceGc(input, plan, store);
    return {
      skipped: false,
      applied: result.applied.length,
      failed: result.failed.length,
      restored: result.restored.length
    };
  };
}
