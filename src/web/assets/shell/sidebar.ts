import { SIDEBAR } from "../shared/geometry.js";
import { iconSvg } from "../shared/icons.js";

// The sidebar region and its resize divider: brand and sync state, search,
// the attention and status filter mounts, the task list, the catalog pager
// and the footer actions. The client renders the list and filter contents.
// The string keeps its indentation inside .app and has no trailing newline.
export const SIDEBAR_HTML = `    <aside class="sidebar" aria-label="Tasks" data-i18n-aria-label="sidebar.label">
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
    <div id="sidebar-divider" class="sidebar-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-valuemin="${SIDEBAR.min}" aria-valuemax="${SIDEBAR.max}" aria-valuenow="${SIDEBAR.compact}" aria-label="Resize task list" data-i18n-aria-label="sidebar.resize" title="Drag to resize · double-click to reset" data-i18n-title="sidebar.resizeHint"><span aria-hidden="true"></span></div>`;
