import { LAYOUT_GEOMETRY } from "../../shared/geometry.js";

export const SIDEBAR_NAV_SCRIPT = String.raw`
// Task list visibility. On wide screens the list is a column the user can
// collapse (remembered in this browser). Where it cannot sit beside the
// workspace — narrow screens, or a medium screen with the dock open — it
// opens as a drawer over the workspace instead, and closes on a choice,
// on the scrim, on Escape or by dragging it away. Every [data-sidebar-toggle]
// reports the state. Drawer motion lives in CSS (layout/responsive); a drag
// only moves the panels with the finger and hands the release back to CSS.
// Collapsing the inline column glides through lib/motion.
import { readPreference, writePreference } from "/assets/js/lib/prefs.js";
import { layoutTransition } from "/assets/js/lib/motion.js";

const G = ${JSON.stringify(LAYOUT_GEOMETRY)};

// deps: { el: { sidebar, rail?, scrim, collapse }, relayout }
//   rail        the global rail, which travels with the list on narrow screens
//   relayout()  re-applies column widths after the list appears or hides
export function createSidebarNav(deps) {
  const body = document.body;
  const state = { collapsed: readPreference("yui.sidebar.collapsed", "0") === "1" };

  // Whether the list can sit in the grid at the current width and dock state.
  function inlineAvailable() {
    const width = window.innerWidth;
    if (width <= G.narrow) return false;
    return !(width <= G.focusMax && body.classList.contains("dock-open"));
  }
  function drawerOpen() { return body.classList.contains("sidebar-drawer"); }
  function visible() { return drawerOpen() || (inlineAvailable() && !state.collapsed); }
  function sync() {
    const expanded = String(visible());
    document.querySelectorAll("[data-sidebar-toggle]").forEach(function (button) {
      if (button.getAttribute("aria-expanded") !== expanded) button.setAttribute("aria-expanded", expanded);
    });
  }
  function setCollapsed(collapsed) {
    state.collapsed = collapsed;
    writePreference("yui.sidebar.collapsed", collapsed ? "1" : "0");
    // The columns glide to their new widths (View Transition, desktop only).
    const update = function () {
      body.classList.toggle("sidebar-collapsed", collapsed);
      deps.relayout();
      sync();
    };
    if (typeof layoutTransition === "function") layoutTransition(update);
    else update();
  }
  function setDrawer(open) {
    if (open === drawerOpen()) return;
    body.classList.toggle("sidebar-drawer", open);
    if (open) deps.el.collapse.focus({ preventScroll: true });
    sync();
  }
  function reveal() {
    if (!inlineAvailable()) setDrawer(true);
    else if (state.collapsed) setCollapsed(false);
  }
  function hide() {
    if (drawerOpen()) setDrawer(false);
    else if (inlineAvailable()) setCollapsed(true);
  }

  body.classList.toggle("sidebar-collapsed", state.collapsed);
  deps.el.collapse.addEventListener("click", hide);
  deps.el.scrim.addEventListener("click", function () { setDrawer(false); });
  // A choice made in the drawer hands the screen back to the workspace.
  deps.el.sidebar.addEventListener("click", function (event) {
    if (drawerOpen() && event.target.closest(".task-row, .manage-link, #create-task, #body-search-open")) setDrawer(false);
  });
  bindDrag(deps.el, drawerOpen, function () { setDrawer(false); });
  window.addEventListener("resize", function () { if (drawerOpen() && inlineAvailable()) setDrawer(false); sync(); });
  // The dock opening or closing changes whether the list fits.
  new MutationObserver(sync).observe(body, { attributes: true, attributeFilter: ["class"] });
  sync();

  return {
    toggle: function () { if (visible()) hide(); else reveal(); },
    reveal: reveal,
    hide: hide,
    closeDrawer: function () { setDrawer(false); },
    drawerOpen: drawerOpen,
    sync: sync
  };
}

// Drag to dismiss, as native drawers do: once a touch moves mostly sideways,
// the panels follow the finger (leftward only) and the scrim thins with them.
// Releasing past a third of the width, or with a quick flick, closes; any
// other release springs back. Either way CSS animates from the current spot.
function bindDrag(el, isOpen, close) {
  const panels = [el.sidebar, el.rail].filter(Boolean);
  let drag = null;
  function place(dx) {
    const offset = "translate3d(" + dx + "px,0,0)";
    panels.forEach(function (panel) { panel.style.transform = offset; });
    el.scrim.style.opacity = String(Math.max(0, 1 + dx / drag.width));
  }
  function release() {
    panels.forEach(function (panel) { panel.style.transform = ""; });
    el.scrim.style.opacity = "";
    document.body.classList.remove("drawer-dragging");
  }
  function start(event) {
    if (!isOpen() || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const width = panels.reduce(function (sum, panel) { return sum + panel.getBoundingClientRect().width; }, 0);
    drag = { x: touch.clientX, y: touch.clientY, width: width || 1, active: false, dx: 0, at: event.timeStamp, v: 0 };
  }
  function move(event) {
    if (!drag) return;
    const touch = event.touches[0];
    const dx = touch.clientX - drag.x;
    const dy = touch.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // A vertical start is a scroll; leave it alone.
      if (Math.abs(dy) >= Math.abs(dx) || dx > 0) { drag = null; return; }
      drag.active = true;
      document.body.classList.add("drawer-dragging");
    }
    const next = Math.min(0, dx);
    const elapsed = event.timeStamp - drag.at;
    if (elapsed > 0) drag.v = (next - drag.dx) / elapsed;
    drag.dx = next;
    drag.at = event.timeStamp;
    place(next);
  }
  function end() {
    if (!drag) return;
    const finished = drag;
    drag = null;
    if (!finished.active) return;
    // Removing the inline offset in the same frame as the class change lets
    // the CSS transition continue from where the finger let go.
    const dismiss = finished.dx < -finished.width / 3 || finished.v < -0.45;
    release();
    if (dismiss) close();
  }
  [el.sidebar, el.rail, el.scrim].filter(Boolean).forEach(function (node) {
    node.addEventListener("touchstart", start, { passive: true });
    node.addEventListener("touchmove", move, { passive: true });
    node.addEventListener("touchend", end, { passive: true });
    node.addEventListener("touchcancel", end, { passive: true });
  });
}
`;
