import type { AgentRun } from "../agentRun/agentRun.js";
import type { GlobalRoleMessage, TaskMessage } from "../message/message.js";
import type { TaskWake } from "../scheduler/taskWake.js";
import { parseWakeReason } from "../scheduler/wakeReason.js";

/** Optional producer-authored presentation, stored in the original text, not a
 * parsed business outcome or a second fact store. Reject oversized summaries
 * whole: clipping could remove a failure/authority qualifier. */
export function authoredNotificationSummary(text: string | undefined): string | undefined {
  const line = text?.trimStart().split(/\r?\n/u, 1)[0];
  if (!line?.startsWith("Yui-Summary: ")) return undefined;
  const summary = line.slice("Yui-Summary: ".length).trim();
  return summary.length > 0 && Buffer.byteLength(summary) <= 512
    && !/[\u0000-\u001f\u007f]/u.test(summary) ? summary : undefined;
}

export function taskMessagePresentation(
  message: TaskMessage, getRun: (taskId: string, runId: string) => AgentRun | null
) {
  const run = message.resultRef?.type === "agent-run-result"
    ? getRun(message.taskId, message.resultRef.runId) : null;
  const summary = authoredNotificationSummary(run?.result?.output ?? message.body);
  const fact = run !== null
    ? `${run.purpose === "review" ? "Review" : "Execution"} result returned (${run.status}); disposition pending`
    : message.kind === "role-result" ? "Role result returned; disposition pending"
      : message.kind === "user" || message.kind === "operator" ? "Additional input received"
        : "System message received";
  return {
    fact,
    ...(summary === undefined ? {} : {
      summary, summarySource: run?.result?.output === undefined ? "message-body" : "agent-run-result"
    })
  };
}

export function wakeChangeLabels(reasons: readonly string[]): string[] {
  return [...new Set(reasons.map(tag => {
    const { kind } = parseWakeReason(tag);
    switch (kind) {
      case "operator-input": case "user-message": case "interrupt-then": return "Additional input received";
      case "execution-started": return "Task execution enabled";
      case "task-created": return "Task created";
      case "task-reopened": return "Task reopened; check for scoped follow-up";
      case "role-result": return "Role result returned; disposition pending";
      case "review-failed": return "Review execution failed; inspect original failure";
      case "agent-error": case "leader-turn-failed": case "role-turn-failed": return "Execution failure needs attention";
      case "job-finished": return "Job ended; inspect outcome";
      case "input-timeout": return "Input deadline reached; inspect recorded decision";
      case "notification-retry": return "Notification retry after recorded correction";
      default: return Buffer.byteLength(kind) <= 120 && !/[\u0000-\u001f\u007f]/u.test(kind)
        ? `Recorded update: ${kind}` : "Other recorded update; inspect wake";
    }
  }))];
}

export function wakeMessages(wake: TaskWake, messages: readonly TaskMessage[], history = false): TaskMessage[] {
  const ids = new Set(wake.refs?.filter(ref => ref.type === "message" && ref.taskId === wake.taskId).map(ref => ref.id));
  const from = Date.parse(wake.fromCursor), to = Date.parse(wake.toCursor);
  return messages.filter(message => message.taskId === wake.taskId && (ids.has(message.id)
    || (history || wake.refs === undefined) && Date.parse(message.createdAt) > from && Date.parse(message.createdAt) <= to));
}

export function taskNotificationPresentation(
  wake: TaskWake,
  store: {
    listMessages(taskId: string): readonly TaskMessage[];
    getRun(taskId: string, runId: string): AgentRun | null;
  }
): string {
  const messages = wakeMessages(wake, store.listMessages(wake.taskId));
  const labels = wakeChangeLabels(wake.reasons);
  return [
    `Yui Task notification: task=${wake.taskId} wake=${wake.id}.`,
    `Changes: ${labels.slice(0, 4).join("; ")}${labels.length > 4 ? "; more in wake" : ""}.`,
    ...messages.slice(0, 4).map(message => {
      const item = taskMessagePresentation(message, (task, run) => store.getRun(task, run));
      return `- ${message.id} [${message.author.type}${message.author.type === "role" ? `:${message.author.roleName}` : ""}]: ${item.fact}.`
        + (item.summary === undefined ? "" : ` Author summary (${item.summarySource}): ${JSON.stringify(item.summary)}`);
    }),
    ...(messages.length > 4 ? [`${messages.length - 4} more messages in the fixed wake.`] : []),
    `Refresh: yui task context ${wake.taskId} --json`,
    `Read inputs/results: yui task wake show ${wake.taskId} ${wake.id} --json`,
    `Handling: claim exact inbox entry ${wake.id}; after disposition, ack it with a concrete reason before ending this turn.`,
    "Use yui inbox list --view current --json for current inputs. Historical missing receipts are not new work; never replay effects to repair an ACK.",
    "Check current Skills each turn: yui session skills --json. Apply current yui-leader; read relevant originals in full and advance authorized work."
  ].join("\n");
}

export function globalMessagePresentation(roleName: string, messageId: string, message?: GlobalRoleMessage): string {
  const summary = authoredNotificationSummary(message?.body);
  return [
    `Yui Global Message: role=${roleName} message=${messageId}.`,
    `Changes: ${message?.author.type ?? "Recorded"} input received.`,
    ...(summary === undefined ? [] : [`Author summary (message-body): ${JSON.stringify(summary)}`]),
    "Refresh Session Context using the current Manifest's loadCommand.",
    `Read original: yui role message show ${roleName} ${messageId} --json`,
    `Handling: claim exact inbox entry ${messageId}; after disposition, ack it with a concrete reason before ending this turn.`,
    "Routing to a Task or asking a necessary user question can settle this input without completing the Task. Missing ACK is not permission to repeat effects.",
    `The Global loadCommand checks current Skill versions each turn. Apply current ${roleName === "operator" ? "yui-operator" : "yui-runtime"} within existing authority.`
  ].join("\n");
}
