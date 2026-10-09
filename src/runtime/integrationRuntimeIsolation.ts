import { resolve } from "node:path";
import { controllerSocketPath } from "../core/controllerEndpoint.js";
import { managedIntegrationRuntimeRoot } from "../storage/homeLayout.js";
import { yuiTmuxServerName } from "../tmux/tmuxManager.js";
import { FileTaskRuntimeIsolation, type TaskRuntimeIsolationPort } from "./taskRuntimeIsolation.js";

/** One identity/layout for Integration execution and exact-owner cleanup. */
export function defaultIntegrationRuntimeIsolation(home: string, homeId: string): TaskRuntimeIsolationPort {
  const controlHome = resolve(home);
  const runtimeRoot = managedIntegrationRuntimeRoot(controlHome);
  return new FileTaskRuntimeIsolation({
    runtimeRoot,
    pathLayout: "compact",
    controlPlane: {
      yuiHome: controlHome,
      managedRuntimeRoot: runtimeRoot,
      controllerSocketPath: controllerSocketPath(homeId),
      tmuxNamespace: yuiTmuxServerName(controlHome),
      globalInstallPaths: [process.execPath]
    }
  });
}
