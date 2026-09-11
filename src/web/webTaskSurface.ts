import type { TaskStore } from "../storage/taskStore.js";
import {
  readTaskContext, readTaskContextDelta, inspectTaskContext, withContextObservations,
  type ContextObservationProvider
} from "../context/taskContext.js";
import { BUILTIN_CAPABILITIES } from "../kernel/builtinCapabilities.js";
import { capabilitySchemaError } from "../kernel/capabilitySchema.js";
import {
  updateTaskMetadataCommand, sendTaskMessageCommand, runTaskCommand,
  type TaskCommandOptions, type TaskCommandExecution
} from "../commands/taskCommands.js";
import type { TaskMetadataUpdate } from "../task/task.js";
import type { TaskSubmissionIntent } from "../message/message.js";
import { webLocalMutation, WebRequestRejected } from "./webMutation.js";
import { runTaskInputCommand } from "../commands/taskInputCommands.js";
import {
  sendAgentHostSteerControl, sendAgentHostCancelControl, AGENT_HOST_CONTROL_PROTOCOL,
  foldSteerLiveReceipt, foldInterruptLiveReceipt,
  type AgentHostControlResult, type AgentHostSteerRunControl, type AgentHostCancelControl
} from "../runtime/agentHost.js";
import type { WebInputAnswer } from "./webServer.js";

/**
 * The three decision-3 input-control actions, exactly as the CLI exposes them
 * (`yui task message queue|steer` and `yui task role interrupt`). The Web
 * surface is a local-human ingress; it never carries a caller Role, so its
 * authority is the local user (see {@link assertTaskInputControlAuthority}).
 */
export type WebControlInput =
  | Readonly<{ action: "queue"; body: string; requestId: string;
      to?: string; workItem?: string; reviewRound?: string }>
  | Readonly<{ action: "steer"; body: string; requestId: string; expectedTarget: string;
      to: string; workItem?: string; reviewRound?: string }>
  | Readonly<{ action: "interrupt"; requestId: string; expectedTarget: string;
      role: string; thenMessage?: string }>;

/**
 * The single live Agent Host edge for a resolved steer/interrupt. It is a socket
 * client that needs only `home`; injecting it keeps the surface testable against
 * a fake Host (a real Provider is never a test subject). The default port is the
 * real Host senders — identical to the calls cli.ts performs.
 */
export type WebHostControlPort = Readonly<{
  steer(input: Readonly<{ home: string; scope: string; taskId?: string; roleName: string;
    control: AgentHostSteerRunControl }>): Promise<AgentHostControlResult>;
  cancel(input: Readonly<{ home: string; scope: string; taskId?: string; roleName: string;
    control: AgentHostCancelControl }>): Promise<AgentHostControlResult>;
}>;

const DEFAULT_WEB_HOST_CONTROL: WebHostControlPort = {
  steer: sendAgentHostSteerControl,
  cancel: sendAgentHostCancelControl
};

/** The store-only CLI argv for the shared application-layer primitive
 * (decision-3 §7). The Web surface never re-implements the queue/steer/interrupt
 * decisions; it drives the exact same command the CLI drives. */
function controlArgv(taskId: string, input: WebControlInput): string[] {
  if (input.action === "queue") {
    return ["message", "queue", taskId, input.body, "--request-id", input.requestId,
      ...(input.to === undefined ? [] : ["--to", input.to]),
      ...(input.workItem === undefined ? [] : ["--work-item", input.workItem]),
      ...(input.reviewRound === undefined ? [] : ["--review-round", input.reviewRound])];
  }
  if (input.action === "steer") {
    return ["message", "steer", taskId, input.body, "--request-id", input.requestId,
      "--expected-target", input.expectedTarget, "--to", input.to,
      ...(input.workItem === undefined ? [] : ["--work-item", input.workItem]),
      ...(input.reviewRound === undefined ? [] : ["--review-round", input.reviewRound])];
  }
  return ["role", "interrupt", taskId, input.role, "--expected-target", input.expectedTarget,
    ...(input.thenMessage === undefined ? [] : ["--then-message", input.thenMessage]),
    "--request-id", input.requestId];
}

/** A queue is delivered to the Leader mailbox only when it is unaddressed or
 * addressed to the Leader; an addressed Worker/Reviewer queue goes to the Task
 * mailbox. A steer/interrupt is a live control op, so it only reconciles the
 * Task. This mirrors the mailbox the core command itself enqueues. */
function controlNotifiesLeader(input: WebControlInput): boolean {
  return input.action === "queue" && (input.to === undefined || input.to === "leader");
}

function controlTarget(taskId: string, input: WebControlInput) {
  const roleName = input.action === "interrupt" ? input.role : input.to ?? "leader";
  return { scope: "task" as const, taskId, roleName };
}

/** Installed only by the local-user Web composition root. HTTP authenticates
 * its token before using this port; input never supplies a caller or Role.
 * Managed capability RPC keeps its own Session authentication unchanged.
 */
