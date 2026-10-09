import { TASK_TABS } from "../../shared/taskTabs.js";

export const SHORTCUTS_SCRIPT = String.raw`
// Keyboard shortcuts (listed in the settings dialog). They yield to open
// dialogs, to typing and to a focused native Session, which needs its own keys.
import { isEditing } from "/assets/js/lib/dom.js";

const TABS = ${JSON.stringify(TASK_TABS)};

// deps: { el, state, globalInput, workspace, selection, catalog, taskView }
//   el           #search, #settings-dialog and #terminal-host
//   state        read-only here: state.selected, state.detail
//   globalInput  views/globalInput (its dialog blocks shortcuts while open)
//   workspace    layout/workspace: the dock and the operator Session
//   selection    app/selection: Escape leaves the Task
//   catalog      app/catalog: "r" refreshes
//   taskView     app/taskView: 1–4 switch tabs
export function bindShortcuts(deps) {
  document.addEventListener("keydown", function (event) {
    if (document.querySelector("dialog[open]")) return;
    const active = document.activeElement;
    const typing = isEditing(active);
    const inTerminal = deps.el.terminalHost.contains(active);
    if (event.key === "Escape") { escape(deps, active, typing, inTerminal); return; }
    if (typing || inTerminal || event.metaKey || event.ctrlKey || event.altKey) return;
    shortcut(deps, event);
  });
}

// Escape unwinds one level: leave a field, close the dock, leave the Task.
function escape(deps, active, typing, inTerminal) {
  if (inTerminal) return;
  if (typing) { active.blur(); return; }
  if (deps.workspace.dockVisible()) { deps.workspace.setDockOpen(false); return; }
  if (deps.state.selected) deps.selection.clearSelection();
}

function shortcut(deps, event) {
  const key = event.key.toLowerCase();
  if (key === "/") { event.preventDefault(); deps.el.search.focus(); deps.el.search.select(); }
  else if (key === "r") deps.catalog.refresh();
  else if (key === "o") deps.workspace.openOperator();
  else if (key === "d") deps.workspace.toggleDock();
  else if (/^[1-9]$/.test(key) && Number(key) <= TABS.length && deps.state.detail) deps.taskView.switchTab(TABS[Number(key) - 1]);
}
`;
