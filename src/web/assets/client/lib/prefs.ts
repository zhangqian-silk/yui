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

// Shared with session access consumers: no server configuration or live
// Session is changed by this browser-local preference.
export function readSessionAccessMode() {
  const value = readPreference("yui.session.accessMode", "native");
  return value === "structured" ? "structured" : "native";
}

export function writeSessionAccessMode(value) {
  if (value !== "native" && value !== "structured") throw new Error("Invalid session access mode.");
  return writePreference("yui.session.accessMode", value);
}
`;
