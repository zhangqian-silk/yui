export const DISCUSSION_SCRIPT = String.raw`
// The Task discussion in the dock: recorded Task messages plus the composer.
// The feed is a read-only projection and redraws on every refresh; the
// composer is kept per Task so a refresh can never discard an unsent draft or
// a pending receipt.
import { h, clear } from "/assets/js/lib/dom.js";
import { fill, formatShort } from "/assets/js/lib/format.js";
import { chip, emptyState } from "/assets/js/ui/primitives.js";
import { richText } from "/assets/js/ui/text.js";
import { label } from "/assets/js/domain/vocab.js";
import { cachedExact, entriesOf, exactCache, totalOf } from "/assets/js/domain/context.js";
import { recordCard } from "/assets/js/domain/records.js";
import { messageComposer } from "/assets/js/domain/taskForms.js";

export function renderDiscussion(host, data, t, locale, actions) {
  const task = data.task;
  const composerKey = task.id + "|" + task.status + "|" + locale;
  let feed = host.querySelector(".feed");
  const composerWrap = host.querySelector(".composer-wrap");
  const composer = composerWrap && composerWrap.firstChild;
  const keepComposer = host.dataset.taskId === task.id && composer
    && (composer.dataset.key === composerKey || composer.dataset.unsent === "true" || composer.contains(document.activeElement));
  const previousScroll = feed ? feed.scrollTop : 0;
  const atEnd = !feed || host.dataset.taskId !== task.id || feed.scrollHeight - feed.clientHeight - feed.scrollTop < 40;
  if (host.dataset.taskId !== task.id || !feed) feed = discussionFrame(host, t);
  host.dataset.taskId = task.id;
  latest.set(task.id, { data: data, t: t, locale: locale, actions: actions });
  if (!feed.querySelector('[data-reading="true"]')) drawFeed(feed, data, t, locale, actions);
  feed.scrollTop = atEnd ? feed.scrollHeight : previousScroll;
  if (!keepComposer) {
    const next = messageComposer(task, t, actions);
    next.dataset.key = composerKey;
    host.querySelector(".composer-wrap").replaceChildren(next);
  }
}

function discussionFrame(host, t) {
  clear(host);
  host.append(
    h("div.dock-sub", null, h("span.dock-sub-title", null, t("discussion.title")), h("span.dock-sub-note", null, t("discussion.source"))),
    h("div.feed", { "aria-label": t("discussion.feed"), tabIndex: 0 }),
    h("div.composer-wrap"));
  return host.querySelector(".feed");
}

export function discussionHasUnsent(host) {
  return !!host.querySelector('[data-unsent="true"]');
}

// The Context read carries bounded summaries. Full bodies are opened by the
// reader, never downloaded automatically because the dock was rendered.
const older = new Map();
const latest = new Map();

function exactValue(entry, cache) {
  if (!entry.omitted) return entry.value;
  const hit = cachedExact(cache, entry);
  return hit ? hit.value : null;
}

function loadOlder(data, actions, state, shownIds) {
  state.pending = true;
  state.error = null;
  let rounds = 0;
  function next() {
    return actions.list(data.task.id, "task-message", { limit: 20, cursor: state.cursor }).then(function (page) {
      const known = new Set(state.items.map(function (item) { return item.ref.refId; }));
      const fresh = page.items.filter(function (item) { return !known.has(item.ref.refId) && !shownIds.has(item.ref.refId); });
      state.items = state.items.concat(fresh);
      state.cursor = page.nextCursor;
      state.done = !page.nextCursor;
      rounds += 1;
      if (!fresh.length && page.nextCursor && rounds < 10) return next();
    });
  }
  // A listing that moved invalidates its continuation; the next request
  // starts again from the newest page and skips what is already shown.
  return next().catch(function (error) { state.error = error.message; state.cursor = null; })
    .then(function () { state.pending = false; });
}

function olderState(taskId) {
  if (!older.has(taskId)) older.set(taskId, { items: [], cursor: null, done: false, pending: false, error: null });
  return older.get(taskId);
}

// Feed rows oldest first, reusing an exact value only when already read.
function feedRows(olderItems, contextEntries, cache) {
  // Context lists messages newest first; the feed reads oldest first.
  const rows = olderItems.map(function (item) { return { entry: { ref: item.ref, summary: item.summary, omitted: true }, at: item.createdAt }; })
    .concat(contextEntries.slice().reverse().map(function (entry) { return { entry: entry, at: null }; }));
  rows.forEach(function (row) {
    row.value = exactValue(row.entry, cache);
    row.at = (row.value && row.value.createdAt) || row.at;
  });
  if (rows.every(function (row) { return row.at; })) rows.sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at); });
  return rows;
}

function drawFeed(feed, data, t, locale, actions) {
  clear(feed);
  const task = data.task;
  const cache = exactCache(data.viewState);
  const contextEntries = entriesOf(data.core, "task-message");
  const shownIds = new Set(contextEntries.map(function (entry) { return entry.ref.refId; }));
  const state = olderState(task.id);
  const olderItems = state.items.filter(function (item) { return !shownIds.has(item.ref.refId); })
    .sort(function (a, b) { return Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0); });
  const rows = feedRows(olderItems, contextEntries, cache);
  const remaining = totalOf(data.core, "task-message") - shownIds.size - olderItems.length;
  if (actions.list && remaining > 0 && !state.done) {
    feed.append(olderButton(remaining, state, t, function () {
      return loadOlder(data, actions, state, shownIds).then(function () { redraw(feed, task.id, true); });
    }));
  }
  if (state.error) feed.append(h("p.feed-note", null, t("records.unavailable") + " " + state.error));
  if (!rows.length) {
    feed.append(emptyState(t("discussion.empty"), "chat"));
    return;
  }
  let lastDay = "";
  rows.forEach(function (row) {
    if (!row.value) { feed.append(placeholderRow(row, task.id, t, actions)); return; }
    const day = row.value.createdAt ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(row.value.createdAt)) : "";
    if (day && day !== lastDay) { feed.append(h("div.feed-day", null, h("span", null, day))); lastDay = day; }
    feed.append(messageRow(row, t, locale));
  });
}

function olderButton(remaining, state, t, onLoad) {
  const more = h("button.show-more.feed-older", { type: "button", disabled: state.pending },
    state.pending ? t("discussion.olderLoading") : fill(t("discussion.older"), { count: remaining }));
  more.addEventListener("click", function () {
    more.disabled = true;
    more.textContent = t("discussion.olderLoading");
    onLoad();
  });
  return more;
}

function placeholderRow(row, taskId, t, actions) {
  const placeholder = recordCard(row.entry, taskId, t, actions, { compact: true });
  if (row.reading) placeholder.dataset.reading = "true";
  return placeholder;
}

function messageRow(row, t, locale) {
  const value = row.value;
  const type = (value.author && value.author.type) || "system";
  const author = (value.author && value.author.roleName) || label(t, "author", type);
  const message = h("article.msg.from-" + (type === "user" || type === "operator" ? "user" : type === "role" ? "role" : "system"));
  message.append(h("span.msg-avatar", { "aria-hidden": "true" }, String(author).slice(0, 1).toUpperCase()));
  message.append(h("div.msg-main", null,
    h("header.msg-head", null, h("strong", null, author),
      value.intent ? chip(label(t, "intent", value.intent)) : null,
      value.kind === "role-result" ? chip(label(t, "messageKind", value.kind)) : null,
      h("time", { dateTime: value.createdAt || "", title: row.entry.ref.refId }, formatShort(value.createdAt, locale))),
    h("div.msg-bubble", null, richText(null, value.body || "", t, { threshold: 900 }))));
  return message;
}

// Redraw after a read without losing the reader's place: the bottom stays
// pinned, and prepended older messages keep the current message in view.
function redraw(feed, taskId, prepend) {
  const host = feed.closest("[data-task-id]");
  const current = latest.get(taskId);
  if (!feed.isConnected || !host || host.dataset.taskId !== taskId || !current) return;
  const atEnd = feed.scrollHeight - feed.clientHeight - feed.scrollTop < 40;
  const fromBottom = feed.scrollHeight - feed.scrollTop;
  drawFeed(feed, current.data, current.t, current.locale, current.actions);
  feed.scrollTop = atEnd && !prepend ? feed.scrollHeight : feed.scrollHeight - fromBottom;
}
`;
