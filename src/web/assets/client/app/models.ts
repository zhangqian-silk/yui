export const MODELS_SCRIPT = String.raw`
// Entry for the standalone /models page. The page body lives in
// views/models; this module owns the URL (?section=...&source=...), the
// section navigation, translation and the unsaved-draft guard. The URL alone
// decides what a direct open or a refresh shows; in-page navigation pushes
// history entries so back/forward restore the same section and source.
import { api } from "/assets/js/lib/api.js";
import { createI18n } from "/assets/js/lib/i18n.js";
import { mountModels, normalizeRoute } from "/assets/js/views/models.js";

const i18n = createI18n(document.querySelector("#locale-select"));
const t = i18n.t;
const root = document.querySelector("#models-root");
const links = Array.from(document.querySelectorAll("a[data-section]"));
let flags = {};

function readRoute() {
  const query = new URLSearchParams(window.location.search);
  return normalizeRoute({ section: query.get("section"), source: query.get("source") });
}
function href(route) {
  const query = new URLSearchParams({ section: route.section });
  if (route.section === "quota") query.set("source", route.source);
  return "/models?" + query.toString();
}
let route = readRoute();

function decorate() {
  links.forEach(function (link) {
    const section = link.dataset.section;
    // The quota link returns to the source last shown.
    link.setAttribute("href", href({ section: section, source: route.source }));
    if (section === route.section) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
    const dirty = section === "providers" ? flags.provider : section === "connection" ? flags.connection : false;
    if (dirty) link.dataset.dirty = "true";
    else delete link.dataset.dirty;
  });
  document.title = t("models.section." + route.section) + " · " + t("models.title") + " · Yui";
}
function apply(next) {
  route = page.show(next);
  decorate();
}
function navigate(next) {
  const target = normalizeRoute(next);
  if (href(target) === href(route) && window.location.search) { apply(target); return; }
  window.history.pushState(null, "", href(target));
  apply(target);
  window.scrollTo(0, 0);
}
function mount() {
  return mountModels(root, { t: t, locale: i18n.getLocale, api: api, route: route, navigate: navigate,
    onChange: function (next) { flags = next; decorate(); } });
}

let page = mount();
decorate();
links.forEach(function (link) {
  link.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate({ section: link.dataset.section, source: route.source });
  });
});
// Sections stay mounted, so back/forward between them never drops a draft.
window.addEventListener("popstate", function () { apply(readRoute()); });
// A language switch re-reads the page unless that would drop a draft or an
// unresolved-write warning; those keep the current language until reload.
i18n.subscribe(function () {
  decorate();
  if (page.dirty() || page.state.unknown) return;
  page = mount();
});
window.addEventListener("beforeunload", function (event) {
  if (!page.dirty()) return;
  event.preventDefault(); event.returnValue = "";
});
`;
