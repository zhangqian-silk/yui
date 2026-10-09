export const TASK_ACTIONS_SCRIPT = String.raw`
import { h } from "/assets/js/lib/dom.js";
import { button, note } from "/assets/js/ui/primitives.js";
import { card } from "/assets/js/ui/containers.js";
import { receiptLine, setReceipt, submitWrite } from "/assets/js/ui/forms.js";

export function taskActions(task, t, ctx) {
  const element = card({ title: t("workbench.next"), icon: "chat" });
  element.body.append(button(t("workbench.continue"), { variant: "primary", onClick: function () { ctx.openConversation(); } }));
  const action = task.status === "draft" ? "activate"
    : ["completed", "cancelled"].includes(task.status) ? "archive" : null;
  if (!action) return element;
  const activation = task.activationRequest;
  const blocked = action === "activate" && (task.executionGate.state !== "enabled"
    || activation && ["pending", "failed"].includes(activation.disposition));
  const receipt = receiptLine(blocked ? (activation && activation.outcome || t("workbench.activationBlocked")) : t("receipt.notSubmitted"));
  const control = button(t("workbench." + action), { disabled: !!blocked, onClick: function () {
    if (!window.confirm(t("workbench." + action + "Confirm"))) return;
    submitWrite({
      control: control, receipt: receipt, form: element.body, t: t,
      send: function (requestId) { return ctx.taskAction(task.id, action, requestId); },
      saved: function (value) {
        const result = value.result;
        const text = action === "activate" ? result.operationRef + " · " + result.request.disposition
          : result.task.id + " · " + result.task.status;
        setReceipt(receipt, text, "ok");
        return true;
      },
      rejectedKey: "receipt.notSubmittedBecause", unknownKey: "workbench.unknown",
      afterWrite: ctx.afterWrite
    });
  } });
  element.body.append(control, note(t("workbench." + action + "Hint")), receipt);
  return element;
}
`;
