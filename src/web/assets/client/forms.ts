export const FORMS_SCRIPT = String.raw`
// Write forms. Each submission carries a fresh requestId, marks itself unsent
// until a receipt settles, and reports an unknown outcome as unknown: nothing
// here ever replays a write automatically.
import { h, icon, clear } from "/assets/js/dom.js";
import { button } from "/assets/js/components.js";

function receiptLine(text, state) {
  const line = h("p.receipt", { role: "status" }, text);
  if (state) line.dataset.state = state;
  return line;
}
function setReceipt(line, text, state) {
  line.textContent = text;
  line.dataset.state = state || "";
}

function segmented(name, options, value, onChange) {
  const group = h("div.seg.seg-sm", { role: "radiogroup" });
  options.forEach(function (option) {
    const item = h("button.seg-btn", {
      type: "button", role: "radio", title: option.title || null,
      "aria-checked": String(option.value === value),
      dataset: { value: option.value },
      onclick: function () {
        group.querySelectorAll(".seg-btn").forEach(function (other) { other.setAttribute("aria-checked", String(other === item)); });
        onChange(option.value);
      }
    }, option.label);
    group.append(item);
  });
  group.dataset.name = name;
  return group;
}

export function messageComposer(task, t, actions) {
  let intent = "discuss";
  const form = h("form.composer");
  const message = h("textarea.composer-input", {
    required: true, maxLength: 8000, rows: 3, placeholder: t("composer.placeholder"),
    "aria-label": t("composer.label")
  });
  const open = ["active", "draft"].includes(task.status);
  const send = h("button.btn.btn-primary.composer-send", { type: "submit", disabled: !open, title: t("composer.sendHint") },
    icon("send"), h("span", null, t("composer.send")));
  const intents = segmented("intent", [
    { value: "discuss", label: t("intent.discuss"), title: t("intent.discuss.hint") },
    { value: "record", label: t("intent.record"), title: t("intent.record.hint") },
    { value: "develop", label: t("intent.develop"), title: t("intent.develop.hint") }
  ], intent, function (value) { intent = value; });
  const receipt = receiptLine(open ? t("receipt.notSubmitted") : t("composer.closed"));
  const facets = h("div.facets");
  form.append(h("div.composer-box", null, message, h("div.composer-bar", null, intents, h("span.spacer"), send)), receipt, facets);
  form.addEventListener("input", function () { form.dataset.unsent = message.value ? "true" : "false"; });
  message.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (send.disabled || !message.value.trim()) return;
    send.disabled = true;
    form.dataset.unsent = "true";
    const requestId = crypto.randomUUID();
    clear(facets);
    setReceipt(receipt, t("receipt.waiting") + " · " + requestId, "pending");
    try {
      // requestId is the submission key: the same key retried returns the
      // original Message and routing, never a second submission.
      const result = await actions.sendMessage(task.id, message.value, requestId, intent);
      setReceipt(receipt, t("receipt.saved") + " · " + result.record.id, "ok");
      renderSubmissionFacets(facets, result.submission, t);
      message.value = "";
      form.dataset.unsent = "false";
      send.disabled = false;
      if (actions.afterWrite) actions.afterWrite();
    } catch (error) {
      if (error.disposition === "not-submitted") {
        setReceipt(receipt, t("receipt.notSubmittedBecause") + " " + error.message, "bad");
        send.disabled = false;
        return;
      }
      setReceipt(receipt, t("receipt.unknownMessage") + " · " + requestId, "warn");
    }
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
  if (!step) return;
  const text = step.kind === "activate-manually" ? t("next.activateManually").replace("{task}", step.taskId)
    : step.kind === "start-execution" ? t("next.startExecution").replace("{task}", step.taskId)
    : step.kind === "await-pending-activation" ? t("next.awaitActivation").replace("{ref}", step.activationRef)
    : step.kind === "resolve-failed-activation" ? t("next.resolveFailed").replace("{failure}", step.failure).replace("{ref}", step.activationRef)
    : "";
  if (text) container.append(h("p.next-step", { dataset: { nextStep: step.kind } }, icon("flag", "icon-sm"), h("span", null, text)));
}

// Queue / steer / interrupt — the same three application-layer actions the
// CLI drives. Steer and interrupt name an exact current Turn; a mismatch is a
// visible failure receipt, never a silent downgrade to a queue.
export function controlForm(task, t, actions, roleNames) {
  let kind = "queue";
  const form = h("form.stack");
  const role = h("input", { list: "control-roles-" + task.id, placeholder: t("control.rolePlaceholder") });
  const roles = h("datalist", { id: "control-roles-" + task.id }, (roleNames || []).map(function (name) { return h("option", { value: name }); }));
  const body = h("textarea", { maxLength: 8000, rows: 3 });
  const expected = h("input.mono", { placeholder: t("control.expectedPlaceholder") });
  const workItem = h("input.mono");
  const then = h("input.mono", { placeholder: t("control.thenPlaceholder") });
  const field = function (text, control, hint) {
    return h("label.field", null, h("span", null, text), control, hint ? h("small.faint", null, hint) : null);
  };
  const roleField = field(t("control.role"), role);
  const bodyField = field(t("control.message"), body);
  const expectedField = field(t("control.expectedTurn"), expected, t("control.expectedHint"));
  const workItemField = field(t("control.workItem"), workItem);
  const thenField = field(t("control.then"), then);
  const open = ["active", "draft"].includes(task.status);
  const submit = button(t("control.submit"), { type: "submit", variant: "primary", icon: "send", disabled: !open });
  const receipt = receiptLine(t("receipt.notSubmitted"));
  function apply() {
    bodyField.hidden = kind === "interrupt";
    expectedField.hidden = kind === "queue";
    thenField.hidden = kind !== "interrupt";
    workItemField.hidden = kind === "interrupt";
    role.required = kind !== "queue";
    body.required = kind !== "interrupt";
    expected.required = kind !== "queue";
  }
  const actionsSeg = segmented("action", [
    { value: "queue", label: t("control.queue"), title: t("control.queue.hint") },
    { value: "steer", label: t("control.steer"), title: t("control.steer.hint") },
    { value: "interrupt", label: t("control.interrupt"), title: t("control.interrupt.hint") }
  ], kind, function (value) { kind = value; apply(); });
  form.append(h("div.field", null, h("span", null, t("control.action")), actionsSeg),
    h("div.field-row", null, roleField, workItemField), roles, bodyField, expectedField, thenField,
    h("div.form-actions", null, submit), receipt);
  apply();
  form.addEventListener("input", function () { form.dataset.unsent = "true"; });
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    form.dataset.unsent = "true";
    const requestId = crypto.randomUUID();
    const payload = { action: kind, requestId };
    if (kind === "interrupt") {
      payload.role = role.value.trim();
      payload.expectedTarget = expected.value.trim();
      if (then.value.trim()) payload.thenMessage = then.value.trim();
    } else {
      payload.body = body.value;
      if (kind === "steer") { payload.to = role.value.trim(); payload.expectedTarget = expected.value.trim(); }
      else if (role.value.trim()) payload.to = role.value.trim();
      if (workItem.value.trim()) payload.workItem = workItem.value.trim();
    }
    setReceipt(receipt, t("receipt.waiting") + " · " + requestId, "pending");
    try {
      // The receipt states exactly what settled; none of these states implies
      // the Provider executed the input.
      const result = await actions.control(task.id, payload);
      const settled = result.steer || result.interrupt || result.delivery || { state: result.disposition };
      setReceipt(receipt, t("receipt.receipt") + " " + result.action + " · " + settled.state
        + (settled.outcome ? " · " + settled.outcome : "") + (settled.detail ? " · " + settled.detail : "")
        + (result.record ? " · " + result.record.id : ""), "ok");
      form.dataset.unsent = "false";
      submit.disabled = false;
      if (actions.afterWrite) actions.afterWrite();
    } catch (error) {
      if (error.disposition === "not-submitted") {
        setReceipt(receipt, t("receipt.notSubmittedBecause") + " " + error.message, "bad");
        submit.disabled = false;
        return;
      }
      setReceipt(receipt, t("receipt.unknownControl") + " · " + requestId, "warn");
    }
  });
  return form;
}

export function titleForm(task, t, actions) {
  const form = h("form.inline-form");
  const archived = task.status === "archived";
  const input = h("input", { value: task.title, required: true, maxLength: 500, disabled: archived, "aria-label": t("details.title") });
  const save = button(t("actions.save"), { type: "submit", variant: "primary", disabled: archived });
  const receipt = receiptLine(t("receipt.notSubmitted"));
  form.append(h("div.inline-row", null, input, save), receipt);
  form.addEventListener("input", function () { form.dataset.unsent = input.value !== task.title ? "true" : "false"; });
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    form.dataset.unsent = "true";
    const requestId = crypto.randomUUID();
    setReceipt(receipt, t("receipt.waiting") + " · " + requestId, "pending");
    try {
      const result = await actions.updateTask(task.id, { title: input.value }, requestId);
      setReceipt(receipt, t("receipt.savedRevision") + " " + result.revision, "ok");
      input.value = result.record.title;
      form.dataset.unsent = "false";
      save.disabled = false;
      if (actions.afterWrite) actions.afterWrite();
    } catch (error) {
      if (error.disposition === "not-submitted") {
        setReceipt(receipt, t("receipt.notSavedBecause") + " " + error.message, "bad");
        save.disabled = false;
        return;
      }
      // A lost response must never automatically replay a write.
      setReceipt(receipt, t("receipt.unknownSave") + " · " + requestId, "warn");
    }
  });
  return form;
}
`;
