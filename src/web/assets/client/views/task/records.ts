export const TASK_RECORDS_SCRIPT = String.raw`
// Task › Records: what happened — the History timeline, the Task facts with
// the title form, and the Advanced disclosure (Context cursors and provider
// panels, read when it is first opened). Every #detail-* anchor stays
// addressable via ?section=.
import { h, clear } from "/assets/js/lib/dom.js";
import { formatDateTime } from "/assets/js/lib/format.js";
import { button, chip, emptyState, externalLink, jsonBlock, kv, mono, note, safeUrl } from "/assets/js/ui/primitives.js";
import { card, cardDisclosure, disclosure } from "/assets/js/ui/containers.js";
import { label, statusBadge } from "/assets/js/domain/vocab.js";
import { titleForm } from "/assets/js/domain/taskForms.js";
import { historyCard } from "/assets/js/views/task/timeline.js";

export function renderRecords(panel, data, t, locale, ctx) {
  panel.append(historyCard(panel, data, t, locale, ctx));
  panel.append(factsCard(data.task, t, locale, ctx));
  panel.append(advancedCard(data.core, data.task, t, locale, ctx));
}

// --- Task information --------------------------------------------------------
function factsCard(task, t, locale, ctx) {
  const facts = card({ id: "detail-facts", title: t("details.facts"), icon: "info" });
  facts.body.append(kv([
    [t("details.id"), mono(task.id)],
    [t("details.status"), statusBadge(t, "task", "status", task.status)],
    [t("details.priority"), task.priority ? label(t, "priority", task.priority) : null],
    [t("details.tags"), (task.tags || []).length ? h("span.chip-row", null, task.tags.map(function (tag) { return chip(tag); })) : null],
    [t("details.projects"), (task.projectBindings || []).length ? h("span.chip-row", null, task.projectBindings.map(function (b) { return chip(b.projectId); })) : null],
    [t("details.created"), formatDateTime(task.createdAt, locale)],
    [t("details.updated"), formatDateTime(task.updatedAt, locale)],
    [t("details.workspace"), task.cwd ? mono(task.cwd) : null]
  ]));
  facts.body.append(h("div.prose-block", null, h("h4.prose-label", null, t("details.title")), titleForm(task, t, ctx)));
  return facts;
}

// --- Advanced ------------------------------------------------------------------
function advancedCard(core, task, t, locale, ctx) {
  const advanced = cardDisclosure("detail-advanced", t("advanced.title"), "advanced", t("advanced.meta"));
  advanced.body.append(h("h4.sub-head", null, t("details.context")), jsonBlock({
    coreCursor: core.coreCursor, throughCursor: core.throughCursor, count: core.count, collections: core.collections, omitted: core.omitted
  }), note(t("details.contextHelp")));
  const panels = h("div.stack");
  advanced.body.append(h("h4.sub-head", null, t("panels.title")), panels);
  let loading = false;
  let loaded = false;
  advanced.addEventListener("toggle", async function () {
    if (!advanced.open || loading || loaded) return;
    loading = true;
    try { loaded = await readPanels(panels, task, t, locale, ctx); } finally { loading = false; }
  });
  return advanced;
}

// Provider panels are read once, on the first open; a failure may retry.
async function readPanels(holder, task, t, locale, ctx) {
  clear(holder);
  holder.append(h("p.faint", null, t("panels.reading")));
  try {
    const current = await ctx.panels(task.id);
    clear(holder);
    holder.append(h("p.faint.small", null, t("panels.observed") + " " + formatDateTime(current.observedAt, locale)));
    if (!current.panels.length) holder.append(emptyState(t("panels.none")));
    current.panels.forEach(function (item) { holder.append(panelCard(item, task, t, ctx)); });
    return true;
  } catch (error) {
    clear(holder);
    holder.append(note(t("panels.unavailable") + " " + error.message, "bad"));
    return false;
  }
}

function panelCard(item, task, t, ctx) {
  const panel = item.panel;
  const element = h("article.record", null,
    h("header.record-head", null, h("strong", null, panel.title), h("span.spacer"), h("span.faint.small", null, item.capability + " · " + item.provider.id)));
  if (item.unavailable) { element.append(note(item.unavailable, "warn")); return element; }
  if (panel.kind === "text") element.append(h("p.small", null, panel.text));
  else if (panel.kind === "link") {
    const href = safeUrl(panel.href);
    if (href) element.append(externalLink(href, panel.title));
  } else if (panel.kind === "data" && panel.renderer === "json") element.append(...dataPanel(item, task, t, ctx));
  return element;
}

// A data panel is read on request with the user's JSON input.
function dataPanel(item, task, t, ctx) {
  const input = h("textarea.mono", { rows: 3 });
  input.value = JSON.stringify({ taskId: task.id });
  const schema = disclosure(t("panels.schema"), null);
  schema.body.append(jsonBlock(item.inputSchema));
  const output = h("pre.code-block");
  output.hidden = true;
  const read = button(t("panels.read"), { icon: "eye", variant: "ghost" });
  read.addEventListener("click", async function () {
    if (read.disabled) return;
    read.disabled = true;
    output.hidden = false;
    try {
      const result = await ctx.readPanel(task.id, {
        capability: item.capability, contractVersion: item.contractVersion, provider: item.provider
      }, JSON.parse(input.value));
      output.textContent = JSON.stringify(result, null, 2);
    } catch (error) { output.textContent = t("panels.unavailable") + " " + error.message; }
    finally { read.disabled = false; }
  });
  return [h("label.field", null, h("span", null, t("panels.input")), input), schema, h("div.form-actions", null, read), output];
}
`;
