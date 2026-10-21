export const JOBS_APP_SCRIPT = String.raw`
import { h } from "/assets/js/lib/dom.js";
import { requestJson } from "/assets/js/lib/api.js";
import { i18n, registerManagePage, navigateManage, replaceManageRoute } from "/assets/js/layout/manageShell.js";
import { mountJobs } from "/assets/js/views/jobs.js";

// The Jobs entry: one shared Job module (the same one the Task page uses)
// over exactly one scope at a time, global or one owning Task. The scope,
// the selected Job and Run live in the URL, so deep links, refresh and
// Back/Forward all reopen the same view. One view is live at a time: a
// replaced view is retired, so its late reads cannot write this page.
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
  if (!navigateManage({ page: "jobs", section: "jobs", task })) drawScopes();
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
  if (view) view.dispose();
  mountedScope = next.task || null;
  let self = null;
  self = view = mountJobs(root, t, mountedScope || undefined, {
    index: listMount,
    navigate: selection => navigateManage({ ...route, job: selection.job, jobRun: null, artifact: null, moved: undefined }),
    pin: selection => pin(self, selection),
    heading: heading(),
    notice: next.moved ? t("jobs.moved") : "",
    locale: i18n.getLocale
  });
}
// Only the live view, while Jobs is the shown page, records its selection.
function pin(owner, selection) {
  if (owner !== view || root.hidden || !route || route.page !== "jobs") return;
  route = { ...route, ...selection, moved: undefined };
  replaceManageRoute(route);
}
function show(next) {
  route = next;
  drawScopes();
  if (!view || mountedScope !== (next.task || null)) mount(next);
  else view.select(next.job, next.jobRun, next.artifact);
}
// Asked before any route change that leaves or enters Jobs, whatever its
// source. Leaving Jobs keeps its view (hidden) as it is; a change of scope or
// Job replaces the editor, so a draft needs confirmation; while a write is in
// flight the selection stays put so its receipt remains observable.
function canNavigate(next) {
  if (!view || next.page !== "jobs" || !route) return true;
  const same = key => (next[key] || null) === (route[key] || null);
  if ((next.task || null) === mountedScope && same("job") && same("jobRun") && same("artifact")) return true;
  if (view.isBusy() && root.hidden) { window.alert(t("jobs.leaveBusy")); return false; }
  return view.leave((next.task || null) !== mountedScope || !same("job"));
}
registerManagePage("jobs", { show, canNavigate, crumb: () => route && route.task ? route.task : t("jobs.ownerGlobal") });
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
