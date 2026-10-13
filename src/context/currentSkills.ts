import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILTIN_YUI_SKILLS: ReadonlySet<string> = new Set([
  "yui-runtime", "yui-operator", "yui-leader", "yui-worker", "yui-reviewer"
]);

export function currentSkillPath(home: string | undefined, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id)) throw new Error(`Invalid configured Skill id: ${id}.`);
  if (BUILTIN_YUI_SKILLS.has(id)) return fileURLToPath(new URL(`../../skills/${id}`, import.meta.url));
  if (home === undefined) throw new Error("YUI_HOME is required to load configured Role skills.");
  return resolve(home, "skills", id);
}

/** Per-turn metadata only: never read the body, traverse resources, snapshot a
 * package, or claim that the model still has instructions in its context. */
export function checkCurrentSkills(home: string | undefined, ids: readonly string[]) {
  return [...new Set(ids)].map(id => {
    const path = currentSkillPath(home, id);
    const versionPath = join(path, "VERSION");
    try {
      for (const file of [join(path, "SKILL.md"), versionPath]) {
        if (realpathSync(file) !== resolve(file) || !lstatSync(file).isFile()) {
          throw new Error(`Skill files must be regular files without symlinks: ${file}.`);
        }
        accessSync(file, constants.R_OK);
      }
      if (lstatSync(versionPath).size > 128) throw new Error("VERSION exceeds 128 bytes.");
      const version = readFileSync(versionPath, "utf8").trim();
      if (!/^[1-9][0-9]{0,8}$/u.test(version)) throw new Error("VERSION must contain a positive internal integer.");
      return { id, path, version, versionPath };
    } catch (error) {
      throw new Error(`Current Skill ${id} is missing, unreadable or invalid at ${path}. `
        + `${error instanceof Error ? error.message : String(error)} `
        + "Restore the current installation/configured Skill (including VERSION) in this Home, then check again; "
        + "do not replace the Session or replay input to repair Skill loading.", { cause: error });
    }
  });
}

export const SKILL_CHECK_COMMAND = "yui session skills --json";
export const SKILL_REUSE_RULE = "At the start of every turn, check current Skill versions and availability. "
  + "Read full SKILL.md and necessary references on first entry, version change, recovery, "
  + "or missing/compacted/uncertain context; reuse only unchanged full instructions available now. "
  + "A version check is not a loading receipt or authority.";
