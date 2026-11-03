import { checkSessionSkills } from "./sessionBootstrapManifest.js";

/** Host-local last accepted metadata, never a model loading/memory receipt.
 * A new Host/attachment starts cold. No durable schema or input replay is added. */
export function createSessionSkillNotice(home: string) {
  let previous: { key: string; skills: Map<string, string> } | undefined;
  let generation = 0;
  const invalidate = (): void => { previous = undefined; generation += 1; };
  return {
    invalidate,
    prepare(
      text: string,
      environment: Readonly<Record<string, string | undefined>>,
      sessionKey: string,
      options: { recovery?: boolean } = {}
    ): { text: string; commit(): void } {
      const manifest = environment.YUI_SESSION_MANIFEST;
      if (manifest === undefined) return { text, commit() {} };
      if (options.recovery) invalidate();
      let current: ReturnType<typeof checkSessionSkills>;
      try {
        current = checkSessionSkills(home, manifest);
      } catch (error) {
        invalidate();
        throw error; // Do not submit business input with an invalid current installation.
      }
      const key = JSON.stringify([sessionKey, manifest, current.roleProfileRef]);
      const skills = new Map(current.skills.map(skill => [skill.id, JSON.stringify({
        id: skill.id, path: skill.path, version: skill.version
      })]));
      const cold = previous?.key !== key;
      const changed = [...skills].filter(([id, value]) => cold || previous!.skills.get(id) !== value)
        .map(([, value]) => value);
      const removed = !cold && [...previous!.skills.keys()].some(id => !skills.has(id));
      // Every input is checked, but only a lifecycle/metadata event needs an
      // instruction-loading notice. This marker distinguishes Host-mediated
      // input from an unmediated client without restating the operating manual.
      const lines = ["Yui Host checked current Skills; no Agent check needed."];
      if (cold || changed.length > 0 || removed) {
        lines.push(`Yui Session Manifest: ${manifest}`,
          cold
            ? `First input or recovered attachment: read the exact Role profile at ${current.roleProfileRef.path} and the full current listed Skill entry points. Follow references only for the action you are taking, not to restore every previously used procedure. A Task role-profile projection is not this profile.`
            : "Skill metadata changed: load affected entries and applicable references; retain other complete instructions.",
          `Current Skill pointers: [${(removed ? [...skills.values()] : changed).join(",")}]`,
          "Metadata is not a loading receipt. Read each required file through EOF; if output is truncated, finish the missing ranges. Recover missing instructions for the current task, not the whole manual.");
      }
      const preparedGeneration = generation;
      return {
        text: `${lines.join("\n")}\n\n${text}`,
        commit() {
          if (generation !== preparedGeneration) return;
          previous = { key, skills };
          generation += 1;
        }
      };
    }
  };
}
