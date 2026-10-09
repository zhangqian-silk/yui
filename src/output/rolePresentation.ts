import {
  activeRoleAgentSession,
  type RoleSessionSet
} from "../executor/agentExecutor.js";
import type { GlobalRole, Role, RoleAgentBinding } from "../role/role.js";
import { effectiveRoleForLaunch, type EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import { defaultTableWidth, renderTable } from "./table.js";

type PresentedRole = GlobalRole | Role;

/** Desired configuration and the fixed Session request are not Provider evidence. */
export function renderRoleLaunchComparison(
  role: PresentedRole,
  effective: EffectiveLaunchSnapshot
): string {
  const pinned = effectiveRoleForLaunch(role, effective);
  return renderTable(
    "Configuration intent (not observed Provider state)",
    [
      { header: "Source", minWidth: 14, maxWidth: 20 },
      { header: "Agent / component", minWidth: 18, maxWidth: 32 },
      { header: "Model", minWidth: 10, maxWidth: 20 },
      { header: "Effort", minWidth: 8, maxWidth: 14 },
      { header: "Permission", minWidth: 12, maxWidth: 34 },
      { header: "Profile intent", minWidth: 14, maxWidth: 14 }
    ],
    ([[`Role desired r${role.launchRevision}`, role],
      [`Session pinned r${effective.sourceDesiredRevision}`, pinned]] as const).map(([source, current]) => {
      const binding = current.agentBindings[current.activeAgentId]!;
      return [
        source,
        `${binding.agentId}/${binding.component}`,
        binding.config.model ?? "Agent default",
        binding.config.effort ?? "Agent default",
        permission(binding),
        current.defaultAccess
      ];
    }),
    defaultTableWidth()
  ) + "\n\nSkill package evidence:\n" + (effective.skillPackages === undefined
    ? "  Legacy / externally recorded: complete package versions were not recorded."
    : effective.skillPackages.map(skill =>
      `  ${skill.id} @ ${skill.digest}\n    ${skill.source.kind}: ${skill.source.path}\n`
      + `    ${skill.fileCount} files; ${skill.byteSize} bytes; inventory: ${skill.manifestPath}`
    ).join("\n"));
}

export function activeRoleSummary(role: PresentedRole): Readonly<{
  agent: string;
  model: string;
  effort: string;
}> {
  const binding = role.agentBindings[role.activeAgentId];
  return {
    agent: role.activeAgentId,
    model: binding?.config.model ?? "CLI default",
    effort: binding?.config.effort ?? "CLI default"
  };
}

export function renderRoleDetails(
  title: string,
  role: PresentedRole,
  input: Readonly<{ kind: "system" | "global" | "task"; sessions?: RoleSessionSet | null }>
): string {
  const bindings = Object.values(role.agentBindings)
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  const effective = activeRoleAgentSession(input.sessions ?? null)?.effective;
  const profile = [
    `  Description      ${present(role.description)}`,
    `  Responsibilities ${presentList(role.responsibilities)}`,
    `  Constraints      ${presentList(role.constraints)}`,
    `  Expected output  ${present(role.expectedOutput)}`,
    `  System prompt    ${present(role.systemPrompt)}`,
    `  Skills           ${presentList(role.skills)}`
  ];
  const overview = [
    `  Kind             ${input.kind}`,
    `  Active Agent     ${role.activeAgentId}`,
    `  Workspace        ${role.workspace}`,
    ...("taskId" in role ? [
      `  Desired environment ${role.executionEnvironment === undefined
        ? "managed workspace"
        : `${role.executionEnvironment.environmentRef}; ${role.executionEnvironment.directory.path}; ${role.executionEnvironment.access}`}`,
      `  Session environment ${effective === undefined ? "not started"
        : effective.executionEnvironment === undefined ? "managed workspace"
          : `${effective.executionEnvironment.environmentRef}; ${effective.executionEnvironment.directory.path}; ${effective.executionEnvironment.access}`}`
    ] : []),
    `  Desired launch   r${role.launchRevision}; Profile intent=${role.defaultAccess}`,
    // The component is what the Session is pinned to; its plan follows from it.
    // Naming the plan alone would show two different ACP products identically.
    `  Effective launch ${effective === undefined
      ? "not started"
      : `${effective.agentId}/${effective.component}; r${effective.sourceDesiredRevision}; Profile intent=${effective.profileAccess}; permission=${effective.permission.strategy}`}`,
    `  Desired drift    ${effective === undefined
      ? "-"
      : effective.sourceDesiredRevision === role.launchRevision
        ? "none"
        : "pending next launch"}`
  ];
  return [
    title,
    "",
    "Role settings",
    ...overview,
    "",
    "Profile",
    ...profile,
    "",
    renderTable(
      "Agent settings",
      [
        { header: "Agent", minWidth: 5, maxWidth: 20 },
        { header: "Active", minWidth: 6, maxWidth: 6 },
        // Wide enough to hold the longest component id whole: it is an
        // identifier, so splitting it mid-token reads worse than letting the
        // prose in Permission wrap, which it does naturally.
        { header: "Component", minWidth: 17, maxWidth: 18 },
        { header: "Model", minWidth: 8, maxWidth: 24 },
        { header: "Effort", minWidth: 8, maxWidth: 16 },
        { header: "Permission", minWidth: 10, maxWidth: 34 },
        { header: "Search", minWidth: 6, maxWidth: 11 },
        { header: "Session", minWidth: 7, maxWidth: 12 }
      ],
      bindings.map((binding) => bindingRow(binding, role, input.sessions)),
      defaultTableWidth()
    )
  ].join("\n").concat("\n");
}

function bindingRow(
  binding: RoleAgentBinding,
  role: PresentedRole,
  sessions: RoleSessionSet | null | undefined
): string[] {
  return [
    binding.agentId,
    binding.agentId === role.activeAgentId ? "yes" : "",
    binding.component,
    binding.config.model ?? "CLI default",
    binding.config.effort ?? "CLI default",
    permission(binding),
    binding.config.adapterId === "codex"
      ? binding.config.search === true ? "enabled" : "CLI default"
      : "-",
    sessions?.sessions[binding.agentId]?.status ?? "not started"
  ];
}

function permission(binding: RoleAgentBinding): string {
  if (binding.config.adapterId === "codex") {
    const permission = binding.config.permission;
    if (permission.strategy === "default") return "CLI default";
    if (permission.strategy === "bypass") return "bypass";
    return [
      permission.sandbox === undefined ? undefined : `sandbox=${permission.sandbox}`,
      permission.approval === undefined ? undefined : `approval=${permission.approval}`
    ].filter((value): value is string => value !== undefined).join("; ");
  }
  // ACP's strategy decides the Session mode Yui requests over the protocol. It
  // is stated separately from how Yui answers `session/request_permission`,
  // which is always a decline on this transport: those are two different
  // questions, and collapsing them would make a configured Session mode read as
  // interactive consent Yui does not hold.
  if (binding.config.adapterId === "acp") {
    const permission = binding.config.permission;
    const requests = "requests declined";
    if (permission.strategy === "default") return `Agent default; ${requests}`;
    if (permission.strategy === "bypass") return `bypass; ${requests}`;
    return `mode=${permission.mode}; ${requests}`;
  }
  const permission = binding.config.permission;
  if (permission.strategy === "default") return "CLI default";
  if (permission.strategy === "bypass") return "bypass";
  const rules = [
    permission.mode === undefined ? undefined : `mode=${permission.mode}`,
    permission.allowedTools === undefined
      ? undefined
      : `allow=${permission.allowedTools.join(", ")}`,
    permission.disallowedTools === undefined
      ? undefined
      : `deny=${permission.disallowedTools.join(", ")}`
  ].filter((value): value is string => value !== undefined);
  return rules.join("; ");
}

function present(value: string | undefined): string {
  return value === undefined || value.length === 0 ? "-" : value;
}

function presentList(values: readonly string[] | undefined): string {
  return values === undefined || values.length === 0 ? "-" : values.join("; ");
}
