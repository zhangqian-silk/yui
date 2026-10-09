import { DOCK } from "../shared/geometry.js";
import { iconSvg } from "../shared/icons.js";

// The dock divider and the dock region: the Discussion / Live session tabs,
// their actions, the discussion mount and the terminal pane, whose host,
// target chips and connection state must survive re-renders.
// The string keeps its indentation inside .app and has no trailing newline.
export const DOCK_HTML = `    <div id="dock-divider" class="dock-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-valuemin="${DOCK.min}" aria-valuemax="${DOCK.max}" aria-valuenow="${DOCK.initial}" aria-label="Resize session panel" data-i18n-aria-label="dock.resize" hidden><span aria-hidden="true"></span></div>
    <aside id="dock" class="dock" aria-label="Session" data-i18n-aria-label="dock.label" hidden>
      <header class="dock-head">
        <div class="seg" role="tablist" aria-label="Session view" data-i18n-aria-label="dock.label">
          <button id="dock-tab-conversation" class="seg-btn" type="button" role="tab" aria-selected="false" aria-controls="dock-conversation"><span data-i18n="conversation.title">Conversation</span></button>
          <button id="dock-tab-discussion" class="seg-btn" type="button" role="tab" aria-selected="true" aria-controls="dock-discussion">${iconSvg("chat")}<span data-i18n="dock.discussion">Discussion</span></button>
          <button id="dock-tab-session" class="seg-btn" type="button" role="tab" aria-selected="false" aria-controls="dock-session">${iconSvg("terminal")}<span data-i18n="dock.session">Live session</span></button>
        </div>
        <div class="dock-actions">
          <button id="dock-swap" class="icon-btn" type="button" aria-label="Swap with task details" data-i18n-aria-label="dock.swap" title="Swap with task details">${iconSvg("swap")}</button>
          <button id="dock-close" class="icon-btn" type="button" aria-label="Hide session panel" data-i18n-aria-label="dock.hide" title="Hide · D">${iconSvg("close")}</button>
        </div>
      </header>
      <section id="dock-conversation" class="dock-pane dock-discussion" role="tabpanel" aria-labelledby="dock-tab-conversation" hidden></section>
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
    </aside>`;
