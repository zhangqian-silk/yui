export const SECTIONS_SCRIPT = String.raw`
// Task sections behind the Work, Execution, History and Details tabs.
import { h, icon, clear } from "/assets/js/dom.js";
import { formatDateTime } from "/assets/js/format.js";
import {
  sectionTitle, card, disclosure, emptyState, note, button, statusBadge, label, tone, dot, chip, mono,
  kv, richText, pagedList, workItemCard, runCard, reviewCard, roleCard, timeTag, observabilityMetricCard
} from "/assets/js/components.js";
import { entriesOf, valuesOf, recordCard, recordReader } from "/assets/js/records.js";
import { renderEvidence } from "/assets/js/evidence.js";
import { controlForm, titleForm } from "/assets/js/forms.js";

function omittedNote(core, t) {
  return core.omitted.records ? t("records.notIncluded") : t("records.none");
}

// --- Work -------------------------------------------------------------------------
export function renderWork(panel, data, t, locale, ctx) {
  const core = data.core;
  const items = entriesOf(core, "work-item");
  const titles = {};
  valuesOf(core, "work-item").forEach(function (item) { titles[item.id] = item.title; });
  const rank = function (entry) { return entry.omitted ? 1 : entry.value.status === "open" ? 0 : 2; };
  const sorted = items.slice().sort(function (a, b) {
    return rank(a) - rank(b) || Date.parse((b.value && b.value.updatedAt) || 0) - Date.parse((a.value && a.value.updatedAt) || 0);
  });
  const work = h("section.section", { id: "detail-work" }, sectionTitle(t("work.title"), items.length));
  if (!sorted.length) work.append(emptyState(omittedNote(core, t), "layers"));
  const list = h("div.stack");
  sorted.forEach(function (entry) {
    list.append(entry.omitted ? recordCard(entry, data.task.id, t, ctx) : workItemCard(entry.value, t, locale, titles));
  });
  work.append(list);
  panel.append(work);

  const results = h("section.section", { id: "detail-results" }, sectionTitle(t("evidence.title")));
  const resultsBody = h("div.card-grid.card-grid-1");
  renderEvidence(resultsBody, data, t, locale, ctx);
  results.append(resultsBody);
  panel.append(results);

  const reviews = entriesOf(core, "review-round");
  const reviewSection = h("section.section", { id: "detail-reviews" }, sectionTitle(t("reviews.title"), reviews.length));
  if (!reviews.length) reviewSection.append(emptyState(omittedNote(core, t)));
  else {
    reviewSection.append(note(t("reviews.hint")));
    const reviewList = h("div.stack");
    reviews.forEach(function (entry) {
      reviewList.append(entry.omitted ? recordCard(entry, data.task.id, t, ctx) : reviewCard(entry.value, t, locale));
    });
    reviewSection.append(reviewList);
  }
  panel.append(reviewSection);
}

// --- Execution --------------------------------------------------------------------
export function renderExecution(panel, data, t, locale, ctx) {
  const core = data.core;
  const task = data.task;
  const runtimeRoles = (data.runtime && data.runtime.roles) || [];
  const runs = valuesOf(core, "run");

  const roleEntries = entriesOf(core, "role");
  const roles = h("section.section", { id: "detail-roles" }, sectionTitle(t("roles.title"), roleEntries.length));
  const roleGrid = h("div.role-grid");
  roleEntries.forEach(function (entry) {
    if (entry.omitted) { roleGrid.append(recordCard(entry, task.id, t, ctx)); return; }
    const role = entry.value;
    const active = runs.find(function (run) { return run.roleName === role.name && run.status === "active"; });
    const runtimeRole = runtimeRoles.find(function (item) { return item.name === role.name; });
    const element = roleCard(role, t, locale, {
      runtimeRole: runtimeRole,
      retry: entry.providerRetry,
      launchDrift: active && active.effective && active.effective.sourceDesiredRevision !== role.launchRevision,
      onOpen: task.status === "archived" ? null : ctx.openSession
    });
    const statusSlot = h("span", { dataset: { roleStatus: role.name } });
    element.querySelector(".role-head").append(statusSlot);
    if (!active) element.append(h("p.faint.small", null, t("roles.noActiveRun")));
    roleGrid.append(element);
  });
  if (!roleEntries.length) roleGrid.append(emptyState(omittedNote(core, t)));
  roles.append(roleGrid);
  panel.append(roles);

  const redirect = disclosure(t("control.title"), "control", { className: "card-disclosure", meta: t("control.meta") });
  redirect.body.append(note(t("control.help")), controlForm(task, t, ctx, roleEntries.map(function (entry) { return entry.ref.refId; })));
  panel.append(h("section.section", { id: "detail-control" }, redirect));

  const runEntries = entriesOf(core, "run");
  const runSection = h("section.section", { id: "detail-exec" });
  const filters = ["all", "active", "completed", "failed"];
  let filter = "all";
  const filterRow = h("div.chip-tabs", { role: "group", "aria-label": t("runs.filter") });
  const list = h("div.stack");
  function draw() {
    clear(list);
    const visible = runEntries.filter(function (entry) { return filter === "all" || (!entry.omitted && entry.value.status === filter); });
    if (!visible.length) { list.append(emptyState(omittedNote(core, t), "pulse")); return; }
    pagedList(list, visible, 12, function (entry) {
      return entry.omitted ? recordCard(entry, task.id, t, ctx) : runCard({ ...entry.value, execution: entry.execution }, t, locale);
    }, t);
  }
  filters.forEach(function (status) {
    const count = status === "all" ? runEntries.length : runs.filter(function (run) { return run.status === status; }).length;
    if (status !== "all" && !count) return;
    filterRow.append(h("button.chip-tab", {
      type: "button", "aria-pressed": String(status === filter), dataset: { status },
      onclick: function () {
        filter = status;
        filterRow.querySelectorAll(".chip-tab").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.status === status)); });
        draw();
      }
    }, status === "all" ? t("filter.all") : label(t, "run", status), h("span.count", null, String(count))));
  });
  runSection.append(sectionTitle(t("runs.title"), runEntries.length), note(t("runs.hint")), filterRow, list);
  draw();
  panel.append(runSection);

  const jobs = entriesOf(core, "job");
  const jobSection = h("section.section", { id: "detail-operations" }, sectionTitle(t("jobs.title"), jobs.length));
  if (!jobs.length) jobSection.append(emptyState(omittedNote(core, t)));
  else {
    jobSection.append(note(t("jobs.hint")));
    const jobList = h("div.stack");
    jobs.forEach(function (entry) {
      if (entry.omitted) { jobList.append(recordCard(entry, task.id, t, ctx)); return; }
      const job = entry.value;
      jobList.append(h("article.record", null,
        h("header.record-head", null, dot(tone("job", job.status)), mono(task.id + "/" + job.id), h("span.spacer"),
          statusBadge(t, "job", "job", job.status)),
        h("p.small", null, t("job." + job.status + ".note", t("job.terminal.note"))),
        h("p.faint.small", null, (job.steps || []).map(function (step) { return step.name; }).join(" → ")),
        timeTag(job.terminalAt || job.startedAt || job.createdAt, locale, t)));
    });
    jobSection.append(jobList);
  }
  panel.append(jobSection);

  const usage = h("section.section", { id: "detail-usage" }, sectionTitle(t("usage.title")));
  const usageBody = h("div", { dataset: { slot: "usage" } });
  const metrics = data.runtime && observabilityMetricCard(data.runtime.observability, t);
  usageBody.append(metrics || emptyState(t("usage.unavailable")));
  usage.append(usageBody);
  panel.append(usage);

  const observations = disclosure(t("observation.title"), "execution", { className: "card-disclosure" });
  observations.body.append(note(t("observation.help")));
  (core.observations || []).forEach(function (observation) {
    observations.body.append(h("p.small.mono-line", null,
      observation.source + " · " + observation.status + " · " + observation.coverage + " · " + observation.observedAt));
  });
  observations.body.append(h("p.faint.small", { dataset: { slot: "runtime-status" } }), h("pre.code-block", { dataset: { slot: "runtime-raw" } }));
  panel.append(h("section.section", null, observations));
}

// --- History ----------------------------------------------------------------------
export function renderHistory(panel, data, t, locale, ctx) {
  const core = data.core;
  const task = data.task;
  const events = [];
  entriesOf(core, "task-decision").forEach(function (entry) { events.push({ kind: "decision", entry }); });
  entriesOf(core, "task-milestone").forEach(function (entry) { events.push({ kind: "milestone", entry }); });
  entriesOf(core, "task-message").forEach(function (entry) { events.push({ kind: "message", entry }); });
  const at = function (event) {
    const value = event.entry.value || {};
    return Date.parse(value.createdAt || value.updatedAt || 0) || 0;
  };
  events.sort(function (a, b) { return at(b) - at(a); });
  const section = h("section.section", { id: "detail-history" }, sectionTitle(t("history.title"), events.length));
  const kinds = ["all", "decision", "milestone", "message"];
  let kind = "all";
  const filterRow = h("div.chip-tabs", { role: "group", "aria-label": t("history.filter") });
  const list = h("ol.timeline");
  function draw() {
    clear(list);
    const visible = events.filter(function (event) { return kind === "all" || event.kind === kind; });
    if (!visible.length) { list.append(h("li.timeline-empty", null, emptyState(omittedNote(core, t), "history"))); return; }
    pagedList(list, visible, 20, function (event) { return timelineItem(event, task.id, t, locale, ctx); }, t);
  }
  kinds.forEach(function (value) {
    const count = value === "all" ? events.length : events.filter(function (event) { return event.kind === value; }).length;
    filterRow.append(h("button.chip-tab", {
      type: "button", "aria-pressed": String(value === kind), dataset: { kind: value },
      onclick: function () {
        kind = value;
        filterRow.querySelectorAll(".chip-tab").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.kind === value)); });
        draw();
      }
    }, t("history." + value), h("span.count", null, String(count))));
  });
  section.append(filterRow, list);
  if (core.omitted.records) section.append(note(t("history.omitted")));
  draw();
  panel.append(section);
}

function timelineItem(event, taskId, t, locale, ctx) {
  const entry = event.entry;
  const item = h("li.timeline-item.kind-" + event.kind);
  item.append(h("span.timeline-mark", { "aria-hidden": "true" }, icon(event.kind === "decision" ? "check" : event.kind === "milestone" ? "flag" : "chat", "icon-sm")));
  if (entry.omitted) { item.append(recordCard(entry, taskId, t, ctx, { compact: true })); return item; }
  const value = entry.value;
  const body = h("div.timeline-body");
  if (event.kind === "message") {
    const author = (value.author && value.author.roleName) || label(t, "author", (value.author && value.author.type) || "system");
    body.append(h("header.timeline-head", null, h("strong", null, author),
      value.kind ? chip(label(t, "messageKind", value.kind)) : null,
      value.intent ? chip(label(t, "intent", value.intent)) : null,
      h("span.spacer"), timeTag(value.createdAt, locale, t)));
    body.append(richText(null, value.body || "", t, { threshold: 480 }));
    if (value.resultRef) body.append(h("p.faint.small", null, t("history.resultOf") + " ", mono(value.resultRef.runId)));
  } else if (event.kind === "decision") {
    body.append(h("header.timeline-head", null, h("strong", null, value.title),
      value.status ? statusBadge(t, "decision", "decision", value.status) : null, h("span.spacer"), timeTag(value.createdAt, locale, t)));
    if (value.rationale) body.append(richText(null, value.rationale, t, { muted: true }));
    if (value.supersededReason) body.append(richText(t("history.superseded"), value.supersededReason, t, { muted: true }));
  } else {
    body.append(h("header.timeline-head", null, h("strong", null, value.title), h("span.spacer"), timeTag(value.createdAt, locale, t)));
    if (value.summary) body.append(richText(null, value.summary, t, { muted: true }));
  }
  body.append(h("p.faint.small", null, mono(entry.ref.refId)));
  body.append(recordReader(entry, taskId, t, ctx));
  item.append(body);
  return item;
}

// --- Details ----------------------------------------------------------------------
export function renderDetails(panel, data, t, locale, ctx) {
  const task = data.task;
  const core = data.core;
  const facts = card({ title: t("details.facts"), icon: "file" });
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
  const edit = card({ title: t("details.title"), icon: "sparkle" });
  edit.body.append(titleForm(task, t, ctx));
  const grid = h("div.card-grid");
  grid.append(facts, edit);
  panel.append(h("section.section", { id: "detail-facts" }, grid));

  const context = disclosure(t("details.context"), "context", { className: "card-disclosure" });
  context.body.append(h("pre.code-block", null, JSON.stringify({
    coreCursor: core.coreCursor, throughCursor: core.throughCursor, count: core.count, omitted: core.omitted
  }, null, 2)), note(t("details.contextHelp")));
  panel.append(h("section.section", null, context));

  const panels = disclosure(t("panels.title"), "panels", { className: "card-disclosure" });
  let loading = false;
  panels.addEventListener("toggle", async function () {
    if (!panels.open || loading) return;
    loading = true;
    clear(panels.body);
    panels.body.append(h("p.faint", null, t("panels.reading")));
    try {
      const current = await ctx.panels(task.id);
      clear(panels.body);
      panels.body.append(h("p.faint.small", null, t("panels.observed") + " " + formatDateTime(current.observedAt, locale)));
      if (!current.panels.length) panels.body.append(emptyState(t("panels.none")));
      current.panels.forEach(function (item) { panels.body.append(panelCard(item, task, t, ctx)); });
    } catch (error) {
      clear(panels.body);
      panels.body.append(note(t("panels.unavailable") + " " + error.message, "bad"));
    } finally { loading = false; }
  });
  panel.append(h("section.section", null, panels));
}

function panelCard(item, task, t, ctx) {
  const panel = item.panel;
  const element = h("article.record", null,
    h("header.record-head", null, h("strong", null, panel.title), h("span.spacer"), h("span.faint.small", null, item.capability + " · " + item.provider.id)));
  if (item.unavailable) { element.append(note(item.unavailable, "warn")); return element; }
  if (panel.kind === "text") element.append(h("p.small", null, panel.text));
  else if (panel.kind === "link") {
    try {
      const url = new URL(panel.href);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
        element.append(h("a.link", { href: url.href, rel: "noopener noreferrer", target: "_blank" }, panel.title));
      }
    } catch {}
  } else if (panel.kind === "data" && panel.renderer === "json") {
    const input = h("textarea.mono", { rows: 3 });
    input.value = JSON.stringify({ taskId: task.id });
    const schema = disclosure(t("panels.schema"), null);
    schema.body.append(h("pre.code-block", null, JSON.stringify(item.inputSchema, null, 2)));
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
    element.append(h("label.field", null, h("span", null, t("panels.input")), input), schema, h("div.form-actions", null, read), output);
  }
  return element;
}
`;
