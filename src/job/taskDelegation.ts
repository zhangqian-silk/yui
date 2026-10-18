import { requireIdentity, requireKnownFields, requireText } from "../domain/validation.js";
import { createTask, validateTask, type TaskProjectBinding } from "../task/task.js";
import { createHash } from "node:crypto";
import type { WorkItem } from "../workItem/workItem.js";

/** Definition intent. No Task identity exists for a new target until admission. */
export type TaskJobConfiguration = Readonly<{
  kind: "task";
  goal: "delivery" | "task-created";
  target: Readonly<{
    kind: "new"; title: string; description: string; type?: string;
    projectBindings: readonly TaskProjectBinding[];
  }>;
}> | Readonly<{
  kind: "task";
  goal: "work-item";
  target: Readonly<{ kind: "work-item"; taskId: string; workItemId: string; revision: number }>;
}>;

/** Exact scope, minted atomically with the Run. Not an independent lifecycle. */
export type TaskDelegation = Readonly<{
  taskId: string;
  goal: TaskJobConfiguration["goal"];
  workItemId?: string;
  workItemRevision?: number;
  workItemDefinitionDigest?: string;
}>;

/** WorkItem revision also advances on execution/candidate submission. Freeze
 * requirements, not that mutable progress counter, as the delegated scope. */
export function workItemDefinitionDigest(work: WorkItem): string {
  return createHash("sha256").update(JSON.stringify([work.title, work.objective, work.acceptance,
    work.dependsOn, work.writeProjectIds, work.baseRefs ?? null])).digest("hex");
}

export function validateTaskJobConfiguration(config: TaskJobConfiguration): void {
  requireKnownFields(config, ["kind", "goal", "target"], "Task Job");
  if (config.target.kind === "new") {
    requireKnownFields(config.target, ["kind", "title", "description", "type", "projectBindings"], "New Task target");
    if (!["delivery", "task-created"].includes(config.goal)) throw new Error("New Task requires a delivery or explicit task-created goal.");
    requireText(config.target.description, "Task requirements");
    if (!Array.isArray(config.target.projectBindings)) throw new Error("Explicit Task Project bindings required.");
    for (const binding of config.target.projectBindings) {
      requireKnownFields(binding, ["projectId", "directory", "baseRef"], "Draft Project binding");
    }
    validateTask(createTask("task-1", config.target.title, new Date(0), config.target));
  } else if (config.target.kind === "work-item" && config.goal === "work-item") {
    requireKnownFields(config.target, ["kind", "taskId", "workItemId", "revision"], "WorkItem target");
    requireIdentity(config.target.taskId, "Target Task");
    requireIdentity(config.target.workItemId, "Target WorkItem");
    if (!/^task-\d+$/u.test(config.target.taskId) || !/^work-item-\d+$/u.test(config.target.workItemId)
      || !Number.isSafeInteger(config.target.revision) || config.target.revision < 1) throw new Error("Exact WorkItem scope and revision required.");
  } else throw new Error("Invalid Task delegation target/goal.");
}

export function validateTaskDelegation(value: TaskDelegation): void {
  requireKnownFields(value, ["taskId", "goal", "workItemId", "workItemRevision", "workItemDefinitionDigest"], "Task delegation");
  if (!/^task-\d+$/u.test(value.taskId)) throw new Error("Invalid delegated Task.");
  if (value.goal === "work-item") {
    if (!/^work-item-\d+$/u.test(value.workItemId ?? "")
      || !Number.isSafeInteger(value.workItemRevision) || value.workItemRevision! < 1
      || !/^[a-f0-9]{64}$/u.test(value.workItemDefinitionDigest ?? "")) throw new Error("Exact delegated WorkItem required.");
  } else if (!["delivery", "task-created"].includes(value.goal) || value.workItemId !== undefined
    || value.workItemRevision !== undefined || value.workItemDefinitionDigest !== undefined) throw new Error("Invalid delegated goal.");
}
