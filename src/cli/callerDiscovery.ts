import { maintenanceCallerEnvironment } from "../storage/maintenanceCaller.js";
import { discoveryAudience } from "./commandDiscovery.js";
import type { DiscoveryAudience } from "./commandCatalog.js";

/** Complete role hints retain their offline template, not authentication.
 * Native-ID-only callers need local lookup to select a template. Read only the
 * selected Home's registry; failure yields unbound, never a public fallback.
 * This observation is deliberately not written back to the process environment. */
export function callerDiscoveryAudience(home: string, env: NodeJS.ProcessEnv): DiscoveryAudience {
  if ((env.YUI_SESSION_SCOPE !== undefined && env.YUI_ROLE !== undefined)
    || (env.CODEX_THREAD_ID === undefined && env.YUI_NATIVE_SESSION_ID === undefined)) {
    return discoveryAudience(env);
  }
  try { return discoveryAudience(maintenanceCallerEnvironment(home, env, false)); }
  catch { return "unbound"; }
}
