export const CONTAINERS_SCRIPT = String.raw`
// Panels of the single reading column. A card has a heading (icon tile,
// title, count and hint) with optional actions, then its body; a list card's
// body is a .row-stack whose rows are divided by hairlines, not nested boxes.
import { h, icon, markSelected } from "/assets/js/lib/dom.js";
import { fill } from "/assets/js/lib/format.js";
import { button, jsonBlock } from "/assets/js/ui/primitives.js";

export function card(options) {
  const opts = options || {};
  const element = h("section.card" + (opts.className ? "." + opts.className.split(" ").join(".") : ""));
  if (opts.id) element.id = opts.id;
  if (opts.title || opts.actions) element.append(cardHead(opts));
  const body = h("div.card-body");
  element.append(body);
  element.body = body;
  return element;
}

function cardHead(opts) {
  const heading = h("div.card-heading", null,
    h("h3.card-title", null, opts.icon ? h("span.card-icon", null, icon(opts.icon)) : null, h("span", null, opts.title),
      opts.count !== undefined && opts.count !== null ? h("span.count", null, String(opts.count)) : null),
    opts.hint ? h("p.card-hint", null, opts.hint) : null);
  return h("header.card-head", null, heading, opts.actions ? h("div.card-actions", null, opts.actions) : null);
}

export function listCard(options) {
  const element = card({ ...options, className: "list-card" + (options.className ? " " + options.className : "") });
  element.list = h("div.row-stack");
  element.body.append(element.list);
  return element;
}

// Update a card heading count after a later read; null removes it.
export function setCardCount(element, value) {
  const title = element.querySelector(".card-title");
  let count = title && title.querySelector(".count");
  if (value === undefined || value === null) { if (count) count.remove(); return; }
  if (!title) return;
  if (!count) { count = h("span.count"); title.append(count); }
  count.textContent = String(value);
}

export function disclosure(title, viewKey, options) {
  const opts = options || {};
  const element = h("details.disclosure" + (opts.className ? "." + opts.className : ""));
  if (viewKey) element.dataset.viewKey = viewKey;
  const summary = h("summary", null, icon("chevron", "disclosure-chevron"), h("span.disclosure-title", null, title));
  if (opts.meta) summary.append(h("span.disclosure-meta", null, opts.meta));
  element.append(summary);
  const body = h("div.disclosure-body");
  element.append(body);
  element.body = body;
  return element;
}

// A top-level section that stays closed until asked (control, diagnostics…).
export function cardDisclosure(id, title, viewKey, meta) {
  const element = disclosure(title, viewKey, { className: "card-disclosure", meta: meta });
  element.id = id;
  return element;
}

// The exact record behind a rich rendering, one click away.
export function rawDisclosure(t, value) {
  const raw = disclosure(t("record.raw"), null);
  raw.body.append(jsonBlock(value));
  return raw;
}

// Local filter chips; selecting one redraws the list in place.
export function filterChips(ariaLabel, options, selected, onSelect) {
  const row = h("div.chip-tabs", { role: "group", "aria-label": ariaLabel });
  options.forEach(function (option) {
    row.append(h("button.chip-tab", {
      type: "button", "aria-pressed": String(option.value === selected), dataset: { filter: option.value },
      onclick: function () {
        markSelected(row.querySelectorAll(".chip-tab"), "aria-pressed", function (b) { return b.dataset.filter === option.value; });
        onSelect(option.value);
      }
    }, option.label, option.count === undefined || option.count === null ? null : h("span.count", null, String(option.count))));
  });
  return row;
}

// Paged list footers: how much is loaded, and a button for the next page
// that disables itself until the caller redraws.
export function loadedNote(t, shown, total) {
  return h("span.faint.small", null, fill(t("history.loaded"), { shown: shown, total: total }));
}

export function moreButton(t, onMore) {
  const more = button(t("history.more"), { icon: "chevron", variant: "ghost" });
  more.addEventListener("click", function () {
    more.disabled = true;
    onMore();
  });
  return more;
}
`;
