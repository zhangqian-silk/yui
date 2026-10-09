import { iconSvg } from "../shared/icons.js";
import { TASK_TABS } from "../shared/taskTabs.js";

// Modal dialogs: settings (theme, language, keyboard shortcuts) and the
// global Role input form. The string keeps its indentation inside <body> and
// has no trailing newline.
export const DIALOGS_HTML = `  <dialog id="settings-dialog" class="dialog settings-dialog" aria-labelledby="settings-title">
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
          <dt><kbd>1</kbd>–<kbd>${TASK_TABS.length}</kbd></dt><dd data-i18n="shortcut.tabs">Switch task sections</dd>
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
  </dialog>`;
