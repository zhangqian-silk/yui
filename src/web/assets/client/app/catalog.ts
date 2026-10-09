export const CATALOG_SCRIPT = String.raw`
// The Task catalog: the refresh loop over the dashboard read, the sidebar
// (attention, status tabs, search, paged list), its filters from the URL and
// the explicit Session read of the current catalog page. This module is the
// only writer of the catalog fields of state. Only the newest request may
// apply its result.
import { fill, formatClock } from "/assets/js/lib/format.js";
import { h } from "/assets/js/lib/dom.js";
import { loadingBlock } from "/assets/js/ui/primitives.js";
import { renderAttentionBar, renderFilters, renderTasks, STATUS_FILTERS, ATTENTION_KINDS } from "/assets/js/views/sidebar.js";
import { syncUrl } from "/assets/js/layout/router.js";

// deps: { el, state, t, locale, api, toast, selectTask, showOverview, reloadSelected }
//   el     the sidebar elements, the sync state and the refresh button
//   state  writes the catalog fields; reads state.selected
//   selectTask(taskId)  a task row was chosen (app/selection)
//   showOverview()      redraw the center overview while nothing is selected
//   reloadSelected()    re-read the selected Task; rejects when the read fails
export function createCatalog(deps) {
  // progress: whether a refresh is in flight and the newest request number.
  const progress = { refreshing: false, request: 0 };
  const catalog = {
    refresh: function (options) { return refresh(deps, progress, options); },
    reset: function () { reset(deps, progress); },
    renderSidebar: function () { renderSidebar(deps, progress); },
    renderTaskList: function () { renderTaskList(deps); },
    pickAttention: function (kind) { pickAttention(deps, progress, kind); },
    readPageSessions: function () { return readPageSessions(deps); },
    applyFilters: function (params) { applyFilters(deps, params); }
  };
  bindCatalogControls(deps.el, deps.state, catalog);
  return catalog;
}

function reset(deps, progress) {
  deps.state.catalogCursor = null;
  deps.state.nextCursor = null;
  refresh(deps, progress);
}

async function refresh(deps, progress, options) {
  const el = deps.el;
  const state = deps.state;
  const quiet = options && options.quiet;
  if (progress.refreshing && quiet) return;
  const request = ++progress.request;
  progress.refreshing = true;
  beginRefresh(el, state, deps.t, quiet);
  const previousInputs = state.counts ? state.counts.openInputs : null;
  try {
    const query = catalogQuery(state);
    const dashboard = await deps.api.dashboard(query);
    if (request !== progress.request) return;
    applyDashboard(state, dashboard, query);
    showDashboard(deps, progress, previousInputs);
    // A selected Task may live on another page or outside current filters;
    // only its own read can establish that it no longer exists.
    if (state.selected) {
      try { await deps.reloadSelected(); }
      catch { deps.toast(deps.t("errors.disconnected")); }
    }
  } catch {
    if (request !== progress.request) return;
    dashboardFailed(deps, quiet);
  } finally {
    if (request === progress.request) {
      progress.refreshing = false;
      el.refresh.disabled = false;
      el.catalogNext.disabled = !state.nextCursor;
    }
  }
}

function showDashboard(deps, progress, previousInputs) {
  deps.el.sync.dataset.state = "ok";
  renderSidebar(deps, progress);
  if (!deps.state.selected) deps.showOverview();
  if (previousInputs !== null && deps.state.counts.openInputs > previousInputs) deps.toast(deps.t("input.new"));
}

function dashboardFailed(deps, quiet) {
  deps.el.sync.dataset.state = "error";
  if (quiet) return;
  deps.el.tasks.replaceChildren(h("div.list-empty.is-error", null, h("p", null, deps.t("errors.dashboard"))));
  deps.toast(deps.t("errors.dashboard"));
}

function renderSidebar(deps, progress) {
  const el = deps.el;
  const state = deps.state;
  const t = deps.t;
  renderAttentionBar(el.attention, state, t, function (kind) { pickAttention(deps, progress, kind); });
  renderFilters(el.filters, state, t, function (filter) {
    state.filter = filter;
    state.attentionFilter = null;
    state.catalogAll = false;
    syncUrl(state, false);
    reset(deps, progress);
  });
  el.catalogCount.textContent = fill(t("catalog.count"), { shown: state.tasks.length, total: state.catalogTotal });
  el.catalogReset.hidden = !state.catalogCursor;
  el.catalogNext.hidden = !state.nextCursor && !state.catalogCursor;
  el.catalogAttentionReset.hidden = !state.attentionFilter;
  renderTaskList(deps);
  el.lastSync.textContent = state.generatedAt ? formatClock(state.generatedAt, deps.locale()) : "—";
}

// Redraw the list in place, keeping its scroll position.
function renderTaskList(deps) {
  const scroll = deps.el.tasks.scrollTop;
  renderTasks(deps.el.tasks, deps.state, deps.t, deps.locale(), deps.selectTask);
  deps.el.tasks.scrollTop = scroll;
}

function pickAttention(deps, progress, kind) {
  const state = deps.state;
  state.attentionFilter = kind;
  state.catalogAll = !!kind && !!state.catalogScope && state.catalogScope.archived === "included";
  state.filter = "all";
  state.query = "";
  deps.el.search.value = "";
  syncUrl(state, false);
  reset(deps, progress);
}

function beginRefresh(el, state, t, quiet) {
  el.catalogNext.disabled = true;
  el.sync.dataset.state = "syncing";
  if (quiet) return;
  el.refresh.disabled = true;
  if (!state.tasks.length) el.tasks.replaceChildren(loadingBlock(t("loading.dashboard")));
}

function catalogQuery(state) {
  const query = new URLSearchParams();
  if (state.catalogAll) query.set("all", "true");
  if (state.filter !== "all") query.set("status", state.filter);
  if (state.query.trim()) query.set("search", state.query.trim());
  if (state.attentionFilter) query.set("attention", state.attentionFilter);
  if (state.catalogCursor) query.set("cursor", state.catalogCursor);
  return query.toString();
}

function taskIds(tasks, key) {
  return JSON.stringify(tasks.map(function (task) { return task[key]; }));
}

function applyDashboard(state, dashboard, query) {
  state.tasks = dashboard.tasks;
  // A Session read describes exactly one catalog page.
  if (state.catalogQuery !== query || (state.sessionOverview
    && taskIds(state.sessionOverview.tasks, "taskId") !== taskIds(dashboard.tasks, "id"))) {
    state.sessionOverview = null;
  }
  state.catalogQuery = query;
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
}

async function readPageSessions(deps) {
  const state = deps.state;
  if (state.sessionLoading) return;
  const query = state.catalogQuery;
  state.sessionLoading = true;
  deps.showOverview();
  try {
    const result = await deps.api.pageSessions(query);
    if (query !== state.catalogQuery) return;
    if (taskIds(result.tasks, "taskId") !== taskIds(state.tasks, "id")) throw new Error(deps.t("overview.sessionsPageChanged"));
    state.sessionOverview = result;
    state.sessionError = null;
  } catch (error) { state.sessionError = error.message; }
  finally {
    state.sessionLoading = false;
    if (!state.selected) deps.showOverview();
  }
}

// Filters from the URL, on load and on back/forward.
function applyFilters(deps, params) {
  const state = deps.state;
  const filter = params.get("filter");
  state.filter = STATUS_FILTERS.includes(filter) ? filter : "all";
  state.query = params.get("q") || "";
  state.attentionFilter = ATTENTION_KINDS.includes(params.get("attention")) ? params.get("attention") : null;
  state.catalogAll = params.get("all") === "true";
  deps.el.search.value = state.query;
}

function bindCatalogControls(el, state, catalog) {
  let searchTimer = null;
  el.search.addEventListener("input", function () {
    state.query = el.search.value;
    syncUrl(state, true);
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(catalog.reset, 200);
  });
  el.catalogNext.addEventListener("click", function () {
    if (!state.nextCursor) return;
    state.catalogCursor = state.nextCursor;
    catalog.refresh();
  });
  el.catalogReset.addEventListener("click", catalog.reset);
  el.catalogAttentionReset.addEventListener("click", function () { catalog.pickAttention(null); });
  el.refresh.addEventListener("click", function () { catalog.refresh(); });
}
`;
