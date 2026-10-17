import type { TaskEvent } from "../event/taskEvent.js";

/** An append-only Task decision, not a Project permission or a merge fact. */
export const PROJECT_DELIVERY_DECIDED_EVENT = "task.project-delivery-decided";
export type ProjectDeliveryRequirement = "required" | "excluded";

export function projectDeliveryDecision(
  events: readonly TaskEvent[], taskId: string, projectId: string
): TaskEvent | null {
  return events.filter(event => event.taskId === taskId
    && event.type === PROJECT_DELIVERY_DECIDED_EVENT && event.payload.projectId === projectId)
    // Task event IDs are monotonic durable sequence numbers; wall clocks can move backwards.
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).at(-1) ?? null;
}

export function projectDeliveryRequirement(decision: TaskEvent | null): ProjectDeliveryRequirement {
  if (decision === null) return "required";
  const p = decision.payload;
  if (!["required", "excluded"].includes(p.requirement ?? "")
    || !p.reason?.trim() || !p.sourceMessageId?.trim()
    || !/^[a-f0-9]{64}$/u.test(p.sourceDigest ?? "") || !p.purpose?.trim()
    || !["user", "operator", "leader"].includes(p.by ?? "")) {
    throw new Error(`Project delivery decision ${decision.id} has incomplete evidence; preserve it for diagnosis.`);
  }
  return p.requirement as ProjectDeliveryRequirement;
}
