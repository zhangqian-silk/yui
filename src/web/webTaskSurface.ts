import type { TaskStore } from "../storage/taskStore.js";
import {
  readTaskContext, readTaskContextDelta, inspectTaskContext, withContextObservations,
  type ContextObservationProvider
} from "../context/taskContext.js";
import { BUILTIN_CAPABILITIES } from "../kernel/builtinCapabilities.js";
import { capabilitySchemaError } from "../kernel/capabilitySchema.js";
import {
  updateTaskMetadataCommand, sendTaskMessageCommand,
  type TaskCommandOptions
} from "../commands/taskCommands.js";
import type { TaskMetadataUpdate } from "../task/task.js";
import type { TaskSubmissionIntent } from "../message/message.js";
import { webLocalMutation, WebRequestRejected } from "./webMutation.js";
import { runTaskInputCommand } from "../commands/taskInputCommands.js";
import type { WebInputAnswer } from "./webServer.js";

/** Installed only by the local-user Web composition root. HTTP authenticates
 * its token before using this port; input never supplies a caller or Role.
 * Managed capability RPC keeps its own Session authentication unchanged.
 */
export function createWebTaskSurface(
  store: TaskStore,
  options: TaskCommandOptions = {},
  observations: readonly ContextObservationProvider[] = []
) {
  const environment = {};
  const commandOptions = { ...options, environment, runtime: undefined };
  // Notifications are after the outer transaction. Their failure must not be
  // reclassified as a rejection of a mutation that already committed.
  const notify = (taskId: string, leader = false) => {
    if (options.runtime?.notifyMailboxChanged) {
      void options.runtime.notifyMailboxChanged(leader
        ? { kind: "role", taskId, roleName: "leader" } : { kind: "task", taskId });
    } else options.runtime?.notifyStateChanged(taskId);
  };
  return {
    message: (taskId: string, body: string, intent?: TaskSubmissionIntent, requestId?: string) => {
      // With no explicit intent the Web surface submits `discuss` like every other
      // client (§2.5), through the one shared service; the requestId is threaded as
      // the submission key (§2.3) and the structured feedback is returned verbatim.
      const { message, task, queuedForLeader, feedback } = webLocalMutation(store, (tx) =>
        sendTaskMessageCommand(tx, taskId, body, undefined, commandOptions, undefined, intent, requestId));
      notify(taskId, queuedForLeader);
      return { record: message, revision: message.createdAt,
        disposition: queuedForLeader ? "queued" : "saved",
        planning: task.status === "draft",
        ...(feedback === undefined ? {} : { submission: feedback }),
        target: { scope: "task", taskId, roleName: "leader" } };
    },
    read: async (taskId: string) => withContextObservations(
      readTaskContext(store, taskId, environment), observations
    ),
    delta: (taskId: string, input: { after: string; continuation?: string }) =>
      readTaskContextDelta(store, taskId, input, environment),
    inspect: (taskId: string, input: { store: string; refId: string; digest?: string }) =>
      inspectTaskContext(store, taskId, input, environment),
    update: (taskId: string, input: unknown) => {
      const descriptor = BUILTIN_CAPABILITIES.find((entry) => entry.name === "task.update")!;
      const error = capabilitySchemaError(descriptor.inputSchema, { taskId, patch: input });
      if (error) throw new WebRequestRejected(error);
      const patch = input as Pick<TaskMetadataUpdate, "title" | "description" | "priority" | "tags">;
      const record = webLocalMutation(store, (tx) => updateTaskMetadataCommand(tx, taskId, {
        ...patch,
        ...(patch.description === "" ? { description: null } : {}),
        ...(patch.tags?.length === 0 ? { tags: null } : {})
      }, commandOptions));
      notify(taskId);
      return { record, revision: record.updatedAt };
    },
    answer: (taskId: string, inputId: string, answer: WebInputAnswer) => {
      const result = webLocalMutation(store, (tx) => runTaskInputCommand([
        "answer", inputId, "--task", taskId,
        ...("choiceKey" in answer ? ["--choice", answer.choiceKey] : ["--text", answer.text])
      ], tx, commandOptions));
      const data = result.data as { request: unknown };
      notify(taskId, true);
      return data.request;
    }
  };
}

export type WebTaskSurface = ReturnType<typeof createWebTaskSurface>;
