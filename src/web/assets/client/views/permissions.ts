export const PERMISSIONS_SCRIPT = String.raw`
import { h } from "/assets/js/lib/dom.js";
import { requestJson } from "/assets/js/lib/api.js";

export function mountPermissions(root, t) {
  let meta, generation = 0, timer;
  let mode = "commands", role = "", category = "", q = "", cursor = "0", previous = [];
  const label = r => r.name ? t("permissions.configured") + ": " + r.name : t("permissions.role." + r.id);
  let status, results, prev, next, search, roleSelect, categorySelect;
  function reset() { cursor = "0"; previous = []; load(); }
  function controls() {
    const modeSelect = h("select", { onchange: () => {
      mode = modeSelect.value; roleSelect.disabled = categorySelect.disabled = mode !== "commands"; reset();
    } }, ["commands", "capabilities"].map(id => h("option", { value: id }, t("permissions." + id))));
    modeSelect.value = mode;
    search = h("input", { type: "search", value: q, maxlength: 200, oninput: () => {
      q = search.value; clearTimeout(timer);
      // Invalidate any older result immediately, even during debounce.
      generation++; prev.disabled = next.disabled = true;
      timer = setTimeout(reset, 180);
    } });
    roleSelect = h("select", { onchange: () => { role = roleSelect.value; reset(); } },
      h("option", { value: "" }, t("permissions.allRoles")),
      meta.roles.map(r => h("option", { value: r.id }, label(r))));
    roleSelect.value = role;
    categorySelect = h("select", { onchange: () => { category = categorySelect.value; reset(); } },
      h("option", { value: "" }, t("permissions.allCategories")),
      meta.categories.map(c => h("option", { value: c }, c)));
    categorySelect.value = category;
    roleSelect.disabled = categorySelect.disabled = mode !== "commands";
    status = h("p", { role: "status", "aria-live": "polite" });
    results = h("div.permissions-results");
    prev = h("button.btn", { type: "button", disabled: true, onclick: () => { cursor = previous.pop(); load(); } }, t("permissions.previous"));
    next = h("button.btn", { type: "button", disabled: true }, t("permissions.next"));
    const field = (key, input) => h("label.field", null, h("span", null, t("permissions." + key)), input);
    root.replaceChildren(
      h("div.card.settings-card.settings-stack", null,
        h("p", null, t("permissions.notice")),
        h("div.settings-grid", null, field("view", modeSelect), field("search", search),
          field("role", roleSelect), field("category", categorySelect))),
      status, results, h("div.settings-actions", null, prev, next),
      h("details.settings-card", null, h("summary", null, t("permissions.legend")),
        h("p", null, t("permissions.states")),
        h("p", null, t("permissions.boundaries")),
        h("p", null, t("permissions.sources") + ": " + meta.sources.join(" · "))));
  }
  function detailContent(data) {
    return h("div.settings-stack", null,
      h("p", null, t("permissions.unevaluated")),
      h("p", null, t("permissions.boundaries")),
      data.roles.map(r => h("div", null,
        h("h3", null, label(meta.roles.find(item => item.id === r.role))),
        h("p", null, t("permissions.reason." + (r.visible ? "visible" : "hidden"))),
        h("p", null, t("permissions.boundary." + r.audience)),
        r.usage.length ? h("pre", null, r.usage.join("\n")) : null)),
      h("small", null, t("permissions.sources") + ": " + data.source));
  }
  function commandTable(page, version) {
    const shown = role ? meta.roles.filter(r => r.id === role) : meta.roles.filter(r => !r.name);
    const body = h("tbody");
    page.items.forEach((item, index) => {
      const detail = h("td", { colSpan: shown.length + 1 });
      const detailRow = h("tr", { hidden: true, id: "permission-detail-" + version + "-" + index }, detail);
      let loaded = false;
      const button = h("button.permissions-command", { type: "button", "aria-expanded": "false",
        "aria-controls": detailRow.id, onclick: async () => {
          detailRow.hidden = !detailRow.hidden;
          button.setAttribute("aria-expanded", String(!detailRow.hidden));
          if (detailRow.hidden || loaded) return;
          loaded = true; detail.textContent = t("permissions.loading");
          try {
            const params = new URLSearchParams({ id: item.id, ...(role ? { role } : {}) });
            const data = await requestJson("/api/permissions/command?" + params);
            if (version !== generation) return;
            detail.replaceChildren(detailContent(data));
          } catch (error) { loaded = false; detail.textContent = error.message; }
        } }, item.id);
      body.append(h("tr", null, h("th", { scope: "row" }, button, h("small", null, item.summary)),
        item.roles.map(r => h("td", null, h("span", { class: r.visible ? "permissions-visible" : "permissions-hidden" },
          t("permissions." + (r.visible ? "visible" : "hidden")))))), detailRow);
    });
    return h("div.permissions-scroll", { tabIndex: 0, role: "region", "aria-label": t("permissions.commands") },
      h("table.permissions-table", null,
        h("caption", null, t("permissions.tableHint")),
        h("thead", null, h("tr", null, h("th", { scope: "col" }, t("permissions.command")),
          shown.map(r => h("th", { scope: "col" }, label(r))))), body));
  }
  async function load() {
    clearTimeout(timer);
    const version = ++generation;
    status.textContent = t("permissions.loading");
    results.replaceChildren(); prev.disabled = next.disabled = true;
    const params = new URLSearchParams({ q, cursor, ...(mode === "commands" ? { role, category } : {}) });
    try {
      const page = await requestJson("/api/permissions/" + mode + "?" + params);
      if (version !== generation) return;
      status.textContent = page.items.length ? (Number(cursor) + 1) + "–" + (Number(cursor) + page.items.length) + " / " + page.total : t("permissions.empty");
      if (mode === "commands") results.append(commandTable(page, version));
      else results.append(h("p", null, t("permissions.capabilityNotice")), ...page.items.map(item =>
        h("details.settings-card", null, h("summary", null, item.name),
          h("p", null, item.summary), h("p", null, t("permissions.unevaluated")),
          h("p", null, t("permissions.effect") + ": " + item.effect),
          h("p", null, t("permissions.requiredPermissions") + ": " + (item.requiredPermissions.join(", ") || "—")),
          h("p", null, t("permissions.requiredInputs") + ": " + (item.requiredInputs.join(", ") || "—")),
          h("p", null, t("permissions.inputs") + ": " + (item.inputs.join(", ") || "—")),
          h("small", null, t("permissions.sources") + ": " + page.source + " → " + item.source))));
      prev.disabled = previous.length === 0;
      next.disabled = page.nextCursor === null;
      next.onclick = () => { previous.push(cursor); cursor = page.nextCursor; load(); };
    } catch (error) {
      if (version !== generation) return;
      status.textContent = error.message;
      results.append(h("button.btn", { type: "button", onclick: load }, t("permissions.retry")));
    }
  }
  async function init() {
    root.replaceChildren(h("p", { role: "status" }, t("permissions.loading")));
    try {
      meta = await requestJson("/api/permissions");
      controls(); load();
    } catch (error) {
      root.replaceChildren(h("p", { role: "status" }, error.message),
        h("button.btn", { type: "button", onclick: init }, t("permissions.retry")));
    }
  }
  init();
  return { translate() { if (meta) { controls(); load(); } } };
}
`;
