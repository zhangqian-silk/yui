import { MANAGE_SECTIONS } from "../../shared/manageNav.js";

export const MANAGE_SHELL_SCRIPT = String.raw`
import { createI18n } from "/assets/js/lib/i18n.js";
import { rememberPlace, linkPlaces } from "/assets/js/lib/prefs.js";
import { enter } from "/assets/js/lib/motion.js";
const SECTIONS = ${JSON.stringify(MANAGE_SECTIONS)};
export const i18n = createI18n([document.querySelector("#locale-select"), document.querySelector("#settings-locale")]);
const pages = new Map();
const dirty = {};
let started = false;
let route;

export function manageArea(page, section) {
  return section === "connection" ? "settings" : page;
}
export function pageSections(page) {
  return Object.values(SECTIONS).flat().filter(item => item.page === page).map(item => item.section);
}
const TASK_ID = /^task-\d+$/;
export function readManageRoute(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  // Jobs has its own entry. The retired Settings section keeps its links
  // working: it opens the same Job (canonicalized without a Back step).
  const legacyJobs = parts[0] === "settings" && (parts[1] || url.searchParams.get("section")) === "jobs";
  if (parts[0] === "jobs" || legacyJobs) {
    const task = url.searchParams.get("task");
    return { page: "jobs", section: "jobs", task: task && TASK_ID.test(task) ? task : null,
      job: url.searchParams.get("job"), jobRun: url.searchParams.get("jobRun"),
      artifact: url.searchParams.get("artifact"), ...(legacyJobs ? { moved: true } : {}) };
  }
  const area = parts[0] === "settings" ? "settings" : "models";
  const requested = parts[1] || url.searchParams.get("section");
  const section = (SECTIONS[area].find(item => item.section === requested) ||
    (area === "models" && requested === "connection" ? SECTIONS.settings.at(-1) : SECTIONS[area][0])).section;
  return { page: section === "connection" ? "models" : area, section,
    source: url.searchParams.get("source") === "command-code" ? "command-code" : "factory" };
}
export function manageHref(next) {
  if (next.page === "jobs") {
    const query = new URLSearchParams();
    for (const key of ["task", "job", "jobRun", "artifact"]) if (next[key]) query.set(key, next[key]);
    return "/jobs" + (query.size ? "?" + query : "");
  }
  return "/" + manageArea(next.page, next.section) + "/" + next.section +
    (next.section === "quota" && next.source === "command-code" ? "?source=command-code" : "");
}
// The center column scrolls, not the document (the frame is the workbench's).
function scroller() { return document.querySelector("#manage-scroll"); }
function render() {
  if (!started) return;
  const rail = document.querySelector(".manage-rail");
  const area = manageArea(route.page, route.section);
  rail.querySelectorAll("a[data-section]").forEach(link => {
    const active = link.dataset.page === route.page && link.dataset.section === route.section;
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    if (dirty[link.dataset.page]?.[link.dataset.section]) link.dataset.dirty = "true"; else delete link.dataset.dirty;
  });
  // The global rail marks the current area.
  const app = document.querySelector(".manage-app");
  app.querySelectorAll("a[data-area]").forEach(link => {
    if (link.dataset.area === area) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  // The list head and the top bar name where the reader is.
  const areaTitle = i18n.t(area === "jobs" ? "nav.jobs" : area + ".title");
  const page = pages.get(route.page);
  const sectionTitle = page && page.crumb ? page.crumb()
    : i18n.t((route.page === "models" ? "models" : "settings") + ".section." + route.section);
  document.querySelector("#manage-area-title").textContent = areaTitle;
  document.querySelector("#manage-crumb-area").textContent = areaTitle;
  document.querySelector("#manage-crumb-section").textContent = sectionTitle;
  rail.querySelectorAll("[data-area-group]").forEach(group => {
    if (group.dataset.areaGroup === area) group.dataset.active = "true"; else delete group.dataset.active;
  });
  linkPlaces(app);
  document.title = sectionTitle + " · " + areaTitle + " · Yui";
}
function apply(next) {
  route = next;
  rememberPlace(manageArea(next.page, next.section), manageHref(next));
  rememberPlace("manage", manageHref(next));
  for (const name of ["models", "settings", "jobs"]) document.querySelector("#" + name + "-root").hidden = next.page !== name;
  pages.get(next.page).show(next);
  render();
}
// A section the reader switched to rises in (never on the first paint).
function revealSection() {
  if (typeof enter !== "function") return;
  enter(document.querySelector("#models-root:not([hidden]), #settings-root:not([hidden]), #jobs-root:not([hidden])"), "rise");
}
// Every route change (link, control, Back/Forward) first asks the page it
// leaves and the page it enters; either may keep the current view.
function mayNavigate(next) {
  for (const name of new Set([route.page, next.page])) {
    const page = pages.get(name);
    if (page && page.canNavigate && !page.canNavigate(next)) return false;
  }
  return true;
}
// Returns false when a page kept the current view (nothing changed).
export function navigateManage(next) {
  const normalized = readManageRoute(new URL(manageHref(next), location.origin));
  if (manageHref(normalized) === location.pathname + location.search) return true;
  if (!mayNavigate(normalized)) return false;
  history.replaceState({ ...history.state, scroll: scroller().scrollTop }, "");
  history.pushState({ scroll: 0 }, "", manageHref(normalized));
  apply(normalized);
  scroller().scrollTop = 0;
  revealSection();
  return true;
}
// A page settled on a more exact address for the current view (for example
// the Job it opened): record it in place, without a history step.
export function replaceManageRoute(next) {
  route = next;
  rememberPlace(manageArea(next.page, next.section), manageHref(next));
  rememberPlace("manage", manageHref(next));
  history.replaceState(history.state, "", manageHref(next));
  render();
}
export function createManageShell(options) {
  return {
    set: function () { render(); },
    setDirty: function (flags) { dirty[options.page] = flags; render(); },
    link: section => document.querySelector('.manage-rail a[data-page="' + options.page + '"][data-section="' + section + '"]'),
    render: render
  };
}
export function registerManagePage(name, controller) { pages.set(name, controller); }
export function startManagement() {
  started = true;
  route = readManageRoute(new URL(location.href));
  history.replaceState({ ...history.state, scroll: scroller().scrollTop }, "", manageHref(route));
  history.scrollRestoration = "manual";
  apply(route);
  document.querySelector(".manage-app").hidden = false;
  document.addEventListener("click", event => {
    const link = event.target.closest("a");
    if (!link || link.target || link.hasAttribute("download") || event.defaultPrevented ||
      event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || !/^\/(models|settings|jobs)(\/|$)/.test(url.pathname)) return;
    event.preventDefault();
    navigateManage(readManageRoute(url));
  });
  window.addEventListener("popstate", () => {
    const next = readManageRoute(new URL(location.href));
    // A kept view restores its own address as the newest entry.
    if (!mayNavigate(next)) { history.pushState({ scroll: scroller().scrollTop }, "", manageHref(route)); return; }
    apply(next);
    scroller().scrollTop = history.state?.scroll || 0;
    revealSection();
  });
  window.addEventListener("pageshow", render);
  i18n.subscribe(render);
}
`;
