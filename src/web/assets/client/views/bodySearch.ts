export const BODY_SEARCH_SCRIPT = String.raw`
import { h } from "/assets/js/lib/dom.js";
import { button, jsonBlock } from "/assets/js/ui/primitives.js";

// Search never sends input or starts a Task. The user/Operator chooses excerpts
// to reuse through the normal Task input path with its own authority.
export function bindBodySearch(options) {
  const t = options.t, api = options.api;
  const dialog = h("dialog.dialog.body-search-dialog", { "aria-labelledby": "body-search-title" });
  const close = button(t("actions.close"));
  close.dataset.i18n = "actions.close";
  close.addEventListener("click", function () { dialog.close(); });
  const query = h("input", { type: "search", required: true, maxLength: 256 });
  const kind = h("select");
  ["", "brief", "message", "decision", "result", "completion"].forEach(function (value) {
    const key = "bodySearch.kind." + (value || "all");
    kind.append(h("option", { value: value, dataset: { i18n: key } }, t(key)));
  });
  const submit = button(t("bodySearch.search"), { variant: "primary" });
  submit.dataset.i18n = "bodySearch.search";
  submit.type = "submit";
  const status = h("p.receipt", { role: "status" });
  const results = h("div.row-stack");
  const next = button(t("catalog.next"));
  next.dataset.i18n = "catalog.next";
  next.disabled = true;
  const form = h("form.dialog-body", null,
    h("header.dialog-head", null, h("h2", { id: "body-search-title", dataset: { i18n: "bodySearch.title" } }, t("bodySearch.title")), close),
    h("p.dialog-sub", { dataset: { i18n: "bodySearch.help" } }, t("bodySearch.help")),
    h("label.field", null, h("span", { dataset: { i18n: "bodySearch.query" } }, t("bodySearch.query")), query),
    h("label.field", null, h("span", { dataset: { i18n: "bodySearch.kind" } }, t("bodySearch.kind")), kind),
    h("div.dialog-actions", null, submit, next), status, results);
  dialog.append(form);
  document.body.append(dialog);
  let cursor = null, searched = null, generation = 0;
  function invalidate() {
    generation += 1; cursor = null; searched = null; next.disabled = true;
    submit.disabled = false; results.replaceChildren(); status.textContent = "";
  }
  query.addEventListener("input", invalidate);
  kind.addEventListener("change", invalidate);
  async function load(more) {
    const ticket = ++generation;
    const parameters = more ? new URLSearchParams(searched) : new URLSearchParams({ query: query.value.trim(), limit: "20" });
    if (!more && kind.value) parameters.set("kind", kind.value);
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
        const reference = h("textarea", { readOnly: true, rows: 4, "aria-label": t("bodySearch.reference") });
        // Bounded quoted evidence, never an instruction to execute old work.
        reference.value = JSON.stringify({
          authority: "reference-only", taskId: item.taskId, ref: item.ref,
          field: item.field, offset: item.offset, excerpt: item.snippet
        }, null, 2);
        reference.addEventListener("focus", function () { reference.select(); });
        const citation = h("details.disclosure", null,
          h("summary", { dataset: { i18n: "bodySearch.reference" } }, t("bodySearch.reference")), h("label.field", null, reference));
        const detail = h("div");
        const row = h("article.card", null, h("div.card-body", null,
          h("h3.card-title", null, source), h("pre.code-block", null, item.snippet),
          h("p.faint.small", null, item.ref.revision),
          h("div.dialog-actions", null, original, locate), citation, detail));
        original.addEventListener("click", async function () {
          original.disabled = true;
          detail.textContent = t("bodySearch.loading");
          try {
            const value = await api.inspect(item.taskId, item.ref);
            detail.replaceChildren(jsonBlock(value));
          } catch (error) { detail.textContent = error.message; original.disabled = false; }
        });
        results.append(row);
      });
      next.disabled = !cursor;
    } catch (error) {
      if (ticket !== generation) return;
      status.textContent = error.message;
    } finally { if (ticket === generation) submit.disabled = false; }
  }
  form.addEventListener("submit", function (event) { event.preventDefault(); if (!submit.disabled) load(false); });
  next.addEventListener("click", function () { if (cursor && searched) load(true); });
  document.querySelector("#body-search-open").addEventListener("click", function () {
    dialog.showModal(); query.focus();
  });
  return { dialog: dialog };
}
`;
