import { usageError } from "../errors/cliError.js";

export const MODEL_COMMAND_ACTIONS = ["read", "preview", "save", "save-provider", "refresh", "maintain", "connection-preview", "connection-apply"] as const;

/** Parsing only. Execution stays on the original authenticated capability path. */
export function modelCommandArguments(args: readonly string[]): string[] {
  const [action, ...rest] = args;
  if (!(MODEL_COMMAND_ACTIONS as readonly string[]).includes(action)) throw usageError("Unknown models action; use yui models guide.");
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index], value = rest[++index];
    if (!["--task", "--input", "--request-id"].includes(flag) || flags.has(flag) || !value || value.startsWith("--"))
      throw usageError(`Invalid models option: ${flag}.`);
    flags.set(flag, value);
  }
  if (!flags.has("--task")) throw usageError("Models requires --task <actual-task-id> for the existing authenticated capability context.");
  if (action !== "read" && !flags.has("--input")) throw usageError("Models mutation/preview requires --input <json>; consult yui models guide.");
  let input: unknown;
  try { input = JSON.parse(flags.get("--input") ?? "{}"); } catch { throw usageError("Invalid models JSON input."); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw usageError("Models input must be a JSON object.");
  const capabilityInput = action === "read" ? input
    : action === "save" || action === "save-provider" ? { operation: action === "save" ? "resource" : "provider", input }
    : { input };
  return ["call", `models.${action === "save-provider" ? "save" : action}`,
    "--task", flags.get("--task")!, "--input", JSON.stringify(capabilityInput),
    ...(flags.has("--request-id") ? ["--request-id", flags.get("--request-id")!] : [])];
}
