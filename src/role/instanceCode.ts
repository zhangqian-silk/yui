/** Presentation only: never used for routing, authorization or launch identity. */
export type RoleDisplaySettings = { instanceCode?: string };

export function validateInstanceCode(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 24
    || !/^[\p{L}\p{N}\p{M}_-]+$/u.test(value)) {
    throw new Error("Instance code must be 1–24 UTF-16 units of Unicode letters, numbers, marks, '_' or '-'; omit '@'.");
  }
  return value;
}
