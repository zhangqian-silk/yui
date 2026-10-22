/** Additive configuration: valid older records remain enabled. This is not
 * Session state, launch configuration drift, or permission to stop a writer. */
export function isEnabled(value: Readonly<{ enabled?: boolean }>): boolean {
  return value.enabled !== false;
}

export function validateEnabled(value: unknown): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error("Enabled must be a boolean.");
  }
}

export function parseEnabled(value: string | undefined): boolean {
  if (value !== "true" && value !== "false") throw new Error("--enabled must be true or false.");
  return value === "true";
}

export function roleDisabledReason(role: Readonly<{ name: string; taskId?: string }>): string {
  const target = role.taskId === undefined ? `config role enable ${role.name}`
    : `task role enable ${role.taskId} ${role.name}`;
  return `Role ${role.taskId === undefined ? "" : `${role.taskId}/`}${role.name} is disabled. `
    + `Use yui ${target} to allow new execution; existing execution is not stopped.`;
}

export function assertRoleEnabled(role: Readonly<{ name: string; taskId?: string; enabled?: boolean }>): void {
  if (!isEnabled(role)) throw new Error(roleDisabledReason(role));
}
