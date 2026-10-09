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
`;
