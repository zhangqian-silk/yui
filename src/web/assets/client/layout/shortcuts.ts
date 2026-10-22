import { TASK_TABS } from "../../shared/taskTabs.js";

export const SHORTCUTS_SCRIPT = String.raw`
// Keyboard shortcuts (listed in the settings dialog). They yield to open
// dialogs, to typing and to a focused native Session, which needs its own keys.
import { isEditing } from "/assets/js/lib/dom.js";

const TABS = ${JSON.stringify(TASK_TABS)};

// deps: { el, state, globalInput, workspace, sidebarNav, selection, catalog, taskView }
//   el           #search, #settings-dialog and the dock (its terminal host)
//   state        read-only here: state.selected, state.detail
//   globalInput  views/globalInput (its dialog blocks shortcuts while open)
//   workspace    layout/workspace: the dock and the operator Session
//   sidebarNav   layout/sidebarNav: "[" shows or hides the task list
//   selection    app/selection: Escape leaves the Task
//   catalog      app/catalog: "r" refreshes
//   taskView     app/taskView: 1–4 switch tabs
export function bindShortcuts(deps) {
  document.addEventListener("keydown", function (event) {
    if (document.querySelector("dialog[open]")) return;
    const active = document.activeElement;
    const typing = isEditing(active);
    const inTerminal = !!active && !!active.closest && !!active.closest(".terminal-host");
    if (event.key === "Escape") { escape(deps, active, typing, inTerminal); return; }
    if (typing || inTerminal || event.metaKey || event.ctrlKey || event.altKey) return;
    shortcut(deps, event);
  });
}

// Escape unwinds one level: leave a field, close the task-list drawer, close
// the dock, leave the Task.
function escape(deps, active, typing, inTerminal) {
  if (inTerminal) return;
  if (typing) { active.blur(); return; }
  if (deps.sidebarNav.drawerOpen()) { deps.sidebarNav.closeDrawer(); return; }
  if (deps.workspace.dockVisible()) { deps.workspace.setDockOpen(false); return; }
  if (deps.state.selected) deps.selection.clearSelection();
}

function shortcut(deps, event) {
  const key = event.key.toLowerCase();
  if (key === "/") { event.preventDefault(); deps.el.search.focus(); deps.el.search.select(); }
  else if (key === "[") deps.sidebarNav.toggle();
  else if (key === "r") deps.catalog.refresh();
  else if (key === "o") deps.workspace.toggleOperator();
  else if (key === "d") deps.workspace.toggleDock();
  else if (/^[1-9]$/.test(key) && Number(key) <= TABS.length && deps.state.detail) deps.taskView.switchTab(TABS[Number(key) - 1]);
}
`;
