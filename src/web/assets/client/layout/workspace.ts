import { BREAKPOINTS, DOCK } from "../../shared/geometry.js";

export const WORKSPACE_SCRIPT = String.raw`
// The sidebar | center | dock workspace. The dock holds the Task discussion
// or a live native Session; on desktop it is a resizable column (at the end or
// in the center), below the narrow breakpoint a full-screen sheet opened
// explicitly per Task. Everything here is view state and browser preference.
import { readPreference, writePreference, readSessionAccessMode } from "/assets/js/lib/prefs.js";
import { markSelected, h, icon, clear } from "/assets/js/lib/dom.js";
import { createSizing } from "/assets/js/layout/sizing.js";
import { layoutTransition, leave } from "/assets/js/lib/motion.js";

const NARROW_QUERY = "(max-width: ${BREAKPOINTS.narrow}px)";
const DOCK_INITIAL = ${DOCK.initial};

// deps: { el, state, t, terminal, conversation, preview, sessionOpened }
//   el        the shell elements (dock, dividers, sidebar, the dock's target
//             menu, and the page's [data-panel-toggle] / legacy [data-operator-toggle]
//             buttons inside el.detail)
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
    setDockOpen: function (open) { glide(function () { setDockOpen(ws, open); }); },
    toggleDock: function (mode) { glide(function () { toggleDock(ws, mode); }); },
    openSession: function (target) { openSession(ws, target); },
    openConversation: function (target, materials) {
      ws.deps.terminal.close();
      showDock(ws, true);
      ws.dock.mode = "conversation";
      updateLayout(ws);
      ws.deps.conversation.open(target, { current: true, materials: materials });
      syncDockButtons(ws);
    },
    openOperator: function () { glide(function () { openOperator(ws); }); },
    toggleOperator: function () { glide(function () { toggleOperator(ws); }); },
    // A newly selected Task starts with the narrow-screen sheet closed.
    enterTask: function () {
      ws.deps.terminal.close();
      ws.terminalTarget = { scope: "task", taskId: ws.deps.state.selected, roleName: "leader" };
      ws.dock.sheet = false;
      ws.dock.mode = preferredMode();
      ws.deps.conversation.open({ scope: "task", taskId: ws.deps.state.selected, roleName: "leader" });
      pauseHiddenConversation(ws);
      if (ws.dock.mode === "session" && !ws.narrow.matches && ws.dock.open) {
        ws.deps.terminal.open({ scope: "task", taskId: ws.deps.state.selected, roleName: "leader" });
      }
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
    mode: "conversation",
    center: readPreference("yui.dock.side", "end") === "center",
    width: Number(readPreference("yui.dock.width", String(DOCK_INITIAL))) || DOCK_INITIAL,
    // On narrow screens the dock is a full-screen sheet opened explicitly per
    // Task, never restored from the desktop preference.
    sheet: false
  };
}

function preferredMode() {
  return readSessionAccessMode() === "native" ? "session" : "conversation";
}

function dockVisible(ws) {
  const dock = ws.dock;
  if (ws.narrow.matches ? !dock.sheet : !dock.open) return false;
  if (ws.deps.state.selected) return true;
  if (dock.mode === "conversation") return true;
  return dock.mode === "session" && !!ws.deps.terminal.current();
}

function updateLayout(ws) {
  const el = ws.deps.el;
  const dock = ws.dock;
  const selected = !!ws.deps.state.selected;
  const visible = dockVisible(ws);
  document.body.classList.toggle("task-open", selected);
  document.body.classList.toggle("dock-open", visible);
  document.body.classList.toggle("dock-center", dock.center);
  revealDock(ws, visible);
  el.divider.hidden = !visible;
  el.discussion.hidden = dock.mode !== "discussion";
  el.session.hidden = dock.mode !== "session";
  el.conversation.hidden = dock.mode !== "conversation";
  el.preview.hidden = dock.mode !== "preview";
  el.dockTabPreview.setAttribute("aria-selected", String(dock.mode === "preview"));
  el.dockTabPreview.disabled = !selected;
  if (visible && dock.mode === "preview" && selected) ws.deps.preview.open(ws.deps.state.selected);
  else ws.deps.preview.close();
  el.dockTabConversation.setAttribute("aria-selected", String(dock.mode === "conversation"));
  el.dockTabDiscussion.setAttribute("aria-selected", String(dock.mode === "discussion"));
  el.dockTabSession.setAttribute("aria-selected", String(dock.mode === "session"));
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
// The dock header names who the panel talks to. Operator is always offered;
// a selected Task adds its Leader. Other Roles use the global message dialog.
function currentTarget(ws) {
  const mode = ws.dock.mode;
  const selected = ws.deps.state.selected;
  if (mode === "session") return ws.deps.terminal.current() || ws.terminalTarget || null;
  if (mode === "conversation") return ws.deps.conversation.current();
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

function drawTarget(ws) {
  const el = ws.deps.el;
  const current = currentTarget(ws);
  el.dockTargetLabel.textContent = targetLabel(ws, current);
  el.dockTargetIcon.replaceChildren(icon(current && current.scope === "task" ? "target" : "broadcast"));
  const options = [{ scope: "global", roleName: "operator" }];
  if (ws.deps.state.selected) options.push({ scope: "task", taskId: ws.deps.state.selected, roleName: "leader" });
  if (current && !options.some(function (option) { return sameTarget(option, current); })) options.push(current);
  const signature = JSON.stringify([options, current, ws.deps.t("actions.operator")]);
  if (el.dockTargetOptions.dataset.signature === signature) return;
  el.dockTargetOptions.dataset.signature = signature;
  clear(el.dockTargetOptions);
  options.forEach(function (target) {
    el.dockTargetOptions.append(h("button.dock-target-item", {
      type: "button", "aria-pressed": String(sameTarget(target, current)),
      onclick: function () { chooseTarget(ws, target); }
    }, icon(target.scope === "task" ? "target" : "broadcast"), h("span", null, targetLabel(ws, target)),
      sameTarget(target, current) ? icon("check", "icon-sm dock-target-check") : null));
  });
}

// Keep the current view (live terminal or structured conversation) and switch
// only its owner; Task-only views fall back to the conversation.
function chooseTarget(ws, target) {
  ws.deps.el.dockTarget.open = false;
  if (ws.dock.mode === "session") { openSession(ws, target); return; }
  ws.deps.terminal.close();
  showDock(ws, true);
  ws.dock.mode = "conversation";
  updateLayout(ws);
  ws.deps.conversation.open(target);
  syncDockButtons(ws);
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
  }
}

function setDockOpen(ws, open) {
  // Closing with focus inside the panel returns it to the page's panel switch
  // rather than leaving it on a hidden element.
  const active = document.activeElement;
  const focusInside = !open && !!active && ws.deps.el.dock.contains(active);
  showDock(ws, open);
  if (!open) {
    ws.terminalTarget = ws.deps.terminal.current() || ws.terminalTarget;
    ws.deps.terminal.close();
  }
  if (!open) ws.deps.conversation.close();
  if (open && ws.dock.mode === "conversation") ws.deps.conversation.reconnect();
  if (open && ws.dock.mode === "session") {
    // Keep the selected owner, not a Session identity cached before hiding.
    const target = ws.terminalTarget || { scope: "global", roleName: "operator" };
    ws.deps.terminal.open({ scope: target.scope, roleName: target.roleName,
      ...(target.scope === "task" ? { taskId: target.taskId } : {}) });
  }
  updateLayout(ws);
  if (focusInside) {
    const toggle = ws.deps.el.detail.querySelector("[data-panel-toggle]");
    if (toggle) toggle.focus();
  }
}

function setDockMode(ws, mode) {
  if (mode === "preview" && ws.deps.state.selected) {
    ws.deps.terminal.close();
    ws.deps.conversation.close();
    ws.dock.mode = "preview";
    updateLayout(ws);
    return;
  }
  if (mode === "conversation") {
    const target = ws.deps.terminal.current() || ws.deps.conversation.current();
    ws.deps.terminal.close();
    ws.dock.mode = mode;
    updateLayout(ws);
    ws.deps.conversation.open(target ? { scope: target.scope, ...(target.scope === "task" ? { taskId: target.taskId } : {}), roleName: target.roleName } : ws.deps.state.selected
      ? { scope: "task", taskId: ws.deps.state.selected, roleName: "leader" }
      : { scope: "global", roleName: "operator" });
    syncDockButtons(ws);
    return;
  }
  if (mode === "session") {
    const target = ws.deps.conversation.selection();
    if (!target) return;
    openSession(ws, target);
    return;
  }
  ws.deps.terminal.close();
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
  ws.terminalTarget = target;
  ws.deps.conversation.close();
  ws.dock.mode = "session";
  showDock(ws, true);
  ws.deps.terminal.open(target);
  updateLayout(ws);
  ws.deps.sessionOpened();
}

function toggleOperator(ws) {
  if (operatorShown(ws)) setDockOpen(ws, false);
  else openOperator(ws);
}

function openOperator(ws) {
  ws.deps.terminal.close();
  showDock(ws, true);
  setDockMode(ws, "conversation");
  ws.deps.conversation.open({ scope: "global", roleName: "operator" });
  if (preferredMode() === "session") openSession(ws, { scope: "global", roleName: "operator" });
  syncDockButtons(ws);
}

// Leaving a Task: when the dock's last Session belonged to a Task and is no
// longer connected, the dock returns to the discussion mode.
function leaveTask(ws) {
  ws.deps.terminal.close();
  ws.dock.mode = "conversation";
  ws.deps.conversation.open({ scope: "global", roleName: "operator" });
  pauseHiddenConversation(ws);
  syncDockButtons(ws);
}

// The conversation keeps its owner while the panel is hidden but stops
// polling; opening the panel reconnects it.
function pauseHiddenConversation(ws) {
  if (!dockVisible(ws) || ws.dock.mode !== "conversation") ws.deps.conversation.close();
}

function bindDockControls(ws) {
  const el = ws.deps.el;
  const dock = ws.dock;
  el.dockTabDiscussion.addEventListener("click", function () { setDockMode(ws, "discussion"); });
  el.dockTabConversation.addEventListener("click", function () { setDockMode(ws, "conversation"); });
  el.dockTabSession.addEventListener("click", function () { setDockMode(ws, "session"); });
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
