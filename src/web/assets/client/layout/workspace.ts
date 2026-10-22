import { BREAKPOINTS, DOCK } from "../../shared/geometry.js";

export const WORKSPACE_SCRIPT = String.raw`
// The sidebar | center | dock workspace. The dock holds the session page
// (one Role and Session, as chat or terminal), the Task discussion or the
// preview; on desktop it is a resizable column (at the end or in the center),
// below the narrow breakpoint a full-screen sheet opened explicitly per Task.
// Everything here is view state and browser preference.
import { readPreference, writePreference, readSessionAccessMode } from "/assets/js/lib/prefs.js";
import { markSelected, h, icon, clear } from "/assets/js/lib/dom.js";
import { createSizing } from "/assets/js/layout/sizing.js";
import { layoutTransition, leave } from "/assets/js/lib/motion.js";

const NARROW_QUERY = "(max-width: ${BREAKPOINTS.narrow}px)";
const DOCK_INITIAL = ${DOCK.initial};

// deps: { el, state, t, session, preview }
//   el        the shell elements (dock, dividers, sidebar, the dock's target
//             menu, and the page's [data-panel-toggle] / legacy [data-operator-toggle]
//             buttons inside el.detail)
//   state     read-only here: state.selected
//   session   the dock's session page (views/dock/session): owner, selected
//             Session and its chat / terminal mode
// The dock state (open, view, side, width, sheet) and the Role list offered
// by the target menu are private to this module.
export function createWorkspace(deps) {
  const ws = {
    deps: deps,
    dock: readDockState(),
    // Roles the target menu offers besides Operator (setTargets, app/taskView).
    targets: [],
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
    setTargets: function (targets) { ws.targets = targets; drawTarget(ws); },
    setDockOpen: function (open) { glide(function () { setDockOpen(ws, open); }); },
    toggleDock: function (mode) { glide(function () { toggleDock(ws, mode); }); },
    // Shortcuts into the session page: a Role's live Session opens in the
    // terminal mode, a continuation of the Leader in the chat mode.
    openSession: function (target) { openSessionPage(ws, target, { mode: "terminal", current: true }); },
    openConversation: function (target, materials) {
      openSessionPage(ws, target, { mode: "chat", current: true, ...(materials ? { materials: materials } : {}) });
    },
    openOperator: function () { glide(function () { openOperator(ws); }); },
    toggleOperator: function () { glide(function () { toggleOperator(ws); }); },
    // A newly selected Task starts with the narrow-screen sheet closed.
    enterTask: function () {
      ws.dock.sheet = false;
      ws.dock.mode = "conversation";
      ws.deps.session.open({ scope: "task", taskId: ws.deps.state.selected, roleName: "leader" },
        { current: true, mode: preferredMode() });
      pauseHiddenSession(ws);
      syncDockButtons(ws);
    },
    leaveTask: function () { leaveTask(ws); }
  };
}

// User-initiated dock changes (open, close, swap sides) glide the columns to
// their new widths; internal re-layouts stay immediate.
function glide(update) {
  if (typeof layoutTransition === "function") layoutTransition(update);
  else update();
}

function readDockState() {
  return {
    // The panel starts closed on every load and opens only on request.
    open: false,
    // Which dock view: the session page ("conversation"), the Task
    // discussion or the preview.
    mode: "conversation",
    center: readPreference("yui.dock.side", "end") === "center",
    width: Number(readPreference("yui.dock.width", String(DOCK_INITIAL))) || DOCK_INITIAL,
    // On narrow screens the dock is a full-screen sheet opened explicitly per
    // Task, never restored from the desktop preference.
    sheet: false
  };
}

// The Settings preference picks the session page's starting mode.
function preferredMode() {
  return readSessionAccessMode() === "native" ? "terminal" : "chat";
}

function dockVisible(ws) {
  const dock = ws.dock;
  if (ws.narrow.matches ? !dock.sheet : !dock.open) return false;
  return !!ws.deps.state.selected || dock.mode === "conversation";
}

function updateLayout(ws) {
  const el = ws.deps.el;
  const dock = ws.dock;
  const selected = !!ws.deps.state.selected;
  if (!selected && dock.mode !== "conversation") dock.mode = "conversation";
  const visible = dockVisible(ws);
  document.body.classList.toggle("task-open", selected);
  document.body.classList.toggle("dock-open", visible);
  document.body.classList.toggle("dock-center", dock.center);
  revealDock(ws, visible);
  el.divider.hidden = !visible;
  el.discussion.hidden = dock.mode !== "discussion";
  el.conversation.hidden = dock.mode !== "conversation";
  el.preview.hidden = dock.mode !== "preview";
  el.dockTabPreview.setAttribute("aria-selected", String(dock.mode === "preview"));
  el.dockTabPreview.disabled = !selected;
  if (visible && dock.mode === "preview" && selected) ws.deps.preview.open(ws.deps.state.selected);
  else ws.deps.preview.close();
  el.dockTabConversation.setAttribute("aria-selected", String(dock.mode === "conversation"));
  el.dockTabDiscussion.setAttribute("aria-selected", String(dock.mode === "discussion"));
  el.dockTabDiscussion.disabled = !selected;
  el.dockSwap.setAttribute("aria-pressed", String(dock.center));
  ws.sizing.applySidebarWidth();
  syncDockButtons(ws);
}

// On narrow screens the dock is a full-screen sheet: CSS slides it up on
// open, and closing slides it back down before it hides (an immediate close
// would cut the motion off). Wider screens change the grid; user-initiated
// changes there glide through glide().
function revealDock(ws, visible) {
  const dockEl = ws.deps.el.dock;
  if (ws.closingDock) { ws.closingDock.cancel(); ws.closingDock = null; }
  if (visible || dockEl.hidden || !ws.narrow.matches || typeof leave !== "function") { dockEl.hidden = !visible; return; }
  const closing = leave(dockEl, "sheetDown");
  if (!closing.animation) { dockEl.hidden = true; return; }
  ws.closingDock = closing;
  closing.finished.then(function () {
    if (ws.closingDock !== closing) return;
    ws.closingDock = null;
    dockEl.hidden = true;
    closing.cancel();
  });
}

function syncDockButtons(ws) {
  const el = ws.deps.el;
  const visible = dockVisible(ws);
  el.detail.querySelectorAll("[data-panel-toggle]").forEach(function (button) {
    button.setAttribute("aria-expanded", String(visible));
    button.setAttribute("aria-label", ws.deps.t(visible ? "dock.hide" : "dock.show"));
  });
  markSelected(el.detail.querySelectorAll("[data-operator-toggle]"), "aria-pressed", function () { return operatorShown(ws); });
  drawTarget(ws);
}

// --- Conversation target -----------------------------------------------------
// The dock header names who the session page talks to; it is the only Role
// selector for both chat and terminal. Operator is always offered; a selected
// Task adds its Roles. Other global Roles use the global message dialog.
function currentTarget(ws) {
  const selected = ws.deps.state.selected;
  if (ws.dock.mode === "conversation") return ws.deps.session.current();
  return selected ? { scope: "task", taskId: selected, roleName: "leader" } : null;
}

function targetLabel(ws, target) {
  if (!target) return ws.deps.t("actions.operator");
  if (target.scope === "global") return target.roleName === "operator" ? ws.deps.t("actions.operator") : target.roleName;
  return target.roleName + " · " + target.taskId;
}

function sameTarget(a, b) {
  return !!a && !!b && a.scope === b.scope && a.roleName === b.roleName && (a.scope !== "task" || a.taskId === b.taskId);
}

function targetOptions(ws, current) {
  const selected = ws.deps.state.selected;
  const options = [{ scope: "global", roleName: "operator" }];
  if (selected) {
    const roles = ws.targets.filter(function (target) { return target.scope === "task" && target.taskId === selected; });
    if (!roles.some(function (target) { return target.roleName === "leader"; })) options.push({ scope: "task", taskId: selected, roleName: "leader" });
    roles.forEach(function (target) { options.push(target); });
  }
  if (current && !options.some(function (option) { return sameTarget(option, current); })) options.push(current);
  return options;
}

function drawTarget(ws) {
  const el = ws.deps.el;
  const current = currentTarget(ws);
  el.dockTargetLabel.textContent = targetLabel(ws, current);
  el.dockTargetIcon.replaceChildren(icon(current && current.scope === "task" ? "target" : "broadcast"));
  const options = targetOptions(ws, current);
  const signature = JSON.stringify([options, current, ws.deps.t("actions.operator")]);
  if (el.dockTargetOptions.dataset.signature === signature) return;
  el.dockTargetOptions.dataset.signature = signature;
  clear(el.dockTargetOptions);
  options.forEach(function (target) {
    const chosen = sameTarget(target, current);
    el.dockTargetOptions.append(h("button.dock-target-item", {
      type: "button", "aria-pressed": String(chosen),
      onclick: function () { chooseTarget(ws, target); }
    }, target.scope === "task" ? h("i.dock-target-dot" + (target.live ? ".is-live" : ""), { "aria-hidden": "true" }) : icon("broadcast"),
      h("span", null, targetLabel(ws, target)),
      chosen ? icon("check", "icon-sm dock-target-check") : null));
  });
}

// Keep the session page's mode (chat or terminal) and switch only its owner;
// from the discussion or preview, the session page opens again.
function chooseTarget(ws, target) {
  ws.deps.el.dockTarget.open = false;
  openSessionPage(ws, { scope: target.scope, roleName: target.roleName, ...(target.scope === "task" ? { taskId: target.taskId } : {}) }, {});
}

function openSessionPage(ws, target, options) {
  showDock(ws, true);
  ws.dock.mode = "conversation";
  updateLayout(ws);
  ws.deps.session.open(target, options);
  syncDockButtons(ws);
}

// The dock currently shows the global operator Session.
function operatorShown(ws) {
  return dockVisible(ws) && ws.dock.mode === "conversation" && ws.deps.session.current()?.scope === "global";
}

function showDock(ws, open) {
  if (ws.narrow.matches) ws.dock.sheet = open;
  else {
    ws.dock.open = open;
  }
}

function setDockOpen(ws, open) {
  // Closing with focus inside the panel returns it to the page's panel switch
  // rather than leaving it on a hidden element.
  const active = document.activeElement;
  const focusInside = !open && !!active && ws.deps.el.dock.contains(active);
  showDock(ws, open);
  // Hiding stops polling and detaches the terminal; showing resumes the same
  // owner and selected Session in the same mode.
  if (!open) ws.deps.session.close();
  else if (ws.dock.mode === "conversation") {
    if (ws.deps.session.current()) ws.deps.session.reconnect();
    else ws.deps.session.open({ scope: "global", roleName: "operator" }, { mode: preferredMode() });
  }
  updateLayout(ws);
  if (focusInside) {
    const toggle = ws.deps.el.detail.querySelector("[data-panel-toggle]");
    if (toggle) toggle.focus();
  }
}

function setDockMode(ws, mode) {
  if (mode === ws.dock.mode) return;
  if (mode === "conversation") {
    ws.dock.mode = mode;
    updateLayout(ws);
    if (ws.deps.session.current()) ws.deps.session.reconnect();
    else ws.deps.session.open(ws.deps.state.selected
      ? { scope: "task", taskId: ws.deps.state.selected, roleName: "leader" }
      : { scope: "global", roleName: "operator" }, { mode: preferredMode() });
    syncDockButtons(ws);
    return;
  }
  if (!ws.deps.state.selected) return;
  ws.deps.session.close();
  ws.dock.mode = mode === "preview" ? "preview" : "discussion";
  updateLayout(ws);
}

// mode "session" (the legacy native entry) opens the session page in its
// terminal mode; "discussion" and "preview" need a selected Task.
function toggleDock(ws, mode) {
  const dock = ws.dock;
  const selected = ws.deps.state.selected;
  const view = mode === "session" ? "conversation" : mode;
  if (dockVisible(ws) && (!view || dock.mode === view)) { setDockOpen(ws, false); return; }
  if (view) dock.mode = view === "conversation" || selected ? view : "conversation";
  if (!selected && dock.mode !== "conversation") dock.mode = "conversation";
  setDockOpen(ws, true);
  if (mode === "session") ws.deps.session.setMode("terminal");
}

function toggleOperator(ws) {
  if (operatorShown(ws)) setDockOpen(ws, false);
  else openOperator(ws);
}

function openOperator(ws) {
  const current = ws.deps.session.current();
  openSessionPage(ws, { scope: "global", roleName: "operator" },
    current && current.scope === "global" && current.roleName === "operator" ? {} : { mode: preferredMode() });
}

// Leaving a Task: the session page returns to Operator, hidden unless shown.
function leaveTask(ws) {
  ws.dock.mode = "conversation";
  ws.deps.session.open({ scope: "global", roleName: "operator" });
  pauseHiddenSession(ws);
  syncDockButtons(ws);
}

// The session page keeps its owner while the panel is hidden but stops
// polling and detaches; opening the panel reconnects it.
function pauseHiddenSession(ws) {
  if (!dockVisible(ws) || ws.dock.mode !== "conversation") ws.deps.session.close();
}

function bindDockControls(ws) {
  const el = ws.deps.el;
  const dock = ws.dock;
  el.dockTabDiscussion.addEventListener("click", function () { setDockMode(ws, "discussion"); });
  el.dockTabConversation.addEventListener("click", function () { setDockMode(ws, "conversation"); });
  el.dockTabPreview.addEventListener("click", function () { setDockMode(ws, "preview"); });
  el.dockClose.addEventListener("click", function () { glide(function () { setDockOpen(ws, false); }); });
  el.dockSwap.addEventListener("click", function () {
    dock.center = !dock.center;
    writePreference("yui.dock.side", dock.center ? "center" : "end");
    glide(function () { updateLayout(ws); });
  });
  el.globalInputOpen.addEventListener("click", function () { el.dockTarget.open = false; });
  document.addEventListener("click", function (event) {
    if (el.dockTarget.open && !el.dockTarget.contains(event.target)) el.dockTarget.open = false;
  });
  el.dockTarget.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && el.dockTarget.open) { event.stopPropagation(); el.dockTarget.open = false; el.dockTarget.querySelector("summary").focus(); }
  });
}
`;
