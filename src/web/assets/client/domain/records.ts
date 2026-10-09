export const RECORDS_SCRIPT = String.raw`
// Record rows and cards. A row keeps its Context reference: an omitted value
// is shown as the honest summary until its exact read arrives, and reading
// never acknowledges or accepts anything.
import { h, icon } from "/assets/js/lib/dom.js";
import { button, jsonBlock, mono, note } from "/assets/js/ui/primitives.js";
import { rawDisclosure } from "/assets/js/ui/containers.js";
import { richText } from "/assets/js/ui/text.js";
import { cachedExact, readExact, summaryFields } from "/assets/js/domain/context.js";

// A row drawn from its exact value: synchronously when cached, otherwise the
// summary card until the read returns and replaces it in place.
export function exactRow(entry, taskId, t, actions, cache, render) {
  if (!entry.omitted) return render(entry.value, null);
  const hit = cachedExact(cache, entry);
  if (hit) return render(hit.value, hit);
  const placeholder = recordCard(entry, taskId, t, actions);
  placeholder.dataset.reading = "true";
  readExact(entry, taskId, actions, cache).then(function (result) {
    if (placeholder.isConnected) placeholder.replaceWith(render(result.value, result));
  }, function () { placeholder.dataset.reading = "false"; });
  return placeholder;
}

// A closed row drawn from a list summary; its exact value is read on first
// open. Open rows are remembered in view state and reopen after a redraw.
export function lazyRow(item, taskId, t, actions, options) {
  const opts = options || {};
  const key = item.ref.store + ":" + item.ref.refId;
  const element = h("details.lazy-row");
  if (item.status) element.dataset.status = item.status;
  const body = h("div.lazy-body");
  element.append(h("summary.lazy-head", null, icon("chevron", "disclosure-chevron"), opts.head), body);
  let state = "idle";
  function load() {
    if (state !== "idle") return;
    state = "reading";
    element.dataset.reading = "true";
    body.replaceChildren(h("p.faint.small", null, t("record.reading")));
    readExact({ ref: item.ref }, taskId, actions, opts.cache || {}).then(function (result) {
      state = "done";
      body.replaceChildren();
      body.append(h("div.lazy-content", null, opts.render ? opts.render(result.value, result) : null), rawDisclosure(t, result.value));
    }, function (error) {
      state = "idle";
      body.replaceChildren(note(t("record.changed") + " · " + error.message, "bad"));
    }).then(function () { element.dataset.reading = "false"; });
  }
  element.addEventListener("toggle", function () {
    if (opts.openRows) { if (element.open) opts.openRows[key] = true; else delete opts.openRows[key]; }
    if (element.open) load();
  });
  if (opts.openRows && opts.openRows[key]) element.open = true;
  return element;
}

// A generic card for any record: omitted values say so and can be read by
// reference.
export function recordCard(entry, taskId, t, actions, options) {
  const opts = options || {};
  const element = h("article.record" + (opts.compact ? ".is-compact" : ""));
  element.append(h("header.record-head", null,
    h("span.record-store", null, t("store." + entry.ref.store, entry.ref.store)),
    mono(entry.ref.refId),
    h("span.spacer"),
    h("span.faint.small", { title: t("record.revision") }, String(entry.ref.revision).slice(0, 24))));
  element.append.apply(element, !entry.omitted && entry.value ? valueLines(entry, t) : summaryLines(entry, t));
  element.append(recordReader(entry, taskId, t, actions));
  return element;
}

function valueLines(entry, t) {
  const value = entry.value;
  const lines = [];
  const text = value.content || value.summary || value.body || value.objective || value.title || value.leaderSummary;
  if (text) lines.push(richText(null, text, t, { threshold: 360 }));
  if (entry.ref.store === "task-decision" && value.rationale) lines.push(richText(t("record.rationale"), value.rationale, t, { muted: true }));
  const facts = [value.status, value.roleName].filter(Boolean);
  if (facts.length) lines.push(h("p.faint.small", null, facts.join(" · ")));
  if (entry.ref.store === "job") {
    lines.push(note(t("job." + value.status + ".note", t("job.terminal.note")), value.status === "unknown-needs-attention" ? "warn" : ""));
  }
  return lines;
}

function summaryLines(entry, t) {
  const fields = summaryFields(entry.summary);
  const lead = fields.title || fields.question || fields.objective;
  const text = fields.summary || fields.body || (lead === fields.objective ? null : fields.objective);
  const lines = [];
  if (lead) lines.push(h("p.record-lead", null, lead));
  if (text) lines.push(h("p.faint", null, text));
  if (!lead && !text) lines.push(h("p.faint", null, entry.summary || t("record.omitted")));
  return lines;
}

// Shared source access for cards, history and discussion, including records
// whose compact value is present but does not display every durable field.
// With a renderer, the exact value is drawn richly and the raw record stays
// available behind a disclosure.
export function recordReader(entry, taskId, t, actions, render) {
  const element = h("div.stack");
  const expand = button(t("record.read"), { icon: "eye", variant: "link" });
  expand.addEventListener("click", async function () {
    expand.disabled = true;
    element.dataset.reading = "true";
    try {
      const result = await actions.inspect(taskId, entry.ref);
      const rich = render ? render(result.value, result) : null;
      if (rich) element.append(rich, rawDisclosure(t, result.value));
      else {
        if (result.result && result.result.output) element.append(richText(t("record.output"), result.result.output, t));
        if (result.result && result.result.diagnostic) element.append(richText(t("record.diagnostic"), result.result.diagnostic, t));
        element.append(jsonBlock(result.value));
        if (result.execution) element.append(jsonBlock(result.execution));
      }
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
