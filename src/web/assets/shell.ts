import { iconSvg } from "./icons.js";

// Static application frame. Everything inside #detail, #task-list and the dock
// panes is rendered by the client modules; this file only fixes the regions
// and the controls whose identity must survive re-renders.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en" data-theme="sumi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <meta name="yui-web-token" content="__YUI_WEB_TOKEN__">
  <link rel="icon" href="data:,">
  <title>Yui</title>
  <link rel="preload" href="/assets/fonts/inter-500.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/assets/fonts/inter-600.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/assets/css/fonts.css">
  <link rel="stylesheet" href="/assets/css/tokens.css">
  <link rel="stylesheet" href="/assets/css/base.css">
  <link rel="stylesheet" href="/assets/css/layout.css">
  <link rel="stylesheet" href="/assets/css/components.css">
  <link rel="stylesheet" href="/assets/css/views.css">
  <link rel="stylesheet" href="/assets/css/markdown.css">
  <link rel="stylesheet" href="/assets/css/responsive.css">
  <link rel="stylesheet" href="/assets/vendor/xterm.css">
</head>
<body>
  <a class="skip-link" href="#center" data-i18n="a11y.skip">Skip to task details</a>
  <div class="app">
    <aside class="sidebar" aria-label="Tasks" data-i18n-aria-label="sidebar.label">
      <header class="side-head">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">結</span>
          <span class="brand-name">Yui</span>
        </div>
        <span class="sync" id="sync-state" title="Last sync" data-i18n-title="sync.label">
          <i aria-hidden="true"></i><time id="last-sync">—</time>
        </span>
        <button id="refresh" class="icon-btn" type="button" aria-label="Refresh" data-i18n-aria-label="actions.refresh" title="Refresh · R">${iconSvg("refresh")}</button>
      </header>
      <label class="search-field">
        ${iconSvg("search")}
        <span class="sr-only" data-i18n="search.label">Search tasks</span>
        <input id="search" type="search" autocomplete="off" spellcheck="false" placeholder="Search tasks" data-i18n-placeholder="search.placeholder">
        <kbd>/</kbd>
      </label>
      <div id="attention-bar" class="attention-bar" aria-live="polite"></div>
      <div id="status-filters" class="status-tabs" role="group" aria-label="Filter by status" data-i18n-aria-label="filters.label"></div>
      <div id="task-list" class="task-list" aria-label="Tasks" data-i18n-aria-label="sidebar.label" aria-live="polite"></div>
      <div id="catalog-controls" class="pager" aria-live="polite">
        <button id="catalog-reset" class="pager-btn" type="button" data-i18n="catalog.first">First page</button>
        <span id="catalog-count" class="pager-count"></span>
        <button id="catalog-next" class="pager-btn" type="button" data-i18n="catalog.next" disabled>Next page</button>
        <button id="catalog-attention-reset" class="pager-clear" type="button" data-i18n="catalog.clearAttention" hidden>Clear attention filter</button>
      </div>
      <footer class="side-foot">
        <button id="operator-terminal" class="foot-btn" type="button" title="Operator session · O">
          ${iconSvg("terminal")}<span data-i18n="actions.operator">Operator</span><kbd>O</kbd>
        </button>
        <button id="global-input-open" class="foot-btn" type="button" title="Global input" data-i18n-title="global.open">
          ${iconSvg("broadcast")}<span data-i18n="global.open">Global input</span>
        </button>
        <button id="settings-open" class="icon-btn" type="button" aria-label="Settings" data-i18n-aria-label="settings.title" title="Settings">${iconSvg("settings")}</button>
      </footer>
    </aside>
    <div id="sidebar-divider" class="sidebar-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-valuemin="240" aria-valuemax="560" aria-valuenow="264" aria-label="Resize task list" data-i18n-aria-label="sidebar.resize" title="Drag to resize · double-click to reset" data-i18n-title="sidebar.resizeHint"><span aria-hidden="true"></span></div>
    <main id="center" class="center" tabindex="-1">
      <div id="detail" class="detail"></div>
    </main>
    <div id="dock-divider" class="dock-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-valuemin="320" aria-valuemax="720" aria-valuenow="440" aria-label="Resize session panel" data-i18n-aria-label="dock.resize" hidden><span aria-hidden="true"></span></div>
    <aside id="dock" class="dock" aria-label="Session" data-i18n-aria-label="dock.label" hidden>
      <header class="dock-head">
        <div class="seg" role="tablist" aria-label="Session view" data-i18n-aria-label="dock.label">
          <button id="dock-tab-discussion" class="seg-btn" type="button" role="tab" aria-selected="true" aria-controls="dock-discussion">${iconSvg("chat")}<span data-i18n="dock.discussion">Discussion</span></button>
          <button id="dock-tab-session" class="seg-btn" type="button" role="tab" aria-selected="false" aria-controls="dock-session">${iconSvg("terminal")}<span data-i18n="dock.session">Live session</span></button>
        </div>
        <div class="dock-actions">
          <button id="dock-swap" class="icon-btn" type="button" aria-label="Swap with task details" data-i18n-aria-label="dock.swap" title="Swap with task details">${iconSvg("swap")}</button>
          <button id="dock-close" class="icon-btn" type="button" aria-label="Hide session panel" data-i18n-aria-label="dock.hide" title="Hide · D">${iconSvg("close")}</button>
        </div>
      </header>
      <section id="dock-discussion" class="dock-pane dock-discussion" role="tabpanel" aria-labelledby="dock-tab-discussion"></section>
      <section id="dock-session" class="dock-pane dock-session" role="tabpanel" aria-labelledby="dock-tab-session" hidden>
        <div class="session-bar">
          <div id="session-targets" class="session-targets" role="group" aria-label="Session target" data-i18n-aria-label="dock.target"></div>
          <span id="terminal-state" class="conn" data-state="idle"><i aria-hidden="true"></i><span data-i18n="terminal.idle">Not connected</span></span>
        </div>
        <div id="terminal-host" class="terminal-host"></div>
        <div id="terminal-empty" class="terminal-empty">
          ${iconSvg("terminal", "icon icon-xl")}
          <p class="terminal-empty-title" data-i18n="terminal.emptyTitle">Attach to a native Session</p>
          <p class="terminal-empty-text" data-i18n="terminal.emptyText">Pick a Role above. The panel shows the Session's current screen; attaching never starts or restarts an Agent.</p>
        </div>
        <footer class="session-foot">
          <span data-i18n="terminal.cliHint">Full terminal</span>
          <code id="terminal-cli">yui operator enter</code>
        </footer>
      </section>
    </aside>
  </div>
  <dialog id="settings-dialog" class="dialog settings-dialog" aria-labelledby="settings-title">
    <form method="dialog" class="dialog-body">
      <header class="dialog-head">
        <h2 id="settings-title" data-i18n="settings.title">Settings</h2>
        <button class="icon-btn" value="close" aria-label="Close" data-i18n-aria-label="actions.close">${iconSvg("close")}</button>
      </header>
      <fieldset class="field">
        <legend data-i18n="settings.theme">Theme</legend>
        <div id="theme-options" class="theme-options"></div>
      </fieldset>
      <label class="field">
        <span data-i18n="settings.language">Language</span>
        <select id="locale-select">
          <option value="en">English</option>
          <option value="zh-CN">简体中文</option>
        </select>
      </label>
      <div class="field">
        <span data-i18n="settings.shortcuts">Keyboard</span>
        <dl class="shortcut-list">
          <dt><kbd>/</kbd></dt><dd data-i18n="shortcut.search">Search tasks</dd>
          <dt><kbd>R</kbd></dt><dd data-i18n="shortcut.refresh">Refresh</dd>
          <dt><kbd>D</kbd></dt><dd data-i18n="shortcut.dock">Show or hide the session panel</dd>
          <dt><kbd>O</kbd></dt><dd data-i18n="shortcut.operator">Operator session</dd>
          <dt><kbd>1</kbd>–<kbd>5</kbd></dt><dd data-i18n="shortcut.tabs">Switch task sections</dd>
          <dt><kbd>Esc</kbd></dt><dd data-i18n="shortcut.escape">Close panel / leave task</dd>
        </dl>
      </div>
    </form>
  </dialog>
  <dialog id="global-input-dialog" class="dialog" aria-labelledby="global-input-title">
    <form id="global-input-form" class="dialog-body">
      <header class="dialog-head">
        <div>
          <h2 id="global-input-title" data-i18n="global.title">Global Role input</h2>
          <p class="dialog-sub" data-i18n="global.help">Queue is the default. A cancel request does not prove the Turn stopped.</p>
        </div>
        <button id="global-input-close" class="icon-btn" type="button" aria-label="Close" data-i18n-aria-label="actions.close">${iconSvg("close")}</button>
      </header>
      <div class="field-row">
        <label class="field"><span data-i18n="global.role">Role</span><input id="global-input-role" value="operator" required pattern="[A-Za-z0-9_-]+"></label>
        <label class="field"><span data-i18n="control.action">Action</span><select id="global-input-action">
          <option value="queue" data-i18n="control.queue">Queue</option>
          <option value="steer" data-i18n="control.steer">Steer</option>
          <option value="interrupt" data-i18n="control.interrupt">Interrupt</option>
        </select></label>
      </div>
      <label id="global-input-body-label" class="field"><span data-i18n="control.message">Message</span><textarea id="global-input-body" maxlength="8000" required rows="4"></textarea></label>
      <label id="global-input-target-label" class="field" hidden><span data-i18n="control.expectedTurn">Expected current Turn</span><input id="global-input-target" class="mono"></label>
      <label id="global-input-then-label" class="field" hidden><span data-i18n="control.then">Then-message reference</span><input id="global-input-then" class="mono"></label>
      <div class="dialog-actions">
        <button id="global-input-inspect" type="button" class="btn" data-i18n="global.inspect">Read state</button>
        <button id="global-input-submit" type="submit" class="btn btn-primary" data-i18n="actions.submit">Submit</button>
      </div>
      <p id="global-input-receipt" role="status" class="receipt" data-i18n="receipt.notSubmitted">Not submitted</p>
      <pre id="global-input-state" class="code-block" hidden></pre>
    </form>
  </dialog>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>`;
