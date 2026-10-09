export const TASK_OVERVIEW_SCRIPT = String.raw`
// Task › Overview: one reading column, top to bottom — where the Task stands
// now, what needs the user, what it has reported, its goal and its current
// decisions. A Draft also reports its planning Turn.
import { h } from "/assets/js/lib/dom.js";
import { fill, formatDateTime } from "/assets/js/lib/format.js";
import { bulletList, button, codeBlock, dot, emptyState, kv, mono, note, timeTag } from "/assets/js/ui/primitives.js";
import { card, disclosure } from "/assets/js/ui/containers.js";
import { richText } from "/assets/js/ui/text.js";
import { entriesOf, exactCache, readExact, totalOf, valuesOf } from "/assets/js/domain/context.js";
import { recordCard } from "/assets/js/domain/records.js";
import { inputCard } from "/assets/js/domain/work.js";

export function renderOverviewPanel(panel, data, t, locale, ctx) {
  // Now: the derived execution status (observation), the open questions and
  // who acts next. drawNow() tints the banner with the status tone.
  const now = card({ className: "now-card" });
  now.body.append(h("div", { dataset: { slot: "now" } }), h("p.next-line", { dataset: { slot: "next" } }));
  panel.append(now);
  if (data.core.attention.openInputs.count) panel.append(needsCard(data, t, locale, ctx));
  const progress = progressCard(data, t, locale, ctx);
  const goal = goalCard(data, t);
  panel.append(progress);
  if (data.task.status === "draft") panel.append(planningCard(data, t, locale));
  panel.append(goal, decisionsCard(data, t, locale, ctx));
  readBrief(data, progress, goal, t, locale, ctx);
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
  missing.forEach(function (ref) { needs.body.append(recordCard({ ref: ref, omitted: true }, task.id, t, ctx)); });
  if (openInputs.count > inputs.length + missing.length) {
    needs.body.append(note(t("overview.moreInputs"), "warn"), codeBlock("yui task input list " + task.id));
  }
  return needs;
}

// The Brief is the Overview's main source; when the bounded read withheld
// its value, read it exactly once per digest and redraw both cards.
function readBrief(data, progress, goal, t, locale, ctx) {
  const briefEntry = entriesOf(data.core, "task-brief")[0];
  if (!briefEntry || !briefEntry.omitted) return;
  readExact(briefEntry, data.task.id, ctx, exactCache(data.viewState)).then(function (result) {
    if (!progress.isConnected) return;
    const exact = { ...data, briefValue: result.value };
    progress.replaceWith(progressCard(exact, t, locale, ctx));
    goal.replaceWith(goalCard(exact, t));
  }, function () {});
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

function goalCard(data, t) {
  const task = data.task;
  const brief = briefOf(data);
  const element = card({ title: t("goal.title"), icon: "target" });
  if (brief && brief.objective) element.body.append(richText(null, brief.objective, t));
  if (brief && brief.boundaries && brief.boundaries.length) {
    element.body.append(h("div.prose-block", null, h("h4.prose-label", null, t("goal.boundaries")), bulletList(brief.boundaries)));
  }
  if (brief && brief.technicalApproach) element.body.append(proseDisclosure(t("goal.approach"), "approach", brief.technicalApproach, t));
  if (task.description) element.body.append(proseDisclosure(t("goal.requirements"), "requirements", task.description, t));
  if (!element.body.childNodes.length) element.body.append(emptyState(t("goal.none")));
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

// A Draft's Leader conversation is its planning Turn. Report the snapshot's
// real planning facts; a withheld value is reported as withheld, never as
// "not dispatched".
function planningCard(data, t, locale) {
  const planning = valuesOf(data.core, "run").filter(function (run) { return run.roleName === "leader" && run.purpose === "planning"; });
  const turn = planning[planning.length - 1] || null;
  const withheld = turn === null && entriesOf(data.core, "run").some(function (entry) { return entry.omitted; });
  const live = ((data.runtime && data.runtime.roles) || []).find(function (role) { return role.name === "leader"; }) || null;
  const element = card({ title: t("planning.title"), icon: "sparkle", className: "planning-card" });
  element.dataset.planning = turn ? turn.status : withheld ? "withheld" : "not-dispatched";
  element.body.append(note(withheld ? t("planning.withheld") : turn === null ? t("planning.none")
    : turn.status === "active" ? t("planning.open") : fill(t("planning.settled"), { status: turn.status })));
  const provider = (turn && turn.result && turn.result.provider) || {};
  const environment = turn && turn.effective && turn.effective.executionEnvironment;
  element.body.append(kv([
    [t("planning.run"), turn ? mono(turn.id + " (" + turn.status + ")") : withheld ? t("planning.withheldValue") : t("common.none")],
    [t("planning.providerTerminal"), provider.status || t("common.notReported")],
    [t("planning.conversation"), provider.conversationId || t("common.notReported")],
    [t("planning.liveSession"), (live && live.runtimeSession && live.runtimeSession.nativeSessionId) || t("planning.notRunning")],
    [t("planning.environment"), (environment && environment.environmentRef) || t("planning.emptyEnvironment")],
    [t("planning.updated"), turn ? formatDateTime((turn.result && turn.result.completedAt) || turn.updatedAt, locale) : t("common.unknown")]
  ]));
  return element;
}
`;
