import { STYLESHEETS } from "../styles/index.js";
import { DEFAULT_DARK_THEME } from "../shared/themes.js";
import { iconSvg } from "../shared/icons.js";
import { MANAGE_SECTIONS, type ManageArea, type ManagePage, type ManageSection } from "../shared/manageNav.js";

// One frame and entry point for /models/* and /settings/*. The shared router
// changes sections without unloading their controllers or drafts. Leaving
// the management document still uses the browser's unsaved-draft prompt.
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const sectionLink = (item: ManageSection) =>
  `<a class="manage-link" href="/${item.section === "connection" ? "settings" : item.page}/${item.section}" data-page="${item.page}" data-section="${item.section}"><span data-i18n="${item.key}">${escapeHtml(item.label)}</span><i class="manage-dirty" aria-hidden="true"></i></a>`;

const area = (name: ManageArea, icon: string, key: string, label: string) => `
        <div class="manage-area" data-area-group="${name}">
          <a class="manage-primary" href="/${name}" data-area="${name}">${iconSvg(icon)}<span data-i18n="${key}">${label}</span></a>
          <div class="manage-sections" role="group" aria-label="${label}" data-i18n-aria-label="${key}">
            ${MANAGE_SECTIONS[name].map(sectionLink).join("\n            ")}
          </div>
        </div>`;

const RAIL = `<aside class="manage-rail">
      <header class="manage-rail-head">
        <a class="brand" href="/" title="Workbench" data-i18n-title="manage.workbench">
          <span class="brand-mark" aria-hidden="true">結</span><span class="brand-name">Yui</span>
        </a>
        <label class="manage-locale"><span class="sr-only" data-i18n="settings.language">Language</span><select id="locale-select"><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
      </header>
      <nav class="manage-nav" aria-label="Main navigation" data-i18n-aria-label="manage.nav">
        <div class="manage-area" data-area-group="workbench">
          <a class="manage-primary" href="/" data-area="workbench">${iconSvg("inbox")}<span data-i18n="manage.workbench">Workbench</span></a>
        </div>${area("models", "layers", "models.title", "Models")}${area("settings", "settings", "settings.title", "Settings")}
      </nav>
    </aside>`;

// One management document. `main` is the page's reading column markup.
export function manageDocument(options: Readonly<{
  page: ManagePage; title: string; main: string;
}>): string {
  return `<!doctype html>
<html lang="en" data-theme="${DEFAULT_DARK_THEME.id}">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="yui-web-token" content="__YUI_WEB_TOKEN__">
  <script src="/assets/theme.js"></script>
  <link rel="icon" href="data:,"><title>Yui · ${options.title}</title>
  ${STYLESHEETS.map(s => `<link rel="stylesheet" href="/assets/css/${s.name}.css">`).join("\n  ")}
</head>
<body class="manage-body ${options.page}-body">
  <div class="manage-app" data-page="${options.page}" hidden>
    ${RAIL}
    <main class="manage-main" id="manage-main">
${options.main}
    </main>
  </div>
  <script type="module" src="/assets/js/app/manage.js"></script>
</body></html>`;
}

// The common section heading: title and one explanatory line.
export function manageHead(id: string, key: string, label: string, hintKey: string, hint: string): string {
  return `<header class="manage-head"><div class="manage-heading"><h1 id="${id}" data-i18n="${key}">${escapeHtml(label)}</h1><p data-i18n="${hintKey}">${escapeHtml(hint)}</p></div></header>`;
}
