import { BREAKPOINTS } from "../../shared/geometry.js";
import { MOTION } from "../../shared/motion.js";

export const MOTION_SCRIPT = String.raw`
// Script-side motion, on the same durations, curves and presets as the
// stylesheets (shared/motion.ts). Every helper degrades to an immediate,
// synchronous change when the browser lacks the API, the user prefers
// reduced motion, or (for layout transitions) the screen is narrow, where
// drawers and sheets carry their own CSS motion.
const M = ${JSON.stringify(MOTION)};
const NARROW = ${BREAKPOINTS.narrow};

export const motion = M;

export function reducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function options(preset, extra) {
  return Object.assign({ duration: M.durations[preset.duration], easing: M.easings[preset.easing] }, extra || {});
}

function canAnimate(el) { return Boolean(el) && typeof el.animate === "function" && !reducedMotion(); }

// Plays a preset on an element that has just appeared. Returns the
// Animation, or null when nothing was played.
export function enter(el, name) {
  const preset = M.presets[name || "rise"];
  if (!preset || !canAnimate(el)) return null;
  return el.animate(preset.frames, options(preset));
}

// Plays an exit preset and resolves once it has finished (or at once when
// motion is unavailable). The final frame is held until the caller hides
// the element; call cancel() on the returned animation to abort.
export function leave(el, name) {
  const preset = M.presets[name || "fade"];
  if (!preset || !canAnimate(el)) return { finished: Promise.resolve(), cancel() {} , animation: null };
  const animation = el.animate(preset.frames, options(preset, { fill: "forwards" }));
  return { finished: animation.finished.then(function () {}, function () {}), cancel() { animation.cancel(); }, animation };
}

// Runs a DOM update that moves the workspace columns (sidebar collapse,
// dock open or close) inside a View Transition, so the columns glide to
// their new widths. Without support the update runs synchronously.
let layoutRunning = 0;
export function layoutTransition(update) {
  const supported = typeof document !== "undefined" && typeof document.startViewTransition === "function" &&
    typeof window !== "undefined" && window.innerWidth > NARROW && !reducedMotion() && !document.hidden;
  if (!supported) { update(); return; }
  // The column names exist only during the transition (styles/motion).
  const root = document.documentElement;
  const done = function () { if (--layoutRunning === 0) root.classList.remove("vt-layout"); };
  layoutRunning += 1;
  root.classList.add("vt-layout");
  let transition;
  try { transition = document.startViewTransition(update); } catch { done(); update(); return; }
  transition.finished.finally(done);
}
`;
