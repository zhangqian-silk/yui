export const TASK_ACTIONS_SCRIPT = String.raw`
// Next step: one compact action bar. A short prompt on the left, the actions
// on the right (secondary first, primary last), and a single status line
// below that appears only when it carries a condition, a block or a receipt.
import { h } from "/assets/js/lib/dom.js";
import { button } from "/assets/js/ui/primitives.js";
import { card } from "/assets/js/ui/containers.js";
import { receiptLine, setReceipt, submitWrite } from "/assets/js/ui/forms.js";

export function taskActions(task, t, ctx) {
  const action = task.status === "draft" ? "activate"
    : ["completed", "cancelled"].includes(task.status) ? "archive" : null;
  const element = card({ className: "next-card" });
  const continueButton = button(t("workbench.continue"), {
    icon: "chat", variant: action ? "" : "primary", onClick: function () { ctx.openConversation(); }
  });
  const buttons = h("div.next-actions", null, continueButton);
  const lead = h("div.next-lead", null,
    h("p.next-kicker", null, t("workbench.next")),
    h("p.next-prompt", null, t("workbench.prompt." + (action || "running"))));
  element.body.append(h("div.next-row", null, lead, buttons));
  if (!action) return element;

  const activation = task.activationRequest;
  const blocked = action === "activate" && (task.executionGate.state !== "enabled"
    || activation && ["pending", "failed"].includes(activation.disposition));
  // Idle receipts stay empty (hidden); only real state is shown.
  const receipt = receiptLine(blocked ? (activation && activation.outcome || t("workbench.activationBlocked")) : "", blocked ? "warn" : "");
  const control = button(t("workbench." + action), {
    icon: action === "activate" ? "play" : "archive", variant: "primary", disabled: !!blocked,
    title: t("workbench." + action + "Hint"),
    onClick: function () {
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
    }
  });
  buttons.append(control);
  element.body.append(h("div.next-foot", null, h("p.next-hint", null, t("workbench." + action + "Hint")), receipt));
  return element;
}
`;
