import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ConfiguredAgent } from "../agent/agent.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import { requireIdentity } from "../domain/validation.js";
import { projectAgentCapabilityConfig, validateAgentCapabilityConfig,
  type AgentCapabilityConfig } from "../executor/agentCapabilityConfig.js";

/** The requested launch configuration, not a copy of native credentials/files. */
export type AgentFailureContext =
  | Readonly<{ status: "recorded"; agentId: string; cwd: string;
      config: AgentCapabilityConfig; agentFingerprint: string }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export function configuredAgentFingerprint(agent: ConfiguredAgent): string {
  // Environment entries name bindings, never their resolved secret values.
  return createHash("sha256").update(JSON.stringify({
    id: agent.id, component: agent.component, adapterId: agent.adapterId,
    command: agent.command, baseArgs: agent.baseArgs, environment: agent.environment
  })).digest("hex");
}

export function captureAgentFailureContext(
  effective: EffectiveLaunchSnapshot | undefined, agent: ConfiguredAgent | null
): string {
  const value: AgentFailureContext = effective === undefined || agent === null
    ? { status: "unavailable", reason: "The failing execution did not report a complete launch configuration." }
    : agent.id !== effective.agentId || agent.adapterId !== effective.adapterId || agent.component !== effective.component
      ? { status: "unavailable", reason: "The configured Agent no longer matches the failing execution's implementation." }
      : { status: "recorded", agentId: effective.agentId, cwd: effective.workspace.root,
          config: projectAgentCapabilityConfig(effective),
          agentFingerprint: configuredAgentFingerprint(agent) };
  return JSON.stringify(value);
}

export function readAgentFailureContext(value: string | undefined): AgentFailureContext {
  if (value === undefined) throw new Error("Agent failure is missing its configuration context.");
  const parsed = JSON.parse(value) as AgentFailureContext;
  if (parsed?.status === "unavailable" && typeof parsed.reason === "string" && parsed.reason.length > 0) return parsed;
  if (parsed?.status !== "recorded" || !/^[a-f0-9]{64}$/.test(parsed.agentFingerprint)) {
    throw new Error("Agent failure configuration context is invalid.");
  }
  if (Object.keys(parsed).some(key => !["status", "agentId", "cwd", "config", "agentFingerprint"].includes(key))) {
    throw new Error("Agent failure context contains unsupported fields.");
  }
  requireIdentity(parsed.agentId, "Failure Agent id");
  if (typeof parsed.cwd !== "string" || !isAbsolute(parsed.cwd) || parsed.cwd.includes("\0")) {
    throw new Error("Agent failure working directory is invalid.");
  }
  validateAgentCapabilityConfig(parsed.config);
  return parsed;
}

export function failureCapabilitiesCommand(taskId: string, roleName: string, eventId: string): string {
  return `yui task role capabilities ${taskId} ${roleName} --error ${eventId} --refresh`;
}
