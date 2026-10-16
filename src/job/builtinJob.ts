import type { BuiltinJobConfiguration } from "./jobDefinition.js";
import type { GlobalJobRun } from "./durableJob.js";
import { fileURLToPath } from "node:url";
import { requireKnownFields } from "../domain/validation.js";

/**
 * Controlled action compilation, not a shell/Agent plugin surface.
 * Unknown actions fail closed; executable paths/argv are never caller supplied.
 */
export function prepareBuiltinJob(configuration: BuiltinJobConfiguration, workspace: string,
  execution?: Readonly<{ home: string; runId: string }>):
  Pick<GlobalJobRun, "workspace" | "env" | "steps" | "head"> {
  if (configuration.action === "project.refresh") {
    projectRefreshDigest(configuration);
    // Runtime-owned Git discovery/authentication context, never caller input
    // or arbitrary inherited credentials. Background Git cannot prompt.
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
    for (const key of ["PATH", "HOME", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key]!;
    }
    return {
      workspace, env, head: "0".repeat(40),
      steps: [{
        name: "project.refresh", command: `project.refresh ${configuration.projectId}`,
        argv: [process.execPath, fileURLToPath(new URL("./projectRefreshRunner.js", import.meta.url)),
          execution?.home ?? "", execution?.runId ?? ""],
        timeoutMs: 10 * 60_000
      }]
    };
  }
  if (configuration.action !== "system.noop") throw new Error(`Unsupported builtin Job action: ${configuration.action}.`);
  if (configuration.projectId !== undefined || JSON.stringify(configuration.input) !== "{}") {
    throw new Error("system.noop accepts an empty input and no Project target.");
  }
  return {
    workspace,
    env: {},
    // No source repository applies to this action. This explicit sentinel is
    // never an Integration candidate or evidence of a Project revision.
    head: "0".repeat(40),
    steps: [{
      name: "system.noop",
      command: "system.noop",
      argv: [process.execPath, "-e", "process.stdout.write('system.noop completed\\n')"],
      timeoutMs: 5000
    }]
  };
}

export function projectRefreshDigest(configuration: BuiltinJobConfiguration): string {
  if (!/^project-\d+$/u.test(configuration.projectId ?? "")) throw new Error("project.refresh requires an exact Project ID.");
  const input = configuration.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid project.refresh input.");
  requireKnownFields(input, ["targetDigest"], "project.refresh input");
  const digest = (input as Readonly<Record<string, unknown>>).targetDigest;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("project.refresh requires its current catalog targetDigest.");
  }
  return digest;
}
