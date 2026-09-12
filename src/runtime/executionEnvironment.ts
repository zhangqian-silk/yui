import { isDeepStrictEqual } from "node:util";
import type { TaskStore } from "../storage/taskStore.js";
import { createProjectResources } from "../resources/projectResourceService.js";
import type { ExecutionEnvironmentSnapshot } from "../resources/projectResource.js";

/** Revalidate the adopted owner; a saved path alone never authorizes execution. */
export function assertExecutionEnvironmentCurrent(
  store: TaskStore,
  taskId: string,
  snapshot: ExecutionEnvironmentSnapshot
): void {
  if (snapshot.taskId !== taskId) throw new Error("Execution environment belongs to another Task.");
  const current = createProjectResources(store).resolveExecutionEnvironment(taskId, snapshot.preparationId);
  if (!isDeepStrictEqual(current, snapshot)) {
    throw new Error("Execution environment changed; select an adopted environment and start a new Session.");
  }
}
