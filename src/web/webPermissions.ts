import { ROOT_COMMAND, type CommandNode, type DiscoveryAudience } from "../cli/commandCatalog.js";
import { discoveryCommandTree } from "../cli/commandDiscovery.js";
import { BUILTIN_CAPABILITIES } from "../kernel/builtinCapabilities.js";
import type { TaskStore } from "../storage/taskStore.js";

type RoleTemplate = Readonly<{ id: string; audience: DiscoveryAudience; name?: string }>;
const templates: readonly RoleTemplate[] = [
  { id: "public", audience: "public" },
  { id: "operator", audience: "operator" },
  { id: "global", audience: "global" },
  { id: "leader", audience: "leader" },
  { id: "worker", audience: "assignment" },
  { id: "reviewer", audience: "assignment" },
  { id: "unbound", audience: "unbound" }
];
function executableNodes(node: CommandNode): CommandNode[] {
  return [...(node.kind !== "group" && node.discovery?.surface !== "runtime" ? [node] : []),
    ...node.children.flatMap(executableNodes)];
}
const commands = executableNodes(ROOT_COMMAND);
// The same pure projection as CLI help/completion. No fake Session, caller
// environment, authority issuance, registry invocation or domain assessment.
const projections = new Map(templates.map(role => [role.audience,
  new Map(executableNodes(discoveryCommandTree({}, role.audience)).map(node => [node.path.join(" "), node]))]));
const pageSize = 30;

function searchText(value = ""): string {
  if (value.length > 200) throw new Error("Search is limited to 200 characters.");
  return value.trim().toLowerCase();
}
function page<T>(items: T[], cursor = "0") {
  if (!/^(0|[1-9]\d*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new Error("Invalid cursor.");
  const start = Number(cursor);
  return { items: items.slice(start, start + pageSize), total: items.length,
    nextCursor: start + pageSize < items.length ? String(start + pageSize) : null };
}

/** Read-only metadata projection for the authenticated local Web user.
 * Only configured GlobalRole names cross the Store boundary. Task contents,
 * bindings, profiles, Sessions, Grants and plugin descriptors are not read.
 * These templates deliberately have no AccessAssessment field. */
export function createWebPermissions(store: Pick<TaskStore, "listGlobalRoles">) {
  const roles = (): RoleTemplate[] => [...templates, ...store.listGlobalRoles()
    .filter(role => role.name !== "operator").map(role => ({
      id: `global:${role.name}`, name: role.name, audience: "global" as const
    }))];
  const selected = (id?: string): readonly RoleTemplate[] => {
    if (!id) return templates;
    const role = roles().find(role => role.id === id);
    if (!role) throw new Error("Unknown role template.");
    return [role];
  };
  const cells = (id: string, selectedRoles: readonly RoleTemplate[]) => selectedRoles.map(role => {
    const projected = projections.get(role.audience)!.get(id);
    return { role: role.id, visible: !!projected };
  });
  return {
    index() {
      return { roles: roles(), categories: [...new Set(commands.map(node => node.path[1]!))].sort(),
        sources: ["cli/commandCatalog.ts", "cli/commandDiscovery.ts", "kernel/builtinCapabilities.ts", "docs/authorization.md"],
        evaluation: "not-performed" as const };
    },
    commands(query: { q?: string; role?: string; category?: string; cursor?: string } = {}) {
      const q = searchText(query.q);
      const selectedRoles = selected(query.role);
      return { ...page(commands.filter(node => (!query.category || node.path[1] === query.category)
        && `${node.path.join(" ")} ${node.summary}`.toLowerCase().includes(q))
        .map(node => ({ id: node.path.join(" "), summary: node.summary, category: node.path[1],
          roles: cells(node.path.join(" "), selectedRoles) })), query.cursor),
        evaluation: "not-performed" as const };
    },
    command(id: string, role?: string) {
      const node = commands.find(node => node.path.join(" ") === id);
      if (!node) throw new Error("Unknown command template.");
      return { id, summary: node.summary, evaluation: "not-performed" as const,
        source: "cli/commandCatalog.ts → cli/commandDiscovery.ts",
        roles: selected(role).map(role => {
          const projected = projections.get(role.audience)!.get(id);
          return { role: role.id, audience: role.audience, visible: !!projected,
            // Use the projected usage/options, including option audience gates.
            usage: projected?.usage ?? [], options: projected?.options ?? [] };
        }) };
    },
    capabilities(query: { q?: string; cursor?: string } = {}) {
      const q = searchText(query.q);
      return { ...page(BUILTIN_CAPABILITIES
        .filter(entry => `${entry.name} ${entry.summary} ${entry.requiredPermissions.join(" ")}`.toLowerCase().includes(q))
        .map(entry => ({
          name: entry.name, summary: entry.summary, effect: entry.effect, source: entry.source,
          requiredPermissions: entry.requiredPermissions,
          requiredInputs: entry.inputSchema.required ?? [],
          inputs: Object.keys(entry.inputSchema.properties ?? {})
        })), query.cursor), evaluation: "not-performed" as const,
        source: "kernel/builtinCapabilities.ts (registry built-in descriptors)" };
    }
  };
}
export type WebPermissions = ReturnType<typeof createWebPermissions>;
