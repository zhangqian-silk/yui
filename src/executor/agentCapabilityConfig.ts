import { isAbsolute } from "node:path";
import { isAgentAdapterId, type AgentAdapterId } from "../agent/adapterCatalog.js";

/** Native metadata selectors and requested values, not execution authority. */
export type AgentCapabilityConfig = Readonly<{
  adapterId: AgentAdapterId;
  model?: string;
  effort?: string;
  profile?: string;
  settingsFile?: string;
  settingsSources?: readonly string[];
}>;

/** Project an existing Role/launch config without changing its native values. */
export function projectAgentCapabilityConfig(config: AgentCapabilityConfig): AgentCapabilityConfig {
  return validateAgentCapabilityConfig({
    adapterId: config.adapterId,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.effort === undefined ? {} : { effort: config.effort }),
    ...(config.adapterId !== "codex" || config.profile === undefined ? {} : { profile: config.profile }),
    ...(config.adapterId !== "claude" || config.settingsFile === undefined ? {} : { settingsFile: config.settingsFile }),
    ...(config.adapterId !== "claude" || config.settingsSources === undefined ? {} : { settingsSources: [...config.settingsSources] })
  });
}

export function validateAgentCapabilityConfig(value: unknown): AgentCapabilityConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent capability configuration is invalid.");
  }
  const config = value as Record<string, unknown>;
  if (!isAgentAdapterId(config.adapterId)) throw new Error("Agent capability adapter is invalid.");
  const keys = ["adapterId", "model", "effort",
    ...(config.adapterId === "codex" ? ["profile"] : []),
    ...(config.adapterId === "claude" ? ["settingsFile", "settingsSources"] : [])];
  if (Object.keys(config).some(key => !keys.includes(key))) {
    throw new Error("Agent capability configuration contains execution-only or unsupported fields.");
  }
  for (const key of ["model", "effort", "profile", "settingsFile"]) {
    const field = config[key];
    if (field !== undefined && (typeof field !== "string" || field.trim().length === 0 || field.includes("\0"))) {
      throw new Error(`Agent capability ${key} is invalid.`);
    }
  }
  if (config.settingsFile !== undefined && !isAbsolute(config.settingsFile as string)) {
    throw new Error("Agent capability settings file must be absolute.");
  }
  const sources = config.settingsSources;
  if (sources !== undefined && (!Array.isArray(sources)
    || sources.some(source => typeof source !== "string" || source.trim().length === 0 || source.includes("\0"))
    || new Set(sources).size !== sources.length)) {
    throw new Error("Agent capability settings sources are invalid.");
  }
  return config as AgentCapabilityConfig;
}
