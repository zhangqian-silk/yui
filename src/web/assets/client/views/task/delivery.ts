export const TASK_DELIVERY_SCRIPT = String.raw`
// Task › Delivery: work items, reviews, integration and remote delivery,
// saved files and retained workspaces. Opening the tab reads the original
// evidence once per Context cursor; reading never accepts, publishes,
// executes or cleans anything.
import { h, clear } from "/assets/js/lib/dom.js";
import { button, dot, emptyState, note } from "/assets/js/ui/primitives.js";
import { listCard, loadedNote, moreButton, setCardCount } from "/assets/js/ui/containers.js";
import { richText } from "/assets/js/ui/text.js";
import { statusBadge, tone } from "/assets/js/domain/vocab.js";
import { entriesOf, exactCache, familyState, loadFamily, summaryFields, totalOf, valuesOf } from "/assets/js/domain/context.js";
import { exactRow, lazyRow } from "/assets/js/domain/records.js";
import { workItemBody, workItemCard } from "/assets/js/domain/work.js";
import { reviewCard } from "/assets/js/domain/runs.js";
import { newest, readRemoteDelivery, resultsSection, workspacesSection } from "/assets/js/views/task/deliveryResults.js";
import { filesCard } from "/assets/js/views/task/files.js";

export function renderDelivery(panel, data, t, locale, ctx) {
  const view = data.viewState;
  exactCache(view);
  view.openRows = view.openRows || {};
  view.reports = view.reports || {};
  view.panels = view.panels || {};
  view.panels.delivery = panel;
  const scope = { data: data, view: view, core: data.core, task: data.task, t: t, locale: locale, ctx: ctx, refresh: refresh };
  const work = workSection(scope);
  const reviews = reviewsSection(scope);
  const results = resultsSection(scope);
  const workspaces = workspacesSection(scope);
  panel.append(work.element, reviews.element, results.element, filesCard(data, t, locale, ctx), workspaces.element);
  panel.redraw = function () { work.draw(); reviews.draw(); results.draw(); workspaces.draw(); };
  panel.redraw();

  // Reads outlive one render: they redraw whichever Delivery panel is current
  // and re-read when the Context cursor moved while they were in flight.
  function refresh() {
    const current = view.panels.delivery;
    if (!current || !current.isConnected) return;
    current.redraw();
    if (!current.hidden) current.onShow();
  }
  panel.onShow = function () {
    readEvidence(scope);
    readRemoteDelivery(scope);
    const key = scope.core.coreCursor;
    const family = familyState(view, "work-item");
    if (family.key !== key && family.errorKey !== key && !family.pending) loadFamily(view, data.task.id, "work-item", key, ctx, { limit: 40 }).then(refresh);
  };
}

// Original evidence (reviews, integrations, workspaces), once per cursor.
function readEvidence(scope) {
  const view = scope.view;
  const key = scope.core.coreCursor;
  const previous = view.evidence || {};
  if (previous.key === key || previous.errorKey === key || previous.pending) return;
  view.evidence = { key: previous.key, value: previous.value, readAt: previous.readAt, error: null, pending: true };
  scope.ctx.evidence(scope.task.id).then(function (value) {
    view.evidence = { key: key, value: value, readAt: new Date().toISOString(), error: null, pending: false };
  }, function (error) {
    view.evidence = { key: previous.key, value: previous.value, readAt: previous.readAt, error: error.message, errorKey: key, pending: false };
  }).then(scope.refresh);
}

// --- Work items ------------------------------------------------------------
function workSection(scope) {
  const t = scope.t;
  const work = listCard({ id: "detail-work", title: t("work.title"), icon: "layers", count: totalOf(scope.core, "work-item") || null, hint: t("work.openHint") });
  return { element: work, draw: function () { drawWork(work, scope); } };
}

// Open items from the snapshot first, then open items only the family pages
// list, then the settled ones.
function drawWork(work, scope) {
  const t = scope.t;
  clear(work.list);
  const family = familyState(scope.view, "work-item");
  const entries = entriesOf(scope.core, "work-item");
  const titles = workTitles(family, scope.core);
  const shown = new Set(entries.map(function (entry) { return entry.ref.refId; }));
  const extraOpen = family.items.filter(function (item) { return item.status === "open" && !shown.has(item.ref.refId); });
  entries.forEach(function (entry) {
    work.list.append(exactRow(entry, scope.task.id, t, scope.ctx, scope.view.exact, function (value) { return workItemCard(value, t, scope.locale, titles); }));
  });
  extraOpen.forEach(function (item) { work.list.append(workRow(scope, item, titles)); });
  const loaded = family.key && family.pages;
  if (loaded) setCardCount(work, family.total || null);
  if (!entries.length && !extraOpen.length) {
    work.list.append(emptyState(loaded && family.total === 0 ? t("work.none") : t("work.noneOpen"), "layers"));
  }
  if (family.error) work.list.append(note(t("records.unavailable") + " " + family.error, "bad"));
  if (!loaded) {
    if (family.pending) work.list.append(h("p.row-label", null, t("work.reading")));
    return;
  }
  drawFinished(work, scope, family, titles);
}

function workTitles(family, core) {
  const titles = {};
  family.items.forEach(function (item) { const fields = summaryFields(item.summary); if (fields.title) titles[item.ref.refId] = fields.title; });
  valuesOf(core, "work-item").forEach(function (item) { titles[item.id] = item.title; });
  return titles;
}

function drawFinished(work, scope, family, titles) {
  const finished = family.items.filter(function (item) { return item.status !== "open"; });
  const finishedTotal = Math.max(finished.length, (family.total || 0) - totalOf(scope.core, "work-item"));
  if (!finishedTotal) return;
  const group = h("div.row-stack.is-finished", null, h("p.row-label", null, scope.t("work.finished") + " · " + finishedTotal));
  finished.forEach(function (item) { group.append(workRow(scope, item, titles)); });
  work.list.append(group);
  if (!family.nextCursor) return;
  work.list.append(h("div.list-foot", null, loadedNote(scope.t, family.items.length, family.total), moreButton(scope.t, function () {
    loadFamily(scope.view, scope.task.id, "work-item", family.key, scope.ctx, { more: true, limit: 40 }).then(scope.refresh);
  })));
}

function workRow(scope, item, titles) {
  const t = scope.t;
  const fields = summaryFields(item.summary);
  return lazyRow(item, scope.task.id, t, scope.ctx, {
    cache: scope.view.exact, openRows: scope.view.openRows,
    head: [dot(tone("work", item.status)), h("span.lazy-title", null, fields.title || item.ref.refId),
      item.assignee ? h("span.faint.small.lazy-meta", null, item.assignee) : null,
      statusBadge(t, "work", "work", item.status)],
    render: function (value) { return workItemBody(value, t, scope.locale, titles); }
  });
}

// --- Reviews ---------------------------------------------------------------
function reviewsSection(scope) {
  const reviews = listCard({ id: "detail-reviews", title: scope.t("reviews.title"), icon: "eye", hint: scope.t("reviews.hint") });
  return { element: reviews, draw: function () { drawReviews(reviews, scope); } };
}

function drawReviews(reviews, scope) {
  const view = scope.view;
  clear(reviews.list);
  const evidence = view.evidence && view.evidence.key && view.evidence.value;
  if (evidence) {
    const rounds = evidence.reviews.slice().sort(newest);
    setCardCount(reviews, rounds.length || null);
    if (!rounds.length) reviews.list.append(emptyState(scope.t("reviews.none"), "eye"));
    rounds.forEach(function (round) { reviews.list.append(reviewRow(scope, round)); });
    return;
  }
  const entries = entriesOf(scope.core, "review-round");
  setCardCount(reviews, entries.length || null);
  entries.forEach(function (entry) {
    reviews.list.append(exactRow(entry, scope.task.id, scope.t, scope.ctx, view.exact, function (value) { return reviewRow(scope, value); }));
  });
  if (view.evidence && view.evidence.error) reviews.list.append(note(scope.t("records.unavailable") + " " + view.evidence.error, "bad"));
  else reviews.list.append(h("p.row-label", null, scope.t("evidence.loading")));
}

function reviewRow(scope, round) {
  const t = scope.t;
  const element = reviewCard(round, t, scope.locale);
  if (!round.reviewerRunId) return element;
  const holder = h("div.stack");
  const cached = scope.view.reports[round.id];
  if (cached) { holder.append(richText(t("evidence.report"), cached, t, { threshold: 480 })); element.append(holder); return element; }
  element.append(h("div.record-actions", null, reportButton(scope, round, holder)), holder);
  return element;
}

// The reviewer's report is read from its execution record on request and
// kept in view state for later renders.
function reportButton(scope, round, holder) {
  const t = scope.t;
  const report = button(t("evidence.readReport"), { icon: "eye", variant: "link" });
  report.addEventListener("click", async function () {
    report.disabled = true;
    try {
      const source = await scope.ctx.inspect(scope.task.id, { store: "run", refId: round.reviewerRunId });
      const output = (source.result && source.result.output) || (source.value && source.value.result && source.value.result.output) || t("evidence.noReport");
      scope.view.reports[round.id] = output;
      holder.append(richText(t("evidence.report"), output, t, { threshold: 480 }));
      report.remove();
    } catch (error) { holder.append(note(error.message, "bad")); report.disabled = false; }
  });
  return report;
}
`;
