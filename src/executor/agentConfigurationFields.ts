import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import type { AgentConfigurationField } from "./agentConfigurationCatalog.js";

// These are Yui's accepted configuration values, not a native capability probe.
// Keep existing explicit configuration legal; current native choices come from
// help and requirements, and may be a smaller set.
export const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
export const CODEX_APPROVALS = ["untrusted", "on-request", "never"] as const;
export const STATIC_CONFIGURATION_NOTICE =
  "Static adapter configuration contracts are not native enumeration or proof of Provider acceptance; see field reasons.";

export function staticAgentConfigurationFields(id: AgentAdapterId): AgentConfigurationField[] {
  const fields = [
    staticField("model", [], true, "Model values require native metadata; custom IDs remain explicit input."),
    staticField("effort", [], true, "Effort values depend on the selected native model."),
    staticField("permission.strategy", ["default", "bypass", "configured"], false,
      "These are Yui strategies, not Provider modes.")
  ];
  if (id === "codex") return [
    ...fields,
    staticField("permission.sandbox", CODEX_SANDBOXES, false),
    staticField("permission.approval", CODEX_APPROVALS, false,
      "Native versions may retire values accepted by the adapter."),
    staticField("search", ["true"], false),
    staticField("profile", [], true),
    staticField("additionalDirectories", [], true)
  ];
  if (id === "acp") return [
    ...fields,
    staticField("permission.mode", [], true, "Mode IDs are enumerated per Session and checked at launch."),
    staticField("additionalDirectories", [], true,
      "Delivery requires the Agent's initialize capability; it is unverified offline.")
  ];
  return [
    ...fields,
    staticField("permission.mode", [], true, "No native modes were enumerated."),
    staticField("permission.allowedTools", [], true),
    staticField("permission.disallowedTools", [], true),
    staticField("settingsSources", ["user", "project", "local"], false),
    staticField("settingsFile", [], true),
    staticField("additionalDirectories", [], true)
  ];
}

function staticField(
  key: string, values: readonly string[], allowCustom: boolean, detail = ""
): AgentConfigurationField {
  return {
    key, choices: values.map(value => ({ value, label: value })), allowCustom,
    reason: `Static adapter configuration contract; native support is unverified.${detail ? ` ${detail}` : ""}`
  };
}

/** One help interpretation shared by installation inspection and live probes. */
export function configurationFieldsFromHelp(
  id: AgentAdapterId, help: string
): AgentConfigurationField[] {
  const fields = staticAgentConfigurationFields(id);
  if (id === "acp") return fields;
  const bypassFlag = id === "codex"
    ? "--dangerously-bypass-approvals-and-sandbox" : "--dangerously-skip-permissions";
  const replacements: AgentConfigurationField[] = [
    {
      ...staticField("permission.strategy", [
        "default", ...(configurationFlagAvailable(help, bypassFlag) ? ["bypass"] : []), "configured"
      ], false),
      reason: `Static Yui strategies; ${bypassFlag} ${
        configurationFlagAvailable(help, bypassFlag) ? "reported" : "not reported"
      } by native --help. This does not confirm account policy.`
    },
    ...(id === "codex"
      ? [
          helpChoiceField("permission.sandbox", help, "--sandbox", false, CODEX_SANDBOXES),
          helpChoiceField("permission.approval", help, "--ask-for-approval", false, CODEX_APPROVALS)
        ]
      : [
          helpChoiceField("permission.mode", help, "--permission-mode", true),
          helpChoiceField("effort", help, "--effort", true),
          // The CLI's description often names settings sources without an enum.
          // Retain the explicit static contract, never relabel it as discovery.
          ...(configurationHelpChoices(help, "--setting-sources").length === 0 ? []
            : [helpChoiceField("settingsSources", help, "--setting-sources", false)])
        ])
  ];
  const byKey = new Map(replacements.map(value => [value.key, value]));
  return fields.map(value => byKey.get(value.key) ?? value);
}

function helpChoiceField(
  key: string, help: string, flag: string, allowCustom: boolean, supported?: readonly string[]
): AgentConfigurationField {
  const reported = configurationHelpChoices(help, flag);
  const values = supported === undefined ? reported : reported.filter(value => supported.includes(value));
  return {
    key, choices: values.map(value => ({ value, label: value })), allowCustom,
    available: values.length > 0,
    reason: values.length > 0
      ? `Native --help ${flag} enumeration${supported === undefined ? "" : ", limited to adapter-supported values"}.`
      : `Native enumeration unavailable: ${flag} values were not reported or are not supported by this adapter.`
  };
}

export function configurationFieldWarnings(fields: readonly AgentConfigurationField[]): string[] {
  return [
    STATIC_CONFIGURATION_NOTICE,
    ...fields.filter(field => field.available === false)
      .map(field => `${field.key}: ${field.reason ?? "Native capability unavailable."}`)
  ];
}

/** Read only an explicit native enum. Prose examples and missing fields are not choices. */
export function configurationHelpChoices(help: string, flag: string): string[] {
  const section = helpSection(help, flag);
  if (section === undefined) return [];
  const inline = /(?:\[possible values:\s*([^\]]+)\]|\(choices:\s*([^)]*)\))/i.exec(section);
  const declared = inline?.[1] ?? inline?.[2];
  const bullets = declared === undefined && /Possible values:/i.test(section)
    ? [...section.matchAll(/^\s*-\s*([\w.+-]+)\s*:/gm)].map(match => match[1] ?? "")
    : [];
  return [...new Set((declared ?? bullets.join(",")).replace(/["']/g, "").split(",")
    .map(value => value.trim().replace(/\.$/, "")).filter(value => /^[\w.+-]+$/.test(value)))];
}

export function configurationFlagAvailable(help: string, flag: string): boolean {
  return helpSection(help, flag) !== undefined;
}

function helpSection(help: string, flag: string): string | undefined {
  const lines = help.replace(/\r\n/g, "\n").split("\n");
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`^\\s*(?:-[A-Za-z],?\\s+)?${escaped}(?=[\\s=,<\\[]|$)`);
  const start = lines.findIndex(line => declaration.test(line));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^\s*(?:-[A-Za-z],?\s+|--)[\w-]/.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n");
}
