export const JOBS_APP_SCRIPT = String.raw`
import { h } from "/assets/js/lib/dom.js";
import { requestJson } from "/assets/js/lib/api.js";
import { i18n, registerManagePage, navigateManage } from "/assets/js/layout/manageShell.js";
import { mountJobs } from "/assets/js/views/jobs.js";

// The Jobs entry: one shared Job module (the same one the Task page uses)
// over exactly one scope at a time, global or one owning Task. The scope,
// the selected Job and Run live in the URL, so deep links, refresh and
// Back/Forward all reopen the same view.
const t = i18n.t;
const root = document.querySelector("#jobs-root");
const index = document.querySelector("#jobs-index");
const scopeSelect = h("select", { id: "jobs-scope", "aria-describedby": "jobs-scope-help" });
const scopeLabel = h("label", { for: "jobs-scope" });
const scopeHelp = h("p.jobs-scope-help", { id: "jobs-scope-help" });
const listMount = h("div.jobs-index-body");
index.replaceChildren(h("div.jobs-scope", null, scopeLabel, scopeSelect, scopeHelp), listMount);
let route = null, view = null, mountedScope, scopes = null, scopesError = null;

scopeSelect.addEventListener("change", () => {
  const task = scopeSelect.value || null;
  if ((route && route.task) === task) return;
  if (view && view.isDirty() && !window.confirm(t("jobs.discard"))) { drawScopes(); return; }
  navigateManage({ page: "jobs", section: "jobs", task });
});

function drawScopes() {
  scopeLabel.textContent = t("jobs.scopeLabel");
  scopeHelp.textContent = scopesError ? t("jobs.scopesError") + " " + scopesError : t("jobs.scopeHelp");
  scopeHelp.classList.toggle("is-error", !!scopesError);
  const current = route ? route.task : null;
  const tasks = scopes ? scopes.tasks.slice() : [];
  // A deep-linked Task stays selectable even when it has no Job yet.
  if (current && !tasks.some(item => item.taskId === current)) tasks.unshift({ taskId: current, title: "" });
  scopeSelect.replaceChildren(h("option", { value: "" }, t("jobs.ownerGlobal")),
    ...tasks.map(item => h("option", { value: item.taskId }, item.taskId + (item.title ? " · " + item.title : ""))));
  scopeSelect.value = current || "";
}
async function loadScopes() {
  try { scopes = await requestJson("/api/jobs/scopes"); scopesError = null; }
  catch (error) { scopesError = error.message; }
  drawScopes();
}
function heading() {
  return { title: t("nav.jobs"), hint: t(route && route.task ? "jobs.pageHintTask" : "jobs.pageHint") };
}
function mount(next) {
  mountedScope = next.task || null;
  view = mountJobs(root, t, mountedScope || undefined, {
    index: listMount,
    navigate: selection => navigateManage({ ...route, job: selection.job, jobRun: null, artifact: null, moved: undefined }),
    heading: heading(),
    notice: next.moved ? t("jobs.moved") : "",
    locale: i18n.getLocale
  });
}
function show(next) {
  route = next;
  drawScopes();
  if (!view || mountedScope !== (next.task || null)) mount(next);
  else view.select(next.job, next.jobRun);
}
registerManagePage("jobs", { show, crumb: () => route && route.task ? route.task : t("jobs.ownerGlobal") });
void loadScopes();
i18n.subscribe(() => {
  drawScopes();
  if (route && route.page === "jobs" && view && !view.isDirty() && !view.isBusy()) mount({ ...route, moved: false });
});
window.addEventListener("beforeunload", event => {
  if (!view || !view.isDirty()) return;
  event.preventDefault(); event.returnValue = "";
});
`;
