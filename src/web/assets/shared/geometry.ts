// Layout geometry shared by the static shell (separator ARIA ranges), the
// stylesheets (breakpoints, default widths) and the client layout controller
// (clamping and keyboard steps), so the three can never drift apart.
export const BREAKPOINTS = Object.freeze({
  // ≤ wide: compact sidebar default and a three-column metric strip.
  wide: 1200,
  // ≤ narrow: master–detail; the dock becomes a full-screen sheet.
  narrow: 900,
  // ≤ small: phone layout for page content.
  small: 620
});

// The global navigation rail (Workbench / Models / Settings) on every page.
export const RAIL_WIDTH = 60;
export const SIDEBAR = Object.freeze({ min: 240, max: 560, compact: 264, step: 16 });
export const DOCK = Object.freeze({ min: 320, max: 760, initial: 440, step: 24 });
// The task column never shrinks below this while a divider is dragged.
export const CENTER_MIN = 420;
export const DIVIDER_WIDTH = 9;
// Between narrow and this width an open dock and the default task list cannot
// both fit beside a minimum task column, so the task list steps aside while
// the dock is open (closing the dock brings it back).
export const DOCK_FOCUS_MAX = RAIL_WIDTH + SIDEBAR.compact + DIVIDER_WIDTH + DOCK.initial + CENTER_MIN - 1;

export const LAYOUT_GEOMETRY = Object.freeze({
  narrow: BREAKPOINTS.narrow, focusMax: DOCK_FOCUS_MAX, rail: RAIL_WIDTH, sidebar: SIDEBAR, dock: DOCK, centerMin: CENTER_MIN, divider: DIVIDER_WIDTH
});
