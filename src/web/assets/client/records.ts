export const RECORDS_SCRIPT = String.raw`
// Context record access. Every business fact keeps its Context reference; an
// expanded value is a current read, never a mutation of the snapshot.
import { h, icon } from "/assets/js/dom.js";
import { richText, mono, button, note, disclosure } from "/assets/js/components.js";

export function entriesOf(core, store) {
  return core.records.filter(function (entry) { return entry.ref.store === store; });
}

export function valuesOf(core, store) {
  return entriesOf(core, store).filter(function (entry) { return !entry.omitted; }).map(function (entry) { return entry.value; });
}

// The family total from the same bounded read as its samples. The current
// view counts current records only: open work, active runs, open questions.
export function totalOf(core, store) {
  const row = (core.collections || []).find(function (item) { return item.store === store; });
  return row ? row.total : entriesOf(core, store).length;
}

// List and omitted-value summaries join known fields in a fixed order
// ("title: …; status: …"). Split them for display only; the exact record
// stays one read away.
const SUMMARY_KEYS = ["title", "objective", "question", "summary", "body", "status", "type"];
export function summaryFields(summary) {
  const fields = {};
  if (!summary) return fields;
  const pattern = new RegExp("(?:^|; )(" + SUMMARY_KEYS.join("|") + "): ", "g");
  const marks = [];
  let match;
  while ((match = pattern.exec(summary))) {
    const rank = SUMMARY_KEYS.indexOf(match[1]);
    if (marks.length && rank <= marks[marks.length - 1].rank) continue;
    marks.push({ key: match[1], rank: rank, start: match.index, from: match.index + match[0].length });
  }
  marks.forEach(function (mark, index) {
    fields[mark.key] = summary.slice(mark.from, index + 1 < marks.length ? marks[index + 1].start : summary.length);
  });
  return fields;
}

// --- Exact reads -------------------------------------------------------------
// One inspect per reference digest, held in view state so a refresh with an
// unchanged reference never reads again. A changed digest is a new read.
export function readExact(entry, taskId, actions, cache) {
  const key = entry.ref.store + "/" + entry.ref.refId;
  const hit = cache[key];
  if (hit && hit.digest === entry.ref.digest) return hit.promise;
  const promise = actions.inspect(taskId, entry.ref);
  const slot = { digest: entry.ref.digest, promise: promise, result: null };
  cache[key] = slot;
  promise.then(function (result) { slot.result = result; }, function () { if (cache[key] === slot) delete cache[key]; });
  return promise;
}

// A row drawn from its exact value: synchronously when cached, otherwise the
// honest summary card until the read returns and replaces it in place.
export function exactRow(entry, taskId, t, actions, cache, render) {
  if (!entry.omitted) return render(entry.value, null);
  const hit = cache[entry.ref.store + "/" + entry.ref.refId];
  if (hit && hit.digest === entry.ref.digest && hit.result) return render(hit.result.value, hit.result);
  const placeholder = recordCard(entry, taskId, t, actions);
  placeholder.dataset.reading = "true";
  readExact(entry, taskId, actions, cache).then(function (result) {
    if (placeholder.isConnected) placeholder.replaceWith(render(result.value, result));
  }, function () { placeholder.dataset.reading = "false"; });
  return placeholder;
}

// A closed row drawn from a list summary; its exact value is read on first
// open. Open rows are remembered in view state and reopen after a redraw.
export function lazyRow(item, taskId, t, actions, options) {
  const opts = options || {};
  const key = item.ref.store + ":" + item.ref.refId;
  const element = h("details.lazy-row");
  if (item.status) element.dataset.status = item.status;
  const body = h("div.lazy-body");
  element.append(h("summary.lazy-head", null, icon("chevron", "disclosure-chevron"), opts.head), body);
  let state = "idle";
  function load() {
    if (state !== "idle") return;
    state = "reading";
    element.dataset.reading = "true";
    body.replaceChildren(h("p.faint.small", null, t("record.reading")));
    readExact({ ref: item.ref }, taskId, actions, opts.cache || {}).then(function (result) {
      state = "done";
      const raw = disclosure(t("record.raw"), null);
      raw.body.append(h("pre.code-block", null, JSON.stringify(result.value, null, 2)));
      body.replaceChildren();
      body.append(h("div.lazy-content", null, opts.render ? opts.render(result.value, result) : null), raw);
    }, function (error) {
      state = "idle";
      body.replaceChildren(note(t("record.changed") + " · " + error.message, "bad"));
    }).then(function () { element.dataset.reading = "false"; });
  }
  element.addEventListener("toggle", function () {
    if (opts.openRows) { if (element.open) opts.openRows[key] = true; else delete opts.openRows[key]; }
    if (element.open) load();
  });
  if (opts.openRows && opts.openRows[key]) element.open = true;
  return element;
}

// --- Paged family discovery --------------------------------------------------
// Pages of one Context family for the current Context cursor. A continuation
// never mixes versions: after the cursor changes, the first page is re-read.
export function familyState(view, store) {
  view.families = view.families || {};
  if (!view.families[store]) view.families[store] = { items: [], total: null, nextCursor: null, pages: 0, key: null, error: null, pending: null };
  return view.families[store];
}

export function loadFamily(view, taskId, store, key, actions, options) {
  const state = familyState(view, store);
  const more = !!(options && options.more);
  if (state.pending) return state.pending;
  if (more ? !state.nextCursor : state.key === key && state.pages && !state.error) return Promise.resolve(state);
  state.pending = actions.list(taskId, store, { limit: (options && options.limit) || 40, cursor: more ? state.nextCursor : null })
    .then(function (page) {
      if (!more) { state.items = []; state.pages = 0; }
      state.items = state.items.concat(page.items);
      state.total = page.total;
      state.nextCursor = page.nextCursor;
      state.pages += 1;
      state.key = more ? state.key : key;
      state.error = null;
      state.errorKey = null;
      return state;
    }, function (error) { state.error = error.message; state.errorKey = more ? state.key : key; return state; })
    .then(function (result) { state.pending = null; return result; });
  return state.pending;
}

// --- Cards ---------------------------------------------------------------------
// A generic, honest card for any record: omitted values say so and can be
// read by reference; reading never acknowledges or accepts anything.
export function recordCard(entry, taskId, t, actions, options) {
  const opts = options || {};
  const element = h("article.record" + (opts.compact ? ".is-compact" : ""));
  element.append(h("header.record-head", null,
    h("span.record-store", null, t("store." + entry.ref.store, entry.ref.store)),
    mono(entry.ref.refId),
    h("span.spacer"),
    h("span.faint.small", { title: t("record.revision") }, String(entry.ref.revision).slice(0, 24))));
  if (!entry.omitted && entry.value) {
    const value = entry.value;
    const text = value.content || value.summary || value.body || value.objective || value.title || value.leaderSummary;
    if (text) element.append(richText(null, text, t, { threshold: 360 }));
    if (entry.ref.store === "task-decision" && value.rationale) element.append(richText(t("record.rationale"), value.rationale, t, { muted: true }));
    const facts = [value.status, value.roleName].filter(Boolean);
    if (facts.length) element.append(h("p.faint.small", null, facts.join(" · ")));
    if (entry.ref.store === "job") element.append(note(t("job." + value.status + ".note", t("job.terminal.note")), value.status === "unknown-needs-attention" ? "warn" : ""));
  } else {
    const fields = summaryFields(entry.summary);
    const lead = fields.title || fields.question || fields.objective;
    if (lead) element.append(h("p.record-lead", null, lead));
    const text = fields.summary || fields.body || (lead === fields.objective ? null : fields.objective);
    if (text) element.append(h("p.faint", null, text));
    if (!lead && !text) element.append(h("p.faint", null, entry.summary || t("record.omitted")));
  }
  element.append(recordReader(entry, taskId, t, actions));
  return element;
}

// Shared source access for cards, history and discussion, including records
// whose compact value is present but does not display every durable field.
// With a renderer, the exact value is drawn richly and the raw record stays
// available behind a disclosure.
export function recordReader(entry, taskId, t, actions, render) {
  const element = h("div.stack");
  const expand = button(t("record.read"), { icon: "eye", variant: "link" });
  expand.addEventListener("click", async function () {
    expand.disabled = true;
    element.dataset.reading = "true";
    try {
      const result = await actions.inspect(taskId, entry.ref);
      const rich = render ? render(result.value, result) : null;
      if (rich) {
        const raw = disclosure(t("record.raw"), null);
        raw.body.append(h("pre.code-block", null, JSON.stringify(result.value, null, 2)));
        element.append(rich, raw);
      } else {
        if (result.result && result.result.output) element.append(richText(t("record.output"), result.result.output, t));
        if (result.result && result.result.diagnostic) element.append(richText(t("record.diagnostic"), result.result.diagnostic, t));
        element.append(h("pre.code-block", null, JSON.stringify(result.value, null, 2)));
        if (result.execution) element.append(h("pre.code-block", null, JSON.stringify(result.execution, null, 2)));
      }
      expand.remove();
    } catch {
      expand.disabled = false;
      expand.replaceChildren(icon("refresh"), h("span", null, t("record.changed")));
    } finally { element.dataset.reading = "false"; }
  });
  element.append(h("div.record-actions", null, expand));
  return element;
}
`;
