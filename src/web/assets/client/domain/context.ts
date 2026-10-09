export const CONTEXT_SCRIPT = String.raw`
// Context access. Every business fact keeps its Context reference; an
// expanded value is a current read, never a mutation of the snapshot.

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
const SUMMARY_KEYS = ["title", "scope", "expiresWhen", "version", "objective", "question", "summary", "body", "status", "type"];
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
// One inspect per reference digest, held in the Task's view state so a
// refresh with an unchanged reference never reads again. A changed digest is
// a new read.
export function exactCache(view) {
  view.exact = view.exact || {};
  return view.exact;
}

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

// The settled exact read for this exact reference, or null.
export function cachedExact(cache, entry) {
  const hit = cache[entry.ref.store + "/" + entry.ref.refId];
  return hit && hit.digest === entry.ref.digest && hit.result ? hit.result : null;
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
`;
