export const ROUTER_SCRIPT = String.raw`
// URL state. The selected Task, section, status filter, search, attention
// filter and archive scope live in the query string so back/forward, refresh
// and deep links keep context. Empty parameters are dropped.
export function readQuery() { return new URLSearchParams(window.location.search); }

export function applyUrl(params, replace) {
  const entries = Array.from(params.entries()).filter(function (entry) { return entry[1] !== ""; });
  const search = entries.length ? "?" + entries.map(function (entry) {
    return encodeURIComponent(entry[0]) + "=" + encodeURIComponent(entry[1]);
  }).join("&") : "";
  const url = window.location.pathname + search + window.location.hash;
  history[replace ? "replaceState" : "pushState"]({ task: params.get("task") || null }, "", url);
}

export function urlTaskId() { return readQuery().get("task") || null; }

export function syncUrl(state, replace) {
  const params = readQuery();
  if (state.selected) params.set("task", state.selected);
  else { params.delete("task"); params.delete("section"); }
  if (state.filter !== "all") params.set("filter", state.filter); else params.delete("filter");
  if (state.query) params.set("q", state.query); else params.delete("q");
  if (state.attentionFilter) params.set("attention", state.attentionFilter); else params.delete("attention");
  if (state.catalogAll) params.set("all", "true"); else params.delete("all");
  applyUrl(params, replace);
}

export function setSectionParam(state, section) {
  const params = readQuery();
  if (!state.selected || params.get("section") === section) return;
  if (section === "overview") params.delete("section"); else params.set("section", section);
  applyUrl(params, true);
}
`;
