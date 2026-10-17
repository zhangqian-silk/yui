import { readTaskAuthorizationMessage, taskAuthorizationSource } from "../grant/taskAuthorization.js";
import { assertTaskDeliveryAuthority } from "../task/taskAuthority.js";
import { PROJECT_DELIVERY_DECIDED_EVENT, projectDeliveryDecision } from "../task/projectDeliveryScope.js";
import { enqueueWork } from "../coordination/workMailboxQueue.js";
import { usageError } from "../errors/cliError.js";
import { clock, exactPositionals, leaderMailbox, notifyMailbox, output, parseTail,
  recordTaskEvent, requiredOption, requireTask, taskMailbox, taskRef } from "./taskCommandSupport.js";
import type { TaskCommandExecution, TaskCommandOptions, TaskWorkflowStore } from "./taskCommandTypes.js";

export function taskProjectDeliveryCommand(
  args: string[], store: TaskWorkflowStore, options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "yui task project delivery <task> <project-id> --requirement <required|excluded> "
    + "--reason <text> --source-message <message-id> --purpose <exact-quote> --if-current <event-id|none>";
  const parsed = parseTail(args, new Set([
    "--requirement", "--reason", "--source-message", "--purpose", "--if-current"
  ]), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const requirement = requiredOption(parsed.options, "--requirement");
  if (requirement !== "required" && requirement !== "excluded") throw usageError(usage);
  const reason = requiredOption(parsed.options, "--reason");
  const sourceMessage = requiredOption(parsed.options, "--source-message");
  const purpose = requiredOption(parsed.options, "--purpose");
  const guard = requiredOption(parsed.options, "--if-current");
  const now = clock(options);
  const result = store.transaction(tx => {
    const task = requireTask(tx, parsed.positionals[0]);
    const actor = assertTaskDeliveryAuthority(tx, options.environment, task.id);
    if (!["active", "completed"].includes(task.status) || task.executionGate.state !== "enabled") {
      throw usageError("Delivery scope requires an active or completed, unarchived Task with execution enabled; it does not reopen or resume work.");
    }
    const projectId = parsed.positionals[1]!;
    if (!task.projectBindings.some(binding => binding.projectId === projectId)) {
      throw usageError(`Project is not bound to this Task: ${projectId}.`);
    }
    const source = actor === "leader"
      ? taskAuthorizationSource(tx, task.id, options.environment ?? {}, sourceMessage, purpose)
      : readTaskAuthorizationMessage(tx, task.id, sourceMessage, purpose);
    const previous = projectDeliveryDecision(
      tx.listEventsByType(task.id, [PROJECT_DELIVERY_DECIDED_EVENT]), task.id, projectId);
    if (guard !== (previous?.id ?? "none")) {
      throw usageError("Project delivery scope changed; read task remote-delivery and reconcile before retrying with its scopeDecision.id (or none).");
    }
    const event = recordTaskEvent(tx, task.id, PROJECT_DELIVERY_DECIDED_EVENT, {
      projectId, requirement, reason, by: actor,
      sourceMessageId: source.messageId, sourceDigest: source.digest, purpose: source.purpose,
      ...("nativeSessionId" in source && typeof source.nativeSessionId === "string"
        ? { nativeSessionId: source.nativeSessionId } : {}),
      ...(previous === null ? {} : { supersedes: previous.id })
    }, now);
    enqueueWork(tx, taskMailbox(task.id), "project-delivery-decided", now, [taskRef(task.id)]);
    if (task.status === "active" && actor !== "leader") {
      enqueueWork(tx, leaderMailbox(task.id), "project-delivery-decided", now, [taskRef(task.id)]);
    }
    return { task, event };
  });
  notifyMailbox(options.runtime, taskMailbox(result.task.id));
  if (result.task.status === "active") notifyMailbox(options.runtime, leaderMailbox(result.task.id));
  return output(`Recorded Project delivery requirement (${requirement}); merge facts and cleanup authority are unchanged.\n`, result.event);
}
