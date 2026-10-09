export const GLOBAL_INPUT_SCRIPT = String.raw`
// The global Role input dialog: queue / steer / interrupt for a Role outside
// any Task, with an explicit read of its current Turn. The receipt is shown
// verbatim; an unknown delivery keeps the submit button disabled.
import { setReceipt, submitWrite } from "/assets/js/ui/forms.js";

const UNKNOWN_STATES = ["pending", "delivery-unknown", "steer-unknown", "interrupt-unknown"];

export function bindGlobalInput(options) {
  const t = options.t;
  const api = options.api;
  const $ = function (selector) { return document.querySelector(selector); };
  const el = {
    dialog: $("#global-input-dialog"), form: $("#global-input-form"), role: $("#global-input-role"),
    action: $("#global-input-action"), body: $("#global-input-body"), target: $("#global-input-target"),
    then: $("#global-input-then"), submit: $("#global-input-submit"), receipt: $("#global-input-receipt"),
    state: $("#global-input-state")
  };
  $("#global-input-open").addEventListener("click", function () { el.dialog.showModal(); });
  $("#global-input-close").addEventListener("click", function () { el.dialog.close(); });
  el.action.addEventListener("change", function () {
    $("#global-input-body-label").hidden = el.action.value === "interrupt";
    $("#global-input-target-label").hidden = el.action.value === "queue";
    $("#global-input-then-label").hidden = el.action.value !== "interrupt";
    el.body.required = el.action.value !== "interrupt";
    el.target.required = el.action.value !== "queue";
  });
  $("#global-input-inspect").addEventListener("click", function () { inspectRole(el, api); });
  el.form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (el.submit.disabled) return;
    submitWrite({
      control: el.submit, receipt: el.receipt, t: t, unknownKey: "receipt.unknownControl",
      send: function (requestId) { return api.globalControl(el.role.value.trim(), globalPayload(el, requestId)); },
      saved: function (receipt) { return showReceipt(el, receipt); }
    });
  });
  return { dialog: el.dialog };
}

async function inspectRole(el, api) {
  el.state.hidden = false;
  try {
    const facts = await api.globalState(el.role.value.trim());
    el.state.textContent = JSON.stringify(facts, null, 2);
    el.target.value = (facts.turn && (facts.turn.nativeTurnId || facts.turn.attemptId)) || "";
  } catch (error) { el.state.textContent = error.message; }
}

function globalPayload(el, requestId) {
  const action = el.action.value;
  const input = { action: action, requestId: requestId };
  if (action !== "interrupt") input.body = el.body.value;
  if (action !== "queue") input.expectedTarget = el.target.value.trim();
  if (action === "interrupt" && el.then.value.trim()) input.thenMessage = el.then.value.trim();
  return input;
}

// Returns true while the outcome is unknown, which keeps the submit disabled.
function showReceipt(el, receipt) {
  const status = receipt.steer || receipt.interrupt || receipt.delivery || {};
  setReceipt(el.receipt, JSON.stringify(receipt), "ok");
  const unknown = UNKNOWN_STATES.includes(status.state) || status.code === "DELIVERY_UNKNOWN";
  if (!unknown && !status.code) el.body.value = "";
  return unknown;
}
`;
