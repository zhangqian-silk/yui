import { STYLESHEETS } from "../styles/index.js";
import { DEFAULT_DARK_THEME } from "../shared/themes.js";
import { BRAND_ICONS } from "../shared/brand.js";
import { iconSvg } from "../shared/icons.js";
import { appRail } from "./appRail.js";
import { MANAGE_SECTIONS, type ManageArea, type ManagePage, type ManageSection } from "../shared/manageNav.js";

// One frame and entry point for /models/* and /settings/*. The frame is the
// workbench's own: the global rail, a collapsible list (here the current
// area's sections), and the center column under the shared top bar. Narrow
// screens open the rail and the list together as a drawer, exactly as on the
// workbench. The shared router changes sections without unloading their
// controllers or drafts. Leaving the management document still uses the
// browser's unsaved-draft prompt.
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const sectionLink = (item: ManageSection) =>
  `<a class="manage-link" href="/${item.section === "connection" ? "settings" : item.page}/${item.section}" data-page="${item.page}" data-section="${item.section}"><span data-i18n="${item.key}">${escapeHtml(item.label)}</span><i class="manage-dirty" aria-hidden="true"></i></a>`;

const area = (name: ManageArea, key: string, label: string) => `
        <div class="manage-area" data-area-group="${name}">
          <div class="manage-sections" role="group" aria-label="${label}" data-i18n-aria-label="${key}">
            ${MANAGE_SECTIONS[name].map(sectionLink).join("\n            ")}
          </div>
        </div>`;

const RAIL = `<aside class="manage-rail sidebar" aria-label="Sections" data-i18n-aria-label="manage.sections">
      <header class="side-head">
        <h2 id="manage-area-title" class="side-title"></h2>
        <button id="sidebar-collapse" class="icon-btn side-collapse" type="button" aria-label="Collapse sections" data-i18n-aria-label="manage.collapseSections" title="Collapse sections · [" data-i18n-title="manage.collapseSections">${iconSvg("sidebar")}</button>
      </header>
      <nav class="manage-nav" aria-label="Sections" data-i18n-aria-label="manage.sections">${area("models", "models.title", "Models")}${area("settings", "settings.title", "Settings")}
      </nav>
    </aside>`;

const TOP_BAR = `<header class="top-bar">
        <button class="icon-btn side-expand" type="button" data-sidebar-toggle="true" aria-expanded="false" aria-label="Show sections" data-i18n-aria-label="manage.showSections" title="Show sections · [" data-i18n-title="manage.showSections"><span class="i-sidebar">${iconSvg("sidebar")}</span><span class="i-menu">${iconSvg("menu")}</span></button>
        <nav class="crumbs" aria-label="Location" data-i18n-aria-label="crumbs.label"><span id="manage-crumb-area" class="crumb crumb-static"></span><span class="crumb-sep" aria-hidden="true">/</span><span id="manage-crumb-section" class="crumb-current"></span></nav>
        <span class="spacer"></span>
        <label class="top-locale"><span class="sr-only" data-i18n="settings.language">Language</span><select id="locale-select"><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
      </header>`;

// One management document. `main` is the page's reading column markup.
export function manageDocument(options: Readonly<{
  page: ManagePage; title: string; main: string;
}>): string {
  return `<!doctype html>
<html lang="en" data-theme="${DEFAULT_DARK_THEME.id}">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="yui-web-token" content="__YUI_WEB_TOKEN__">
  <link rel="icon" type="image/svg+xml" href="${BRAND_ICONS[DEFAULT_DARK_THEME.id]}">
  <script src="/assets/theme.js"></script>
  <title>Yui · ${options.title}</title>
  ${STYLESHEETS.map(s => `<link rel="stylesheet" href="/assets/css/${s.name}.css">`).join("\n  ")}
</head>
<body class="manage-body ${options.page}-body">
  <div class="app manage-app" data-page="${options.page}" hidden>
    ${appRail(options.page === "models" ? "models" : "settings")}
    ${RAIL}
    <div id="sidebar-scrim" class="sidebar-scrim"></div>
    <main id="manage-scroll" class="center manage-center" tabindex="-1">
      ${TOP_BAR}
      <div class="manage-main" id="manage-main">
${options.main}
      </div>
    </main>
  </div>
  <script type="module" src="/assets/js/app/manage.js" blocking="render"></script>
</body></html>`;
}

// The common section heading: title and one explanatory line.
export function manageHead(id: string, key: string, label: string, hintKey: string, hint: string): string {
  return `<header class="manage-head"><div class="manage-heading"><h1 id="${id}" data-i18n="${key}">${escapeHtml(label)}</h1><p data-i18n="${hintKey}">${escapeHtml(hint)}</p></div></header>`;
}
