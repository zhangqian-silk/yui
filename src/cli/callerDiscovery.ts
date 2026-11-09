import { maintenanceCallerEnvironment } from "../storage/maintenanceCaller.js";
import { discoveryAudience } from "./commandDiscovery.js";
import type { DiscoveryAudience } from "./commandCatalog.js";
import { readCurrentTaskLeader } from "../storage/currentTaskLeader.js";

/** Complete role hints retain their offline template, not authentication.
 * Native-ID-only callers need local lookup to select a template. Read only the
 * selected Home's registry; failure yields unbound, never a public fallback.
 * This observation is deliberately not written back to the process environment. */
export function callerDiscoveryAudience(home: string, env: NodeJS.ProcessEnv): DiscoveryAudience {
  const project = (environment: NodeJS.ProcessEnv): DiscoveryAudience => {
    const audience = discoveryAudience(environment);
    if (audience !== "leader") return audience;
    // Preserve the existing offline base template, but hints never grant the
    // specialized view. This projection is not execution authentication.
    try {
      return readCurrentTaskLeader(home, environment.YUI_TASK_ID!)?.template === "experiment-leader"
        ? "experiment-leader" : "leader";
    } catch { return audience; }
  };
  if ((env.YUI_SESSION_SCOPE !== undefined && env.YUI_ROLE !== undefined)
    || (env.CODEX_THREAD_ID === undefined && env.YUI_NATIVE_SESSION_ID === undefined)) {
    return project(env);
  }
  try { return project(maintenanceCallerEnvironment(home, env, false)); }
  catch { return "unbound"; }
}
