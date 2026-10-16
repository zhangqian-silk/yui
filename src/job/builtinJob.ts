import type { BuiltinJobConfiguration } from "./jobDefinition.js";
import type { GlobalJobRun } from "./durableJob.js";

/**
 * Controlled action compilation, not a shell/Agent plugin surface.
 * project.refresh is added by its owning feature; unknown actions fail closed.
 */
export function prepareBuiltinJob(configuration: BuiltinJobConfiguration, workspace: string):
  Pick<GlobalJobRun, "workspace" | "env" | "steps" | "head"> {
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
