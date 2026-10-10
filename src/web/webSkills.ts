import { createHash } from "node:crypto";
import { listSkillSources, readFrozenSkill, readSkillSource } from "../context/skillCatalog.js";
import { runGlobalRoleCommand } from "../commands/globalRoleCommands.js";
import { runTaskCommand } from "../commands/taskCommands.js";
import type { TaskStore } from "../storage/taskStore.js";
import { webLocalMutation, WebRequestRejected } from "./webMutation.js";

type Target = { scope: "global" | "task"; role: string; task?: string };
function target(input: unknown): Target {
  if (!input || typeof input !== "object") throw new WebRequestRejected("Choose an explicit Role scope.");
  const v = input as Record<string, unknown>;
  if (!["global", "task"].includes(String(v.scope)) || typeof v.role !== "string" || !v.role
    || (v.scope === "task" ? typeof v.task !== "string" || !v.task : v.task !== undefined && v.task !== "")) {
    throw new WebRequestRejected("Choose an explicit global or Task Role.");
  }
  return { scope: v.scope as Target["scope"], role: v.role, ...(v.scope === "task" ? { task: v.task as string } : {}) };
}
const revision = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Local-human adapter; all writes retain CLI Role guards, validation and revision semantics. */
export function createWebSkills(store: TaskStore) {
  const home = store.rootDirectory();
  function roleState(input: unknown) {
    const selected = target(input);
    const role = selected.scope === "global" ? store.getGlobalRole(selected.role) : store.getRole(selected.task!, selected.role);
    if (!role) throw new WebRequestRejected("Role not found in the selected scope.");
    const sessions = selected.scope === "global" ? store.getGlobalRoleSessionSet(selected.role)
      : store.getRoleSessionSet(selected.task!, selected.role);
    const session = sessions?.sessions[role.activeAgentId];
    return { target: selected, revision: revision(role), skills: role.skills ?? [], launchRevision: role.launchRevision,
      session: session ? { nativeSessionId: session.nativeSessionId, status: session.status,
        sourceDesiredRevision: session.effective.sourceDesiredRevision, packages: session.effective.skillPackages ?? null } : null,
      notice: "Configured bindings apply on a subsequent launch. Saving does not load a Skill, restart a Session, rewrite a frozen Run, or delete a package." };
  }
  return {
    catalog: listSkillSources.bind(null, home),
    roles(scope: string, task?: string) {
      if (scope !== "global" && scope !== "task") throw new WebRequestRejected("Choose global or Task scope.");
      if (scope === "task" && (!task || !store.getTask(task))) throw new WebRequestRejected("Task not found.");
      return (scope === "global" ? store.listGlobalRoles() : store.listRoles(task!)).map(role => ({ name: role.name }));
    },
    role: roleState,
    file(input: { id: string; resource?: string; frozen?: boolean; digest?: string; run?: string; target?: unknown }) {
      if (!input.frozen) return readSkillSource(home, input.id, input.resource);
      const state = roleState(input.target);
      let packages = state.session?.packages;
      if (input.run) {
        if (state.target.scope !== "task") throw new WebRequestRejected("A frozen Run requires Task scope.");
        const run = store.getRun(state.target.task!, input.run);
        if (!run || run.roleName !== state.target.role) throw new WebRequestRejected("Run not found for this Task Role.");
        packages = run.effective.skillPackages;
      }
      const ref = packages?.find(p => p.id === input.id);
      if (!ref) throw new WebRequestRejected("No frozen package evidence for this Skill. Current source is not a substitute.");
      if (ref.digest !== input.digest) throw new WebRequestRejected("Frozen package version changed or was not specified. Reload its evidence.");
      return readFrozenSkill(ref, input.resource);
    },
    save(input: unknown) {
      if (!input || typeof input !== "object") throw new WebRequestRejected("Invalid Skill binding request.");
      const body = input as Record<string, unknown>;
      if (Object.keys(body).some(k => !["target", "revision", "skills", "acknowledgeLive"].includes(k))
        || typeof body.revision !== "string" || !Array.isArray(body.skills) || body.skills.length > 128
        || body.skills.some(s => typeof s !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(s))
        || (body.acknowledgeLive !== undefined && typeof body.acknowledgeLive !== "boolean")) {
        throw new WebRequestRejected("Expected a Role read revision and Skill IDs.");
      }
      const selected = target(body.target);
      const skills = [...new Set(body.skills as string[])];
      const args = skills.length ? skills.flatMap(id => ["--skill", id]) : ["--clear-skills"];
      const output = webLocalMutation(store, tx => {
        if (roleState(selected).revision !== body.revision) throw new Error("Role changed since it was read. Reload before saving.");
        if (selected.scope === "global") return runGlobalRoleCommand(
          ["update", selected.role, ...args, ...(body.acknowledgeLive ? ["--yes"] : [])],
          tx as unknown as Parameters<typeof runGlobalRoleCommand>[1], { yuiHome: home, env: {} });
        return runTaskCommand(["role", "update", selected.task!, selected.role, ...args],
          tx, { yuiHome: home, environment: {} }).output;
      });
      return { status: "saved", output, role: roleState(selected) };
    }
  };
}
export type WebSkills = ReturnType<typeof createWebSkills>;
