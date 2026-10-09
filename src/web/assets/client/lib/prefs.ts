export const PREFS_SCRIPT = String.raw`
// Browser-local view preferences (theme, locale, layout). Storage may be
// unavailable (private mode, policy); every access then degrades to the
// fallback instead of throwing.
export function readPreference(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

export function writePreference(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

export function clearPreference(key) {
  try { localStorage.removeItem(key); } catch {}
}

// Shared with session access consumers: no server configuration or live
// Session is changed by this browser-local preference.
export function readSessionAccessMode() {
  const value = readPreference("yui.session.accessMode", "native");
  return value === "structured" ? "structured" : "native";
}

export function writeSessionAccessMode(value) {
  if (value !== "native" && value !== "structured") throw new Error("Invalid session access mode.");
  writePreference("yui.session.accessMode", value);
  return readSessionAccessMode() === value;
}
`;
