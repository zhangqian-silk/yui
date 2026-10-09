import { createHash } from "node:crypto";
import { CONFIG_DOMAINS, configDefinitionsForDomain, type ConfigDomain } from "../config/configCatalog.js";
import { effectiveConfigData, runConfigCommand } from "../commands/configCommands.js";
import { runAgentCommand, type AgentCommandStore } from "../commands/agentCommands.js";
import { runGlobalRoleCommand } from "../commands/globalRoleCommands.js";
import { runProfileCommand, previewProfileAgentConfigurationMutation } from "../commands/profileCommands.js";
import { roleOptionSpecs } from "../commands/roleConfiguration.js";
import { staticAgentConfigurationFields } from "../executor/agentConfigurationFields.js";
import { validateAgentLaunchConfiguration, type AgentConfigurationCatalogService } from "../executor/agentConfigurationCatalog.js";
import { resolveAgentProfileView } from "../profile/agentProfileRuntime.js";
import type { TaskStore } from "../storage/taskStore.js";
import { webLocalMutation, WebRequestRejected } from "./webMutation.js";

type Field = {
  key: string; label: string; value: unknown; kind: "text" | "number" | "boolean" | "json" | "multiline";
  summary?: string; takesEffect?: string; source?: string; defaultValue?: unknown;
  choices?: readonly string[]; reset?: boolean;
};
type Group = {
  id: string; title: string; section: string; advanced: boolean; revision: string;
  fields: Field[]; notice: string; agentId?: string; observation?: unknown;
};
const ROLE_NOTICE = "Saved desired configuration applies to a subsequent Role launch, not the current Session. Existing Task bindings are unchanged. No Session is restarted here.";
const PROFILE_NOTICE = "Profile behavior is copied into newly created Task Roles. Inherited runtime resolves from the global Worker when applied. Existing Task Roles are not rebound.";
const AGENT_NOTICE = "Command, arguments and environment references apply to subsequent Host processes. Authentication remains with the native Agent. Only reference names and presence in the Controller environment are shown; no environment values are returned.";

