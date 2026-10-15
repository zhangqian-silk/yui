import { STYLESHEETS } from "../styles/index.js";
import { DEFAULT_DARK_THEME } from "../shared/themes.js";
import { iconSvg } from "../shared/icons.js";

// Standalone Model management page. The server serves it at /models with the
// page token substituted for __YUI_WEB_TOKEN__, exactly like SETTINGS_HTML.
// The rail mirrors the dashboard sidebar: brand, a way back to Yui, the four
// Model sections (?section=...) and the Settings link. Below the narrow
// breakpoint it becomes a top bar with a scrollable section strip.
const section = (name: string, icon: string, label: string) =>
  `<a class="models-nav-link" href="/models?section=${name}" data-section="${name}">${iconSvg(icon)}<span data-i18n="models.section.${name}">${label}</span><i class="models-nav-dirty" aria-hidden="true"></i></a>`;

export const MODELS_HTML = `<!doctype html>
<html lang="en" data-theme="${DEFAULT_DARK_THEME.id}">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="yui-web-token" content="__YUI_WEB_TOKEN__">
  <script src="/assets/theme.js"></script>
  <link rel="icon" href="data:,"><title>Yui · Models</title>
  ${STYLESHEETS.map(s => `<link rel="stylesheet" href="/assets/css/${s.name}.css">`).join("\n")}
</head>
<body class="models-body">
  <div class="models-app">
    <aside class="models-rail" aria-label="Models" data-i18n-aria-label="models.title">
      <header class="side-head models-rail-head">
        <a class="brand" href="/" title="Back to Yui" data-i18n-title="models.backHome">
          <span class="brand-mark" aria-hidden="true">結</span><span class="brand-name">Yui</span>
        </a>
        <span class="chip models-rail-tag" data-i18n="models.title">Models</span>
      </header>
      <a class="models-nav-link models-home" href="/">${iconSvg("back")}<span data-i18n="models.backHome">Back to Yui</span></a>
      <nav class="models-nav" aria-label="Model sections" data-i18n-aria-label="models.sections">
        <p class="models-nav-group" data-i18n="models.navObserve">Manage</p>
        ${section("providers", "layers", "Access")}
        ${section("catalog", "package", "Model catalog")}
        ${section("quota", "pulse", "Quota")}
        <p class="models-nav-group" data-i18n="models.navConfigure">Configure</p>
        ${section("connection", "settings", "Connection settings")}
      </nav>
      <footer class="side-foot models-rail-foot">
        <a class="foot-btn" href="/settings">${iconSvg("settings")}<span data-i18n="settings.title">Settings</span></a>
        <label class="models-locale"><span class="sr-only" data-i18n="settings.language">Language</span><select id="locale-select"><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
      </footer>
    </aside>
    <main class="models-main">
      <p class="models-scope" data-i18n="models.scope">Manage the metabridge and CLIProxyAPI connection Yui reads. Saved configuration is not applied until metabridge is reloaded, and nothing here runs inference.</p>
      <div id="models-root" class="models-root"></div>
    </main>
  </div>
  <script type="module" src="/assets/js/app/models.js"></script>
</body></html>`;
