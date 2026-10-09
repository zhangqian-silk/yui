import { DEFAULT_DARK_THEME } from "../shared/themes.js";
import { STYLESHEETS } from "../styles/index.js";
import { DIALOGS_HTML } from "./dialogs.js";
import { DOCK_HTML } from "./dock.js";
import { SIDEBAR_HTML } from "./sidebar.js";

// Static application frame. Everything inside #detail, #task-list and the dock
// panes is rendered by the client modules; the shell only fixes the regions
// and the controls whose identity must survive re-renders. Stylesheets are
// linked in registry (cascade) order, followed by the terminal's vendor CSS.
const STYLESHEET_LINKS = STYLESHEETS
  .map(sheet => `  <link rel="stylesheet" href="/assets/css/${sheet.name}.css">`)
  .join("\n");

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en" data-theme="${DEFAULT_DARK_THEME.id}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <meta name="yui-web-token" content="__YUI_WEB_TOKEN__">
  <link rel="icon" href="data:,">
  <title>Yui</title>
  <link rel="preload" href="/assets/fonts/inter-500.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/assets/fonts/inter-600.woff2" as="font" type="font/woff2" crossorigin>
${STYLESHEET_LINKS}
  <link rel="stylesheet" href="/assets/vendor/xterm.css">
</head>
<body>
  <a class="skip-link" href="#center" data-i18n="a11y.skip">Skip to task details</a>
  <div class="app">
${SIDEBAR_HTML}
    <main id="center" class="center" tabindex="-1">
      <div id="detail" class="detail"></div>
    </main>
${DOCK_HTML}
  </div>
${DIALOGS_HTML}
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>`;