/** A view adapter over existing commands, not another writable configuration store. */
export function createWebSettings(store: TaskStore, options: {
  environment: NodeJS.ProcessEnv; catalogs: Pick<AgentConfigurationCatalogService, "resolve">;
  refreshConfiguration?: () => void;
}) {
  function groups() {
    return [
      ...CONFIG_DOMAINS.map(id => ({ id, title: id, section: id === "system" ? "general" : "advanced", advanced: id !== "system",
        searchText: configDefinitionsForDomain(id).map(d => `${d.key} ${d.label} ${d.summary}`).join(" ") })),
      ...store.listConfiguredAgents().map(a => ({ id: `agent/${a.id}`, title: a.id, section: "agents", advanced: true, searchText: "command arguments environment 命令 参数 环境引用" })),
      ...store.listGlobalRoles().map(r => ({ id: `role/${r.name}`, title: r.name, section: "roles", advanced: true, searchText: "model effort permission prompt skills workspace 模型 权限 指令" })),
      ...store.listAgentProfiles().map(p => ({ id: `profile/${p.id}`, title: p.id, section: "profiles", advanced: true, searchText: "model effort access instructions skills inherit 模型 继承" }))
    ];
  }
  function index(query = "", cursor = "0") {
    if (query.length > 256 || !/^\d{1,8}$/.test(cursor)) throw new WebRequestRejected("Invalid settings search or cursor.");
    const needle = query.trim().toLowerCase();
    const all = groups().filter(g => `${g.id} ${g.section} ${g.searchText}`.toLowerCase().includes(needle));
    const offset = Number(cursor);
    return { groups: all.slice(offset, offset + 50), total: all.length,
      nextCursor: offset + 50 < all.length ? String(offset + 50) : null };
  }
  function read(id: string): Group {
    const meta = groups().find(group => group.id === id);
    if (!meta) throw new WebRequestRejected("Configuration group not found.");
    let fields: Field[];
    let notice = "Saved values and effective defaults share the CLI configuration source. Reset removes the stored override; it does not restart services.";
    let observation: unknown;
    let agentId: string | undefined;
    let version: unknown;
    if ((CONFIG_DOMAINS as readonly string[]).includes(id)) {
      const domain = id as ConfigDomain;
      const config = store.getConfig();
      const effective = effectiveConfigData(config, domain);
      const defaults = effectiveConfigData({ schemaVersion: 1 }, domain);
      fields = configDefinitionsForDomain(domain).map(def => ({
        key: def.key, label: def.label, value: effective[def.property],
        kind: def.key === "review" ? "json" : kind(effective[def.property]), summary: def.summary, takesEffect: def.takesEffect,
        source: config[def.property] === undefined ? "default" : "stored",
        defaultValue: defaults[def.property], reset: true,
        ...(def.key === "default-agent" ? { choices: store.listConfiguredAgents().map(a => a.id) } : {}),
        ...(def.key === "resources-gc-mode" ? { choices: ["report", "quarantine"] } : {})
      }));
      version = fields;
    } else if (id.startsWith("agent/")) {
      const agent = store.getConfiguredAgent(id.slice(6))!;
      agentId = agent.id; version = agent; notice = AGENT_NOTICE;
      fields = [
        field("command", agent.command),
        field("baseArgs", agent.baseArgs, "json"),
        { ...field("environment", agent.environment, "json"), summary: "Array of {target, source: \"process\", sourceName, required: true}. Only process-variable references are accepted." }
      ];
      observation = { component: agent.component, adapterId: agent.adapterId,
        environment: agent.environment.map(b => ({ ...b, present: !!options.environment[b.sourceName] })) };
    } else if (id.startsWith("role/")) {
      const role = store.getGlobalRole(id.slice(5))!;
      const binding = role.agentBindings[role.activeAgentId]!;
      agentId = role.activeAgentId; version = role; notice = ROLE_NOTICE;
      const specs = roleOptionSpecs({ update: true, includeWorkspace: true });
      fields = [
        { ...field("activeAgentId", role.activeAgentId), choices: store.listConfiguredAgents().map(a => a.id),
          summary: "Explicit global Role Agent selection. Save this field alone, then edit the selected Agent's settings. Existing live-session and lifecycle guards apply; no Task is rebound." },
        field("workspace", role.workspace),
        ...(["description", "systemPrompt", "expectedOutput", "responsibilities", "constraints", "skills"] as const)
          .map(key => ({ ...field(key, role[key] ?? (["responsibilities", "constraints", "skills"].includes(key) ? [] : ""), ["responsibilities", "constraints", "skills"].includes(key) ? "json" : "multiline"), reset: true })),
        ...staticAgentConfigurationFields(binding.adapterId)
          .filter(f => ROLE_FIELDS[f.key] && specs.has(ROLE_FIELDS[f.key].set))
          .map(f => ({
            ...field(f.key, getPath(binding.config, f.key) ?? "", f.key.endsWith("Tools") ? "json" : "text"),
            summary: f.reason, choices: f.allowCustom ? undefined : f.choices.map(c => c.value),
            reset: !!ROLE_FIELDS[f.key].clear,
            source: getPath(binding.config, f.key) === undefined ? "native/default" : "stored"
          }))
      ];
      observation = { activeAgentId: agentId, launchRevision: role.launchRevision,
        defaultAccess: role.defaultAccess, agentBindings: Object.keys(role.agentBindings),
        session: store.getGlobalRoleSessionSet(role.name)?.sessions[role.activeAgentId]?.status ?? "absent" };
    } else {
      const profile = store.getAgentProfile(id.slice(8))!;
      const view = resolveAgentProfileView(profile, store);
      version = profile; notice = PROFILE_NOTICE;
      agentId = view.runtime.status === "resolved" ? view.runtime.binding.agentId : undefined;
      fields = [
        { ...field("access", profile.defaultAccess), choices: ["read", "write"] },
        { ...field("description", profile.description ?? "", "multiline"), reset: true },
        { ...field("instructions", profile.instructions ?? "", "multiline"), reset: true },
        { ...field("skills", profile.skills ?? [], "json"), reset: true },
        { ...field("agent", profile.runtime.source === "explicit" ? profile.runtime.agentId : ""), choices: ["", ...store.listConfiguredAgents().map(a => a.id)], summary: "Empty = inherit global Worker; an explicit Agent enables model/effort overrides." },
        { ...field("model", profile.runtime.source === "explicit" ? profile.runtime.model ?? "" : ""), reset: true },
        { ...field("effort", profile.runtime.source === "explicit" ? profile.runtime.effort ?? "" : ""), reset: true }
      ];
      observation = view.runtime;
    }
    return { ...meta, fields, notice, agentId, observation,
      revision: createHash("sha256").update(JSON.stringify(version)).digest("hex") };
  }
  async function capabilities(id: string, refresh: boolean) {
    const group = read(id);
    if (!group.agentId) throw new WebRequestRejected("This group has no resolved Agent.");
    const agent = store.getConfiguredAgent(group.agentId);
    if (!agent) throw new WebRequestRejected("Configured Agent not found.");
    const role = id.startsWith("role/") ? store.getGlobalRole(id.slice(5)) : null;
    return options.catalogs.resolve({ agent, refresh,
      cwd: role?.workspace ?? store.getConfig().defaultWorkspace ?? process.cwd(),
      ...(role ? { config: role.agentBindings[role.activeAgentId]!.config } : {}) });
  }
  async function save(input: unknown) {
    let mutationEntered = false;
    try {
    const body = record(input);
    if (Object.keys(body).some(k => !["id", "revision", "changes", "acknowledgeLive"].includes(k))
      || typeof body.id !== "string" || typeof body.revision !== "string"
      || !Array.isArray(body.changes) || !body.changes.length || body.changes.length > 64
      || (body.acknowledgeLive !== undefined && typeof body.acknowledgeLive !== "boolean")) {
      throw new WebRequestRejected("Expected a group, its read revision, and changed fields.");
    }
    const id = body.id;
    const current = read(id);
    if (current.revision !== body.revision) throw new WebRequestRejected("Configuration changed since it was read. Compare current values before saving again.");
    const seen = new Set<string>();
    const changes = body.changes.map(value => {
      const change = record(value);
      const def = current.fields.find(f => f.key === change.key);
      if (!def || seen.has(def.key) || Object.keys(change).some(k => !["key", "value", "reset"].includes(k))
        || (change.reset !== undefined && change.reset !== true) || (change.reset === true && !def.reset)
        || (change.reset === true ? Object.hasOwn(change, "value") : !Object.hasOwn(change, "value"))) {
        throw new WebRequestRejected("Invalid or duplicate configuration field.");
      }
      seen.add(def.key);
      return { key: def.key, value: change.value, reset: change.reset === true };
    });
    const args = objectArguments(id, changes);
    // Explicit Profile runtime uses the same native catalog validator as CLI.
    const profileMutation = id.startsWith("profile/")
      ? previewProfileAgentConfigurationMutation(["update", id.slice(8), ...args], store) : undefined;
    let validated: Awaited<ReturnType<typeof options.catalogs.resolve>> | undefined;
    if (profileMutation) {
      const agent = store.getConfiguredAgent(profileMutation.agentId);
      if (!agent) throw new WebRequestRejected("Configured Agent not found.");
      validated = await options.catalogs.resolve({ agent, cwd: profileMutation.cwd, config: profileMutation.config });
      validateAgentLaunchConfiguration(validated.catalog, profileMutation.config);
    }
    mutationEntered = true;
    const output = webLocalMutation(store, tx => {
      if (read(id).revision !== body.revision) throw new Error("Configuration changed since it was read. Compare current values before saving again.");
      if ((CONFIG_DOMAINS as readonly string[]).includes(id)) {
        return changes.map(change => runConfigCommand(id as ConfigDomain,
          change.reset ? ["clear", change.key] : ["set", change.key, ...configArguments(change.key, change.value)], tx).output).join("");
      }
      const ack = body.acknowledgeLive === true ? ["--yes"] : [];
      if (id.startsWith("agent/")) return runAgentCommand(["update", id.slice(6), ...args, ...ack], tx as unknown as AgentCommandStore);
      if (id.startsWith("role/")) {
        const binding = changes.find(c => c.key === "activeAgentId");
        if (binding && changes.length !== 1) throw new Error("Save the Agent selection alone, then read its supported settings.");
        return runGlobalRoleCommand(binding
          ? ["bind", id.slice(5), text(binding.value)]
          : ["update", id.slice(5), ...args, ...ack],
        tx as unknown as Parameters<typeof runGlobalRoleCommand>[1], { yuiHome: store.rootDirectory(), env: options.environment });
      }
      return runProfileCommand(["update", id.slice(8), ...args], tx, () => new Date(), {
        validateAgentConfiguration: candidate => {
          if (!profileMutation || JSON.stringify(candidate) !== JSON.stringify(profileMutation) || !validated) {
            throw new Error("Profile runtime changed after capability validation. Read it again.");
          }
          validateAgentLaunchConfiguration(validated.catalog, candidate.config);
        }
      }).output;
    });
    let refresh = "not-required";
    if (changes.some(c => c.key === "reconciliation-interval-seconds")) {
      try { options.refreshConfiguration?.(); refresh = options.refreshConfiguration ? "applied" : "restart-required"; }
      catch { refresh = "saved-refresh-failed"; }
    }
    return { status: "saved", output, group: read(id), adoption: "No existing Session or Task was rebound.", refresh };
    } catch (error) {
      if (!mutationEntered) throw new WebRequestRejected(error instanceof Error ? error.message : "Invalid settings request.");
      throw error;
    }
  }
  return { index, read, save, capabilities };
}
export type WebSettings = ReturnType<typeof createWebSettings>;

