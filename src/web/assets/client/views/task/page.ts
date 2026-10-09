import { TASK_TABS, TASK_TAB_ALIASES, TASK_TAB_ICONS } from "../../../shared/taskTabs.js";

export const TASK_PAGE_SCRIPT = String.raw`
// Task page: header, meta line, section tabs and the four panels. The runtime
// observation arrives separately from the Context snapshot, so every fact it
// feeds lives in a [data-slot] that updateObservation() redraws in place.
import { h, icon, clear } from "/assets/js/lib/dom.js";
import { badge, chip, timeTag } from "/assets/js/ui/primitives.js";
import { label, statusBadge } from "/assets/js/domain/vocab.js";
import { totalOf } from "/assets/js/domain/context.js";
import { renderOverviewPanel } from "/assets/js/views/task/overview.js";
import { updateObservation } from "/assets/js/views/task/observation.js";
import { renderDelivery } from "/assets/js/views/task/delivery.js";
import { renderRuntime } from "/assets/js/views/task/runtime.js";
import { renderRecords } from "/assets/js/views/task/records.js";

// Overview: where it stands. Delivery: what it produced. Runtime: what is
// live now. Records: what happened. Retired section names stay addressable.
export const TABS = ${JSON.stringify(TASK_TABS)};
export const TAB_ALIASES = ${JSON.stringify(TASK_TAB_ALIASES)};
const TAB_ICONS = ${JSON.stringify(TASK_TAB_ICONS)};

export function renderTaskDetail(container, data, t, locale, ctx) {
  clear(container);
  const task = data.task;
  container.dataset.taskId = task.id;
  data.viewState.coreKey = data.core.coreCursor;
  const page = h("div.page.task-page");
  page.append(h("header.task-header", null, taskBar(task, t, ctx)),
    h("div.task-hero", null, h("h1.task-title", null, task.title), taskMeta(task, t, locale)),
    h("div.tabs-wrap", null, taskTabs(data.core, t, ctx)));
  const panels = {};
  TABS.forEach(function (tab) {
    panels[tab] = h("section.tab-panel", { id: "panel-" + tab, role: "tabpanel", "aria-labelledby": "tab-" + tab, hidden: ctx.activeTab !== tab });
    page.append(panels[tab]);
  });
  renderOverviewPanel(panels.overview, data, t, locale, ctx);
  renderDelivery(panels.delivery, data, t, locale, ctx);
  renderRuntime(panels.runtime, data, t, locale, ctx);
  renderRecords(panels.records, data, t, locale, ctx);
  container.append(page);
  updateObservation(container, data, t, locale, ctx);
  const active = panels[ctx.activeTab];
  if (active && active.onShow) active.onShow();
}

// A panel may read on first show (evidence, record pages); it keeps those
// reads in view state, so showing it again does not repeat them.
export function selectTab(container, tab) {
  container.querySelectorAll(".tab").forEach(function (button) {
    const active = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  container.querySelectorAll(".tab-panel").forEach(function (panel) {
    panel.hidden = panel.id !== "panel-" + tab;
    if (!panel.hidden && panel.onShow) panel.onShow();
  });
}

function taskBar(task, t, ctx) {
  return h("div.task-bar", null,
    h("button.icon-btn.back-btn", { type: "button", "aria-label": t("actions.back"), title: t("actions.back"), onclick: ctx.onBack }, icon("back")),
    h("nav.crumbs", { "aria-label": t("crumbs.label") },
      h("button.crumb", { type: "button", onclick: ctx.onBack }, t("crumbs.tasks")),
      h("span.crumb-sep", { "aria-hidden": "true" }, "/"),
      h("code.crumb-current", null, task.id)),
    h("span.spacer"),
    dockToggle("discussion", "chat", t("dock.discussion") + " · D", t, ctx),
    dockToggle("session", "terminal", t("dock.session"), t, ctx));
}

function dockToggle(mode, iconName, title, t, ctx) {
  return h("button.btn.btn-ghost.dock-toggle", {
    type: "button", dataset: { dockToggle: mode }, title: title,
    onclick: function () { ctx.showDock(mode); }
  }, icon(iconName), h("span", null, t("dock." + mode)));
}

function taskMeta(task, t, locale) {
  return h("div.task-meta", null,
    statusBadge(t, "task", "status", task.status),
    h("span", { dataset: { slot: "exec-badge" } }),
    task.priority ? badge(label(t, "priority", task.priority), task.priority === "urgent" || task.priority === "high" ? "accent" : "idle") : null,
    (task.tags || []).map(function (tag) { return chip("#" + tag); }),
    h("span.meta-item", null, icon("clock", "icon-sm"), t("task.updated") + " ", timeTag(task.updatedAt, locale, t)),
    (task.projectBindings || []).length ? h("span.meta-item", null, icon("layers", "icon-sm"),
      task.projectBindings.map(function (binding) { return binding.projectId; }).join(", ")) : null);
}

function taskTabs(core, t, ctx) {
  // Tab counts are current totals from the same bounded read, not samples:
  // open questions, open work items and open execution records.
  const counts = {
    overview: core.attention.openInputs.count,
    delivery: totalOf(core, "work-item"),
    runtime: totalOf(core, "run")
  };
  const tabs = h("nav.tabs", { role: "tablist", "aria-label": t("tabs.label") }, TABS.map(function (tab, index) {
    return h("button.tab", {
      type: "button", role: "tab", id: "tab-" + tab,
      "aria-controls": "panel-" + tab,
      "aria-selected": String(ctx.activeTab === tab),
      tabIndex: ctx.activeTab === tab ? 0 : -1,
      title: t("tabs." + tab) + " · " + (index + 1),
      dataset: { tab: tab },
      onclick: function () { ctx.onTab(tab); }
    }, icon(TAB_ICONS[tab], "icon-sm"), h("span", null, t("tabs." + tab)),
    counts[tab] ? h("span.count" + (tab === "overview" ? ".tone-warn" : ""), null, String(counts[tab])) : null);
  }));
  tabs.addEventListener("keydown", function (event) { moveTab(tabs, event, ctx); });
  return tabs;
}

// Left/Right arrows move the selection and the focus to the adjacent tab.
function moveTab(tabs, event, ctx) {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
  event.preventDefault();
  const selected = tabs.querySelector('[aria-selected="true"]');
  const index = TABS.indexOf(selected.dataset.tab);
  const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
  ctx.onTab(next);
  const button = tabs.querySelector('[data-tab="' + next + '"]');
  if (button) button.focus();
}
`;
