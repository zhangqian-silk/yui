export const DEFAULT_GIT_LOCAL_TIMEOUT_SECONDS = 30;
export const DEFAULT_GIT_REMOTE_INACTIVITY_TIMEOUT_SECONDS = 120;
export const DEFAULT_GIT_REMOTE_TIMEOUT_SECONDS = 1_800;

export type GitConfig = Readonly<{
  gitLocalTimeoutSeconds?: number;
  gitRemoteInactivityTimeoutSeconds?: number;
  gitRemoteTimeoutSeconds?: number;
}>;

export function resolveGitLocalTimeoutSeconds(value?: unknown): number {
  return timeoutSeconds(value, DEFAULT_GIT_LOCAL_TIMEOUT_SECONDS, "gitLocalTimeoutSeconds");
}

export function resolveGitRemoteInactivityTimeoutSeconds(value?: unknown): number {
  return timeoutSeconds(value, DEFAULT_GIT_REMOTE_INACTIVITY_TIMEOUT_SECONDS, "gitRemoteInactivityTimeoutSeconds");
}

export function resolveGitRemoteTimeoutSeconds(value?: unknown): number {
  return timeoutSeconds(value, DEFAULT_GIT_REMOTE_TIMEOUT_SECONDS, "gitRemoteTimeoutSeconds");
}

function timeoutSeconds(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 86_400) {
    throw new TypeError(`${label} must be an integer from 1 to 86400.`);
  }
  return value;
}
