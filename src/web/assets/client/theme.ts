export const THEME_SCRIPT = String.raw`
// Theme preference. "system" follows prefers-color-scheme and resolves to
// sumi (dark) or washi (light); the resolved name is stamped on <html> so the
// token blocks in styles/tokens.ts apply. To add a theme, append it here and
// add its token block.
import { h } from "/assets/js/dom.js";

export const THEMES = Object.freeze([
  { id: "system", swatch: ["#141518", "#fbfaf7", "#ff7a52"] },
  { id: "sumi", swatch: ["#0e0f11", "#191a1e", "#ff7a52"] },
  { id: "washi", swatch: ["#f4f2ed", "#ffffff", "#d24a26"] },
  { id: "ai", swatch: ["#0a0e1a", "#141a2e", "#8fa8ff"] }
]);
const IDS = THEMES.map(function (theme) { return theme.id; });

function storedPreference() {
  try {
    const saved = localStorage.getItem("yui.theme");
    return IDS.includes(saved) ? saved : "system";
  } catch { return "system"; }
}

export function createThemeController(container, t) {
  const media = window.matchMedia("(prefers-color-scheme: light)");
  let preference = storedPreference();
  const listeners = new Set();

  function resolved() {
    return preference === "system" ? (media.matches ? "washi" : "sumi") : preference;
  }
  function apply() {
    document.documentElement.dataset.theme = resolved();
    if (container) container.querySelectorAll("[data-theme-option]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.themeOption === preference));
    });
    listeners.forEach(function (listener) { listener(resolved()); });
  }
  function render() {
    if (!container) return;
    container.replaceChildren.apply(container, THEMES.map(function (theme) {
      const swatch = h("span.theme-swatch", { "aria-hidden": "true" },
        theme.swatch.map(function (color, index) {
          const part = h("i");
          part.style.background = color;
          part.dataset.part = String(index);
          return part;
        }));
      return h("button.theme-option", {
        type: "button",
        dataset: { themeOption: theme.id },
        onclick: function () { set(theme.id); }
      }, swatch, h("span", null, t("theme." + theme.id)));
    }));
    apply();
  }
  function set(next) {
    if (!IDS.includes(next)) return;
    preference = next;
    try { localStorage.setItem("yui.theme", next); } catch {}
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
