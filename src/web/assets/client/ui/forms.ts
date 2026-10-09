export const FORMS_SCRIPT = String.raw`
// Write plumbing shared by every form. A submission carries a fresh
// requestId, marks its form unsent until a receipt settles, and reports an
// unknown outcome as unknown: nothing here ever replays a write.
import { h } from "/assets/js/lib/dom.js";

export function field(text, control, hint) {
  return h("label.field", null, h("span", null, text), control, hint ? h("small.faint", null, hint) : null);
}

export function receiptLine(text, state) {
  const line = h("p.receipt", { role: "status" }, text);
  if (state) line.dataset.state = state;
  return line;
}

export function setReceipt(line, text, state) {
  line.textContent = text;
  line.dataset.state = state || "";
}

// options: control (disabled while in flight), receipt, t, send(requestId),
// saved(result) → true to keep the control blocked, rejectedKey (prefix of
// a not-submitted error), unknownKey, and the optional form and afterWrite.
// A rejected submission re-enables the control; an unknown one keeps it
// disabled so the same write cannot be sent twice.
export async function submitWrite(options) {
  const t = options.t;
  options.control.disabled = true;
  if (options.form) options.form.dataset.unsent = "true";
  const requestId = crypto.randomUUID();
  setReceipt(options.receipt, t("receipt.waiting") + " · " + requestId, "pending");
  try {
    const result = await options.send(requestId);
    const blocked = !!options.saved(result);
    if (options.form) options.form.dataset.unsent = "false";
    options.control.disabled = blocked;
    if (options.afterWrite) options.afterWrite();
  } catch (error) {
    if (error.disposition === "not-submitted") {
      setReceipt(options.receipt, (options.rejectedKey ? t(options.rejectedKey) + " " : "") + error.message, "bad");
      options.control.disabled = false;
      return;
    }
    setReceipt(options.receipt, t(options.unknownKey) + " · " + requestId + " · " + error.message, "warn");
  }
}
`;
