export const APP_SCRIPT = String.raw`
// Application controller: view state, URL routing, the refresh loop, the
// sidebar | center | dock layout, keyboard shortcuts and dialogs. Everything
// kept here is view state; Task facts always come from the loopback API.
import { createI18n } from "/assets/js/i18n.js";
import { createThemeController } from "/assets/js/theme.js";
import { api, releaseMutation } from "/assets/js/api.js";
import { formatClock } from "/assets/js/format.js";
import { h } from "/assets/js/dom.js";
import { renderAttentionBar, renderFilters, renderTasks, STATUS_FILTERS, ATTENTION_KINDS } from "/assets/js/sidebar.js";
import { renderOverview } from "/assets/js/overview.js";
import { renderTaskDetail, selectTab, updateObservation, TABS } from "/assets/js/detail.js";
import { renderDiscussion, discussionHasUnsent, createTerminalController, sameTarget } from "/assets/js/dock.js";
import { entriesOf } from "/assets/js/records.js";

const $ = function (selector) { return document.querySelector(selector); };
const el = {
  sidebar: $(".sidebar"), sidebarDivider: $("#sidebar-divider"), center: $("#center"), detail: $("#detail"),
  search: $("#search"), filters: $("#status-filters"), attention: $("#attention-bar"), tasks: $("#task-list"),
  catalogNext: $("#catalog-next"), catalogReset: $("#catalog-reset"), catalogCount: $("#catalog-count"),
  catalogAttentionReset: $("#catalog-attention-reset"),
  refresh: $("#refresh"), sync: $("#sync-state"), lastSync: $("#last-sync"), toast: $("#toast"),
  operator: $("#operator-terminal"), settingsOpen: $("#settings-open"), settings: $("#settings-dialog"),
  locale: $("#locale-select"), themeOptions: $("#theme-options"),
  dock: $("#dock"), divider: $("#dock-divider"), dockSwap: $("#dock-swap"), dockClose: $("#dock-close"),
  dockTabDiscussion: $("#dock-tab-discussion"), dockTabSession: $("#dock-tab-session"),
  discussion: $("#dock-discussion"), session: $("#dock-session"),
  terminalHost: $("#terminal-host"), terminalEmpty: $("#terminal-empty"), terminalState: $("#terminal-state"),
  sessionTargets: $("#session-targets"), terminalCli: $("#terminal-cli")
};

const state = {
  tasks: [], counts: null, attention: [], catalogAttention: null, catalogScope: null, catalogQuery: "",
  catalogAll: false, catalogTotal: 0, catalogCursor: null, nextCursor: null,
  sessionOverview: null, sessionLoading: false, sessionError: null,
  attentionFilter: null, generatedAt: null, filter: "all", query: "",
  selected: null, detail: null, detailKey: null, activeTab: "overview"
};

function readPreference(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function writePreference(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function clearPreference(key) {
  try { localStorage.removeItem(key); } catch {}
}
const dock = {
  open: readPreference("yui.dock.open", "true") !== "false",
  mode: "discussion",
  center: readPreference("yui.dock.side", "end") === "center",
  width: Number(readPreference("yui.dock.width", "440")) || 440,
  // On narrow screens the dock is a full-screen sheet opened explicitly per
  // Task, never restored from the desktop preference.
  sheet: false
};
// Task list width: null keeps the CSS default (--sidebar-w); otherwise the width
// the user dragged to. It is a preference; the width actually applied is clamped
// to the current window.
const sidebar = { width: Number(readPreference("yui.sidebar.width", "")) || null, resizing: false };
const narrow = window.matchMedia("(max-width: 900px)");

const i18n = createI18n(el.locale);
const t = i18n.t;
const locale = i18n.getLocale;
const theme = createThemeController(el.themeOptions, t);
const terminal = createTerminalController({
  host: el.terminalHost, empty: el.terminalEmpty, state: el.terminalState, targets: el.sessionTargets, cli: el.terminalCli
}, t, locale, showToast);
theme.subscribe(function () { terminal.retheme(); });

let toastTimer = null;
function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(function () { el.toast.classList.remove("show"); }, 3200);
}

// --- URL / history ---------------------------------------------------------------
// The selected Task, section, status filter, search and attention filter live
// in the query string so back/forward, refresh and deep links keep context.
function readQuery() { return new URLSearchParams(window.location.search); }
function applyUrl(params, replace) {
  const entries = Array.from(params.entries()).filter(function (entry) { return entry[1] !== ""; });
  const search = entries.length ? "?" + entries.map(function (entry) {
    return encodeURIComponent(entry[0]) + "=" + encodeURIComponent(entry[1]);
  }).join("&") : "";
  const url = window.location.pathname + search + window.location.hash;
  history[replace ? "replaceState" : "pushState"]({ task: params.get("task") || null }, "", url);
}
function urlTaskId() { return readQuery().get("task") || null; }
function syncUrl(replace) {
  const params = readQuery();
  if (state.selected) params.set("task", state.selected);
  else { params.delete("task"); params.delete("section"); }
  if (state.filter !== "all") params.set("filter", state.filter); else params.delete("filter");
  if (state.query) params.set("q", state.query); else params.delete("q");
  if (state.attentionFilter) params.set("attention", state.attentionFilter); else params.delete("attention");
  if (state.catalogAll) params.set("all", "true"); else params.delete("all");
  applyUrl(params, replace);
}
function setSectionParam(section) {
  const params = readQuery();
  if (!state.selected || params.get("section") === section) return;
  if (section === "overview") params.delete("section"); else params.set("section", section);
  applyUrl(params, true);
}

// --- Detail rendering -------------------------------------------------------------
function detailContext() {
  return {
    activeTab: state.activeTab,
    onTab: switchTab,
    onBack: clearSelection,
    showDock: toggleDock,
    openSession: function (roleName) { openSession({ scope: "task", taskId: state.selected, roleName: roleName }); },
    answerInput: answerInput,
    inspect: api.inspect,
    artifacts: api.artifacts,
    readArtifact: api.artifact,
    evidence: api.evidence,
    panels: api.panels,
    readPanel: api.readPanel,
    control: api.control,
    updateTask: api.updateTask,
    afterWrite: function () { refreshDashboard({ quiet: true }); }
  };
}
function dockActions() {
  return {
    sendMessage: api.sendMessage,
    inspect: api.inspect,
    afterWrite: function () { refreshDashboard({ quiet: true }); }
  };
}

// Fingerprint of the rendered payload. Quiet polling skips identical reads so
// local view state (open blocks, list pages, drafts) survives.
function fingerprint(value) {
  const text = JSON.stringify(value);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return text.length + ":" + hash;
}
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

let renderedDetailKey = null;
let renderedDiscussionKey = null;
function centerIsBusy() {
  const active = document.activeElement;
  const editing = active && (["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName) || active.isContentEditable);
  return el.detail.dataset.taskId === (state.detail && state.detail.task.id)
    && (el.detail.querySelector('[data-unsent="true"]') || el.detail.querySelector('[data-reading="true"]')
      || editing && el.center.contains(active));
}
function renderCurrentDetail(force) {
  if (!state.detail) {
    if (!state.selected) { renderedDetailKey = null; showOverview(); }
    return;
  }
  renderDock();
  // Polling must not replace an unsent draft or an in-flight form, including
  // after focus moved. This is view state, never Task state.
  if (centerIsBusy()) return;
  const key = locale() + "|" + state.detailKey + "|" + runtimeSignature(state.detail);
  if (!force && key === renderedDetailKey) return;
  const openSections = Array.from(el.detail.querySelectorAll("details[data-view-key][open]")).map(function (d) { return d.dataset.viewKey; });
  const focusedTab = el.detail.querySelector(".tab:focus");
  const focusedTabId = focusedTab && focusedTab.id;
  const scroll = el.detail.dataset.taskId === state.detail.task.id ? el.center.scrollTop : 0;
  renderTaskDetail(el.detail, state.detail, t, locale(), detailContext());
  el.detail.querySelectorAll("details[data-view-key]").forEach(function (d) { d.open = openSections.includes(d.dataset.viewKey); });
  if (focusedTabId) el.detail.querySelector("#" + CSS.escape(focusedTabId)).focus({ preventScroll: true });
  el.center.scrollTop = scroll;
  renderedDetailKey = key;
  syncDockButtons();
}
function renderDock() {
  if (!state.detail) return;
  const key = locale() + "|" + state.detail.task.id + "|" + state.detailKey + "|" + state.detail.task.status;
  if (key !== renderedDiscussionKey || el.discussion.dataset.taskId !== state.detail.task.id) {
    renderDiscussion(el.discussion, state.detail, t, locale(), dockActions());
    renderedDiscussionKey = key;
  }
  updateSessionTargets();
}
function updateSessionTargets() {
  const targets = [];
  if (state.detail) {
    const runtimeRoles = (state.detail.runtime && state.detail.runtime.roles) || [];
    entriesOf(state.detail.core, "role").forEach(function (entry) {
      const runtimeRole = runtimeRoles.find(function (role) { return role.name === entry.ref.refId; });
      targets.push({ scope: "task", taskId: state.detail.task.id, roleName: entry.ref.refId,
        live: !!(runtimeRole && runtimeRole.runtimeSession && runtimeRole.runtimeSession.nativeSessionId) });
    });
  }
  targets.push({ scope: "global", roleName: "operator" });
  const current = terminal.current();
  if (current && !targets.some(function (target) { return sameTarget(target, current); })) targets.unshift(current);
  terminal.setTargets(targets);
}

function showOverview() {
  delete el.detail.dataset.taskId;
  renderOverview(el.detail, state, t, locale(), {
    select: selectTask,
    filterAttention: pickAttention,
    readSessions: readPageSessions,
    openOperator: openOperator
  });
}

function switchTab(tab, options) {
  if (!TABS.includes(tab)) return;
  state.activeTab = tab;
  selectTab(el.detail, tab);
  if (!(options && options.keepScroll)) el.center.scrollTop = 0;
  setSectionParam(tab);
}
// A section may name a tab or any anchored block inside one (for example
// "reviews" → the Work tab, scrolled to #detail-reviews).
function applySection(section) {
  if (!section || TABS.includes(section)) { switchTab(section || "overview"); return; }
  const anchor = el.detail.querySelector("#detail-" + CSS.escape(section));
  const panel = anchor && anchor.closest(".tab-panel");
  if (!panel) { switchTab("overview"); return; }
  state.activeTab = panel.id.replace(/^panel-/, "");
  selectTab(el.detail, state.activeTab);
  anchor.scrollIntoView({ block: "start" });
}

// --- Loading ----------------------------------------------------------------------
async function loadTaskDetail(taskId, navigate) {
  if (navigate) {
    el.detail.replaceChildren(h("div.page", null, h("div.loading-block", null, h("span.spinner"), h("span", null, t("loading.detail")))));
    delete el.detail.dataset.taskId;
    el.center.scrollTop = 0;
  }
  // Rendering consumes the current Context snapshot, not event pages.
  const core = await api.context(taskId);
  const taskEntry = core.records.find(function (entry) { return entry.ref.store === "task"; });
  if (!taskEntry) throw new Error("Task reference unavailable.");
  const task = taskEntry.omitted ? (await api.inspect(taskId, taskEntry.ref)).value : taskEntry.value;
  if (state.selected !== taskId) return;
  const previous = state.detail && state.detail.task.id === taskId ? state.detail : null;
  const detail = {
    task: task, core: core,
    viewState: previous ? previous.viewState : {},
    runtime: previous ? previous.runtime : null,
    runtimeStatus: previous ? previous.runtimeStatus : "waiting",
    runtimeObservedAt: previous ? previous.runtimeObservedAt : new Date().toISOString()
  };
  state.detail = detail;
  state.detailKey = fingerprint(core);
  renderCurrentDetail(navigate);
  if (navigate) applySection(readQuery().get("section"));
  // The optional observation never participates in core readiness.
  api.observation(taskId).then(function (runtime) {
    if (state.detail !== detail) return;
    detail.runtime = runtime;
    detail.runtimeStatus = "available";
    detail.runtimeObservedAt = new Date().toISOString();
    observationArrived(detail);
  }).catch(function () {
    if (state.detail !== detail) return;
    detail.runtime = null;
    detail.runtimeStatus = "unavailable";
    detail.runtimeObservedAt = new Date().toISOString();
    observationArrived(detail);
  });
}
function observationArrived(detail) {
  if (el.detail.dataset.taskId === detail.task.id) updateObservation(el.detail, detail, t, locale(), detailContext());
  // Patching slots is not enough when the observed identity changed facts the
  // detail drew earlier; the render key decides whether a re-render is due.
  if (state.detail === detail) renderCurrentDetail();
}

let refreshing = false;
let catalogRequest = 0;
function resetCatalog() {
  state.catalogCursor = null;
  state.nextCursor = null;
  refreshDashboard();
}
async function refreshDashboard(options) {
  const quiet = options && options.quiet;
  if (refreshing && quiet) return;
  const request = ++catalogRequest;
  refreshing = true;
  el.catalogNext.disabled = true;
  el.sync.dataset.state = "syncing";
  if (!quiet) {
    el.refresh.disabled = true;
    if (!state.tasks.length) el.tasks.replaceChildren(h("div.loading-block", null, h("span.spinner"), h("span", null, t("loading.dashboard"))));
  }
  const previousInputs = state.counts ? state.counts.openInputs : null;
  try {
    const query = new URLSearchParams();
    if (state.catalogAll) query.set("all", "true");
    if (state.filter !== "all") query.set("status", state.filter);
    if (state.query.trim()) query.set("search", state.query.trim());
    if (state.attentionFilter) query.set("attention", state.attentionFilter);
    if (state.catalogCursor) query.set("cursor", state.catalogCursor);
    const dashboard = await api.dashboard(query.toString());
    if (request !== catalogRequest) return;
    state.tasks = dashboard.tasks;
    if (state.catalogQuery !== query.toString() || (state.sessionOverview && JSON.stringify(
      state.sessionOverview.tasks.map(function (task) { return task.taskId; })) !== JSON.stringify(dashboard.tasks.map(function (task) { return task.id; })))) {
      state.sessionOverview = null;
    }
    state.catalogQuery = query.toString();
    state.counts = { ...dashboard.counts, openInputs: dashboard.attention.openInputs.count };
    state.catalogAttention = dashboard.attention;
    state.catalogScope = dashboard.scope;
    state.catalogTotal = dashboard.total;
    state.nextCursor = dashboard.nextCursor;
    state.attention = dashboard.attention.openInputs.refs.map(function (ref) {
      const task = state.tasks.find(function (entry) { return entry.id === ref.taskId; });
      return { taskId: ref.taskId, taskTitle: task ? task.title : ref.taskId };
    });
    state.generatedAt = new Date().toISOString();
    el.sync.dataset.state = "ok";
    renderSidebar();
    if (!state.selected) showOverview();
    if (previousInputs !== null && state.counts.openInputs > previousInputs) showToast(t("input.new"));
    // A selected Task may live on another page or outside current filters;
    // only its own read can establish that it no longer exists.
    if (state.selected) {
      try { await loadTaskDetail(state.selected, false); }
      catch { showToast(t("errors.disconnected")); }
    }
  } catch {
    if (request !== catalogRequest) return;
    el.sync.dataset.state = "error";
    if (!quiet) {
      el.tasks.replaceChildren(h("div.list-empty.is-error", null, h("p", null, t("errors.dashboard"))));
      showToast(t("errors.dashboard"));
    }
  } finally {
    if (request === catalogRequest) {
      refreshing = false;
      el.refresh.disabled = false;
      el.catalogNext.disabled = !state.nextCursor;
    }
  }
}

function renderSidebar() {
  renderAttentionBar(el.attention, state, t, pickAttention);
  renderFilters(el.filters, state, t, function (filter) {
    state.filter = filter;
    state.attentionFilter = null;
    state.catalogAll = false;
    syncUrl(false);
    resetCatalog();
  });
  el.catalogCount.textContent = t("catalog.count").replace("{shown}", String(state.tasks.length)).replace("{total}", String(state.catalogTotal));
  el.catalogReset.hidden = !state.catalogCursor;
  el.catalogNext.hidden = !state.nextCursor && !state.catalogCursor;
  el.catalogAttentionReset.hidden = !state.attentionFilter;
  const scroll = el.tasks.scrollTop;
  renderTasks(el.tasks, state, t, locale(), selectTask);
  el.tasks.scrollTop = scroll;
  el.lastSync.textContent = state.generatedAt ? formatClock(state.generatedAt, locale()) : "—";
}

async function readPageSessions() {
  if (state.sessionLoading) return;
  const query = state.catalogQuery;
  state.sessionLoading = true;
  showOverview();
  try {
    const result = await api.pageSessions(query);
    if (query !== state.catalogQuery) return;
    if (JSON.stringify(result.tasks.map(function (task) { return task.taskId; })) !== JSON.stringify(state.tasks.map(function (task) { return task.id; }))) {
      throw new Error(t("overview.sessionsPageChanged"));
    }
    state.sessionOverview = result;
    state.sessionError = null;
  } catch (error) { state.sessionError = error.message; }
  finally {
    state.sessionLoading = false;
    if (!state.selected) showOverview();
  }
}

function pickAttention(kind) {
  state.attentionFilter = kind;
  state.catalogAll = !!kind && !!state.catalogScope && state.catalogScope.archived === "included";
  state.filter = "all";
  state.query = "";
  el.search.value = "";
  syncUrl(false);
  resetCatalog();
}

// --- Selection --------------------------------------------------------------------
function hasUnsent() {
  return !!(el.detail.querySelector('[data-unsent="true"]') || discussionHasUnsent(el.discussion));
}
function canLeaveDetail() {
  return !hasUnsent() || window.confirm(t("confirm.leave"));
}
window.addEventListener("beforeunload", function (event) {
  if (!hasUnsent()) return;
  event.preventDefault();
  event.returnValue = "";
});

async function selectTask(taskId) {
  // Re-selecting the visible Task is not navigation.
  if (state.selected === taskId && state.detail) return;
  if (state.selected !== taskId && !canLeaveDetail()) { syncUrl(true); return; }
  if (urlTaskId() !== taskId) {
    const params = readQuery();
    params.delete("section");
    applyUrl(params, true);
  }
  state.selected = taskId;
  state.detail = null;
  state.activeTab = "overview";
  dock.sheet = false;
  renderedDetailKey = null;
  renderedDiscussionKey = null;
  el.discussion.replaceChildren();
  delete el.discussion.dataset.taskId;
  syncUrl(state.selected === urlTaskId());
  updateLayout();
  const scroll = el.tasks.scrollTop;
  renderTasks(el.tasks, state, t, locale(), selectTask);
  el.tasks.scrollTop = scroll;
  try {
    await loadTaskDetail(taskId, true);
  } catch {
    if (state.selected !== taskId) return;
    el.detail.replaceChildren(h("div.page", null, h("div.list-empty.is-error", null, h("p", null, t("errors.detail")))));
    showToast(t("errors.detail"));
  }
}

function clearSelection() {
  if (!canLeaveDetail()) return;
  state.selected = null;
  state.detail = null;
  el.discussion.replaceChildren();
  delete el.discussion.dataset.taskId;
  if (dock.mode === "discussion" || (terminal.current() && terminal.current().scope === "task")) {
    if (!terminal.connected()) dock.mode = "discussion";
  }
  syncUrl(!urlTaskId());
  updateLayout();
  showOverview();
  const scroll = el.tasks.scrollTop;
  renderTasks(el.tasks, state, t, locale(), selectTask);
  el.tasks.scrollTop = scroll;
  updateSessionTargets();
}

async function answerInput(input, answer, control) {
  if (!state.detail) return;
  const taskId = state.detail.task.id;
  if (control) control.disabled = true;
  try {
    await api.answerInput(taskId, input.id, answer);
    releaseMutation(taskId + "/input/" + input.id);
    showToast(t("input.answered"));
    const form = control && control.closest("form");
    if (form) form.dataset.unsent = "false";
    await refreshDashboard({ quiet: true });
  } catch (error) {
    if (control) control.disabled = error.disposition !== "not-submitted";
    showToast(error.disposition === "not-submitted" ? error.message : t("input.unknown"));
  }
}

// --- Dock layout ------------------------------------------------------------------
function dockVisible() {
  if (narrow.matches ? !dock.sheet : !dock.open) return false;
  if (state.selected) return true;
  return dock.mode === "session" && terminal.connected();
}
function maxDockWidth() {
  const sidebar = window.innerWidth > 900 ? el.sidebar.offsetWidth : 0;
  return Math.max(320, Math.min(760, window.innerWidth - sidebar - 420));
}
function setDockWidth(width, persist) {
  const effective = Math.max(320, Math.min(maxDockWidth(), width));
  document.documentElement.style.setProperty("--dock-w", effective + "px");
  el.divider.setAttribute("aria-valuemax", String(maxDockWidth()));
  el.divider.setAttribute("aria-valuenow", String(effective));
  if (persist) { dock.width = effective; writePreference("yui.dock.width", String(effective)); }
}
function updateLayout() {
  const visible = dockVisible();
  document.body.classList.toggle("task-open", !!state.selected);
  document.body.classList.toggle("dock-open", visible);
  document.body.classList.toggle("dock-center", dock.center);
  el.dock.hidden = !visible;
  el.divider.hidden = !visible;
  el.discussion.hidden = dock.mode !== "discussion";
  el.session.hidden = dock.mode !== "session";
  el.dockTabDiscussion.setAttribute("aria-selected", String(dock.mode === "discussion"));
  el.dockTabSession.setAttribute("aria-selected", String(dock.mode === "session"));
  el.dockTabDiscussion.disabled = !state.selected;
  el.dockSwap.setAttribute("aria-pressed", String(dock.center));
  applySidebarWidth();
  syncDockButtons();
}
function syncDockButtons() {
  const visible = dockVisible();
  el.detail.querySelectorAll("[data-dock-toggle]").forEach(function (button) {
    button.setAttribute("aria-pressed", String(visible && dock.mode === button.dataset.dockToggle));
  });
  el.operator.setAttribute("aria-pressed", String(visible && dock.mode === "session"
    && !!terminal.current() && terminal.current().scope === "global"));
}
function setDockOpen(open) {
  if (narrow.matches) dock.sheet = open;
  else {
    dock.open = open;
    writePreference("yui.dock.open", String(open));
  }
  if (!open && terminal.connected()) terminal.close();
  updateLayout();
}
function setDockMode(mode) {
  dock.mode = mode === "session" || !state.selected ? "session" : "discussion";
  updateLayout();
}
function toggleDock(mode) {
  if (dockVisible() && (!mode || dock.mode === mode)) { setDockOpen(false); return; }
  if (mode) dock.mode = mode === "session" || !state.selected ? mode : "discussion";
  if (!state.selected && dock.mode === "discussion") dock.mode = "session";
  setDockOpen(true);
}
function openSession(target) {
  dock.mode = "session";
  if (narrow.matches) dock.sheet = true;
  else {
    dock.open = true;
    writePreference("yui.dock.open", "true");
  }
  terminal.open(target);
  updateLayout();
  updateSessionTargets();
}
function openOperator() { openSession({ scope: "global", roleName: "operator" }); }

el.dockTabDiscussion.addEventListener("click", function () { setDockMode("discussion"); });
el.dockTabSession.addEventListener("click", function () { setDockMode("session"); });
el.dockClose.addEventListener("click", function () { setDockOpen(false); });
el.dockSwap.addEventListener("click", function () {
  dock.center = !dock.center;
  writePreference("yui.dock.side", dock.center ? "center" : "end");
  updateLayout();
});
el.operator.addEventListener("click", function () {
  const current = terminal.current();
  if (dockVisible() && dock.mode === "session" && current && current.scope === "global") { setDockOpen(false); return; }
  openOperator();
});

let resizing = false;
el.divider.addEventListener("pointerdown", function (event) {
  if (event.button !== 0 || window.innerWidth <= 900) return;
  resizing = true;
  el.divider.setPointerCapture(event.pointerId);
  document.body.classList.add("dock-resizing");
  event.preventDefault();
});
el.divider.addEventListener("pointermove", function (event) {
  if (!resizing) return;
  const rect = el.dock.getBoundingClientRect();
  const width = dock.center ? event.clientX - rect.left : rect.right - event.clientX;
  setDockWidth(width, false);
  dock.width = Math.max(320, Math.min(maxDockWidth(), width));
});
function finishResize() {
  if (!resizing) return;
  resizing = false;
  document.body.classList.remove("dock-resizing");
  writePreference("yui.dock.width", String(dock.width));
}
el.divider.addEventListener("pointerup", finishResize);
el.divider.addEventListener("pointercancel", finishResize);
el.divider.addEventListener("keydown", function (event) {
  const grow = dock.center ? "ArrowRight" : "ArrowLeft";
  const shrink = dock.center ? "ArrowLeft" : "ArrowRight";
  const delta = event.key === grow ? 24 : event.key === shrink ? -24 : 0;
  if (!delta && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  setDockWidth(event.key === "Home" ? 320 : event.key === "End" ? maxDockWidth() : dock.width + delta, true);
});
narrow.addEventListener("change", updateLayout);

// --- Sidebar width ----------------------------------------------------------------
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 560;
function maxSidebarWidth() {
  // An open dock can shrink to its minimum, so it reserves only that much.
  const reserve = dockVisible() ? 320 + 9 : 0;
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - reserve - 420));
}
function applySidebarWidth() {
  const root = document.documentElement.style;
  if (sidebar.width === null) root.removeProperty("--sidebar-w");
  else root.setProperty("--sidebar-w", Math.max(SIDEBAR_MIN, Math.min(maxSidebarWidth(), sidebar.width)) + "px");
  // A wider task list leaves the dock less room; the dock keeps its stored width.
  setDockWidth(dock.width, false);
  el.sidebarDivider.setAttribute("aria-valuemax", String(maxSidebarWidth()));
  el.sidebarDivider.setAttribute("aria-valuenow", String(el.sidebar.offsetWidth));
}
function setSidebarWidth(width, persist) {
  sidebar.width = width === null ? null : Math.max(SIDEBAR_MIN, Math.min(maxSidebarWidth(), Math.round(width)));
  if (persist) {
    if (sidebar.width === null) clearPreference("yui.sidebar.width");
    else writePreference("yui.sidebar.width", String(sidebar.width));
  }
  applySidebarWidth();
}
el.sidebarDivider.addEventListener("pointerdown", function (event) {
  if (event.button !== 0 || window.innerWidth <= 900) return;
  sidebar.resizing = true;
  el.sidebarDivider.setPointerCapture(event.pointerId);
  document.body.classList.add("sidebar-resizing");
  event.preventDefault();
});
el.sidebarDivider.addEventListener("pointermove", function (event) {
  if (!sidebar.resizing) return;
  setSidebarWidth(event.clientX - el.sidebar.getBoundingClientRect().left, false);
});
function finishSidebarResize() {
  if (!sidebar.resizing) return;
  sidebar.resizing = false;
  document.body.classList.remove("sidebar-resizing");
  if (sidebar.width !== null) writePreference("yui.sidebar.width", String(sidebar.width));
}
el.sidebarDivider.addEventListener("pointerup", finishSidebarResize);
el.sidebarDivider.addEventListener("pointercancel", finishSidebarResize);
el.sidebarDivider.addEventListener("dblclick", function () { setSidebarWidth(null, true); });
el.sidebarDivider.addEventListener("keydown", function (event) {
  const current = el.sidebar.offsetWidth;
  const next = event.key === "ArrowRight" ? current + 16 : event.key === "ArrowLeft" ? current - 16
    : event.key === "Home" ? SIDEBAR_MIN : event.key === "End" ? maxSidebarWidth() : null;
  if (next === null) return;
  event.preventDefault();
  setSidebarWidth(next, true);
});
window.addEventListener("resize", applySidebarWidth);

// --- Sidebar controls -------------------------------------------------------------
let searchTimer = null;
el.search.addEventListener("input", function () {
  state.query = el.search.value;
  syncUrl(true);
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(resetCatalog, 200);
});
el.catalogNext.addEventListener("click", function () {
  if (!state.nextCursor) return;
  state.catalogCursor = state.nextCursor;
  refreshDashboard();
});
el.catalogReset.addEventListener("click", resetCatalog);
el.catalogAttentionReset.addEventListener("click", function () { pickAttention(null); });
el.refresh.addEventListener("click", function () { refreshDashboard(); });
el.settingsOpen.addEventListener("click", function () { el.settings.showModal(); });

// --- Global Role input ------------------------------------------------------------
const globalDialog = $("#global-input-dialog");
const globalForm = $("#global-input-form");
const globalRole = $("#global-input-role");
const globalAction = $("#global-input-action");
const globalBody = $("#global-input-body");
const globalTarget = $("#global-input-target");
const globalThen = $("#global-input-then");
const globalSubmit = $("#global-input-submit");
const globalReceipt = $("#global-input-receipt");
const globalState = $("#global-input-state");
$("#global-input-open").addEventListener("click", function () { globalDialog.showModal(); });
$("#global-input-close").addEventListener("click", function () { globalDialog.close(); });
globalAction.addEventListener("change", function () {
  $("#global-input-body-label").hidden = globalAction.value === "interrupt";
  $("#global-input-target-label").hidden = globalAction.value === "queue";
  $("#global-input-then-label").hidden = globalAction.value !== "interrupt";
  globalBody.required = globalAction.value !== "interrupt";
  globalTarget.required = globalAction.value !== "queue";
});
$("#global-input-inspect").addEventListener("click", async function () {
  globalState.hidden = false;
  try {
    const facts = await api.globalState(globalRole.value.trim());
    globalState.textContent = JSON.stringify(facts, null, 2);
    globalTarget.value = (facts.turn && (facts.turn.nativeTurnId || facts.turn.attemptId)) || "";
  } catch (error) { globalState.textContent = error.message; }
});
globalForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  if (globalSubmit.disabled) return;
  globalSubmit.disabled = true;
  const role = globalRole.value.trim();
  const action = globalAction.value;
  const requestId = crypto.randomUUID();
  const input = { action: action, requestId: requestId };
  if (action !== "interrupt") input.body = globalBody.value;
  if (action !== "queue") input.expectedTarget = globalTarget.value.trim();
  if (action === "interrupt" && globalThen.value.trim()) input.thenMessage = globalThen.value.trim();
  globalReceipt.dataset.state = "pending";
  globalReceipt.textContent = t("receipt.waiting") + " · " + requestId;
  try {
    const receipt = await api.globalControl(role, input);
    const status = receipt.steer || receipt.interrupt || receipt.delivery || {};
    globalReceipt.dataset.state = "ok";
    globalReceipt.textContent = JSON.stringify(receipt);
    const unknown = ["pending", "delivery-unknown", "steer-unknown", "interrupt-unknown"].includes(status.state)
      || status.code === "DELIVERY_UNKNOWN";
    globalSubmit.disabled = unknown;
    if (!unknown && !status.code) globalBody.value = "";
  } catch (error) {
    globalReceipt.dataset.state = error.disposition === "not-submitted" ? "bad" : "warn";
    globalReceipt.textContent = error.disposition === "not-submitted" ? error.message : t("receipt.unknownControl") + " · " + requestId;
    globalSubmit.disabled = error.disposition !== "not-submitted";
  }
});

// --- Keyboard ---------------------------------------------------------------------
document.addEventListener("keydown", function (event) {
  if (globalDialog.open || el.settings.open) return;
  const active = document.activeElement;
  const typing = active && (["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName) || active.isContentEditable);
  const inTerminal = el.terminalHost.contains(active);
  if (event.key === "Escape") {
    // A native Session needs its own Escape key.
    if (inTerminal) return;
    if (typing) { active.blur(); return; }
    if (dockVisible()) { setDockOpen(false); return; }
    if (state.selected) clearSelection();
    return;
  }
  if (typing || inTerminal || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "/") { event.preventDefault(); el.search.focus(); el.search.select(); }
  else if (key === "r") refreshDashboard();
  else if (key === "o") openOperator();
  else if (key === "d") toggleDock();
  else if (/^[1-5]$/.test(key) && state.detail) switchTab(TABS[Number(key) - 1]);
});

// --- Boot -------------------------------------------------------------------------
function applyStateFromUrl() {
  const params = readQuery();
  const filter = params.get("filter");
  state.filter = STATUS_FILTERS.includes(filter) ? filter : "all";
  state.query = params.get("q") || "";
  state.attentionFilter = ATTENTION_KINDS.includes(params.get("attention")) ? params.get("attention") : null;
  state.catalogAll = params.get("all") === "true";
  el.search.value = state.query;
  const taskId = params.get("task");
  if (taskId) {
    if (taskId === state.selected && state.detail) applySection(params.get("section"));
    else selectTask(taskId);
    return;
  }
  if (state.selected && !canLeaveDetail()) { syncUrl(true); return; }
  state.selected = null;
  state.detail = null;
  el.discussion.replaceChildren();
  delete el.discussion.dataset.taskId;
  updateLayout();
  showOverview();
}
window.addEventListener("popstate", function () {
  applyStateFromUrl();
  resetCatalog();
});
i18n.subscribe(function () {
  theme.render();
  terminal.relabel();
  renderSidebar();
  renderedDiscussionKey = null;
  if (state.detail) renderCurrentDetail(true); else showOverview();
  updateLayout();
});

updateLayout();
showOverview();
applyStateFromUrl();
refreshDashboard();
window.setInterval(function () { refreshDashboard({ quiet: true }); }, 5000);
`;
