export const FORMAT_SCRIPT = String.raw`
// Date / number formatting shared by every view.
export function relativeTime(iso, locale, t) {
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  if (Math.abs(seconds) < 45) return t("time.justNow");
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const selected = units.find(function (entry) { return Math.abs(seconds) >= entry[1]; }) || ["second", 1];
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" })
    .format(Math.round(seconds / selected[1]), selected[0]);
}

export function formatDateTime(iso, locale) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export function formatClock(iso, locale) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "—";
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
}

export function formatShort(iso, locale) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    .format(new Date(iso));
}

export function formatBytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / 1024 / 1024).toFixed(1) + " MB";
}

export function byNewest(left, right) {
  return Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt);
}
`;
