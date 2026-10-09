import { assertContextRecordReadable } from "../context/taskContext.js";
import { readTaskUsage } from "../runtime/taskUsageQuery.js";
import { formatUsageMetric } from "../runtime/taskUsageMetrics.js";
import type { TaskCommandExecution, TaskCommandOptions, TaskWorkflowStore } from "./taskCommandTypes.js";
import { exactPositionals, output, parseTail, requireTask } from "./taskCommandSupport.js";
import { usageError } from "../errors/cliError.js";

export function taskUsageCommand(args: string[], store: TaskWorkflowStore, options: TaskCommandOptions): TaskCommandExecution {
  const usage = "yui task usage <task> [--limit <0..50>] [--offset <n>]";
  const parsed = parseTail(args, new Set(["--limit", "--offset"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const task = requireTask(store, parsed.positionals[0]);
  assertContextRecordReadable(store, task.id, "task", task.id, options.environment);
  const limit = Number(parsed.options.get("--limit") ?? 0), offset = Number(parsed.options.get("--offset") ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) {
    throw usageError(usage);
  }
  const result = readTaskUsage(store, task.id, { limit, offset, now: options.now?.() })!;
  const money = (kind: "actual" | "estimated") => {
    const metric = result.costs[kind];
    return metric.amounts.length === 0 ? `unknown (${metric.reasons.join(", ")})`
      : metric.amounts.map(amount => `${formatUsageMetric(amount)} ${amount.currency}`).join("; ");
  };
  return output([
    `Task: ${task.id} — task lifetime, observed sources only; not a bill`,
    `Tokens: ${formatUsageMetric(result.tokens)}`,
    `Tool calls: ${formatUsageMetric(result.toolCalls)}`,
    `Elapsed: ${formatUsageMetric(result.elapsedSeconds, "s")}`,
    `Native execution: ${formatUsageMetric(result.executionSeconds, "s")} (not billable duration)`,
    `Upstream actual: ${money("actual")}`,
    `Estimated: ${money("estimated")}`,
    `History: ${result.history.complete ? "all retained facts" : "bounded partial facts"}`,
    `Details: --limit 20 --offset ${result.details.nextOffset ?? 0}`,
    ...(limit === 0 ? [] : [JSON.stringify({ sessions: result.sessions, costs: result.costs }, null, 2)])
  ].join("\n") + "\n", result);
}
