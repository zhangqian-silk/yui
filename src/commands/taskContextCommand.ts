import { usageError } from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import { inspectTaskContext, listTaskContext, readTaskContext, readTaskContextDelta } from "../context/taskContext.js";
import { readOptions } from "../output/boundedRead.js";

export function taskRecordList(
  args: string[], store: TaskStore, family: string, environment: NodeJS.ProcessEnv = {}
) {
  const parsed = readOptions(args, ["--cursor", "--limit", "--status", "--after", "--work-item"]);
  if (parsed.positionals.length !== 1) throw usageError("Record list requires one Task and optional --limit/--cursor/--status/--after/--work-item.");
  const data = listTaskContext(store, parsed.positionals[0]!, family, {
    ...parsed, status: parsed.values.get("--status"), after: parsed.values.get("--after"),
    workItemId: parsed.values.get("--work-item")
  }, environment);
  return { kind: "output" as const, output: `${JSON.stringify(data)}\n`, data };
}

/** CLI parsing only; typed callers and capability ingress share the read model. */
export function runTaskContextCommand(
  args: string[], store: TaskStore, environment: NodeJS.ProcessEnv = {}
) {
  const explicit = ["read", "delta", "inspect", "list"].includes(args[0] ?? "");
  const action = explicit ? args[0]! : "read";
  const taskId = args[explicit ? 1 : 0];
  if (!taskId || taskId.startsWith("--")) throw usageError(
    "Task context usage: yui task context [read|list|delta|inspect] <task> [--after <cursor|timestamp>] [--continuation <cursor>] [--cursor <cursor>] [--limit <1..100>] [--store <store> --ref <id> --digest <digest>] [--status <status>] [--work-item <id>]."
  );
  const options = new Map<string, string>();
  const rest = args.slice(explicit ? 2 : 1);
  const allowed = action === "read" ? [] : action === "delta"
    ? ["--after", "--continuation", "--limit"] : action === "list"
      ? ["--store", "--cursor", "--limit", "--status", "--after", "--work-item"] : ["--store", "--ref", "--digest", "--cursor"];
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (!allowed.includes(flag) || options.has(flag) || value === undefined || value.startsWith("--")) {
      throw usageError(`Invalid Context option: ${flag}.`);
    }
    options.set(flag, value);
  }
  let data: unknown;
  if (action === "read") data = readTaskContext(store, taskId, environment);
  else if (action === "list") {
    const family = options.get("--store");
    if (family === undefined) throw usageError("Context list requires --store.");
    data = listTaskContext(store, taskId, family, {
      cursor: options.get("--cursor"),
      status: options.get("--status"), after: options.get("--after"), workItemId: options.get("--work-item"),
      ...(options.has("--limit") ? { limit: Number(options.get("--limit")) } : {})
    }, environment);
  } else if (action === "delta") {
    const after = options.get("--after");
    if (after === undefined) throw usageError("Context delta requires --after from a previous read.");
    data = readTaskContextDelta(store, taskId, {
      after, continuation: options.get("--continuation"),
      ...(options.has("--limit") ? { limit: Number(options.get("--limit")) } : {})
    }, environment);
  } else {
    const family = options.get("--store");
    const refId = options.get("--ref");
    if (family === undefined || refId === undefined) throw usageError("Context inspect requires --store and --ref.");
    data = inspectTaskContext(store, taskId, { store: family, refId, digest: options.get("--digest"),
      cursor: options.get("--cursor") }, environment);
  }
  return { kind: "output" as const, output: `${JSON.stringify(data)}\n`, data };
}
