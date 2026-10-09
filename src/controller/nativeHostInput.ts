import type { TaskStore } from "../storage/taskStore.js";
import { applyTaskInputControl } from "../commands/taskCommands.js";
import { applyGlobalInputControl } from "../commands/globalRoleCommands.js";

/** The Host terminal is a human ingress, like the authenticated local Web
 * surface. Fence that ingress before reusing the existing Message/control
 * transaction; the Host performs the one Provider write after this returns. */
export function prepareNativeHostSteer(store: TaskStore, input: Readonly<{
  taskId?: string; roleName: string; agentId: string; nativeSessionId: string;
  nativeTurnId: string; attemptId: string; authorityEpoch: number;
  authorityOwner: "controller" | "human"; holderId: string; boundedText: string; now: Date;
}>): { attemptId: string; boundedText: string } {
  return store.transaction(tx => {
    const set = input.taskId === undefined ? tx.getGlobalRoleSessionSet(input.roleName)
      : tx.getTaskRoleSessionSet(input.taskId, input.roleName);
    const session = set?.sessions[input.agentId], binding = set?.providerBinding;
    if (!session || session.status !== "active" || session.adapterId !== "codex"
      || set?.activeAgentId !== input.agentId || session.nativeSessionId !== input.nativeSessionId
      || binding?.run?.status !== "accepted" || binding.run.nativeTurnId !== input.nativeTurnId
      || binding.authority.owner !== input.authorityOwner || binding.authority.epoch !== input.authorityEpoch
      || binding.authority.holderId !== input.holderId
      || (input.taskId !== undefined && input.roleName !== "leader")) {
      throw new Error("Native steer carries a stale or unsupported Session/Turn/writer fence.");
    }
    if (!input.boundedText.trim() || input.boundedText.includes("\0") || Buffer.byteLength(input.boundedText) > 12000) {
      throw new Error("Native steer exceeds its text bound.");
    }
    const control = { action: "steer" as const, body: input.boundedText, to: input.roleName,
      requestId: input.attemptId, expectedTarget: input.nativeTurnId, expectedSessionId: input.nativeSessionId };
    if (input.taskId === undefined) {
      applyGlobalInputControl(input.roleName, control, tx, { env: {} });
    } else {
      applyTaskInputControl(input.taskId, { ...control, to: "leader" }, tx,
        { environment: {}, now: () => input.now });
    }
    const messages = input.taskId === undefined ? tx.listGlobalRoleMessages(input.roleName) : tx.listMessages(input.taskId);
    const message = messages.find(message => message.inputControl?.requestId === input.attemptId);
    if (message?.control?.outcome !== "pending") {
      throw new Error("Native steer is already settled or unconfirmed; do not resubmit.");
    }
    return { attemptId: message.control.receiptId, boundedText: input.boundedText };
  });
}
