export const RECORDS_SCRIPT = String.raw`
// Context record access. Every business fact keeps its Context reference; an
// expanded value is a current read, never a mutation of the snapshot.
import { h, icon } from "/assets/js/dom.js";
import { richText, mono, button, note } from "/assets/js/components.js";

export function entriesOf(core, store) {
  return core.records.filter(function (entry) { return entry.ref.store === store; });
}

export function valuesOf(core, store) {
  return entriesOf(core, store).filter(function (entry) { return !entry.omitted; }).map(function (entry) { return entry.value; });
}

// A generic, honest card for any record: omitted values say so and can be
// read by reference; reading never acknowledges or accepts anything.
export function recordCard(entry, taskId, t, actions, options) {
  const opts = options || {};
  const element = h("article.record" + (opts.compact ? ".is-compact" : ""));
  element.append(h("header.record-head", null,
    h("span.record-store", null, t("store." + entry.ref.store, entry.ref.store)),
    mono(entry.ref.refId),
    h("span.spacer"),
    h("span.faint.small", { title: t("record.revision") }, String(entry.ref.revision).slice(0, 24))));
  if (!entry.omitted && entry.value) {
    const value = entry.value;
    const text = value.content || value.summary || value.body || value.objective || value.title || value.leaderSummary;
    if (text) element.append(richText(null, text, t, { threshold: 360 }));
    if (entry.ref.store === "task-decision" && value.rationale) element.append(richText(t("record.rationale"), value.rationale, t, { muted: true }));
    const facts = [value.status, value.roleName].filter(Boolean);
    if (facts.length) element.append(h("p.faint.small", null, facts.join(" · ")));
    if (entry.ref.store === "job") element.append(note(t("job." + value.status + ".note", t("job.terminal.note")), value.status === "unknown-needs-attention" ? "warn" : ""));
  } else {
    element.append(h("p.faint", null, entry.summary || t("record.omitted")));
  }
  element.append(recordReader(entry, taskId, t, actions));
  return element;
}

// Shared source access for cards, history and discussion, including records
// whose compact value is present but does not display every durable field.
export function recordReader(entry, taskId, t, actions) {
  const element = h("div.stack");
  const expand = button(t("record.read"), { icon: "eye", variant: "link" });
  expand.addEventListener("click", async function () {
    expand.disabled = true;
    element.dataset.reading = "true";
    try {
      const result = await actions.inspect(taskId, entry.ref);
      if (result.result && result.result.output) element.append(richText(t("record.output"), result.result.output, t));
      if (result.result && result.result.diagnostic) element.append(richText(t("record.diagnostic"), result.result.diagnostic, t));
      element.append(h("pre.code-block", null, JSON.stringify(result.value, null, 2)));
      if (result.execution) element.append(h("pre.code-block", null, JSON.stringify(result.execution, null, 2)));
      expand.remove();
    } catch {
      expand.disabled = false;
      expand.replaceChildren(icon("refresh"), h("span", null, t("record.changed")));
    } finally { element.dataset.reading = "false"; }
  });
  element.append(h("div.record-actions", null, expand));
  return element;
}
`;
