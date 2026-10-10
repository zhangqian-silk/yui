export const SKILLS_SCRIPT = String.raw`
import { h } from "/assets/js/lib/dom.js";
import { requestJson, submitMutation } from "/assets/js/lib/api.js";

export function mountSkills(root, t) {
  if (!root) return;
  const tr = (key, fallback) => t("skills.browser." + key, fallback);
  const scope = h("select", null, h("option", { value: "global" }, tr("global", "Global Role")),
    h("option", { value: "task" }, tr("task", "Task Role")));
  const task = h("input", { placeholder: "task-123", disabled: true });
  const roles = h("select");
  const status = h("p", { role: "status", "aria-live": "polite" });
  const bindings = h("div.settings-stack");
  const frozen = h("div.settings-stack");
  const query = h("input", { type: "search" });
  const catalog = h("div.settings-stack");
  const reader = h("div.settings-stack", { tabindex: "-1" });
  const acknowledge = h("input", { type: "checkbox" });
  const acknowledgement = h("label.settings-reset", null, acknowledge, tr("ack", "Keep any live global Session on its existing version."));
  const save = h("button.btn.btn-primary", { type: "button", disabled: true }, tr("save", "Save bindings"));
  const reload = h("button.btn", { type: "button" }, tr("reload", "Load / reload Role"));
  const more = h("button.btn", { type: "button", hidden: true }, tr("more", "More Skills"));
  const search = h("button.btn", { type: "button" }, tr("search", "Search"));
  let state = null, draft = [], busy = false, uncertain = false, generation = 0, catalogGeneration = 0, readerGeneration = 0;
  const selected = () => ({ scope: scope.value, role: roles.value, ...(scope.value === "task" ? { task: task.value.trim() } : {}) });
  const params = object => new URLSearchParams(object).toString();
  const label = (text, control) => h("label.field", null, h("span", null, text), control);
  function dirty() { return !!state && JSON.stringify(draft) !== JSON.stringify(state.skills); }
  function invalidate() {
    generation++; state = null; draft = []; bindings.replaceChildren(); frozen.replaceChildren(); save.disabled = true;
    scope.disabled = roles.disabled = false; task.disabled = scope.value !== "task";
    acknowledgement.hidden = scope.value !== "global";
  }
  function renderBindings() {
    // A draft remains attached to the exact Role baseline until saved or explicitly reloaded.
    [scope, roles].forEach(c => { c.disabled = busy || dirty(); });
    task.disabled = busy || dirty() || scope.value !== "task";
    bindings.replaceChildren(h("h3", null, tr("configured", "Configured bindings")),
      ...draft.map(id => h("div.settings-actions", null, h("code", null, id),
        h("button.btn", { type: "button", disabled: busy || uncertain, onclick: () => { draft = draft.filter(s => s !== id); renderBindings(); } }, tr("remove", "Remove binding")),
        h("button.btn", { type: "button", onclick: () => read({ id }) }, tr("readSource", "Read current source")))));
    if (!draft.length) bindings.append(h("p", null, tr("none", "No additional bindings. Built-in Role Skills are loaded automatically.")));
    save.disabled = busy || uncertain || !dirty();
  }
  function renderEvidence(data) {
    frozen.replaceChildren(h("h3", null, tr("frozen", "Current Session · frozen evidence")));
    if (!data.session) frozen.append(h("p", null, tr("noSession", "No current Session. No loaded version can be claimed.")));
    else {
      frozen.append(h("p.mono-line", null, data.session.nativeSessionId + " · " + data.session.status +
        " · " + tr("revision", "launch / desired revision") + " " + data.session.sourceDesiredRevision + " / " + data.launchRevision));
      if (!data.session.packages) frozen.append(h("p", null, tr("unrecorded", "This Session has no frozen package evidence. Current source is not a substitute.")));
      else data.session.packages.forEach(pkg => frozen.append(h("div.settings-stack", null,
        h("strong", null, pkg.id), h("code.mono-line", null, pkg.digest),
        h("span.mono-line", null, pkg.source.kind + " · " + pkg.source.path),
        h("button.btn", { type: "button", onclick: () => read({ ...data.target, id: pkg.id, digest: pkg.digest, frozen: "true" }) }, tr("readFrozen", "Read frozen package")))));
    }
  }
  async function read(input) {
    const current = ++readerGeneration;
    reader.textContent = tr("loading", "Loading…");
    try {
      const data = await requestJson("/api/skills/file?" + params(input));
      if (current !== readerGeneration) return;
      const files = h("select", null, data.files.map(path => h("option", { value: path }, path)));
      files.value = data.resource;
      files.addEventListener("change", () => read({ ...input, resource: files.value }));
      reader.replaceChildren(h("h3", null, data.id + " · " + data.resource),
        h("p.mono-line", null, data.source.kind + " · " + data.source.path),
        h("p.mono-line", null, tr("version", "Package version") + ": " + data.version),
        h("p.mono-line", null, "SHA-256 (" + tr("file", "file") + "): " + data.fileDigest),
        label(tr("resource", "Read a resource (never executed)"), files),
        h("pre.settings-observation", { tabindex: "0" }, data.content));
      reader.focus({ preventScroll: true }); reader.scrollIntoView({ block: "start" });
    } catch (error) {
      if (current === readerGeneration) { reader.textContent = error.message; reader.scrollIntoView({ block: "nearest" }); }
    }
  }
  async function loadRole() {
    if (busy) return;
    if (dirty() && !window.confirm(tr("discard", "Discard unsaved Skill bindings and reload?"))) return;
    const current = ++generation;
    status.textContent = tr("loading", "Loading…");
    try {
      const roleNames = await requestJson("/api/skills/roles?" + params({ scope: scope.value, ...(scope.value === "task" ? { task: task.value.trim() } : {}) }));
      if (current !== generation) return;
      const previous = roles.value;
      roles.replaceChildren(...roleNames.map(r => h("option", { value: r.name }, r.name)));
      if (roleNames.some(r => r.name === previous)) roles.value = previous;
      if (!roles.value) { invalidate(); status.textContent = tr("noRoles", "No Roles in this scope."); return; }
      const data = await requestJson("/api/skills/role?" + params(selected()));
      if (current !== generation) return;
      state = data; draft = [...data.skills]; uncertain = false; renderBindings();
      status.textContent = tr("nextLaunch", "Bindings apply to a subsequent launch; saving does not load a Skill or restart a Session. Removing a binding never deletes its package.");
      renderEvidence(data);
    } catch (error) { if (current === generation) { invalidate(); status.textContent = error.message; } }
  }
  async function loadCatalog(cursor) {
    const current = ++catalogGeneration;
    more.disabled = search.disabled = true;
    try {
      const data = await requestJson("/api/skills/catalog?" + params({ q: query.value.trim(), cursor: cursor || "0" }));
      if (current !== catalogGeneration) return;
      if (!cursor) catalog.replaceChildren();
      if (!data.items.length) catalog.append(h("p", null, tr("noMatches", "No matching Skills.")));
      data.items.forEach(item => catalog.append(h("article.settings-card", null,
        h("h3", null, item.id), h("p", null, item.description || item.error),
        h("small.mono-line", null, item.source.kind + " · " + item.source.path),
        h("div.settings-actions", null,
          h("button.btn", { type: "button", onclick: () => read({ id: item.id }) }, tr("readSource", "Read current source")),
          h("button.btn", { type: "button", disabled: !!item.error, onclick: () => {
            if (!state || busy || uncertain) { status.textContent = tr("choose", "Load an explicit Role before editing bindings."); return; }
            if (!draft.includes(item.id)) draft.push(item.id);
            renderBindings(); status.textContent = tr("unsaved", "Unsaved bindings. Review the selected Role and save.");
            bindings.scrollIntoView({ block: "nearest" });
          } }, tr("add", "Add to selected Role"))))));
      more.hidden = !data.nextCursor; more.onclick = () => loadCatalog(data.nextCursor);
    } catch (error) { catalog.replaceChildren(h("p", null, error.message)); }
    finally { if (current === catalogGeneration) more.disabled = search.disabled = false; }
  }
  save.addEventListener("click", async () => {
    if (!state || busy || uncertain || !dirty()) return;
    busy = true; renderBindings();
    [scope, task, roles, reload].forEach(c => { c.disabled = true; });
    try {
      const result = await submitMutation("skills/" + JSON.stringify(state.target), "/api/skills/role",
        { target: state.target, revision: state.revision, skills: draft, acknowledgeLive: acknowledge.checked });
      state = result.role; draft = [...state.skills];
      renderEvidence(state);
      status.textContent = tr("saved", "Bindings saved. Existing frozen Sessions and Runs are unchanged; no package was deleted.");
    } catch (error) {
      uncertain = error.disposition !== "not-submitted";
      status.textContent = error.message + (uncertain ? "\n" + tr("unknown", "Save outcome unknown. Reload and compare before making another change.") : "");
    } finally {
      busy = false; [scope, roles, reload].forEach(c => { c.disabled = false; }); task.disabled = scope.value !== "task"; renderBindings();
    }
  });
  scope.addEventListener("change", () => { invalidate(); task.disabled = scope.value !== "task"; });
  task.addEventListener("input", invalidate);
  roles.addEventListener("change", () => { invalidate(); void loadRole(); });
  reload.addEventListener("click", loadRole);
  search.addEventListener("click", () => loadCatalog());
  query.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void loadCatalog(); } });
  window.addEventListener("beforeunload", event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
  root.replaceChildren(h("h2", null, tr("title", "Skills · browse & bind")),
    h("p", null, tr("intro", "Read existing packages and choose additional bindings for one explicit Role. Scripts are displayed as data, never run.")),
    h("div.settings-grid", null, label(tr("scope", "Scope"), scope), label(tr("taskId", "Task ID"), task), label("Role", roles)),
    h("div.settings-actions", null, reload), status, bindings, acknowledgement,
    h("div.settings-actions", null, save), frozen, label(tr("query", "Find an existing Skill by name or purpose"), query),
    h("div.settings-actions", null, search), catalog, more, reader);
  void loadRole(); void loadCatalog();
}
`;
