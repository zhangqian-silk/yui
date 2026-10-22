export const APP_SCRIPT = String.raw`
// Composition root (served as /assets/app.js). It binds the static shell,
// owns the view state object and is the only place where controllers are
// wired to each other. Each controller receives one explicit deps object,
// documented at its factory: services, controllers created before it, and
// named callbacks into controllers created after it (bound here, late).
// Everything kept in the browser is view state; Task facts always come from
// the loopback API.
//
//   layout/workspace  sidebar | center | dock columns, dock views, sizing
//   views/dock/session  the dock's session page: one Role and Session, chat or terminal
//   app/taskView      draws the selected Task, the dock discussion, the overview
//   app/selection     selected Task, its detail reads, URL-driven navigation
//   app/catalog       refresh loop, sidebar, catalog paging and filters
//   layout/shortcuts  keyboard shortcuts
//
// Flows:
//   refresh  catalog.refresh → sidebar, then the overview (nothing selected)
//            or selection.reload → taskView.render
//   select   sidebar row / overview row / URL → selection.selectTask
//   leave    rail Workbench or Escape → selection.clearSelection
//   write    Task page or discussion afterWrite → quiet catalog refresh
//   URL      load and back/forward → catalog.applyFilters + selection.followUrl
import { createI18n } from "/assets/js/lib/i18n.js";
import { createThemeController } from "/assets/js/lib/theme.js";
import { api } from "/assets/js/lib/api.js";
import { createToast } from "/assets/js/ui/toast.js";
import { createSessionPage } from "/assets/js/views/dock/session.js";
import { createPreviewController } from "/assets/js/views/dock/preview.js";
import { bindGlobalInput } from "/assets/js/views/globalInput.js";
import { bindCreateTask } from "/assets/js/views/createTask.js";
import { bindBodySearch } from "/assets/js/views/bodySearch.js";
import { readQuery } from "/assets/js/layout/router.js";
import { rememberPlace, linkPlaces, readSessionAccessMode } from "/assets/js/lib/prefs.js";
import { createWorkspace } from "/assets/js/layout/workspace.js";
import { createSidebarNav } from "/assets/js/layout/sidebarNav.js";
import { bindShortcuts } from "/assets/js/layout/shortcuts.js";
import { createTaskView } from "/assets/js/app/taskView.js";
import { createSelection } from "/assets/js/app/selection.js";
import { createCatalog } from "/assets/js/app/catalog.js";

const $ = function (selector) { return document.querySelector(selector); };
const el = {
  sidebar: $(".sidebar"), rail: $(".app-rail"), railWorkbench: $("#rail-workbench"),
  sidebarScrim: $("#sidebar-scrim"), sidebarCollapse: $("#sidebar-collapse"), sidebarDivider: $("#sidebar-divider"), center: $("#center"), detail: $("#detail"),
  search: $("#search"), source: $("#catalog-source"), filters: $("#status-filters"), attention: $("#attention-bar"), tasks: $("#task-list"),
  catalogNext: $("#catalog-next"), catalogReset: $("#catalog-reset"), catalogCount: $("#catalog-count"),
  catalogAttentionReset: $("#catalog-attention-reset"),
  refresh: $("#refresh"), sync: $("#sync-state"), lastSync: $("#last-sync"), toast: $("#toast"),
  dockTarget: $("#dock-target"), dockTargetLabel: $("#dock-target-label"), dockTargetIcon: $("#dock-target-icon"),
  dockTargetOptions: $("#dock-target-options"), globalInputOpen: $("#global-input-open"), settings: $("#settings-dialog"),
  locale: $("#locale-select"), themeOptions: $("#theme-options"),
  dock: $("#dock"), divider: $("#dock-divider"), dockSwap: $("#dock-swap"), dockClose: $("#dock-close"),
  dockTabDiscussion: $("#dock-tab-discussion"),
  dockTabConversation: $("#dock-tab-conversation"), conversation: $("#dock-conversation"),
  dockTabPreview: $("#dock-tab-preview"), preview: $("#dock-preview"),
  discussion: $("#dock-discussion"), settingsOpen: $("#settings-open")
};

// View state. Each group has exactly one writer.
const state = {
  // app/catalog: the dashboard read, its filters and paging, the Session read.
  tasks: [], counts: null, attention: [], catalogAttention: null, catalogScope: null, catalogQuery: "",
  catalogAll: false, catalogTotal: 0, catalogCursor: null, nextCursor: null,
  sessionOverview: null, sessionLoading: false, sessionError: null,
  attentionFilter: null, generatedAt: null, filter: "all", query: "",
  // app/selection: the selected Task and its loaded detail.
  selected: null, detail: null, detailKey: null,
  // app/taskView: the tab the reader is on.
  activeTab: "overview"
};

const i18n = createI18n(el.locale);
const t = i18n.t;
const locale = i18n.getLocale;
const theme = createThemeController(el.themeOptions, t);
const toast = createToast(el.toast);
const preview = createPreviewController(el.preview, t);
// The mode changed inside the session page: the dock header follows it.
const session = createSessionPage(el.conversation, t, locale, toast, function () { workspace.syncDockButtons(); });
theme.subscribe(function () { session.retheme(); });

// Controllers are created in dependency order; the arrow callbacks below are
// the only edges pointing at controllers created later.
let taskView = null;
let selection = null;
let catalog = null;
const workspace = createWorkspace({ el: el, state: state, t: t, session: session, preview: preview });
const sidebarNav = createSidebarNav({
  el: { sidebar: el.sidebar, rail: el.rail, scrim: el.sidebarScrim, collapse: el.sidebarCollapse },
  relayout: function () { workspace.updateLayout(); }
});
taskView = createTaskView({
  el: el, state: state, t: t, locale: locale, api: api, toast: toast, workspace: workspace,
  selectTask: function (taskId) { return selection.selectTask(taskId); },
  clearSelection: function () { selection.clearSelection(); },
  revealSidebar: function () { sidebarNav.reveal(); },
  pickAttention: function (kind) { catalog.pickAttention(kind); },
  readPageSessions: function () { return catalog.readPageSessions(); },
  refreshCatalog: function () { return catalog.refresh({ quiet: true }); }
});
selection = createSelection({
  state: state, t: t, api: api, toast: toast, workspace: workspace, taskView: taskView,
  renderTaskList: function () { catalog.renderTaskList(); }
});
catalog = createCatalog({
  el: el, state: state, t: t, locale: locale, api: api, toast: toast,
  selectTask: selection.selectTask,
  showOverview: taskView.showOverview,
  reloadSelected: selection.reload
});
const globalInput = bindGlobalInput({ t: t, api: api });
bindCreateTask({ t: t, api: api, selectTask: selection.selectTask,
  afterWrite: function () { catalog.refresh({ quiet: true }); } });
bindBodySearch({ t: t, api: api, selectTask: selection.selectTask,
  currentTask: function () { return state.selected; },
  captureDraftTarget: session.captureDraftTarget, insertReference: session.insertReference });
bindShortcuts({
  el: el, state: state, globalInput: globalInput, workspace: workspace, sidebarNav: sidebarNav,
  selection: selection, catalog: catalog, taskView: taskView
});
// Workbench <-> Models/Settings: each side remembers where the user was, so a
// round trip returns to the same filters, Task and management section.
function rememberWorkbench() { rememberPlace("workbench", window.location.pathname + window.location.search); }
el.rail.querySelectorAll("a[data-nav-area]").forEach(function (link) { link.addEventListener("click", rememberWorkbench); });
// The rail's Workbench entry on the workbench itself returns to the overview.
el.railWorkbench.addEventListener("click", function (event) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  sidebarNav.closeDrawer();
  selection.clearSelection();
});
window.addEventListener("pagehide", rememberWorkbench);
function linkAll() { linkPlaces(el.rail); linkPlaces(el.sidebar); }
window.addEventListener("pageshow", linkAll);
linkAll();

// The URL names the catalog filters and the selected Task (with its section).
function applyStateFromUrl() {
  const params = readQuery();
  catalog.applyFilters(params);
  selection.followUrl(params);
}
window.addEventListener("popstate", function () {
  applyStateFromUrl();
  catalog.reset();
});

i18n.subscribe(function () {
  theme.render();
  session.relabel();
  catalog.renderSidebar();
  taskView.relabel();
  workspace.updateLayout();
});

workspace.updateLayout();
taskView.showOverview();
// The panel starts closed: name its owner without polling until it opens.
session.open({ scope: "global", roleName: "operator" }, { mode: readSessionAccessMode() === "native" ? "terminal" : "chat" });
session.close();
applyStateFromUrl();
catalog.refresh();
window.setInterval(function () { catalog.refresh({ quiet: true }); }, 5000);
`;
