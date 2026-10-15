import { STYLESHEETS } from "../styles/index.js";
import { DEFAULT_DARK_THEME } from "../shared/themes.js";

// Standalone Model management page. The server serves it at /models with the
// page token substituted for __YUI_WEB_TOKEN__, exactly like SETTINGS_HTML.
export const MODELS_HTML = `<!doctype html>
<html lang="en" data-theme="${DEFAULT_DARK_THEME.id}">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="yui-web-token" content="__YUI_WEB_TOKEN__">
  <script src="/assets/theme.js"></script>
  <link rel="icon" href="data:,"><title>Yui · Models</title>
  ${STYLESHEETS.map(s => `<link rel="stylesheet" href="/assets/css/${s.name}.css">`).join("\n")}
</head>
<body class="settings-body">
  <main class="settings-page models-page">
    <header class="settings-header">
      <a class="btn" href="/">← Yui</a><h1 data-i18n="models.title">Models</h1>
      <label class="field models-locale"><span class="sr-only" data-i18n="settings.language">Language</span><select id="locale-select"><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
    </header>
    <p data-i18n="models.scope">Manage the metabridge and CLIProxyAPI connection Yui reads. Saved configuration is not applied until metabridge is reloaded, and nothing here runs inference.</p>
    <div id="models-root" class="settings-stack"></div>
  </main>
  <script type="module" src="/assets/js/app/models.js"></script>
</body></html>`;
