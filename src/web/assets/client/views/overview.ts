export const OVERVIEW_SCRIPT = String.raw`
// Workspace overview, shown in the center while no Task is selected: one
// reading column with the work path first (answer, in progress, recent),
// then catalog-wide signals and the explicit Session read.
import { h, icon, clear } from "/assets/js/lib/dom.js";
import { byNewest, fill, formatDateTime, relativeTime } from "/assets/js/lib/format.js";
import { badge, button, dot, emptyState, note } from "/assets/js/ui/primitives.js";
import { card } from "/assets/js/ui/containers.js";
import { metricTile } from "/assets/js/ui/metrics.js";
import { label, sessionBadges, tone } from "/assets/js/domain/vocab.js";
import { ATTENTION_KINDS } from "/assets/js/views/sidebar.js";

export function renderOverview(container, state, t, locale, actions) {
  clear(container);
  const tasks = state.tasks || [];
  const active = tasks.filter(function (task) { return task.status === "active"; });
  const recent = tasks.filter(function (task) { return task.status !== "archived"; }).slice().sort(byNewest).slice(0, 8);
  const page = h("div.page.overview");
  page.append(overviewHead(state.counts, t, actions), metricStrip(state.counts, t));
  page.append(h("div.card-stack", null,
    inboxCard(state, t, actions),
    taskListCard(t("overview.activeNow"), "pulse", active, t("overview.activeEmpty"), t, locale, actions),
    taskListCard(t("overview.recent"), "history", recent, t("sidebar.empty"), t, locale, actions),
    catalogCard(state, t, actions),
    sessionCard(state, t, locale, actions)));
  page.append(h("p.page-foot", null, t("overview.pageScope")));
  container.append(page);
}

function overviewHead(counts, t, actions) {
  return h("header.page-head", null,
    h("div.page-head-main", null,
      h("p.kicker", null, t("overview.kicker")),
      h("h1.page-title", null, t("overview.title")),
      h("p.page-sub", null, counts
        ? fill(t("overview.sub"), { total: counts.total, active: counts.active || 0 })
        : t("loading.dashboard"))),
    h("div.page-head-actions", null,
      button(t("actions.operator"), { icon: "terminal", variant: "ghost", onClick: actions.openOperator })));
}

function metricStrip(counts, t) {
  return h("div.metric-strip", null,
    metricTile(t("metrics.inputs"), counts ? counts.openInputs : "—", { tone: counts && counts.openInputs ? "warn" : "" }),
    metricTile(t("metrics.active"), counts ? counts.active : "—", { tone: "info" }),
    metricTile(t("metrics.draft"), counts ? counts.draft : "—"),
    metricTile(t("metrics.completed"), counts ? counts.completed : "—", { tone: "ok" }),
    metricTile(t("metrics.total"), counts ? counts.total : "—"));
}

// Open questions: the catalog names the affected Tasks, never the questions.
function inboxCard(state, t, actions) {
  const counts = state.counts;
  const inbox = card({ title: t("overview.inbox"), icon: "inbox", count: counts ? counts.openInputs : null });
  const items = state.attention || [];
  if (!items.length) {
    inbox.body.append(emptyState(counts && counts.openInputs > 0 ? t("overview.inboxElsewhere") : t("overview.inboxEmpty"), "check"));
    return inbox;
  }
  inbox.body.append(h("div.row-list", null, items.slice(0, 8).map(function (item) {
    return h("button.list-row", { type: "button", onclick: function () { actions.select(item.taskId); } },
      dot("warn"), h("span.list-row-title", null, item.taskTitle), h("code.id", null, item.taskId),
      h("span.list-row-go", null, t("overview.answer"), icon("chevron", "icon-sm")));
  })));
  return inbox;
}

function catalogCard(state, t, actions) {
  const catalog = card({ title: t("overview.catalog"), icon: "broadcast", hint: t("overview.catalogHint") });
  if (!state.catalogAttention) { catalog.body.append(emptyState(t("loading.dashboard"))); return catalog; }
  catalog.body.append(h("div.row-list", null, ATTENTION_KINDS.map(function (kind) {
    const value = state.catalogAttention[kind];
    if (!value) return null;
    return h("button.list-row", {
      type: "button", disabled: value.taskCount === 0,
      "aria-pressed": String(state.attentionFilter === kind),
      onclick: function () { actions.filterAttention(kind); }
    },
    h("span.list-row-title", null, t("catalog." + kind)),
    h("span.list-row-count", null, String(value.count)),
    h("span.faint", null, value.taskCount + " " + t("overview.tasks")));
  })));
  catalog.body.append(note(t("overview.signalsHelp")));
  return catalog;
}

function taskListCard(title, iconName, tasks, empty, t, locale, actions) {
  const element = card({ title: title, icon: iconName, count: tasks.length, hint: t("overview.thisPage") });
  if (!tasks.length) { element.body.append(emptyState(empty)); return element; }
  element.body.append(h("div.row-list", null, tasks.map(function (task) {
    return h("button.list-row", { type: "button", title: task.summary || task.title, onclick: function () { actions.select(task.id); } },
      dot(tone("task", task.status), label(t, "status", task.status)),
      h("span.list-row-title", null, task.title),
      task.attention && task.attention.openInputs ? badge(String(task.attention.openInputs), "warn") : null,
      h("time.faint", { dateTime: task.updatedAt }, relativeTime(task.updatedAt, locale, t)));
  })));
  return element;
}

// Native Session observation is an explicit read of exactly this catalog page.
function sessionCard(state, t, locale, actions) {
  const element = card({
    title: t("overview.sessions"), icon: "terminal", hint: t("overview.sessionsHint"),
    actions: button(state.sessionOverview ? t("overview.sessionsReread") : t("overview.sessionsRead"), {
      icon: "eye", variant: "ghost", disabled: state.sessionLoading || !(state.tasks || []).length,
      onClick: actions.readSessions
    })
  });
  if (state.sessionError) element.body.append(note(state.sessionError, "bad"));
  const overview = state.sessionOverview;
  if (!overview) {
    element.body.append(emptyState(state.sessionLoading ? t("overview.sessionsReading") : t("overview.sessionsNotRead")));
    return element;
  }
  element.body.append(h("p.faint.small", null, t("overview.readAt") + " " + formatDateTime(overview.readAt, locale)));
  element.body.append(h("div.row-list", null, overview.tasks.map(function (task) {
    const chips = sessionBadges(task.counts, t);
    return h("button.list-row.list-row-wrap", { type: "button", onclick: function () { actions.select(task.taskId); } },
      h("span.list-row-title", null, task.title), h("code.id", null, task.taskId),
      h("span.chip-row", null, chips.length ? chips : h("span.faint", null, t("session.noneRecorded"))));
  })));
  return element;
}
`;
