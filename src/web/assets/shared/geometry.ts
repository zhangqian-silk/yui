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

export const SIDEBAR = Object.freeze({ min: 240, max: 560, compact: 264, step: 16 });
export const DOCK = Object.freeze({ min: 320, max: 760, initial: 440, step: 24 });
// The task column never shrinks below this while a divider is dragged.
export const CENTER_MIN = 420;
export const DIVIDER_WIDTH = 9;

export const LAYOUT_GEOMETRY = Object.freeze({
  narrow: BREAKPOINTS.narrow, sidebar: SIDEBAR, dock: DOCK, centerMin: CENTER_MIN, divider: DIVIDER_WIDTH
});
