export const SIDEBAR_SCRIPT = String.raw`
// Task index: attention shortcuts, status tabs and the grouped task list.
import { h, icon, clear } from "/assets/js/lib/dom.js";
import { relativeTime } from "/assets/js/lib/format.js";
import { dot } from "/assets/js/ui/primitives.js";
import { revealTab, scrollableTabRow, syncTabsOverflow } from "/assets/js/ui/controls.js";
import { label, tone } from "/assets/js/domain/vocab.js";

export const STATUS_FILTERS = ["all", "active", "draft", "completed", "cancelled", "archived"];
export const ATTENTION_KINDS = ["openInputs", "unknownOperations", "pendingOperations", "executionSignals"];
const ATTENTION_ICON = { openInputs: "inbox", unknownOperations: "alert", pendingOperations: "clock", executionSignals: "pulse" };
const ATTENTION_TONE = { openInputs: "warn", unknownOperations: "bad", pendingOperations: "info", executionSignals: "idle" };

export function renderAttentionBar(container, state, t, onPick) {
  clear(container);
  const attention = state.catalogAttention;
  if (!attention) return;
  const kinds = ATTENTION_KINDS.filter(function (kind) { return attention[kind] && attention[kind].taskCount > 0; });
  if (!kinds.length) {
    container.append(h("p.attention-clear", null, icon("check", "icon-sm"), t("sidebar.allClear")));
    return;
  }
  container.append(h("div.attention-list", null, kinds.map(function (kind) {
    const value = attention[kind];
    return h("button.attention-pill.tone-" + ATTENTION_TONE[kind], {
      type: "button",
      "aria-pressed": String(state.attentionFilter === kind),
      title: t("catalog.help." + kind),
      onclick: function () { onPick(state.attentionFilter === kind ? null : kind); }
    }, icon(ATTENTION_ICON[kind], "icon-sm"), h("span", null, t("catalog." + kind)), h("b", null, String(value.count)));
  })));
}

// --- Status tabs -------------------------------------------------------------
// The tab row is created once and updated in place so its horizontal scroll
// position survives every refresh; a newly selected tab scrolls into view.
export function renderFilters(container, state, t, onFilter) {
  const row = container.querySelector(":scope > .tabs-row") || statusRow(container, onFilter);
  STATUS_FILTERS.forEach(function (status) {
    updateStatusTab(row.querySelector('[data-status="' + status + '"]'), status, state, t);
  });
  if (row.dataset.selected !== state.filter) {
    row.dataset.selected = state.filter;
    revealTab(row, row.querySelector('[data-status="' + state.filter + '"]'));
  }
  syncTabsOverflow(row);
}

function statusRow(container, onFilter) {
  const row = h("div.tabs-row");
  STATUS_FILTERS.forEach(function (status) {
    row.append(h("button.status-tab", { type: "button", dataset: { status }, onclick: function () { onFilter(status); } },
      h("span.status-tab-label"), h("span.status-tab-count")));
  });
  container.append(row);
  return scrollableTabRow(row);
}

function updateStatusTab(tab, status, state, t) {
  const counts = state.counts || {};
  tab.setAttribute("aria-pressed", String(state.filter === status));
  tab.querySelector(".status-tab-label").textContent = status === "all"
    ? t(state.catalogAll ? "filter.everything" : "filter.unarchived") : label(t, "status", status);
  const count = status === "all"
    ? (counts.total === undefined ? undefined : counts.total - (state.catalogAll ? 0 : counts.archived || 0))
    : counts[status];
  const badge = tab.querySelector(".status-tab-count");
  const hide = count === undefined || count === null
    || (status === "archived" && state.catalogScope && state.catalogScope.archived === "excluded");
  badge.hidden = hide;
  if (!hide) badge.textContent = String(count);
}

// --- Task list ---------------------------------------------------------------
const GROUP_ORDER = ["attention", "active", "draft", "completed", "cancelled", "archived"];

function groupOf(task) {
  const attention = task.attention || {};
  if (attention.openInputs > 0 || attention.unknownOperations > 0) return "attention";
  if (task.status === "completed") return "completed";
  return task.status;
}

function groupTasks(state) {
  const groups = {};
  (state.tasks || []).forEach(function (task) {
    if (state.filter === "all" && !state.catalogAll && task.status === "archived") return;
    if (state.filter !== "all" && task.status !== state.filter) return;
    const group = groupOf(task);
    (groups[group] = groups[group] || []).push(task);
  });
  return groups;
}

export function renderTasks(container, state, t, locale, onSelect) {
  clear(container);
  const groups = groupTasks(state);
  const present = GROUP_ORDER.filter(function (group) { return groups[group] && groups[group].length; });
  if (!present.length) {
    container.append(h("div.list-empty", null, icon("search"), h("p", null, t(state.query || state.attentionFilter ? "sidebar.noMatch" : "sidebar.empty"))));
    return;
  }
  present.forEach(function (group) {
    container.append(h("section.task-group", null,
      h("h3.task-group-head", null, h("span", null, t("group." + group)), h("span.count", null, String(groups[group].length))),
      groups[group].map(function (task) { return taskRow(task, state, t, locale, onSelect); })));
  });
}

function taskRow(task, state, t, locale, onSelect) {
  const counts = task.counts || {};
  return h("button.task-row", {
    type: "button",
    dataset: { id: task.id },
    "aria-current": String(state.selected === task.id),
    title: task.summary || task.title,
    onclick: function () { onSelect(task.id); }
  },
  dot(tone("task", task.status), label(t, "status", task.status)),
  h("span.task-body", null,
    h("span.task-line", null, h("span.task-name", null, task.title), h("time.task-time", { dateTime: task.updatedAt }, relativeTime(task.updatedAt, locale, t))),
    h("span.task-line.task-sub", null, h("code.task-id", null, task.id),
      counts.workItems > 0 ? h("span.task-count", { title: t("sidebar.workItems") }, icon("layers", "icon-sm"), String(counts.workItems)) : null,
      taskSignals(task, t))));
}

function taskSignals(task, t) {
  const attention = task.attention || {};
  const counts = task.counts || {};
  const signals = h("span.task-signals");
  if (attention.openInputs > 0) signals.append(signal("inbox", attention.openInputs, "warn", t("catalog.openInputs")));
  if (attention.unknownOperations > 0) signals.append(signal("alert", attention.unknownOperations, "bad", t("catalog.unknownOperations")));
  if (counts.activeRuns > 0) signals.append(signal("pulse", counts.activeRuns, "info", t("sidebar.activeRuns")));
  return signals;
}

function signal(iconName, count, toneName, title) {
  return h("span.signal.tone-" + toneName, { title: title }, icon(iconName, "icon-sm"), String(count));
}
`;
