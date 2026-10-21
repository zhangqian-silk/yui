// The motion system: every duration, easing, keyframe and stacking layer in
// the web UI comes from here. The stylesheets read the generated CSS custom
// properties (tokens.ts) and keyframes (styles/motion.ts); client scripts read
// the same values as JSON (client/lib/motion.ts). Changing a number below
// retimes the whole interface in one place.
//
// The curves follow well-known open-source component libraries: `sheet` is
// the iOS / Vaul drawer curve, `standard` a Material/Radix-style ease-out for
// small UI, and `exit` an accelerate curve so things leave quicker than they
// arrive.

export const DURATIONS = Object.freeze({
  // Hover, press and colour feedback.
  fast: 120,
  // Popovers, menus, dialogs, content swaps.
  base: 200,
  // Exits are a little quicker than entries.
  exit: 150,
  // Column resizes (sidebar collapse, dock open) via View Transitions.
  layout: 260,
  // Drawers and sheets.
  sheet: 420,
  sheetOut: 300,
  // Cross-document page transitions.
  page: 220
});

export const EASINGS = Object.freeze({
  standard: "cubic-bezier(.2,.8,.2,1)",
  sheet: "cubic-bezier(.32,.72,0,1)",
  exit: "cubic-bezier(.4,0,1,1)"
});

// Stacking layers, lowest to highest.
export const LAYERS = Object.freeze({
  raised: 1,
  sticky: 10,
  header: 20,
  popover: 30,
  sheet: 60,
  scrim: 70,
  drawer: 71,
  railOver: 72,
  toast: 90,
  skip: 100
});

type Frame = Record<string, string | number>;
type Preset = { frames: Frame[]; duration: keyof typeof DURATIONS; easing: keyof typeof EASINGS };

// Keyframe presets. Each is emitted as a CSS @keyframes rule named
// `m-<name>` and handed to the Web Animations API by the client.
export const PRESETS: Readonly<Record<string, Preset>> = Object.freeze({
  fade: { frames: [{ opacity: 0 }, { opacity: 1 }], duration: "base", easing: "standard" },
  rise: { frames: [{ opacity: 0, transform: "translate3d(0,6px,0)" }, { opacity: 1, transform: "none" }], duration: "base", easing: "standard" },
  pop: { frames: [{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }], duration: "base", easing: "standard" },
  sheetUp: { frames: [{ transform: "translate3d(0,100%,0)" }, { transform: "translate3d(0,0,0)" }], duration: "sheet", easing: "sheet" },
  sheetDown: { frames: [{ transform: "translate3d(0,0,0)" }, { transform: "translate3d(0,100%,0)" }], duration: "sheetOut", easing: "sheet" }
});

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

// CSS custom properties: --t-<duration>, --ease-<easing>, --z-<layer>.
// `--t-med` and `--ease` stay as aliases for the existing stylesheets.
export function motionTokenStyles(): string {
  const t = Object.entries(DURATIONS).map(([k, v]) => `--t-${kebab(k)}:${v}ms`);
  const e = Object.entries(EASINGS).map(([k, v]) => `--ease-${kebab(k)}:${v}`);
  const z = Object.entries(LAYERS).map(([k, v]) => `--z-${kebab(k)}:${v}`);
  return [...t, "--t-med:var(--t-base)", ...e, "--ease:var(--ease-standard)", ...z].join(";") + ";";
}

function frameCss(frame: Frame): string {
  return Object.entries(frame).map(([k, v]) => `${kebab(k)}:${v}`).join(";");
}

export function motionKeyframes(): string {
  const presets = Object.entries(PRESETS).map(([name, p]) => {
    const last = p.frames.length - 1;
    const stops = p.frames.map((f, i) => `${last ? Math.round((i / last) * 100) : 0}%{${frameCss(f)}}`).join("");
    return `@keyframes m-${kebab(name)}{${stops}}`;
  });
  return [...presets, "@keyframes m-spin{to{transform:rotate(360deg)}}", "@keyframes m-blink{50%{opacity:.35}}"].join("\n");
}

// The JSON the client motion helper reads.
export const MOTION = Object.freeze({ durations: DURATIONS, easings: EASINGS, presets: PRESETS });
