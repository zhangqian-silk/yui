import type { TaskStore } from "../storage/taskStore.js";
import { hasManagedIdentity } from "./managedIdentity.js";
import { ManagedRuntimeDriftError, requireManagedGlobalCaller, requireManagedTaskCaller } from "./managedCaller.js";

type LookupStore = Pick<TaskStore, "findNativeSessionSets">;

/** Resolve location from this Home's registry, not from a launch environment.
 * The returned hints are not authority: consumers still validate the current
 * binding (including revocation, Assignment and captured workspace).
 * Native children with their own Codex thread cannot borrow a parent's hints.
 */
export function sessionCallerEnvironment(store: LookupStore, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const native = env.CODEX_THREAD_ID ?? env.YUI_NATIVE_SESSION_ID;
  if (native === undefined) {
    if (hasManagedIdentity(env)) throw new ManagedRuntimeDriftError("Managed Session identity has no native session id.");
    return env;
  }
  if (!native || native.trim() !== native || native.includes("\0")) {
    throw new ManagedRuntimeDriftError("Managed native Session identity is invalid.");
  }
  const identifies = (session: { adapterId: string; nativeSessionId: string }) => session.nativeSessionId === (
    session.adapterId === "codex" ? env.CODEX_THREAD_ID ?? env.YUI_NATIVE_SESSION_ID : env.YUI_NATIVE_SESSION_ID
  );
  const matches = store.findNativeSessionSets(
    [env.CODEX_THREAD_ID, env.YUI_NATIVE_SESSION_ID].filter((id): id is string => id !== undefined)
  ).filter(set => [...Object.values(set.sessions), ...Object.values(set.history ?? {})].some(identifies));
  if (!matches.length && !hasManagedIdentity(env)) return env;
  if (matches.length !== 1) {
    throw new ManagedRuntimeDriftError(matches.length
      ? "Native Session identity is ambiguous in this YUI_HOME; no caller authority was selected."
      : "Managed native Session is not registered in this YUI_HOME. Use its original Home/current Session; do not clear identity hints.");
  }
  const set = matches[0]!;
  const session = set.sessions[set.activeAgentId];
  if (session === undefined || session.status !== "active" || !identifies(session)) {
    throw new ManagedRuntimeDriftError("Managed native Session is no longer current in this YUI_HOME. Use the current Session; historical identity cannot become public.");
  }
  const hints: NodeJS.ProcessEnv = {
    YUI_SESSION_SCOPE: set.owner.scope, YUI_ROLE: set.owner.roleName,
    YUI_AGENT_ID: session.agentId, YUI_ADAPTER_ID: session.adapterId,
    YUI_WORKSPACE: session.effective.workspace.root,
    ...(set.owner.scope === "task" ? { YUI_TASK_ID: set.owner.taskId } : {})
  };
  for (const key of [...Object.keys(hints), "YUI_TASK_ID"]) {
    if (env[key] !== undefined && env[key] !== hints[key]) {
      throw new ManagedRuntimeDriftError(`Managed Session hint ${key} conflicts with this Home's native Session registration.`);
    }
  }
  return { ...env, ...hints };
}

/** One current caller for inbox and other own-address operations. */
export function requireManagedCaller(store: TaskStore, env: NodeJS.ProcessEnv) {
  const current = sessionCallerEnvironment(store, env);
  if (current.YUI_SESSION_SCOPE === "global") {
    return { scope: "global" as const, ...requireManagedGlobalCaller(store, current) };
  }
  return { scope: "task" as const, ...requireManagedTaskCaller(store, current) };
}
