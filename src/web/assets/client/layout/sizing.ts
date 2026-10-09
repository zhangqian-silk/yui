import { LAYOUT_GEOMETRY } from "../../shared/geometry.js";

export const SIZING_SCRIPT = String.raw`
// Column widths. The task list and the dock are user-sized preferences; the
// width actually applied is clamped so the task column keeps its minimum in
// the current window. Geometry comes from shared/geometry.ts.
import { writePreference, clearPreference } from "/assets/js/lib/prefs.js";
import { bindResizeHandle } from "/assets/js/layout/resizer.js";

const G = ${JSON.stringify(LAYOUT_GEOMETRY)};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// el: { sidebar, sidebarDivider, dock, divider }; dock: the dock view state
// (width, center); sidebar: { width } where null keeps the CSS default.
export function createSizing(el, dock, sidebar, dockVisible) {
  const root = document.documentElement.style;

  function maxDockWidth() {
    const aside = window.innerWidth > G.narrow ? el.sidebar.offsetWidth : 0;
    return Math.max(G.dock.min, Math.min(G.dock.max, window.innerWidth - aside - G.centerMin));
  }
  function setDockWidth(width, persist) {
    const effective = clamp(width, G.dock.min, maxDockWidth());
    root.setProperty("--dock-w", effective + "px");
    el.divider.setAttribute("aria-valuemax", String(maxDockWidth()));
    el.divider.setAttribute("aria-valuenow", String(effective));
    if (persist) { dock.width = effective; writePreference("yui.dock.width", String(effective)); }
  }
  function maxSidebarWidth() {
    // An open dock can shrink to its minimum, so it reserves only that much.
    const reserve = dockVisible() ? G.dock.min + G.divider : 0;
    return Math.max(G.sidebar.min, Math.min(G.sidebar.max, window.innerWidth - reserve - G.centerMin));
  }
  function applySidebarWidth() {
    if (sidebar.width === null) root.removeProperty("--sidebar-w");
    else root.setProperty("--sidebar-w", clamp(sidebar.width, G.sidebar.min, maxSidebarWidth()) + "px");
    // A wider task list leaves the dock less room; the dock keeps its stored width.
    setDockWidth(dock.width, false);
    el.sidebarDivider.setAttribute("aria-valuemax", String(maxSidebarWidth()));
    el.sidebarDivider.setAttribute("aria-valuenow", String(el.sidebar.offsetWidth));
  }
  function setSidebarWidth(width, persist) {
    sidebar.width = width === null ? null : clamp(Math.round(width), G.sidebar.min, maxSidebarWidth());
    if (persist) {
      if (sidebar.width === null) clearPreference("yui.sidebar.width");
      else writePreference("yui.sidebar.width", String(sidebar.width));
    }
    applySidebarWidth();
  }

  const sizing = { maxDockWidth, setDockWidth, maxSidebarWidth, applySidebarWidth, setSidebarWidth };
  bindDockDivider(el, dock, sizing);
  bindSidebarDivider(el, sidebar, sizing);
  window.addEventListener("resize", applySidebarWidth);
  return sizing;
}

function bindDockDivider(el, dock, sizing) {
  bindResizeHandle(el.divider, {
    narrow: G.narrow, bodyClass: "dock-resizing",
    drag: function (event) {
      const rect = el.dock.getBoundingClientRect();
      const width = dock.center ? event.clientX - rect.left : rect.right - event.clientX;
      sizing.setDockWidth(width, false);
      dock.width = clamp(width, G.dock.min, sizing.maxDockWidth());
    },
    release: function () { writePreference("yui.dock.width", String(dock.width)); },
    keyWidth: function (event) {
      // The dock grows away from the divider: leftwards at the end, rightwards in the center.
      const grow = dock.center ? "ArrowRight" : "ArrowLeft";
      const shrink = dock.center ? "ArrowLeft" : "ArrowRight";
      return event.key === grow ? dock.width + G.dock.step : event.key === shrink ? dock.width - G.dock.step
        : event.key === "Home" ? G.dock.min : event.key === "End" ? sizing.maxDockWidth() : null;
    },
    setWidth: function (width) { sizing.setDockWidth(width, true); }
  });
}

function bindSidebarDivider(el, sidebar, sizing) {
  bindResizeHandle(el.sidebarDivider, {
    narrow: G.narrow, bodyClass: "sidebar-resizing",
    drag: function (event) { sizing.setSidebarWidth(event.clientX - el.sidebar.getBoundingClientRect().left, false); },
    release: function () { if (sidebar.width !== null) writePreference("yui.sidebar.width", String(sidebar.width)); },
    keyWidth: function (event) {
      const current = el.sidebar.offsetWidth;
      return event.key === "ArrowRight" ? current + G.sidebar.step : event.key === "ArrowLeft" ? current - G.sidebar.step
        : event.key === "Home" ? G.sidebar.min : event.key === "End" ? sizing.maxSidebarWidth() : null;
    },
    setWidth: function (width) { sizing.setSidebarWidth(width, true); },
    reset: function () { sizing.setSidebarWidth(null, true); }
  });
}
`;
