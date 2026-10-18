import { usageError } from "../errors/cliError.js";
import { callFileTaskController } from "../controller/clientRuntime.js";
import type { JsonValue } from "../core/protocol.js";
import { resolveJobCaller } from "../task/taskAuthority.js";

export async function runScheduleCommand(
  args: string[], options: { home: string; environment?: NodeJS.ProcessEnv }
): Promise<JsonValue> {
  const [op, ...rest] = args;
  if (op === undefined || !["create", "list", "show", "update", "enable", "disable", "revoke"].includes(op)) {
    throw usageError("Schedule command must be create, list, show, update, enable, disable, or revoke.");
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (!["--global", "--task", "--schedule", "--job", "--target", "--authorization", "--rule", "--revision"].includes(flag) || flags.has(flag)) {
      throw usageError(`Unknown or repeated Schedule flag: ${flag}.`);
    }
    if (flag === "--global") { flags.set(flag, "true"); continue; }
    const value = rest[++i];
    if (value === undefined || value.startsWith("--")) throw usageError(`Missing value: ${flag}.`);
    flags.set(flag, value);
  }
  if (flags.has("--global") === flags.has("--task")) throw usageError("Choose exactly one of --global or --task.");
  const taskId = flags.get("--task");
  let rule: JsonValue | undefined;
  let target: JsonValue | undefined;
  if (flags.has("--rule")) {
    try { rule = JSON.parse(flags.get("--rule")!); }
    catch { throw usageError("--rule must be JSON."); }
  }
  if (flags.has("--target")) {
    try { target = JSON.parse(flags.get("--target")!); }
    catch { throw usageError("--target must be JSON."); }
  }
  const result = await callFileTaskController(options.home, "schedule.control", {
    op, scope: taskId === undefined ? { kind: "global" } : { kind: "task", taskId },
    caller: resolveJobCaller(options.environment, taskId ?? ""),
    ...(flags.has("--schedule") ? { id: flags.get("--schedule") } : {}),
    ...(flags.has("--job") ? { jobId: flags.get("--job") } : {}),
    ...(rule === undefined ? {} : { rule }),
    ...(target === undefined ? {} : { target }),
    ...(flags.has("--authorization") ? { authorization: flags.get("--authorization") } : {}),
    ...(flags.has("--revision") ? { expectedRevision: Number(flags.get("--revision")) } : {})
  } as JsonValue, { environment: options.environment });
  return result;
}