function kind(value: unknown): Field["kind"] {
  return typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number"
    : value !== null && typeof value === "object" ? "json" : "text";
}
function field(key: string, value: unknown, type: Field["kind"] = "text"): Field {
  return { key, label: key, value, kind: type };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebRequestRejected("Expected an object.");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) throw new WebRequestRejected("Expected text.");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new WebRequestRejected("Expected a JSON array of strings.");
  return value.map(text);
}
function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined, value);
}
function configArguments(key: string, value: unknown): string[] {
  if (key === "runtime-health") {
    const v = record(value);
    if (Object.keys(v).some(k => !["quietAfterSeconds", "diagnosticAfterSeconds", "stallAfterSeconds"].includes(k))) throw new WebRequestRejected("Unknown health field.");
    return ["--quiet-after-seconds", String(v.quietAfterSeconds), "--diagnostic-after-seconds", String(v.diagnosticAfterSeconds), "--stall-after-seconds", String(v.stallAfterSeconds)];
  }
  if (key === "review") {
    const v = record(value);
    if (Object.keys(v).some(k => !["roleName", "trigger"].includes(k))) throw new WebRequestRejected("Unknown review field.");
    return ["--role", text(v.roleName), "--trigger", text(v.trigger)];
  }
  if (!["string", "number", "boolean"].includes(typeof value)) throw new WebRequestRejected("Expected a scalar setting.");
  return [String(value)];
}
const ROLE_FIELDS: Record<string, { set: string; clear?: string; many?: boolean }> = {
  model: { set: "--model", clear: "--clear-model" }, effort: { set: "--effort", clear: "--clear-effort" },
  "permission.strategy": { set: "--permission-strategy" }, "permission.sandbox": { set: "--sandbox" },
  "permission.approval": { set: "--approval" }, "permission.mode": { set: "--permission-mode" },
  "permission.allowedTools": { set: "--allowed-tool", clear: "--clear-allowed-tools", many: true },
  "permission.disallowedTools": { set: "--disallowed-tool", clear: "--clear-disallowed-tools", many: true },
  search: { set: "--search", clear: "--clear-search" },
  workspace: { set: "--workspace" }, description: { set: "--description", clear: "--clear-description" },
  systemPrompt: { set: "--system-prompt", clear: "--clear-system-prompt" },
  expectedOutput: { set: "--expected-output", clear: "--clear-expected-output" },
  responsibilities: { set: "--responsibility", clear: "--clear-responsibilities", many: true },
  constraints: { set: "--constraint", clear: "--clear-constraints", many: true },
  skills: { set: "--skill", clear: "--clear-skills", many: true }
};
function objectArguments(id: string, changes: { key: string; value: unknown; reset: boolean }[]): string[] {
  if ((CONFIG_DOMAINS as readonly string[]).includes(id)) return [];
  return changes.flatMap(c => {
    if (id.startsWith("role/") && c.key === "activeAgentId") return [];
    if (id.startsWith("agent/")) {
      if (c.key === "command") return ["--command", text(c.value)];
      if (c.key === "baseArgs") {
        const values = strings(c.value);
        return values.length ? values.flatMap(v => ["--arg", v]) : ["--clear-args"];
      }
      if (!Array.isArray(c.value)) throw new WebRequestRejected("Expected an environment reference array.");
      return c.value.length ? c.value.flatMap(value => {
        const b = record(value);
        if (Object.keys(b).some(k => !["target", "source", "sourceName", "required"].includes(k))
          || b.source !== "process" || b.required !== true) throw new WebRequestRejected("Only required process-variable references are supported by the Agent command.");
        return ["--env", `${text(b.target)}=${text(b.sourceName)}`];
      }) : ["--clear-env"];
    }
    if (id.startsWith("profile/")) {
      if (c.key === "agent") return c.value === "" ? ["--inherit-worker"] : ["--agent", text(c.value)];
      if (c.reset) return [`--clear-${c.key}`];
      if (c.key === "skills") {
        const values = strings(c.value);
        return values.length ? values.flatMap(v => ["--skill", v]) : ["--clear-skills"];
      }
      return [`--${c.key}`, text(c.value)];
    }
    const spec = ROLE_FIELDS[c.key];
    if (!spec) throw new WebRequestRejected("Unsupported Role field.");
    if (c.reset) return [spec.clear!];
    if (spec.many) {
      const values = strings(c.value);
      return values.length ? values.flatMap(v => [spec.set, v]) : [spec.clear!];
    }
    return [spec.set, typeof c.value === "boolean" ? String(c.value) : text(c.value)];
  });
}
