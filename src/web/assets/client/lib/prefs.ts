export const PREFS_SCRIPT = String.raw`
// Browser-local view preferences (theme, locale, layout). Storage may be
// unavailable (private mode, policy); reads use a fallback and mutations
// report failure instead of throwing.
export function readPreference(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

export function writePreference(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

export function clearPreference(key) {
  try { localStorage.removeItem(key); return true; } catch { return false; }
}

// Per-tab return points between the workbench and the management areas, so
// switching back restores the filters, Task or section the user left. Only
// same-origin paths of the expected area are accepted; anything else falls back.
const PLACES = { workbench: /^\/(?:\?|$)/, models: /^\/models(?:[/?]|$)/, settings: /^\/settings(?:[/?]|$)/,
  jobs: /^\/jobs(?:[/?]|$)/, manage: /^\/(?:jobs|models|settings)(?:[/?]|$)/ };

export function rememberPlace(area, href) {
  if (!PLACES[area] || !PLACES[area].test(href)) return;
  try { sessionStorage.setItem("yui.nav." + area, href); } catch { /* storage unavailable: links keep defaults */ }
}

export function recallPlace(area, fallback) {
  try {
    const value = sessionStorage.getItem("yui.nav." + area);
    return value && PLACES[area] && PLACES[area].test(value) ? value : fallback;
  } catch { return fallback; }
}

// Point every a[data-nav-area] inside root at its area's return point.
export function linkPlaces(root) {
  root.querySelectorAll("a[data-nav-area]").forEach(function (link) {
    if (!link.dataset.navDefault) link.dataset.navDefault = link.getAttribute("href");
    link.setAttribute("href", recallPlace(link.dataset.navArea, link.dataset.navDefault));
  });
}

// Shared with session access consumers: no server configuration or live
// Session is changed by this browser-local preference.
export function readSessionAccessMode() {
  // The structured conversation is the default; the native terminal is opt-in.
  const value = readPreference("yui.session.accessMode", "structured");
  return value === "native" ? "native" : "structured";
}

export function writeSessionAccessMode(value) {
  if (value !== "native" && value !== "structured") throw new Error("Invalid session access mode.");
  return writePreference("yui.session.accessMode", value);
}
`;
