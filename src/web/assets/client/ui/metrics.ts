export const METRICS_SCRIPT = String.raw`
// Metric tiles and the usage card. DOM is built with node() only, so the
// usage test can execute this module with node() and formatDateTime() alone.
import { node } from "/assets/js/lib/dom.js";
import { formatDateTime } from "/assets/js/lib/format.js";

export function metricTile(labelText, value, options) {
  const variant = options && options.tone ? " tone-" + options.tone : "";
  const tile = node("div", "metric" + variant);
  tile.append(node("span", "metric-label", labelText), node("strong", "metric-value", String(value)));
  return tile;
}

function pageLocale() { return typeof document === "undefined" ? undefined : document.documentElement.lang || undefined; }

// Seconds as the largest whole unit plus the next one ("2d 22h", "2小时48分钟").
const DURATION_UNITS = [["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];
function durationText(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const found = DURATION_UNITS.findIndex(function (unit) { return total >= unit[1]; });
  const first = found < 0 ? DURATION_UNITS.length - 1 : found;
  return DURATION_UNITS.slice(first, first + 2).map(function (unit, index) {
    const count = index ? Math.floor((total % DURATION_UNITS[first][1]) / unit[1]) : Math.floor(total / unit[1]);
    return index && !count ? "" : new Intl.NumberFormat(pageLocale(), { style: "unit", unit: unit[0], unitDisplay: "narrow" }).format(count);
  }).filter(Boolean).join(" ");
}

export function usageMetricText(metric, t, suffix) {
  if (!metric || metric.value == null) return t("detail.unobserved");
  const value = suffix === "s" ? durationText(metric.value) : metric.value + (suffix || "");
  return value + (metric.status === "partial" ? " · " + t("detail.partial") : "");
}

function usageTile(labelText, metric, t, suffix) {
  const tile = metricTile(labelText, usageMetricText(metric, t, suffix));
  if (metric && metric.reasons && metric.reasons.length) {
    tile.append(node("small", "metric-note", metric.reasons.map(function (reason) {
      return t("usage.reason." + reason);
    }).join("; ")));
  }
  return tile;
}

export function observabilityMetricCard(observability, t) {
  if (!observability) return null;
  const wrap = node("div", "usage");
  const grid = node("div", "metric-grid");
  const cost = observability.cost || {};
  const context = observability.context || {};
  grid.append(usageTile(t("usage.tokens"), cost.tokens, t));
  grid.append(usageTile(t("usage.toolCalls"), cost.toolCalls, t));
  grid.append(usageTile(t("usage.elapsed"), cost.elapsedSeconds, t, "s"));
  grid.append(usageTile(t("usage.executionSum"), cost.executionSeconds, t, "s"));
  grid.append(metricTile(t("usage.ready"), observability.readyCount === undefined
    ? ((observability.dag && observability.dag.readyIds) || []).length : observability.readyCount));
  grid.append(metricTile(t("usage.contextSnapshots"), context.snapshotCount == null ? t("detail.unobserved") : context.snapshotCount));
  wrap.append(grid);
  const meta = node("p", "usage-meta");
  meta.append(node("span", "", t("usage.scope")));
  meta.append(node("span", "", t("usage.observedThrough") + " "
    + (cost.observedThrough ? formatDateTime(cost.observedThrough, pageLocale()) : t("detail.unobserved"))));
  meta.append(node("span", "", t("usage.contextBytes") + " "
    + (context.totalBytes == null ? t("detail.partial") : context.totalBytes + " B")));
  wrap.append(meta);
  return wrap;
}
`;