export function createWebTaskSurface(
  store: TaskStore,
  options: TaskCommandOptions = {},
  observations: readonly ContextObservationProvider[] = [],
  hostControl: WebHostControlPort = DEFAULT_WEB_HOST_CONTROL
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
    /**
     * The decision-3 three-action input-control path for the local-user Web
     * surface. Its store-only phase is the identical shared application-layer
     * primitive the CLI uses (`runTaskCommand`), run inside `webLocalMutation`
     * so a rejected input is provably not-submitted. A ready steer/interrupt
     * returns a live intent; the single Agent Host edge then runs OUTSIDE the
     * transaction exactly as cli.ts performs it — never a fallback, retarget, or
     * fourth action. A committed input whose live edge fails is delivery-unknown,
     * not not-submitted: it throws a plain error so the receipt is "unknown" and
     * the durable Message is retained (decision-3 §1/§3/§5, message-5 gap F).
     */
    control: async (taskId: string, input: WebControlInput) => {
      const execution: TaskCommandExecution = webLocalMutation(store, (tx) =>
        runTaskCommand(controlArgv(taskId, input), tx, commandOptions));
      if (execution.kind === "output") {
        // A queue receipt, or a steer/interrupt that was saved-but-not-delivered
        // or an idempotent replay: fully durable, no live edge, exact disposition.
        notify(taskId, controlNotifiesLeader(input));
        const data = execution.data as {
          message?: { createdAt: string };
          delivery?: { state: string };
          steer?: { state: string };
          interrupt?: { state: string };
        };
        const settlement = data.delivery ?? data.steer ?? data.interrupt;
        return {
          action: input.action, disposition: settlement?.state ?? "saved",
          target: controlTarget(taskId, input),
          ...(data.message === undefined ? {} : { record: data.message, revision: data.message.createdAt }),
          ...(data.delivery === undefined ? {} : { delivery: data.delivery }),
          ...(data.steer === undefined ? {} : { steer: data.steer }),
          ...(data.interrupt === undefined ? {} : { interrupt: data.interrupt })
        };
      }
      // A resolved live control op. Core has persisted the Message (steer) and
      // recorded the one `pending` control attempt; both are already committed.
      const home = options.yuiHome;
      if (home === undefined) {
        throw new Error("Live Agent Host control requires a configured Yui home.");
      }
      if (execution.kind === "input-steer") {
        let control: AgentHostControlResult;
        try {
          control = await hostControl.steer({
            home, scope: "task", taskId: execution.taskId, roleName: execution.roleName,
            control: {
              protocol: AGENT_HOST_CONTROL_PROTOCOL, type: "steer-turn",
              nativeSessionId: execution.target.nativeSessionId,
              nativeTurnId: execution.target.nativeTurnId ?? execution.target.attemptId,
              authority: execution.target.authority,
              run: { attemptId: execution.receiptId, boundedText: execution.text }
            }
          });
        } catch (error) {
          throw new Error(`Steer message ${execution.messageId} is saved but the native steer did not `
            + `complete: ${error instanceof Error ? error.message : String(error)}. The Message is `
            + "retained and its outcome is recorded from the Host; whether the Provider accepted it may "
            + "be delivery-unknown. Re-read the Session before acting; do not reissue the same input "
            + "under a new requestId or a different action.");
        }
        notify(taskId);
        // decision-3 §7 live acceptance: fold the actual Host outcome rather than
        // presume success. `steered` is the only proven delivery; pending is
        // delivery-unknown; rejected/unavailable did not deliver. No fallback.
        const steer = foldSteerLiveReceipt(control);
        return { action: "steer", disposition: steer.state,
          taskId, roleName: execution.roleName, messageId: execution.messageId,
          target: { scope: "task", taskId, roleName: execution.roleName },
          steer };
      }
      let control: AgentHostControlResult;
      if (execution.kind !== "input-interrupt") {
        // The three-action argv only ever yields output/input-steer/input-interrupt;
        // any other intent means the shared command was mis-dispatched, not a
        // control outcome to fold. Fail closed rather than guess.
        throw new Error(`Unexpected control execution kind: ${execution.kind}.`);
      }
      try {
        control = await hostControl.cancel({
          home, scope: "task", taskId: execution.taskId, roleName: execution.roleName,
          control: {
            protocol: AGENT_HOST_CONTROL_PROTOCOL, type: "cancel",
            nativeSessionId: execution.target.nativeSessionId,
            // Native cancel names the exact original execution attempt it stops,
            // never the durable receiptId of this interrupt operation.
            attemptId: execution.target.attemptId,
            authority: execution.target.authority
          }
        });
      } catch (error) {
        throw new Error(`Interrupt of ${execution.taskId}/${execution.roleName} did not complete: `
          + `${error instanceof Error ? error.message : String(error)}. No process was killed; `
          + "re-read the Session before retrying.");
      }
      notify(taskId);
      // The proof is `control.cancellation`, not the bare `cancel-requested`
      // outcome: only a proven stop-request is `interrupted`. A then-handoff, if
      // any, was already claimed durably by Core and is delivered once by the
      // ordinary continuation path — never re-driven from this receipt.
      const interrupt = foldInterruptLiveReceipt(control);
      return { action: "interrupt", disposition: interrupt.state,
        taskId, roleName: execution.roleName,
        target: { scope: "task", taskId, roleName: execution.roleName },
        ...(execution.thenMessageId === undefined ? {} : { thenMessageId: execution.thenMessageId }),
        interrupt };
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
