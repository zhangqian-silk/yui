export const TASK_OVERVIEW_SCRIPT = String.raw`
// Task › Overview: one reading column, top to bottom — where the Task stands
// now, what needs the user, what it has reported, its goal and its current
// decisions. A Draft also reports its planning Turn.
import { h } from "/assets/js/lib/dom.js";
import { formatDateTime } from "/assets/js/lib/format.js";
import { bulletList, button, codeBlock, dot, emptyState, note, timeTag } from "/assets/js/ui/primitives.js";
import { card, disclosure } from "/assets/js/ui/containers.js";
import { richText } from "/assets/js/ui/text.js";
import { entriesOf, exactCache, totalOf, valuesOf } from "/assets/js/domain/context.js";
import { lazyRow, recordCard } from "/assets/js/domain/records.js";
import { inputCard } from "/assets/js/domain/work.js";
import { taskActions } from "/assets/js/views/task/actions.js";

export function renderOverviewPanel(panel, data, t, locale, ctx) {
  // Now: the derived execution status (observation), the open questions and
  // who acts next. drawNow() tints the banner with the status tone.
  const now = card({ className: "now-card" });
  now.body.append(h("p.faint.small", null, t("workbench.observation")),
    h("div", { dataset: { slot: "now" } }), h("p.next-line", { dataset: { slot: "next" } }));
  panel.append(now);
  panel.append(taskActions(data.task, t, ctx));
  if (data.core.attention.openInputs.count) panel.append(needsCard(data, t, locale, ctx));
  const progress = progressCard(data, t, locale, ctx);
  const goal = goalCard(data, t, ctx);
  panel.append(progress);
  panel.append(goal, workAndEvidence(data, t, ctx), decisionsCard(data, t, locale, ctx));
}

// Needs you: open InputRequests with their answer controls. Open questions
// the bounded read did not carry are listed by reference.
function needsCard(data, t, locale, ctx) {
  const task = data.task;
  const openInputs = data.core.attention.openInputs;
  const inputs = entriesOf(data.core, "input-request").filter(function (entry) { return !entry.omitted && entry.value.status === "open"; });
  const missing = openInputs.refs.filter(function (ref) {
    return !inputs.some(function (entry) { return entry.ref.refId === ref.refId; });
  });
  const needs = card({ title: t("overview.needsYou"), icon: "inbox", count: openInputs.count, className: "needs-card" });
  needs.id = "detail-attention";
  inputs.forEach(function (entry) { needs.body.append(inputCard(entry.value, t, locale, ctx.answerInput)); });
  const seen = new Set(inputs.map(function (entry) { return entry.ref.refId; }));
  function deferredInput(item) {
    seen.add(item.ref.refId);
    return lazyRow(item, task.id, t, ctx, {
      head: h("span", null, item.summary || item.ref.refId),
      cache: exactCache(data.viewState),
      render: function (value) {
        return value.status === "open" ? inputCard(value, t, locale, ctx.answerInput)
          : note(value.id + " · " + value.status);
      }
    });
  }
  missing.forEach(function (ref) {
    const entry = entriesOf(data.core, "input-request").find(function (entry) { return entry.ref.refId === ref.refId; });
    needs.body.append(deferredInput({ ref: ref, summary: entry && entry.summary }));
  });
  if (openInputs.count > inputs.length + missing.length) {
    let cursor;
    const more = button(t("overview.moreInputs"), { onClick: async function () {
      more.disabled = true;
      try {
        const page = await ctx.list(task.id, "input-request", { status: "open", limit: 20, cursor: cursor });
        page.items.forEach(function (item) { if (!seen.has(item.ref.refId)) needs.body.insertBefore(deferredInput(item), more); });
        cursor = page.nextCursor;
        more.disabled = !cursor;
      } catch (error) { needs.body.append(note(error.message, "bad")); more.disabled = false; }
    } });
    needs.body.append(more);
  }
  return needs;
}

function briefOf(data) {
  return data.briefValue || valuesOf(data.core, "task-brief")[0];
}

function progressCard(data, t, locale, ctx) {
  const task = data.task;
  const element = card({ title: t("progress.title"), icon: "flag" });
  const working = task.status === "draft" || task.status === "active";
  if (task.completionSummary) element.body.append(richText(t("progress.completion"), task.completionSummary, t, { className: "callout.tone-ok" }));
  if (task.retirementSummary) element.body.append(richText(t("progress.retirement"), task.retirementSummary, t, { className: "callout" }));
  if (task.archiveSummary || task.archiveReason) element.body.append(richText(t("progress.archive"), [task.archiveSummary, task.archiveReason].filter(Boolean).join("\n\n"), t, { className: "callout" }));
  const briefEntry = entriesOf(data.core, "task-brief")[0];
  const brief = briefOf(data);
  if (brief) {
    element.body.append(richText(t(working ? "progress.focus" : "progress.lastFocus"), brief.currentFocus, t));
    element.body.append(richText(t(working ? "progress.report" : "progress.lastReport"), brief.leaderSummary, t, { muted: true }));
    element.body.append(h("p.faint.small", null, t("progress.briefUpdated") + " " + formatDateTime(brief.updatedAt, locale)));
  } else if (briefEntry) element.body.append(recordCard(briefEntry, task.id, t, ctx, { compact: true }));
  else element.body.append(emptyState(t("progress.none")));
  return element;
}

function goalCard(data, t, ctx) {
  const task = data.task;
  const brief = briefOf(data);
  const element = card({ title: t("goal.title"), icon: "target" });
  if (brief && brief.objective) element.body.append(richText(null, brief.objective, t));
  if (brief && brief.boundaries && brief.boundaries.length) {
    element.body.append(h("div.prose-block", null, h("h4.prose-label", null, t("goal.boundaries")), bulletList(brief.boundaries)));
  }
  if (brief && brief.technicalApproach) element.body.append(proseDisclosure(t("goal.approach"), "approach", brief.technicalApproach, t));
  if (task.description) element.body.append(proseDisclosure(t("goal.requirements"), "requirements", task.description, t));
  element.body.append(note(t("workbench.summary")));
  ["task", "task-brief"].forEach(function (store) {
    const entry = entriesOf(data.core, store)[0];
    if (entry) element.body.append(recordCard({ ref: entry.ref, omitted: true }, task.id, t, ctx));
  });
  if (!element.body.childNodes.length) element.body.append(emptyState(t("goal.none")));
  return element;
}

function workAndEvidence(data, t, ctx) {
  const element = card({ title: t("workbench.evidence"), icon: "layers" });
  entriesOf(data.core, "work-item").slice(0, 3).forEach(function (entry) {
    element.body.append(recordCard(entry, data.task.id, t, ctx, { compact: true }));
  });
  const evidence = data.evidenceSummary || { reviews: [], integrations: [] };
  evidence.reviews.forEach(function (review) {
    element.body.append(h("p.small", null, review.id + " · " + t("workbench.reviewExecution") + " " + review.status),
      review.excerpt ? richText(review.runId, review.excerpt, t) : null);
  });
  evidence.integrations.forEach(function (integration) {
    element.body.append(h("p.small", null, integration.id + " · " + integration.status),
      integration.summary ? richText(null, integration.summary, t) : null);
    (integration.checks || []).forEach(function (check) {
      element.body.append(h("p.faint.small", null, check.name + " · " + check.outcome));
    });
  });
  if (!evidence.reviews.length && !evidence.integrations.length) element.body.append(note(t("workbench.noEvidence")));
  element.body.append(button(t("workbench.openEvidence"), { variant: "link", onClick: function () { ctx.onTab("delivery"); } }));
  return element;
}

function proseDisclosure(title, viewKey, text, t) {
  const element = disclosure(title, viewKey);
  element.body.append(richText(null, text, t));
  return element;
}

function decisionsCard(data, t, locale, ctx) {
  const active = entriesOf(data.core, "task-decision").filter(function (entry) { return !entry.omitted && entry.value.status === "active"; });
  const total = totalOf(data.core, "task-decision");
  const element = card({ id: "detail-decisions", title: t("decisions.title"), icon: "check", count: total || null, hint: t("decisions.hint") });
  active.slice(0, 3).forEach(function (entry) {
    const value = entry.value;
    element.body.append(h("article.decision", null,
      h("header.decision-head", null, dot("ok"), h("strong", null, value.title), timeTag(value.createdAt, locale, t)),
      value.rationale ? richText(null, value.rationale, t, { muted: true, threshold: 260 }) : null));
  });
  if (!active.length) element.body.append(emptyState(t("decisions.none")));
  element.body.append(button(t("decisions.more"), { variant: "link", icon: "chevron", onClick: function () {
    data.viewState.recordsFilter = "decision";
    ctx.onTab("records");
  } }));
  return element;
}

`;
