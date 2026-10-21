import { DOCK } from "../shared/geometry.js";
import { iconSvg } from "../shared/icons.js";

// The dock divider and the dock region: one header row with the target menu,
// the view tabs (icon-only until the dock is wide) and the dock actions; then
// the discussion mount and the terminal pane, whose host, target chips and
// connection state must survive re-renders.
// The string keeps its indentation inside .app and has no trailing newline.
export const DOCK_HTML = `    <div id="dock-divider" class="dock-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-valuemin="${DOCK.min}" aria-valuemax="${DOCK.max}" aria-valuenow="${DOCK.initial}" aria-label="Resize session panel" data-i18n-aria-label="dock.resize" hidden><span aria-hidden="true"></span></div>
    <aside id="dock" class="dock" aria-label="Session" data-i18n-aria-label="dock.label" hidden>
      <header class="dock-head">
        <details id="dock-target" class="dock-target">
          <summary class="dock-target-btn" aria-label="Conversation target" data-i18n-aria-label="dock.target">
            <span id="dock-target-icon" class="dock-target-icon" aria-hidden="true">${iconSvg("broadcast")}</span>
            <span id="dock-target-label" class="dock-target-label">Operator</span>${iconSvg("down")}
          </summary>
          <div class="dock-target-menu">
            <div id="dock-target-options" class="dock-target-options" role="group" aria-label="Conversation target" data-i18n-aria-label="dock.target"></div>
            <hr>
            <button id="global-input-open" class="dock-target-item" type="button">${iconSvg("send")}<span data-i18n="global.openRole">Message another Role…</span></button>
          </div>
        </details>
        <div class="seg seg-sm dock-tabs" role="tablist" aria-label="Session view" data-i18n-aria-label="dock.label">
          <button id="dock-tab-conversation" class="seg-btn" type="button" role="tab" aria-selected="false" aria-controls="dock-conversation" aria-label="Conversation" data-i18n-aria-label="conversation.title" title="Conversation" data-i18n-title="conversation.title">${iconSvg("sparkle")}<span data-i18n="conversation.title">Conversation</span></button>
          <button id="dock-tab-discussion" class="seg-btn" type="button" role="tab" aria-selected="true" aria-controls="dock-discussion" aria-label="Discussion" data-i18n-aria-label="dock.discussion" title="Discussion" data-i18n-title="dock.discussion">${iconSvg("chat")}<span data-i18n="dock.discussion">Discussion</span></button>
          <button id="dock-tab-session" class="seg-btn" type="button" role="tab" aria-selected="false" aria-controls="dock-session" aria-label="Live session" data-i18n-aria-label="dock.session" title="Live session" data-i18n-title="dock.session">${iconSvg("terminal")}<span data-i18n="dock.session">Live session</span></button>
          <button id="dock-tab-preview" class="seg-btn" type="button" role="tab" aria-selected="false" aria-controls="dock-preview" aria-label="Preview" data-i18n-aria-label="preview.title" title="Preview" data-i18n-title="preview.title" disabled>${iconSvg("eye")}<span data-i18n="preview.title">Preview</span></button>
        </div>
        <div class="dock-actions">
          <button id="dock-swap" class="icon-btn" type="button" aria-label="Swap with task details" data-i18n-aria-label="dock.swap" title="Swap with task details">${iconSvg("swap")}</button>
          <button id="dock-close" class="icon-btn" type="button" aria-label="Hide session panel" data-i18n-aria-label="dock.hide" title="Hide · D">${iconSvg("close")}</button>
        </div>
      </header>
      <section id="dock-conversation" class="dock-pane dock-discussion" role="tabpanel" aria-labelledby="dock-tab-conversation" hidden></section>
      <section id="dock-discussion" class="dock-pane dock-discussion" role="tabpanel" aria-labelledby="dock-tab-discussion"></section>
      <section id="dock-preview" class="dock-pane dock-preview" role="tabpanel" aria-labelledby="dock-tab-preview" hidden></section>
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
    </aside>`;
