export const PRIMITIVES_SCRIPT = String.raw`
// Leaf builders: data in, one small DOM element out. Nothing here reads
// application state, translates domain values or performs a request.
import { h, icon } from "/assets/js/lib/dom.js";
import { formatDateTime, relativeTime } from "/assets/js/lib/format.js";

export function badge(text, toneName, options) {
  const element = h("span.badge.tone-" + (toneName || "idle"), null,
    options && options.dot ? h("i.badge-dot", { "aria-hidden": "true" }) : null, text);
  if (options && options.title) element.title = options.title;
  return element;
}

export function dot(toneName, title) {
  const element = h("span.dot.tone-" + (toneName || "idle"), { "aria-hidden": title ? null : "true" });
  if (title) { element.title = title; element.setAttribute("role", "img"); element.setAttribute("aria-label", title); }
  return element;
}

export function chip(text, extraClass) {
  return h("span.chip" + (extraClass ? "." + extraClass : ""), null, text);
}

export function mono(text, extraClass) {
  return h("code.id" + (extraClass ? "." + extraClass : ""), null, text);
}

export function timeTag(iso, locale, t, options) {
  if (!iso) return null;
  const element = h("time.when", { dateTime: iso }, options && options.absolute
    ? formatDateTime(iso, locale) : relativeTime(iso, locale, t));
  element.title = formatDateTime(iso, locale);
  return element;
}

export function button(text, options) {
  const opts = options || {};
  const element = h("button.btn" + (opts.variant ? ".btn-" + opts.variant : ""), {
    type: opts.type || "button", onclick: opts.onClick, disabled: !!opts.disabled, title: opts.title
  }, opts.icon ? icon(opts.icon) : null, text ? h("span", null, text) : null);
  if (opts.dataset) Object.assign(element.dataset, opts.dataset);
  return element;
}

export function note(text, toneName) {
  return h("p.note" + (toneName ? ".tone-" + toneName : ""), null, text);
}

export function emptyState(text, iconName, extra) {
  return h("div.empty", null, iconName ? icon(iconName) : null, h("p", null, text), extra || null);
}

export function loadingBlock(text) {
  return h("div.loading-block", null, h("span.spinner"), h("span", null, text));
}

export function kv(rows) {
  const list = h("dl.kv");
  rows.forEach(function (row) {
    if (!row || row[1] === undefined || row[1] === null || row[1] === "") return;
    list.append(h("dt", null, row[0]), h("dd", null, row[1]));
  });
  return list;
}

export function bulletList(items, className) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  return h("ul.bullets" + (className ? "." + className : ""), null, list.map(function (item) { return h("li", null, item); }));
}

// Verbatim text (a command, an exact record) in a scrollable block.
export function codeBlock(text) {
  return h("pre.code-block", null, text);
}

export function jsonBlock(value) {
  return codeBlock(JSON.stringify(value, null, 2));
}

// Only http(s) links without credentials leave the page.
export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function externalLink(href, text) {
  return h("a.link", { href: href, rel: "noopener noreferrer", target: "_blank" }, text);
}
`;
