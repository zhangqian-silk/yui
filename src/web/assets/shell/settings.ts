import { STYLESHEETS } from "../styles/index.js";
import { DEFAULT_DARK_THEME } from "../shared/themes.js";

export const SETTINGS_HTML = `<!doctype html>
<html lang="en" data-theme="${DEFAULT_DARK_THEME.id}">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="yui-web-token" content="__YUI_WEB_TOKEN__">
  <link rel="icon" href="data:,"><title>Yui · Settings</title>
  ${STYLESHEETS.map(s => `<link rel="stylesheet" href="/assets/css/${s.name}.css">`).join("\n")}
</head>
<body class="settings-body">
  <main class="settings-page">
    <header class="settings-header"><a class="btn" href="/">← Yui</a><h1 data-i18n="settings.title">Settings</h1></header>
    <p data-i18n="settings.scope">Browser preferences apply here immediately. Server settings are desired configuration, not proof that existing Sessions adopted them.</p>
    <section class="settings-card">
      <h2 data-i18n="settings.browser">This browser</h2>
      <div class="settings-grid">
        <fieldset class="field"><legend data-i18n="settings.theme">Theme</legend><div id="theme-options" class="theme-options"></div></fieldset>
        <div class="settings-stack">
          <label class="field"><span data-i18n="settings.language">Language</span><select id="locale-select"><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
          <label class="field"><span data-i18n="settings.accessMode">Default session access</span><select id="access-mode"><option value="native" data-i18n="settings.native">Native terminal</option><option value="structured" data-i18n="settings.structured">Structured view</option></select></label>
          <p data-i18n="settings.accessHelp">Preference for subsequent session selection where supported. It does not switch a live Session.</p>
          <button id="reset-layout" type="button" class="btn" data-i18n="settings.resetLayout">Reset saved workspace layout</button>
          <p id="browser-receipt" role="status"></p>
        </div>
      </div>
    </section>
    <label class="field settings-search"><span data-i18n="settings.search">Find a setting</span><input id="settings-search" type="search" autocomplete="off"></label>
    <p id="settings-status" role="status"></p>
    <div id="settings-groups" class="settings-stack"></div>
  </main>
  <script type="module" src="/assets/js/app/settings.js"></script>
</body></html>`;
