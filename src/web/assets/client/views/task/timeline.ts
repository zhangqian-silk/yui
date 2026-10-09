export const TASK_TIMELINE_SCRIPT = String.raw`
// Task › Records › History: one timeline over four Context families, read as
// paged summaries. Messages live in the Discussion dock. Ascending families
// are read in full (bounded); descending runs page on request, and older rows
// of other families are held back until the run pages reach them so the
// merged order stays honest.
import { h, icon, clear, markSelected } from "/assets/js/lib/dom.js";
import { button, chip, emptyState, mono, note, timeTag } from "/assets/js/ui/primitives.js";
import { card, filterChips, loadedNote, moreButton } from "/assets/js/ui/containers.js";
import { richText } from "/assets/js/ui/text.js";
import { label, statusBadge } from "/assets/js/domain/vocab.js";
import { exactCache, familyState, loadFamily, summaryFields } from "/assets/js/domain/context.js";
import { lazyRow } from "/assets/js/domain/records.js";
import { runBody } from "/assets/js/domain/runs.js";

const TIMELINE = [
  { kind: "decision", store: "task-decision", icon: "check", ascending: true },
  { kind: "milestone", store: "task-milestone", icon: "flag", ascending: true },
  { kind: "run", store: "run", icon: "pulse", ascending: false },
  { kind: "question", store: "input-request", icon: "inbox", ascending: true }
];
const FULL_PAGES = 5;

function at(item) { return Date.parse(item.createdAt || 0) || 0; }

// The History card. It becomes the panel's redraw(), and showing the panel
// reads the family pages for the current Context cursor.
export function historyCard(panel, data, t, locale, ctx) {
  const view = data.viewState;
  view.panels = view.panels || {};
  view.panels.records = panel;
  exactCache(view);
  view.openRows = view.openRows || {};
  if (!TIMELINE.some(function (family) { return family.kind === view.recordsFilter; })) view.recordsFilter = "all";
  const history = card({
    id: "detail-history", title: t("history.title"), icon: "history", hint: t("history.hint"),
    actions: filterChips(t("history.filter"), [{ value: "all", label: t("history.all") }].concat(TIMELINE.map(function (family) {
      return { value: family.kind, label: t("history." + family.kind) };
    })), view.recordsFilter, function (value) { view.recordsFilter = value; draw(); })
  });
  const scope = {
    view: view, core: data.core, task: data.task, t: t, locale: locale, ctx: ctx, history: history,
    known: knownValues(data.core), list: h("ol.timeline"), foot: h("div.list-foot")
  };
  history.body.append(scope.list, scope.foot);
  function draw() { drawTimeline(scope); }
  panel.redraw = draw;
  panel.onShow = function () { show(scope, false); };
  draw();
  return history;
}

// Values the current snapshot already carries need no read.
function knownValues(core) {
  const known = {};
  core.records.forEach(function (entry) { if (!entry.omitted) known[entry.ref.store + "/" + entry.ref.refId] = entry; });
  return known;
}

function drawTimeline(scope) {
  const view = scope.view;
  const t = scope.t;
  clear(scope.list);
  clear(scope.foot);
  markSelected(scope.history.querySelectorAll(".chip-tab"), "aria-pressed", function (chipButton) { return chipButton.dataset.filter === view.recordsFilter; });
  const states = TIMELINE.filter(function (family) { return view.recordsFilter === "all" || view.recordsFilter === family.kind; })
    .map(function (family) { return { family: family, state: familyState(view, family.store) }; });
  const items = mergedItems(states);
  const loading = states.some(function (row) { return row.state.pending && !row.state.pages; });
  const loaded = states.every(function (row) { return row.state.pages || row.state.error; });
  states.forEach(function (row) {
    if (row.state.error) scope.list.append(h("li.timeline-empty", null, note(t("history." + row.family.kind) + " · " + t("records.unavailable") + " " + row.state.error, "bad")));
  });
  if (!items.length) {
    scope.list.append(h("li.timeline-empty", null, emptyState(loading || !loaded ? t("history.loading") : t("records.none"), "history")));
  }
  items.forEach(function (row) { scope.list.append(timelineItem(scope, row.family, row.item)); });
  if (loaded) drawFoot(scope, states, items.length);
}

// Newest first. While a descending family has more pages, rows older than
// its oldest loaded row wait for those pages.
function mergedItems(states) {
  let horizon = -Infinity;
  states.forEach(function (row) {
    if (row.state.nextCursor && !row.family.ascending && row.state.items.length) {
      horizon = Math.max(horizon, Math.min.apply(null, row.state.items.map(at)));
    }
  });
  const items = [];
  states.forEach(function (row) {
    row.state.items.forEach(function (item) { if (at(item) >= horizon) items.push({ family: row.family, item: item }); });
  });
  return items.sort(function (a, b) { return at(b.item) - at(a.item); });
}

function drawFoot(scope, states, shown) {
  const t = scope.t;
  const total = states.reduce(function (sum, row) { return sum + (row.state.total || 0); }, 0);
  scope.foot.append(loadedNote(t, shown, total));
  const stale = states.some(function (row) { return row.state.key && row.state.key !== scope.core.coreCursor; });
  if (stale) {
    scope.foot.append(button(t("history.stale"), { icon: "refresh", variant: "ghost", onClick: function () { show(scope, true); } }));
  }
  if (!states.some(function (row) { return row.state.nextCursor; })) return;
  scope.foot.append(moreButton(t, function () {
    Promise.all(states.filter(function (row) { return row.state.nextCursor; }).map(function (row) {
      return loadFamily(scope.view, scope.task.id, row.family.store, row.state.key, scope.ctx, { more: true, limit: 40 });
    })).then(function () { refresh(scope); });
  }));
}

// --- Rows ----------------------------------------------------------------------
function timelineItem(scope, family, item) {
  const t = scope.t;
  const fields = summaryFields(item.summary);
  const entry = scope.known[item.ref.store + "/" + item.ref.refId];
  const value = entry && entry.ref.digest === item.ref.digest ? entry.value : null;
  const element = h("li.timeline-item.kind-" + family.kind);
  element.append(h("span.timeline-mark", { "aria-hidden": "true" }, icon(family.icon, "icon-sm")));
  const title = timelineTitle(family, item, fields, t);
  const head = h("div.timeline-summary", null, h("header.timeline-head", null, h("strong.timeline-title", null, title),
    family.kind === "run" ? mono(item.ref.refId) : null,
    item.workItemId ? chip(item.workItemId) : null,
    item.history === "retired" ? chip(t("history.retired")) : null,
    item.status ? timelineStatus(family, item, t) : null, h("span.spacer"), timeTag(item.createdAt, scope.locale, t)));
  const preview = value && family.kind === "decision" ? value.rationale : fields.summary !== title ? fields.summary : null;
  if (preview) head.append(h("p.small.muted.timeline-preview", null, preview));
  // The row opens in place; its exact record is read on first open.
  element.append(h("div.timeline-body", null, lazyRow(item, scope.task.id, t, scope.ctx, {
    cache: scope.view.exact, openRows: scope.view.openRows, head: head,
    render: function (exact, result) { return timelineDetail(family, exact, result, t, scope.locale); }
  })));
  return element;
}

function timelineTitle(family, item, fields, t) {
  if (family.kind === "run") return [item.roleName || t("store.run"), item.purpose ? label(t, "run.purpose", item.purpose) : null].filter(Boolean).join(" · ");
  if (family.kind === "question") return fields.question || fields.title || item.ref.refId;
  return fields.title || item.ref.refId;
}

function timelineStatus(family, item, t) {
  if (family.kind === "decision") return statusBadge(t, "decision", "decision", item.status);
  if (family.kind === "run") return statusBadge(t, "run", "run", item.status);
  if (family.kind === "question") return statusBadge(t, "input", "inputStatus", item.status);
  return null;
}

function timelineDetail(family, exact, result, t, locale) {
  if (family.kind === "run") return h("div.stack", null, runBody({ ...exact, execution: result && result.execution }, t, locale));
  if (family.kind === "decision") return h("div.stack", null,
    exact.rationale ? richText(t("record.rationale"), exact.rationale, t, { muted: true }) : null,
    exact.supersededReason ? richText(t("history.superseded"), exact.supersededReason, t, { muted: true }) : null);
  if (family.kind === "milestone") return h("div.stack", null, exact.summary ? richText(null, exact.summary, t) : null);
  if (family.kind !== "question") return null;
  const answer = exact.resolution && exact.resolution.answer;
  return h("div.stack", null, exact.question ? richText(null, exact.question, t) : null,
    answer ? richText(t("history.answer") + " · " + label(t, "answeredBy", exact.resolution.answeredBy),
      answer.text || answer.choiceKey, t, { muted: true }) : null,
    exact.cancellation ? note(exact.cancellation.reason) : null);
}

// --- Reads -----------------------------------------------------------------------
// Reads redraw whichever Records panel is current.
function refresh(scope) {
  const current = scope.view.panels.records;
  if (current && current.isConnected) current.redraw();
}

function loadFull(scope, family, key) {
  return loadFamily(scope.view, scope.task.id, family.store, key, scope.ctx, { limit: 40 }).then(function (state) {
    if (!family.ascending || !state.nextCursor || state.pages >= FULL_PAGES || state.error) return state;
    return loadFamily(scope.view, scope.task.id, family.store, key, scope.ctx, { more: true, limit: 40 }).then(function () { return loadFull(scope, family, key); });
  });
}

// A stale first page re-reads silently; once the user paged further, the
// read waits for an explicit refresh so their position is kept.
function show(scope, force) {
  const key = scope.core.coreCursor;
  TIMELINE.forEach(function (family) {
    const state = familyState(scope.view, family.store);
    if (state.pending || state.key === key || (!force && state.errorKey === key)) return;
    if (!force && state.key && !family.ascending && state.pages > 1) return;
    loadFull(scope, family, key).then(function () { refresh(scope); });
  });
  refresh(scope);
}
`;
