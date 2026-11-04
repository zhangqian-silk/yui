import { checkSessionSkills, checkSessionSkillsAsync } from "./sessionBootstrapManifest.js";
import type { HostSessionLifecycleTransition } from "../runtime/hostSessionLifecycle.js";
import type { LifecycleCheck } from "../runtime/lifecycleChecks.js";

/** Early advisory checks do not commit notices or assert model memory. The
 * next input still validates its exact metadata and emits only its own delta.
 * Invalid metadata may reject that input, never a Session state transition. */
export function createSessionSkillLifecycleCheck(home: string,
  environment: () => Readonly<Record<string, string | undefined>>
): LifecycleCheck<HostSessionLifecycleTransition> {
  return {
    id: "session-skills",
    run: async (transition, signal) => {
      if (!["connected", "interactive-connected", "settled"].includes(transition.event.type)) return;
      const manifest = environment().YUI_SESSION_MANIFEST;
      if (!manifest || signal.aborted) return;
      try { await checkSessionSkillsAsync(home, manifest, signal); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  };
}

/** Per-input provenance, not a model memory/load receipt. A detached client
 * cannot inherit the Host check merely by reusing the same conversation. */
export const HOST_SKILL_CHECK_MARKER = "<!-- yui:skills-checked -->";

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
      options: { recovery?: boolean; contextEpoch?: number } = {}
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
      const key = JSON.stringify([sessionKey, manifest, current.roleProfileRef, options.contextEpoch]);
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
      const lines = [HOST_SKILL_CHECK_MARKER];
      if (cold || changed.length > 0 || removed) {
        lines.push(`Yui Session Manifest: ${manifest}`,
          "The yui:skills-checked transport marker means this input passed the Host's current Skill check; do not repeat or narrate that check. It is not proof of retained instructions. Inputs without this marker or an explicit Host check notice still require the Manifest check fallback.",
          cold
            ? `First input or recovered attachment: read the exact Role profile at ${current.roleProfileRef.path} and the full current listed Skill entry points. Follow references only for the action you are taking, not to restore every previously used procedure. A Task role-profile projection is not this profile.`
            : "Skill metadata changed: load affected entries and applicable references; retain other complete instructions.",
          `Current Skill pointers: [${(removed ? [...skills.values()] : changed).join(",")}]`,
          "Metadata is not a loading receipt. Read each required file through EOF; if output is truncated, finish the missing ranges. Recover missing instructions for the current task, not the whole manual. Keep routine role, Skill-version and empty-inbox checks internal; report only business progress or actionable failures.");
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
