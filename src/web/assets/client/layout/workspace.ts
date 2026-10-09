import { BREAKPOINTS, DOCK } from "../../shared/geometry.js";

export const WORKSPACE_SCRIPT = String.raw`
// The sidebar | center | dock workspace. The dock holds the Task discussion
// or a live native Session; on desktop it is a resizable column (at the end or
// in the center), below the narrow breakpoint a full-screen sheet opened
// explicitly per Task. Everything here is view state and browser preference.
import { readPreference, writePreference } from "/assets/js/lib/prefs.js";
import { markSelected } from "/assets/js/lib/dom.js";
import { createSizing } from "/assets/js/layout/sizing.js";

const NARROW_QUERY = "(max-width: ${BREAKPOINTS.narrow}px)";
const DOCK_INITIAL = ${DOCK.initial};

// deps: { el, state, terminal, sessionOpened }
//   el        the shell elements (dock, dividers, sidebar, operator button,
//             and the Task page's [data-dock-toggle] buttons inside el.detail)
//   state     read-only here: state.selected
//   terminal  the dock's native Session (views/dock/terminal)
//   sessionOpened()  a Session was just opened in the dock; the caller
//             refreshes the Session target chips (app/taskView).
// The dock state (open, mode, side, width, sheet) is private to this module.
export function createWorkspace(deps) {
  const ws = {
    deps: deps,
    dock: readDockState(),
    // Task list width: null keeps the CSS default (--sidebar-w); otherwise
    // the width the user dragged to.
    sidebar: { width: Number(readPreference("yui.sidebar.width", "")) || null },
    narrow: window.matchMedia(NARROW_QUERY),
    sizing: null
  };
  ws.sizing = createSizing(deps.el, ws.dock, ws.sidebar, function () { return dockVisible(ws); });
  bindDockControls(ws);
  ws.narrow.addEventListener("change", function () { updateLayout(ws); });
  return {
    dockVisible: function () { return dockVisible(ws); },
    updateLayout: function () { updateLayout(ws); },
    syncDockButtons: function () { syncDockButtons(ws); },
    setDockOpen: function (open) { setDockOpen(ws, open); },
    toggleDock: function (mode) { toggleDock(ws, mode); },
    openSession: function (target) { openSession(ws, target); },
    openConversation: function (target, materials) {
      showDock(ws, true);
      ws.dock.mode = "conversation";
      updateLayout(ws);
      ws.deps.conversation.open(target, { current: true, materials: materials });
      syncDockButtons(ws);
    },
    openOperator: function () { openOperator(ws); },
    // A newly selected Task starts with the narrow-screen sheet closed.
    enterTask: function () {
      ws.dock.sheet = false;
      ws.dock.mode = "conversation";
      ws.deps.conversation.open({ scope: "task", taskId: ws.deps.state.selected, roleName: "leader" });
    },
    leaveTask: function () { leaveTask(ws); }
  };
}

function readDockState() {
  return {
    open: readPreference("yui.dock.open", "true") !== "false",
    mode: "conversation",
    center: readPreference("yui.dock.side", "end") === "center",
    width: Number(readPreference("yui.dock.width", String(DOCK_INITIAL))) || DOCK_INITIAL,
    // On narrow screens the dock is a full-screen sheet opened explicitly per
    // Task, never restored from the desktop preference.
    sheet: false
  };
}

function dockVisible(ws) {
  const dock = ws.dock;
  if (ws.narrow.matches ? !dock.sheet : !dock.open) return false;
  if (ws.deps.state.selected) return true;
  if (dock.mode === "conversation") return true;
  return dock.mode === "session" && ws.deps.terminal.connected();
}

function updateLayout(ws) {
  const el = ws.deps.el;
  const dock = ws.dock;
  const selected = !!ws.deps.state.selected;
  const visible = dockVisible(ws);
  document.body.classList.toggle("task-open", selected);
  document.body.classList.toggle("dock-open", visible);
  document.body.classList.toggle("dock-center", dock.center);
  el.dock.hidden = !visible;
  el.divider.hidden = !visible;
  el.discussion.hidden = dock.mode !== "discussion";
  el.session.hidden = dock.mode !== "session";
  el.conversation.hidden = dock.mode !== "conversation";
  el.dockTabConversation.setAttribute("aria-selected", String(dock.mode === "conversation"));
  el.dockTabDiscussion.setAttribute("aria-selected", String(dock.mode === "discussion"));
  el.dockTabSession.setAttribute("aria-selected", String(dock.mode === "session"));
  el.dockTabDiscussion.disabled = !selected;
  el.dockSwap.setAttribute("aria-pressed", String(dock.center));
  ws.sizing.applySidebarWidth();
  syncDockButtons(ws);
}

function syncDockButtons(ws) {
  const el = ws.deps.el;
  const visible = dockVisible(ws);
  markSelected(el.detail.querySelectorAll("[data-dock-toggle]"), "aria-pressed", function (button) {
    return visible && ws.dock.mode === button.dataset.dockToggle;
  });
  el.operator.setAttribute("aria-pressed", String(operatorShown(ws)));
}

// The dock currently shows the global operator Session.
function operatorShown(ws) {
  if (ws.dock.mode === "conversation") return dockVisible(ws) && ws.deps.conversation.current()?.scope === "global";
  const current = ws.deps.terminal.current();
  return dockVisible(ws) && ws.dock.mode === "session" && !!current && current.scope === "global";
}

function showDock(ws, open) {
  if (ws.narrow.matches) ws.dock.sheet = open;
  else {
    ws.dock.open = open;
    writePreference("yui.dock.open", String(open));
  }
}

function setDockOpen(ws, open) {
  showDock(ws, open);
  if (!open && ws.deps.terminal.connected()) ws.deps.terminal.close();
  if (!open) ws.deps.conversation.close();
  updateLayout(ws);
  if (open && ws.dock.mode === "conversation") ws.deps.conversation.reconnect();
}

function setDockMode(ws, mode) {
  if (mode === "conversation") {
    ws.dock.mode = mode;
    updateLayout(ws);
    ws.deps.conversation.open(ws.deps.state.selected
      ? { scope: "task", taskId: ws.deps.state.selected, roleName: "leader" }
      : { scope: "global", roleName: "operator" });
    return;
  }
  ws.deps.conversation.close();
  ws.dock.mode = mode === "session" || !ws.deps.state.selected ? "session" : "discussion";
  updateLayout(ws);
}

function toggleDock(ws, mode) {
  const dock = ws.dock;
  const selected = ws.deps.state.selected;
  if (dockVisible(ws) && (!mode || dock.mode === mode)) { setDockOpen(ws, false); return; }
  if (mode) dock.mode = mode === "session" || !selected ? mode : "discussion";
  if (!selected && dock.mode === "discussion") dock.mode = "session";
  setDockOpen(ws, true);
}

function openSession(ws, target) {
  ws.deps.conversation.close();
  ws.dock.mode = "session";
  showDock(ws, true);
  ws.deps.terminal.open(target);
  updateLayout(ws);
  ws.deps.sessionOpened();
}

function openOperator(ws) {
  showDock(ws, true);
  setDockMode(ws, "conversation");
  ws.deps.conversation.open({ scope: "global", roleName: "operator" });
  syncDockButtons(ws);
}

// Leaving a Task: when the dock's last Session belonged to a Task and is no
// longer connected, the dock returns to the discussion mode.
function leaveTask(ws) {
  if (ws.dock.mode === "conversation") {
    ws.deps.conversation.open({ scope: "global", roleName: "operator" });
    return;
  }
  const terminal = ws.deps.terminal;
  const current = terminal.current();
  if ((ws.dock.mode === "discussion" || (current && current.scope === "task")) && !terminal.connected()) ws.dock.mode = "discussion";
}

function bindDockControls(ws) {
  const el = ws.deps.el;
  const dock = ws.dock;
  el.dockTabDiscussion.addEventListener("click", function () { setDockMode(ws, "discussion"); });
  el.dockTabConversation.addEventListener("click", function () { setDockMode(ws, "conversation"); });
  el.dockTabSession.addEventListener("click", function () { setDockMode(ws, "session"); });
  el.dockClose.addEventListener("click", function () { setDockOpen(ws, false); });
  el.dockSwap.addEventListener("click", function () {
    dock.center = !dock.center;
    writePreference("yui.dock.side", dock.center ? "center" : "end");
    updateLayout(ws);
  });
  el.operator.addEventListener("click", function () {
    if (operatorShown(ws)) setDockOpen(ws, false);
    else openOperator(ws);
  });
}
`;
