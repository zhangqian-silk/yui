import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, THEME_OPTIONS } from "../../shared/themes.js";

// Shared by the parser-blocking head script and the later settings controller.
// Both resolve the same browser preference without publishing global state.
const THEME_PREFERENCE_SCRIPT = String.raw`
const IDS = ${JSON.stringify(THEME_OPTIONS.map(theme => theme.id))};
const DEFAULT_DARK = ${JSON.stringify(DEFAULT_DARK_THEME.id)};
const DEFAULT_LIGHT = ${JSON.stringify(DEFAULT_LIGHT_THEME.id)};

function storedPreference() {
  try {
    const saved = localStorage.getItem("yui.theme");
    return IDS.includes(saved) ? saved : "system";
  } catch { return "system"; }
}

function resolveTheme(preference, media) {
  return preference === "system" ? (media.matches ? DEFAULT_LIGHT : DEFAULT_DARK) : preference;
}
`;

// A same-origin classic script runs before styles/body, unlike the deferred
// application module graph. No inline script or weaker CSP is needed.
export const THEME_BOOTSTRAP_SCRIPT = String.raw`
(function () {
${THEME_PREFERENCE_SCRIPT}
  document.documentElement.dataset.theme = resolveTheme(
    storedPreference(), window.matchMedia("(prefers-color-scheme: light)")
  );
})();
`;

export const THEME_SCRIPT = String.raw`
// Theme preference. "system" follows prefers-color-scheme and resolves to the
// default dark or light theme; the resolved id is stamped on <html> so its
// token block applies. Options and swatches come from shared/themes.ts.
import { h, markSelected } from "/assets/js/lib/dom.js";
import { writePreference } from "/assets/js/lib/prefs.js";

const THEMES = Object.freeze(${JSON.stringify(THEME_OPTIONS)});
${THEME_PREFERENCE_SCRIPT}

function themeOption(theme, t, onPick) {
  const swatch = h("span.theme-swatch", { "aria-hidden": "true" }, theme.swatch.map(function (color, index) {
    const part = h("i");
    part.style.background = color;
    part.dataset.part = String(index);
    return part;
  }));
  return h("button.theme-option", {
    type: "button",
    dataset: { themeOption: theme.id },
    onclick: function () { onPick(theme.id); }
  }, swatch, h("span", null, t("theme." + theme.id)));
}

export function createThemeController(container, t) {
  const media = window.matchMedia("(prefers-color-scheme: light)");
  let preference = storedPreference();
  const listeners = new Set();

  function resolved() {
    return resolveTheme(preference, media);
  }
  function apply() {
    document.documentElement.dataset.theme = resolved();
    if (container) markSelected(container.querySelectorAll("[data-theme-option]"), "aria-pressed", function (button) {
      return button.dataset.themeOption === preference;
    });
    listeners.forEach(function (listener) { listener(resolved()); });
  }
  function render() {
    if (!container) return;
    container.replaceChildren.apply(container, THEMES.map(function (theme) { return themeOption(theme, t, set); }));
    apply();
  }
  function set(next) {
    if (!IDS.includes(next)) return;
    preference = next;
    writePreference("yui.theme", next);
    apply();
  }
  media.addEventListener("change", function () { if (preference === "system") apply(); });
  render();
  return {
    resolved: resolved,
    render: render,
    set: set,
    subscribe: function (listener) { listeners.add(listener); }
  };
}
`;
