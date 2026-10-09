import { usageError } from "../errors/cliError.js";
import { loadYuiSkillContexts } from "../context/roleSessionContext.js";
import type { ParsedRoleOptions } from "./roleConfiguration.js";

const ROLE_LAUNCH_CONTEXT_OPTIONS = new Set([
  "--workspace",
  "--description",
  "--clear-description",
  "--responsibility",
  "--clear-responsibilities",
  "--constraint",
  "--clear-constraints",
  "--expected-output",
  "--clear-expected-output",
  "--system-prompt",
  "--clear-system-prompt",
  "--skill",
  "--clear-skills"
]);

const SAFE_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function hasRoleLaunchContextOptions(parsed: ParsedRoleOptions): boolean {
  return [...parsed.seen].some((option) => ROLE_LAUNCH_CONTEXT_OPTIONS.has(option));
}

/**
 * Role Skills are launch-time policy. Reject invalid references before the
 * durable Role is changed so a typo cannot make future enters or wakeups fail.
 */
export function validateConfiguredRoleSkills(
  yuiHome: string | undefined,
  skillIds: readonly string[]
): void {
  if (skillIds.length === 0) return;
  if (yuiHome === undefined || yuiHome.trim().length === 0) {
    throw usageError("YUI_HOME is required to configure Role Skills.");
  }
  for (const id of new Set(skillIds)) {
    if (!SAFE_SKILL_ID.test(id)) {
      throw usageError(`Configured Skill id is invalid: ${id}.`);
    }
    try {
      loadYuiSkillContexts(yuiHome, [id]);
    } catch (error) {
      throw usageError(`Configured Skill not found, unreadable or invalid: ${id}. ${error instanceof Error ? error.message : ""}`);
    }
  }
}
