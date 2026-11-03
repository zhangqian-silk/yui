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
export const SKILL_REUSE_RULE = "The managed Host checks current Skill versions/availability before each input; "
  + "do not repeat a check identified by the yui:skills-checked transport marker or an explicit Host notice. "
  + "Without either, check through the Manifest's command. Keep routine checks internal, not user-facing progress. "
  + "Reuse unchanged full instructions in context; messages alone require no reload. "
  + "Read affected entries/references fully on change or localized loss. On first entry, recovery or lost context, "
  + "rebuild the current working set from applicable Skill entry points and action-relevant references, not all past procedures. "
  + "Metadata proves neither loading, memory nor authority.";
