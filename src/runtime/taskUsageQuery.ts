import type { TaskEvent } from "../event/taskEvent.js";
import type { TaskStore } from "../storage/taskStore.js";
import { projectTaskUsageMetrics, type TaskUsageMetrics, type UsageRun, type UsageMetric } from "./taskUsageMetrics.js";

export const TASK_USAGE_FACT_LIMIT = 2000;
export type TaskUsageFacts = Readonly<{
  events: readonly TaskEvent[];
  runs: readonly UsageRun[];
  complete: boolean;
}>;
export type TaskUsagePage = TaskUsageMetrics & Readonly<{
  details: { offset: number; limit: number; sessionTotal: number; actualTotal: number;
    estimatedTotal: number; nextOffset: number | null };
  history: { complete: boolean; limit: number };
}>;

/** Same bounded, read-only fact query for the Task CLI and Web. */
export function readTaskUsage(
  store: Pick<TaskStore, "getTask" | "readTaskUsageFacts">,
  taskId: string,
  options: { offset?: number; limit?: number; now?: Date } = {}
): TaskUsagePage | null {
  const task = store.getTask(taskId);
  if (task === null) return null;
  const facts = store.readTaskUsageFacts(taskId);
  return pageTaskUsage(projectTaskUsageMetrics({ task, ...facts, now: options.now }),
    facts.complete, options);
}

export function pageTaskUsage(
  input: TaskUsageMetrics, complete = true, options: { offset?: number; limit?: number } = {}
): TaskUsagePage {
  const offset = options.offset ?? 0, limit = options.limit ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0 || limit > 50) {
    throw new Error("Usage detail offset must be non-negative; limit must be 0..50.");
  }
  const bounded = (metric: UsageMetric): UsageMetric => complete ? metric : {
    ...metric, status: metric.value === null ? "unknown" : "partial",
    reasons: [...new Set([...metric.reasons, "usage-history-limited"])]
  };
  const cost = (value: TaskUsageMetrics["costs"]["actual"]) => ({
    ...value,
    status: complete || value.status === "unknown" ? value.status : "partial" as const,
    reasons: complete ? value.reasons : [...new Set([...value.reasons, "usage-history-limited"])],
    amounts: value.amounts.map(amount => ({ ...bounded(amount), currency: amount.currency })),
    evidence: value.evidence.slice(offset, offset + limit)
  });
  const total = Math.max(input.sessions.length, input.costs.actual.evidence.length, input.costs.estimated.evidence.length);
  return {
    ...input, tokens: bounded(input.tokens), toolCalls: bounded(input.toolCalls),
    executionSeconds: bounded(input.executionSeconds),
    costs: { scope: input.costs.scope, actual: cost(input.costs.actual), estimated: cost(input.costs.estimated) },
    sessions: input.sessions.slice(offset, offset + limit),
    details: { offset, limit, sessionTotal: input.sessions.length,
      actualTotal: input.costs.actual.evidence.length, estimatedTotal: input.costs.estimated.evidence.length,
      nextOffset: offset + limit < total ? offset + limit : null },
    history: { complete, limit: TASK_USAGE_FACT_LIMIT }
  };
}
