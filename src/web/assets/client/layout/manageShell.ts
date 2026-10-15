import { MANAGE_SECTIONS } from "../../shared/manageNav.js";

export const MANAGE_SHELL_SCRIPT = String.raw`
// Shared rail controller for the management pages (/models, /settings). The
// static rail (shell/manage) lists every area and section; this module marks
// the current area and section, shows unsaved-draft dots and turns clicks on
// this page's own sections into in-page navigation. Links to the other page
// are left to the browser, so its beforeunload prompt still protects drafts.
//
// options: page ("models" | "settings"), t, onNavigate(section) for this
// page's own sections. The rail's markup is the only source of sections.
const SECTIONS = ${JSON.stringify(MANAGE_SECTIONS)};

// The area a page's section belongs to in the shared navigation.
export function manageArea(page, section) {
  const owner = Object.keys(SECTIONS).find(function (area) {
    return SECTIONS[area].some(function (item) { return item.page === page && item.section === section; });
  });
  return owner || page;
}
// This page's sections in rail order, for normalizing its route.
export function pageSections(page) {
  return Object.keys(SECTIONS).flatMap(function (area) {
    return SECTIONS[area].filter(function (item) { return item.page === page; }).map(function (item) { return item.section; });
  });
}

export function createManageShell(options) {
  const page = options.page;
  const t = options.t;
  const rail = document.querySelector(".manage-rail");
  const links = Array.from(rail.querySelectorAll("a[data-section]"));
  const areaLinks = Array.from(rail.querySelectorAll("a[data-area]"));
  const groups = Array.from(rail.querySelectorAll("[data-area-group]"));
  let current = { section: null, area: page };
  let dirty = {};

  function own(link) { return link.dataset.page === page; }
  function modified(event) {
    return event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  }
  function render() {
    links.forEach(function (link) {
      if (own(link) && link.dataset.section === current.section) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
      if (own(link) && dirty[link.dataset.section]) link.dataset.dirty = "true";
      else delete link.dataset.dirty;
    });
    areaLinks.forEach(function (link) {
      if (link.dataset.area === current.area) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
    groups.forEach(function (group) {
      if (group.dataset.areaGroup === current.area) group.dataset.active = "true";
      else delete group.dataset.active;
    });
    rail.dataset.area = current.area;
    const link = links.find(function (item) { return own(item) && item.dataset.section === current.section; });
    const area = current.area === "models" ? t("models.title") : t("settings.title");
    document.title = (link ? link.textContent.trim() + " · " : "") + area + " · Yui";
  }
  links.forEach(function (link) {
    link.addEventListener("click", function (event) {
      if (!own(link) || modified(event)) return;
      event.preventDefault();
      options.onNavigate(link.dataset.section);
    });
  });
  // An area heading on its own page opens that area's first own section.
  areaLinks.forEach(function (link) {
    link.addEventListener("click", function (event) {
      const first = (SECTIONS[link.dataset.area] || []).find(function (item) { return item.page === page; });
      if (!first || link.getAttribute("href") !== "/" + page || modified(event)) return;
      event.preventDefault();
      options.onNavigate(first.section);
    });
  });
  return {
    // Marks the current section of this page; its area follows the rail.
    set: function (section) { current = { section: section, area: manageArea(page, section) }; render(); },
    // flags: { [section]: boolean } for this page's sections.
    setDirty: function (flags) { dirty = flags || {}; render(); },
    // The rail link for one of this page's sections (for a richer href).
    link: function (section) { return links.find(function (item) { return own(item) && item.dataset.section === section; }) || null; },
    render: render
  };
}
`;
