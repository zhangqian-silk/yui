export const TASK_FORMS_SCRIPT = String.raw`
// Task write forms: the discussion composer, queue / steer / interrupt and
// the title editor. Submission plumbing (requestId, unsent flag, receipts,
// never replaying an unknown outcome) lives in ui/forms submitWrite().
import { h, icon, clear } from "/assets/js/lib/dom.js";
import { fill } from "/assets/js/lib/format.js";
import { button } from "/assets/js/ui/primitives.js";
import { segmented } from "/assets/js/ui/controls.js";
import { field, receiptLine, setReceipt, submitWrite } from "/assets/js/ui/forms.js";

function isOpen(task) {
  return ["active", "draft"].includes(task.status);
}

// --- Discussion composer -----------------------------------------------------
export function messageComposer(task, t, actions) {
  let intent = "discuss";
  const form = h("form.composer");
  const message = h("textarea.composer-input", {
    required: true, maxLength: 8000, rows: 3, placeholder: t("composer.placeholder"),
    "aria-label": t("composer.label")
  });
  const open = isOpen(task);
  const send = h("button.btn.btn-primary.composer-send", { type: "submit", disabled: !open, title: t("composer.sendHint") },
    icon("send"), h("span", null, t("composer.send")));
  const intents = segmented("intent", ["discuss", "record", "develop"].map(function (value) {
    return { value: value, label: t("intent." + value), title: t("intent." + value + ".hint") };
  }), intent, function (value) { intent = value; });
  const receipt = receiptLine(open ? t("receipt.notSubmitted") : t("composer.closed"));
  const facets = h("div.facets");
  form.append(h("div.composer-box", null, message, h("div.composer-bar", null, intents, h("span.spacer"), send)), receipt, facets);
  form.addEventListener("input", function () { form.dataset.unsent = message.value ? "true" : "false"; });
  message.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (send.disabled || !message.value.trim()) return;
    clear(facets);
    // requestId is the submission key: the same key retried returns the
    // original Message and routing, never a second submission.
    submitWrite({
      control: send, receipt: receipt, form: form, t: t,
      send: function (requestId) { return actions.sendMessage(task.id, message.value, requestId, intent); },
      saved: function (result) {
        setReceipt(receipt, t("receipt.saved") + " · " + result.record.id, "ok");
        renderSubmissionFacets(facets, result.submission, t);
        message.value = "";
      },
      rejectedKey: "receipt.notSubmittedBecause", unknownKey: "receipt.unknownMessage", afterWrite: actions.afterWrite
    });
  });
  return form;
}

// Each submission facet is reported on its own line, never collapsed into a
// single "started". A missing facet block is a contract violation and is
// reported as such rather than reinterpreted.
export function renderSubmissionFacets(container, submission, t) {
  clear(container);
  if (!submission) { container.append(h("p.faint.small", null, t("facet.missing"))); return; }
  const rows = [
    ["facet.phase", "phase." + submission.phase, submission.phase],
    ["facet.planning", "planningFacet." + submission.planning, submission.planning],
    ["facet.activation", "activation." + submission.activation, submission.activation],
    ["facet.delivery", "deliveryFacet." + submission.delivery, submission.delivery]
  ];
  container.append(h("dl.kv.kv-compact", null, rows.map(function (row) {
    return [h("dt", null, t(row[0])), h("dd", null, t(row[1], row[2]))];
  })));
  const step = submission.nextStep;
  const text = step ? nextStepText(step, t) : "";
  if (text) container.append(h("p.next-step", { dataset: { nextStep: step.kind } }, icon("flag", "icon-sm"), h("span", null, text)));
}

function nextStepText(step, t) {
  if (step.kind === "activate-manually") return fill(t("next.activateManually"), { task: step.taskId });
  if (step.kind === "start-execution") return fill(t("next.startExecution"), { task: step.taskId });
  if (step.kind === "await-pending-activation") return fill(t("next.awaitActivation"), { ref: step.activationRef });
  if (step.kind === "resolve-failed-activation") return fill(t("next.resolveFailed"), { failure: step.failure, ref: step.activationRef });
  return "";
}

// --- Queue / steer / interrupt ----------------------------------------------
// The same three application-layer actions the CLI drives. Steer and
// interrupt name an exact current Turn; a mismatch is a visible failure
// receipt, never a silent downgrade to a queue.
export function controlForm(task, t, actions, roleNames) {
  let kind = "queue";
  const form = h("form.stack");
  const inputs = controlInputs(task, t, roleNames);
  const fields = controlFields(inputs, t);
  const submit = button(t("control.submit"), { type: "submit", variant: "primary", icon: "send", disabled: !isOpen(task) });
  const receipt = receiptLine(t("receipt.notSubmitted"));
  const apply = function () { applyControlKind(kind, inputs, fields); };
  const actionsSeg = segmented("action", ["queue", "steer", "interrupt"].map(function (value) {
    return { value: value, label: t("control." + value), title: t("control." + value + ".hint") };
  }), kind, function (value) { kind = value; apply(); });
  form.append(h("div.field", null, h("span", null, t("control.action")), actionsSeg),
    h("div.field-row", null, fields.role, fields.workItem), inputs.roles, fields.body, fields.expected, fields.then,
    h("div.form-actions", null, submit), receipt);
  apply();
  form.addEventListener("input", function () { form.dataset.unsent = "true"; });
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (submit.disabled) return;
    submitWrite({
      control: submit, receipt: receipt, form: form, t: t,
      send: function (requestId) { return actions.control(task.id, controlPayload(kind, inputs, requestId)); },
      // The receipt states exactly what settled; none of these states implies
      // the Provider executed the input.
      saved: function (result) { setReceipt(receipt, controlReceipt(result, t), "ok"); },
      rejectedKey: "receipt.notSubmittedBecause", unknownKey: "receipt.unknownControl", afterWrite: actions.afterWrite
    });
  });
  return form;
}

function controlInputs(task, t, roleNames) {
  return {
    role: h("input", { list: "control-roles-" + task.id, placeholder: t("control.rolePlaceholder") }),
    roles: h("datalist", { id: "control-roles-" + task.id }, (roleNames || []).map(function (name) { return h("option", { value: name }); })),
    body: h("textarea", { maxLength: 8000, rows: 3 }),
    expected: h("input.mono", { placeholder: t("control.expectedPlaceholder") }),
    workItem: h("input.mono"),
    then: h("input.mono", { placeholder: t("control.thenPlaceholder") })
  };
}

function controlFields(inputs, t) {
  return {
    role: field(t("control.role"), inputs.role),
    body: field(t("control.message"), inputs.body),
    expected: field(t("control.expectedTurn"), inputs.expected, t("control.expectedHint")),
    workItem: field(t("control.workItem"), inputs.workItem),
    then: field(t("control.then"), inputs.then)
  };
}

function applyControlKind(kind, inputs, fields) {
  fields.body.hidden = kind === "interrupt";
  fields.expected.hidden = kind === "queue";
  fields.then.hidden = kind !== "interrupt";
  fields.workItem.hidden = kind === "interrupt";
  inputs.role.required = kind !== "queue";
  inputs.body.required = kind !== "interrupt";
  inputs.expected.required = kind !== "queue";
}

function controlPayload(kind, inputs, requestId) {
  const payload = { action: kind, requestId: requestId };
  const role = inputs.role.value.trim();
  if (kind === "interrupt") {
    payload.role = role;
    payload.expectedTarget = inputs.expected.value.trim();
    if (inputs.then.value.trim()) payload.thenMessage = inputs.then.value.trim();
    return payload;
  }
  payload.body = inputs.body.value;
  if (kind === "steer") { payload.to = role; payload.expectedTarget = inputs.expected.value.trim(); }
  else if (role) payload.to = role;
  if (inputs.workItem.value.trim()) payload.workItem = inputs.workItem.value.trim();
  return payload;
}

function controlReceipt(result, t) {
  const settled = result.steer || result.interrupt || result.delivery || { state: result.disposition };
  return t("receipt.receipt") + " " + result.action + " · " + settled.state
    + (settled.outcome ? " · " + settled.outcome : "") + (settled.detail ? " · " + settled.detail : "")
    + (result.record ? " · " + result.record.id : "");
}

// --- Title -------------------------------------------------------------------
export function titleForm(task, t, actions) {
  const form = h("form.inline-form");
  const archived = task.status === "archived";
  const input = h("input", { value: task.title, required: true, maxLength: 500, disabled: archived, "aria-label": t("details.title") });
  const save = button(t("actions.save"), { type: "submit", variant: "primary", disabled: archived });
  const receipt = receiptLine(t("receipt.notSubmitted"));
  form.append(h("div.inline-row", null, input, save), receipt);
  form.addEventListener("input", function () { form.dataset.unsent = input.value !== task.title ? "true" : "false"; });
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (save.disabled) return;
    submitWrite({
      control: save, receipt: receipt, form: form, t: t,
      send: function (requestId) { return actions.updateTask(task.id, { title: input.value }, requestId); },
      saved: function (result) {
        setReceipt(receipt, t("receipt.savedRevision") + " " + result.revision, "ok");
        input.value = result.record.title;
      },
      rejectedKey: "receipt.notSavedBecause", unknownKey: "receipt.unknownSave", afterWrite: actions.afterWrite
    });
  });
  return form;
}
`;
