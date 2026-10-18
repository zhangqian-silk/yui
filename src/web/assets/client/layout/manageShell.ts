import { MANAGE_SECTIONS } from "../../shared/manageNav.js";

export const MANAGE_SHELL_SCRIPT = String.raw`
import { createI18n } from "/assets/js/lib/i18n.js";
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
export function readManageRoute(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const area = parts[0] === "settings" ? "settings" : "models";
  const requested = parts[1] || url.searchParams.get("section");
  const section = (SECTIONS[area].find(item => item.section === requested) ||
    (area === "models" && requested === "connection" ? SECTIONS.settings.at(-1) : SECTIONS[area][0])).section;
  return { page: section === "connection" ? "models" : area, section,
    ...(section === "jobs" ? { job: url.searchParams.get("job"), jobRun: url.searchParams.get("jobRun"),
      artifact: url.searchParams.get("artifact") } : {}),
    source: url.searchParams.get("source") === "command-code" ? "command-code" : "factory" };
}
export function manageHref(next) {
  if (next.section === "jobs") {
    const query = new URLSearchParams();
    for (const key of ["job", "jobRun", "artifact"]) if (next[key]) query.set(key, next[key]);
    return "/settings/jobs" + (query.size ? "?" + query : "");
  }
  return "/" + manageArea(next.page, next.section) + "/" + next.section +
    (next.section === "quota" && next.source === "command-code" ? "?source=command-code" : "");
}
function render() {
  if (!started) return;
  const rail = document.querySelector(".manage-rail");
  const area = manageArea(route.page, route.section);
  rail.querySelectorAll("a[data-section]").forEach(link => {
    const active = link.dataset.page === route.page && link.dataset.section === route.section;
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    if (dirty[link.dataset.page]?.[link.dataset.section]) link.dataset.dirty = "true"; else delete link.dataset.dirty;
  });
  rail.querySelectorAll("a[data-area]").forEach(link => {
    if (link.dataset.area === area) link.setAttribute("aria-current", "true"); else link.removeAttribute("aria-current");
  });
  rail.querySelectorAll("[data-area-group]").forEach(group => {
    if (group.dataset.areaGroup === area) group.dataset.active = "true"; else delete group.dataset.active;
  });
  document.title = i18n.t((route.page === "models" ? "models" : "settings") + ".section." + route.section) +
    " · " + i18n.t(area + ".title") + " · Yui";
}
function apply(next) {
  route = next;
  document.querySelector("#models-root").hidden = next.page !== "models";
  document.querySelector("#settings-root").hidden = next.page !== "settings";
  pages.get(next.page).show(next);
  render();
}
export function navigateManage(next) {
  const normalized = readManageRoute(new URL(manageHref(next), location.origin));
  if (manageHref(normalized) === location.pathname + location.search) return;
  history.replaceState({ ...history.state, scroll: window.scrollY }, "");
  history.pushState({ scroll: 0 }, "", manageHref(normalized));
  apply(normalized);
  window.scrollTo(0, 0);
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
  history.replaceState({ ...history.state, scroll: window.scrollY }, "", manageHref(route));
  history.scrollRestoration = "manual";
  apply(route);
  document.querySelector(".manage-app").hidden = false;
  document.addEventListener("click", event => {
    const link = event.target.closest("a");
    if (!link || link.target || link.hasAttribute("download") || event.defaultPrevented ||
      event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = new URL(link.href);
    // Exact Job/Run links initialize a new pinned view, not just a section switch.
    if (url.searchParams.has("job")) return;
    if (url.origin !== location.origin || !/^\/(models|settings)(\/|$)/.test(url.pathname)) return;
    event.preventDefault();
    navigateManage(readManageRoute(url));
  });
  window.addEventListener("popstate", () => {
    apply(readManageRoute(new URL(location.href)));
    window.scrollTo(0, history.state?.scroll || 0);
  });
  i18n.subscribe(render);
}
`;
