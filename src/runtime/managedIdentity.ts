/** Yui-specific hints assert managed intent, not authentication. A provider's
 * CODEX_THREAD_ID alone is only a lookup hint: resolve it in the selected Home
 * before routing execution. Partial Yui identity must never become public. */
export function hasManagedIdentity(environment: NodeJS.ProcessEnv): boolean {
  return ["YUI_SESSION_SCOPE", "YUI_ROLE", "YUI_AGENT_ID", "YUI_NATIVE_SESSION_ID",
    "YUI_TASK_ID", "YUI_SESSION_MANIFEST", "YUI_ADAPTER_ID", "YUI_WORKSPACE"]
    .some(key => environment[key] !== undefined);
}
