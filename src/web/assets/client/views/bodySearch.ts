export const BODY_SEARCH_SCRIPT = String.raw`
import { h } from "/assets/js/lib/dom.js";
import { button } from "/assets/js/ui/primitives.js";

// Textareas normalize CR/CRLF to LF. Map their UTF-16 selections back to the
// unchanged source before computing the search contract's code-point offset.
export function selectedSearchText(page, body) {
  if (body.selectionStart === body.selectionEnd) return { excerpt: page.content, offset: page.offset };
  let visible = 0, start, end;
  for (let index = 0; index <= page.content.length;) {
    if (visible === body.selectionStart) start = index;
    if (visible === body.selectionEnd) { end = index; break; }
    if (index === page.content.length) break;
    const point = String.fromCodePoint(page.content.codePointAt(index));
    index += point === "\r" && page.content[index + 1] === "\n" ? 2 : point.length;
    visible += point.length;
  }
  if (start === undefined || end === undefined) throw new Error("Select complete characters before quoting.");
  return { excerpt: page.content.slice(start, end),
    offset: page.offset + Array.from(page.content.slice(0, start)).length };
}

// Search never sends input or starts a Task. The user/Operator chooses excerpts
// to reuse through the normal Task input path with its own authority.
export function bindBodySearch(options) {
  const t = options.t, api = options.api;
  const dialog = h("dialog.dialog.body-search-dialog", { "aria-labelledby": "body-search-title" });
  const close = button(t("actions.close"));
  close.dataset.i18n = "actions.close";
  close.addEventListener("click", function () { dialog.close(); });
  const query = h("input", { type: "search", required: true, maxLength: 256 });
  const scope = h("select", { "aria-label": t("bodySearch.scope") },
    h("option", { value: "" }, t("bodySearch.allTasks")),
    h("option", { value: "current" }, t("bodySearch.currentTask")));
  const kind = h("select");
  ["", "brief", "message", "decision", "result", "completion"].forEach(function (value) {
    const key = "bodySearch.kind." + (value || "all");
    kind.append(h("option", { value: value, dataset: { i18n: key } }, t(key)));
  });
  const submit = button(t("bodySearch.search"), { variant: "primary" });
  submit.dataset.i18n = "bodySearch.search";
  submit.type = "submit";
  const status = h("p.receipt", { role: "status" });
  const destination = h("p.dialog-sub");
  const results = h("div.row-stack");
  const next = button(t("catalog.next"));
  next.dataset.i18n = "catalog.next";
  next.disabled = true;
  const form = h("form.dialog-body", null,
    h("header.dialog-head", null, h("h2", { id: "body-search-title", dataset: { i18n: "bodySearch.title" } }, t("bodySearch.title")), close),
    h("p.dialog-sub", { dataset: { i18n: "bodySearch.help" } }, t("bodySearch.help")),
    h("label.field", null, h("span", { dataset: { i18n: "bodySearch.query" } }, t("bodySearch.query")), query),
    h("label.field", null, h("span", { dataset: { i18n: "bodySearch.kind" } }, t("bodySearch.kind")), kind),
    h("label.field", null, h("span", null, t("bodySearch.scope")), scope),
    h("div.dialog-actions", null, submit, next), destination, status, results);
  dialog.append(form);
  document.body.append(dialog);
  let cursor = null, searched = null, generation = 0, target = null, currentTask = null;
  function invalidate() {
    generation += 1; cursor = null; searched = null; next.disabled = true;
    submit.disabled = false; results.replaceChildren(); status.textContent = "";
  }
  query.addEventListener("input", invalidate);
  kind.addEventListener("change", invalidate);
  scope.addEventListener("change", invalidate);
  dialog.addEventListener("close", invalidate);
  async function load(more) {
    const ticket = ++generation;
    const parameters = more ? new URLSearchParams(searched) : new URLSearchParams({ query: query.value.trim(), limit: "20" });
    if (!more && kind.value) parameters.set("kind", kind.value);
    if (!more && scope.value === "current") {
      if (!currentTask) { status.textContent = t("bodySearch.noTask"); return; }
      parameters.set("task", currentTask);
    }
    if (more && cursor) parameters.set("cursor", cursor);
    submit.disabled = true; next.disabled = true; status.textContent = t("bodySearch.loading");
    // One page in view: browsing large histories never accumulates all bodies.
    results.replaceChildren();
    try {
      const page = await api.searchBodies(parameters);
      if (ticket !== generation) return;
      cursor = page.nextCursor;
      parameters.delete("cursor"); searched = parameters.toString();
      status.textContent = page.items.length ? t("bodySearch.results") + " " + page.items.length : t("bodySearch.empty");
      page.items.forEach(function (item) {
        const source = item.taskId + " / " + t("bodySearch.kind." + item.kind) + " / " + item.ref.refId + " / " + item.field;
        const original = button(t("bodySearch.original"));
        original.dataset.i18n = "bodySearch.original";
        const locate = button(t("bodySearch.locate"));
        locate.dataset.i18n = "bodySearch.locate";
        locate.addEventListener("click", function () { dialog.close(); options.selectTask(item.taskId); });
        const quote = button(t("bodySearch.quoteSnippet"));
        quote.disabled = !target;
        const feedback = h("p.receipt", { role: "status" });
        const detail = h("div");
        const row = h("article.card", null, h("div.card-body", null,
          h("h3.card-title", null, source), h("pre.code-block.search-snippet", null, item.snippet),
          h("p.faint.small", null, item.ref.revision + " · " + item.ref.digest),
          h("div.dialog-actions", null, original, locate, quote), feedback, detail));
        async function insert(excerpt, offset, control) {
          control.disabled = true;
          try {
            const page = await api.searchSource(item, offset);
            if (ticket !== generation) return;
            if (!page.content.startsWith(excerpt)) throw new Error(t("bodySearch.sourceChanged"));
            const ref = JSON.stringify({ authority: "reference-only", taskId: item.taskId,
              kind: item.kind, ref: item.ref, field: item.field, offset: offset,
              length: Array.from(excerpt).length, offsetUnit: "unicode-code-points" });
            options.insertReference(target, t("bodySearch.referenceOnly") + "\n" + ref
              + "\n\n" + excerpt.split("\n").map(function (line) { return "> " + line; }).join("\n"));
            feedback.textContent = t("bodySearch.inserted");
          } catch (error) { if (ticket === generation) feedback.textContent = error.message; }
          finally { if (ticket === generation) control.disabled = !target; }
        }
        quote.addEventListener("click", function () { insert(item.snippet, item.offset, quote); });
        async function read(offset) {
          original.disabled = true;
          detail.textContent = t("bodySearch.loading");
          try {
            const page = await api.searchSource(item, offset);
            if (ticket !== generation) return;
            const body = h("textarea.search-source", { readOnly: true, rows: 12,
              "aria-label": t("bodySearch.sourceText") });
            body.value = page.content;
            const stage = button(t("bodySearch.quoteSelection"));
            stage.disabled = !target || !page.content;
            stage.addEventListener("click", function () {
              try {
                const selection = selectedSearchText(page, body);
                insert(selection.excerpt, selection.offset, stage);
              } catch (error) { feedback.textContent = error.message; }
            });
            const previous = button(t("bodySearch.previous"));
            previous.disabled = page.offset === 0;
            previous.addEventListener("click", function () { read(Math.max(0, page.offset - 4000)); });
            const more = button(t("catalog.next"));
            more.disabled = page.nextOffset === null;
            more.addEventListener("click", function () { read(page.nextOffset); });
            detail.replaceChildren(h("p.faint.small", null,
              page.offset + "–" + (page.offset + Array.from(page.content).length) + " / " + page.totalCharacters),
              body, h("div.dialog-actions", null, previous, more, stage));
          } catch (error) {
            if (ticket === generation) detail.textContent = t("bodySearch.unavailable") + " " + error.message;
          } finally { if (ticket === generation) original.disabled = false; }
        }
        original.addEventListener("click", function () { read(0); });
        results.append(row);
      });
      next.disabled = !cursor;
    } catch (error) {
      if (ticket !== generation) return;
      cursor = null; searched = null;
      status.textContent = t("bodySearch.failed") + " " + error.message;
    } finally { if (ticket === generation) submit.disabled = false; }
  }
  form.addEventListener("submit", function (event) { event.preventDefault(); if (!submit.disabled) load(false); });
  next.addEventListener("click", function () { if (cursor && searched) load(true); });
  document.querySelector("#body-search-open").addEventListener("click", function () {
    invalidate();
    target = options.captureDraftTarget();
    currentTask = options.currentTask();
    if (!target) destination.textContent = t("bodySearch.noTarget");
    else {
      const identity = JSON.parse(target);
      destination.textContent = t("bodySearch.destination") + " "
        + (identity[0].taskId || identity[0].scope) + " / " + identity[0].roleName + " / " + identity[1];
    }
    dialog.showModal(); query.focus();
  });
  return { dialog: dialog };
}
`;
