export const TASK_VIEW_SCRIPT = String.raw`
// The selected Task on screen: the center page, the dock discussion and its
// Session targets, and the section (tab) the reader is on. This module draws
// state.detail; app/selection loads it. A re-render is skipped while the
// reader has an unsent draft, an in-flight read or focus in the center. The
// only state field written here is state.activeTab.
import { h, isEditing } from "/assets/js/lib/dom.js";
import { releaseMutation } from "/assets/js/lib/api.js";
import { loadingBlock } from "/assets/js/ui/primitives.js";
import { entriesOf } from "/assets/js/domain/context.js";
import { renderOverview } from "/assets/js/views/overview.js";
import { renderTaskDetail, selectTab, TABS, TAB_ALIASES } from "/assets/js/views/task/page.js";
import { updateObservation } from "/assets/js/views/task/observation.js";
import { renderDiscussion, discussionHasUnsent } from "/assets/js/views/dock/discussion.js";
import { sameTarget } from "/assets/js/views/dock/terminal.js";
import { setSectionParam } from "/assets/js/layout/router.js";

// Only the observed identity participates: observation timestamps advance on
// every poll and would otherwise re-render continuously.
function runtimeSignature(detail) {
  const runtime = detail.runtime;
  return detail.runtimeStatus + "|" + JSON.stringify(runtime ? [
    runtime.sessions && runtime.sessions.sessions, runtime.remoteDelivery,
    runtime.execution && runtime.execution.attention, runtime.execution && runtime.execution.blockers,
    runtime.execution && runtime.execution.next, runtime.execution && runtime.execution.status
  ] : null) + "|" + ((runtime && runtime.roles) || []).map(function (role) {
    return role.name + ":" + (role.runtimeSession ? role.runtimeSession.nativeSessionId + "/" + role.runtimeSession.status : "-") + ":" + role.status;
  }).join(",");
}

// deps: { el, state, t, locale, api, toast, terminal, workspace,
//         selectTask, clearSelection, pickAttention, readPageSessions, refreshCatalog }
//   el         #detail, #center and the dock discussion
//   state      reads selected, detail, detailKey and the catalog fields the
//              overview shows; writes activeTab
//   api        Task reads for lazy blocks and the Task page's writes
//   terminal   the dock's native Session (views/dock/terminal)
//   workspace  layout/workspace: dock toggles and opening Sessions
//   selectTask(taskId)  an overview row was chosen (app/selection)
//   clearSelection()    the Task page's back button (app/selection)
//   pickAttention(kind), readPageSessions()  overview actions (app/catalog)
//   refreshCatalog()    quiet catalog refresh after a write; resolves when done
export function createTaskView(deps) {
  const view = {
    deps: deps,
    // The render keys of what is on screen; an unchanged key skips the redraw.
    rendered: { detail: null, discussion: null },
    controller: null
  };
  view.controller = {
    enterTask: function () { enterTask(view); },
    leaveTask: function () { clearDiscussion(deps.el); },
    showLoading: function () { showLoading(deps); },
    showDetailError: function () { showDetailError(deps); },
    hasUnsent: function () { return hasUnsent(deps.el); },
    render: function (force) { render(view, force); },
    observationArrived: function (detail) { observationArrived(view, detail); },
    relabel: function () { relabel(view); },
    showOverview: function () { showOverview(deps); },
    updateSessionTargets: function () { updateSessionTargets(deps); },
    switchTab: function (tab, options) { switchTab(deps, tab, options); },
    applySection: function (section) { applySection(deps, section); }
  };
  return view.controller;
}

// A Task was just selected: start on its overview tab with nothing drawn.
function enterTask(view) {
  view.deps.state.activeTab = "overview";
  view.rendered.detail = null;
  view.rendered.discussion = null;
  clearDiscussion(view.deps.el);
}

function clearDiscussion(el) {
  el.discussion.replaceChildren();
  delete el.discussion.dataset.taskId;
}

function showLoading(deps) {
  const el = deps.el;
  el.detail.replaceChildren(h("div.page", null, loadingBlock(deps.t("loading.detail"))));
  delete el.detail.dataset.taskId;
  el.center.scrollTop = 0;
}

function showDetailError(deps) {
  deps.el.detail.replaceChildren(h("div.page", null, h("div.list-empty.is-error", null, h("p", null, deps.t("errors.detail")))));
}

// An unsent draft in the Task page or the dock discussion.
function hasUnsent(el) {
  return !!(el.detail.querySelector('[data-unsent="true"]') || discussionHasUnsent(el.discussion));
}

// The locale changed: redraw everything that carries text.
function relabel(view) {
  view.rendered.discussion = null;
  if (view.deps.state.detail) render(view, true); else showOverview(view.deps);
}

function render(view, force) {
  const deps = view.deps;
  const state = deps.state;
  if (!state.detail) {
    if (!state.selected) { view.rendered.detail = null; showOverview(deps); }
    return;
  }
  renderDock(view);
  // Polling must not replace an unsent draft or an in-flight form, including
  // after focus moved. This is view state, never Task state.
  if (centerIsBusy(deps)) return;
  const key = deps.locale() + "|" + state.detailKey + "|" + runtimeSignature(state.detail);
  if (!force && key === view.rendered.detail) return;
  drawDetail(deps, detailContext(view));
  view.rendered.detail = key;
  deps.workspace.syncDockButtons();
}

function renderDock(view) {
  const deps = view.deps;
  const detail = deps.state.detail;
  const el = deps.el;
  const key = deps.locale() + "|" + detail.task.id + "|" + deps.state.detailKey + "|" + detail.task.status;
  if (key !== view.rendered.discussion || el.discussion.dataset.taskId !== detail.task.id) {
    renderDiscussion(el.discussion, detail, deps.t, deps.locale(), dockActions(deps));
    view.rendered.discussion = key;
  }
  updateSessionTargets(deps);
}

function observationArrived(view, detail) {
  const deps = view.deps;
  if (deps.el.detail.dataset.taskId === detail.task.id) updateObservation(deps.el.detail, detail, deps.t, deps.locale(), detailContext(view));
  // Patching slots is not enough when the observed identity changed facts the
  // detail drew earlier; the render key decides whether a re-render is due.
  if (deps.state.detail === detail) render(view);
}

// Everything the Task page (views/task/*) may call back into.
function detailContext(view) {
  const deps = view.deps;
  const api = deps.api;
  return {
    activeTab: deps.state.activeTab,
    onTab: view.controller.switchTab,
    onBack: deps.clearSelection,
    showDock: deps.workspace.toggleDock,
    openConversation: function (materials) {
      deps.workspace.openConversation({ scope: "task", taskId: deps.state.selected, roleName: "leader" }, materials);
    },
    openSession: function (roleName) { deps.workspace.openSession({ scope: "task", taskId: deps.state.selected, roleName: roleName }); },
    answerInput: function (input, answer, control) { return answerInput(deps, input, answer, control); },
    taskAction: deps.api.taskAction,
    inspect: api.inspect,
    list: api.list,
    artifacts: api.artifacts,
    readArtifact: api.artifact,
    evidence: api.evidence,
    panels: api.panels,
    readPanel: api.readPanel,
    control: api.control,
    updateTask: api.updateTask,
    afterWrite: function () { deps.refreshCatalog(); }
  };
}

// Everything the dock discussion (views/dock/discussion) may call back into.
function dockActions(deps) {
  return {
    sendMessage: deps.api.sendMessage,
    inspect: deps.api.inspect,
    list: deps.api.list,
    afterWrite: function () { deps.refreshCatalog(); }
  };
}

async function answerInput(deps, input, answer, control) {
  if (!deps.state.detail) return;
  const taskId = deps.state.detail.task.id;
  const card = control && control.closest(".input-card");
  const controls = card ? Array.from(card.querySelectorAll("button, input")) : control ? [control] : [];
  const receipt = card && card.querySelector("[data-input-receipt]");
  if (card) card.dataset.unsent = "true";
  controls.forEach(function (item) { item.disabled = true; });
  if (receipt) receipt.textContent = deps.t("receipt.waiting");
  try {
    const result = await deps.api.answerInput(taskId, input.id, answer);
    releaseMutation(taskId + "/input/" + input.id);
    const text = result.request.id + " · " + result.request.status + " · "
      + (result.request.resolution ? result.request.resolution.answer.text : "");
    if (receipt) receipt.textContent = text;
    if (card) card.dataset.unsent = "false";
    deps.toast(text);
    const form = control && control.closest("form");
    if (form) form.dataset.unsent = "false";
    await deps.refreshCatalog();
  } catch (error) {
    controls.forEach(function (item) { item.disabled = error.disposition !== "not-submitted"; });
    if (card && error.disposition === "not-submitted") card.dataset.unsent = "false";
    const text = error.disposition === "not-submitted" ? error.message : deps.t("input.unknown");
    if (receipt) receipt.textContent = text;
    deps.toast(text);
  }
}

function centerIsBusy(deps) {
  const el = deps.el;
  const active = document.activeElement;
  return el.detail.dataset.taskId === (deps.state.detail && deps.state.detail.task.id)
    && (el.detail.querySelector('[data-unsent="true"]') || el.detail.querySelector('[data-reading="true"]')
      || isEditing(active) && el.center.contains(active));
}

// Re-render the page, restoring what the reader had open, the focused tab and
// the scroll position.
function drawDetail(deps, ctx) {
  const el = deps.el;
  const detail = deps.state.detail;
  const openSections = Array.from(el.detail.querySelectorAll("details[data-view-key][open]")).map(function (d) { return d.dataset.viewKey; });
  const focusedTab = el.detail.querySelector(".tab:focus");
  const focusedTabId = focusedTab && focusedTab.id;
  const scroll = el.detail.dataset.taskId === detail.task.id ? el.center.scrollTop : 0;
  renderTaskDetail(el.detail, detail, deps.t, deps.locale(), ctx);
  el.detail.querySelectorAll("details[data-view-key]").forEach(function (d) { d.open = openSections.includes(d.dataset.viewKey); });
  if (focusedTabId) el.detail.querySelector("#" + CSS.escape(focusedTabId)).focus({ preventScroll: true });
  el.center.scrollTop = scroll;
}

// The dock's Session chips: every role of the selected Task plus the global
// operator, keeping the Session currently open even when it left the list.
function updateSessionTargets(deps) {
  const detail = deps.state.detail;
  const targets = [];
  if (detail) {
    const runtimeRoles = (detail.runtime && detail.runtime.roles) || [];
    entriesOf(detail.core, "role").forEach(function (entry) {
      const runtimeRole = runtimeRoles.find(function (role) { return role.name === entry.ref.refId; });
      targets.push({ scope: "task", taskId: detail.task.id, roleName: entry.ref.refId,
        live: !!(runtimeRole && runtimeRole.runtimeSession && runtimeRole.runtimeSession.nativeSessionId) });
    });
  }
  targets.push({ scope: "global", roleName: "operator" });
  const current = deps.terminal.current();
  if (current && !targets.some(function (target) { return sameTarget(target, current); })) targets.unshift(current);
  deps.terminal.setTargets(targets);
}

function showOverview(deps) {
  delete deps.el.detail.dataset.taskId;
  renderOverview(deps.el.detail, deps.state, deps.t, deps.locale(), {
    select: deps.selectTask,
    filterAttention: deps.pickAttention,
    readSessions: deps.readPageSessions,
    openOperator: deps.workspace.openOperator
  });
}

function switchTab(deps, tab, options) {
  if (!TABS.includes(tab)) return;
  deps.state.activeTab = tab;
  selectTab(deps.el.detail, tab);
  if (!(options && options.keepScroll)) deps.el.center.scrollTop = 0;
  setSectionParam(deps.state, tab);
}

// A section may name a tab, a retired tab name, or any anchored block inside
// one (for example "reviews" → the Delivery tab, scrolled to #detail-reviews).
function applySection(deps, section) {
  const tab = (section && TAB_ALIASES[section]) || section;
  if (!tab || TABS.includes(tab)) { switchTab(deps, tab || "overview"); return; }
  const anchor = deps.el.detail.querySelector("#detail-" + CSS.escape(tab));
  const panel = anchor && anchor.closest(".tab-panel");
  if (!panel) { switchTab(deps, "overview"); return; }
  deps.state.activeTab = panel.id.replace(/^panel-/, "");
  selectTab(deps.el.detail, deps.state.activeTab);
  if (anchor.tagName === "DETAILS") anchor.open = true;
  anchor.scrollIntoView({ block: "start" });
}
`;
