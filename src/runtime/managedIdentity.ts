/** Presence is not authentication. Even partial transport identity must not
 * silently acquire the authority of an unbound public caller. */
export function hasManagedIdentity(environment: NodeJS.ProcessEnv): boolean {
  return ["YUI_SESSION_SCOPE", "YUI_ROLE", "YUI_AGENT_ID", "YUI_NATIVE_SESSION_ID",
    "YUI_TASK_ID", "YUI_SESSION_MANIFEST"].some(key => environment[key] !== undefined);
}
