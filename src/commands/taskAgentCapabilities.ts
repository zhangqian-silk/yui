import type { TaskAgentCapabilityQuery } from "../executor/taskAgentCapabilities.js";
import { exactPositionals, parseTail } from "./taskCommandSupport.js";
import { usageError } from "../errors/cliError.js";

export function parseTaskAgentCapabilityQuery(args: string[]): TaskAgentCapabilityQuery {
  const usage = "Usage: yui task role capabilities <task> <role> [--stage draft|develop | --error <event-id>] [--refresh]";
  const parsed = parseTail(args, new Set(["--error", "--stage"]), usage, new Set(["--refresh"]));
  exactPositionals(parsed.positionals, 2, usage);
  const errorId = parsed.options.get("--error");
  const stage = parsed.options.get("--stage");
  if (stage !== undefined && (stage !== "draft" && stage !== "develop" || errorId !== undefined
    || parsed.positionals[1] !== "leader")) throw usageError("--stage requires Leader draft|develop and cannot be combined with --error.", usage);
  return { taskId: parsed.positionals[0]!, roleName: parsed.positionals[1]!,
    ...(stage === undefined ? {} : { stage: stage as "draft" | "develop" }),
    ...(errorId === undefined ? {} : { errorId }), refresh: parsed.options.has("--refresh") };
}
