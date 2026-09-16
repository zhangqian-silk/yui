import type { TaskAgentCapabilityQuery } from "../executor/taskAgentCapabilities.js";
import { exactPositionals, parseTail } from "./taskCommandSupport.js";

export function parseTaskAgentCapabilityQuery(args: string[]): TaskAgentCapabilityQuery {
  const usage = "Usage: yui task role capabilities <task> <role> [--error <event-id>] [--refresh]";
  const parsed = parseTail(args, new Set(["--error"]), usage, new Set(["--refresh"]));
  exactPositionals(parsed.positionals, 2, usage);
  const errorId = parsed.options.get("--error");
  return { taskId: parsed.positionals[0]!, roleName: parsed.positionals[1]!,
    ...(errorId === undefined ? {} : { errorId }), refresh: parsed.options.has("--refresh") };
}
