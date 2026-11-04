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
      options: { contextEpoch?: number } = {}
    ): { text: string; inputText: string; context?: string; commit(): void } {
      const manifest = environment.YUI_SESSION_MANIFEST;
      if (manifest === undefined) return { text, inputText: text, commit() {} };
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
      // instruction-loading notice. Unchanged input is passed through exactly.
      const lines: string[] = [];
      if (cold || changed.length > 0 || removed) {
        lines.push(`Yui Session Manifest: ${manifest}`,
          "Host-managed Skill checks are active; unchanged input has no notice. Detached/unmediated clients must use the Manifest check fallback.",
          cold
            ? `Read the exact Role profile at ${current.roleProfileRef.path} (not a Task projection) and all current Skill entry points below. Follow references only for the current action.`
            : "Skill metadata changed: load affected entries and applicable references; retain other complete instructions.",
          `Current Skill pointers: [${(removed ? [...skills.values()] : changed).join(",")}]`,
          "Read required files through EOF. Metadata is not loaded instructions. Keep routine checks internal.");
      }
      const preparedGeneration = generation;
      return {
        text: lines.length === 0 ? text : `${lines.join("\n")}\n\n${text}`,
        inputText: text,
        ...(lines.length === 0 ? {} : { context: lines.join("\n") }),
        commit() {
          if (generation !== preparedGeneration) return;
          previous = { key, skills };
          generation += 1;
        }
      };
    }
  };
}
