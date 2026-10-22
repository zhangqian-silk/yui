export const SESSION_PAGE_SCRIPT = String.raw`
// The dock's session page: one owner (a Role) and one selected Session, read
// either as the structured chat or as the live native terminal. The owner is
// picked in the dock header and the Session in the chat's picker; both carry
// across modes. Switching mode destroys the old view (polling, socket,
// listeners and unsent UI state such as drafts and scroll) and builds the
// other one afresh. Saved submission receipts and pending model switches are
// facts, not view state, and survive in the chat's existing storage.
import { h, icon } from "/assets/js/lib/dom.js";
import { formatShort } from "/assets/js/lib/format.js";
import { createConversationController } from "/assets/js/views/dock/conversation.js";
import { createTerminalController } from "/assets/js/views/dock/terminal.js";

export const SESSION_MODES = ["chat", "terminal"];

// host: the dock pane the page owns; notify(message) shows a toast;
// onChange() runs after the mode changed (the workspace redraws its header).
export function createSessionPage(host, t, locale, notify, onChange) {
  const page = { host: host, t: t, locale: locale, notify: notify || function () {}, onChange: onChange || function () {},
    owner: null, session: null, mode: "chat", view: null, active: false, switcher: null };
  return {
    // options: { mode, current, materials }. current resolves the owner's
    // current Session again instead of keeping the selected one.
    open: function (target, options) { open(page, target, options || {}); },
    close: function () { page.active = false; if (page.view) page.view.stop(); },
    reconnect: function () { page.active = true; if (page.view) page.view.start(); },
    setMode: function (mode) { return setMode(page, mode); },
    mode: function () { return page.mode; },
    current: function () { return page.owner; },
    selection: function () { return page.view ? page.view.selection() : null; },
    connected: function () { return !!page.view && page.view.connected(); },
    captureDraftTarget: function () { return page.view ? page.view.captureDraftTarget() : null; },
    insertReference: function (target, citation) {
      if (!page.view) throw new Error(t("bodySearch.targetChanged"));
      page.view.insertReference(target, citation);
    },
    relabel: function () { if (page.view) page.view.relabel(); },
    retheme: function () { if (page.view) page.view.retheme(); }
  };
}

function ownerOf(target) {
  return { scope: target.scope, ...(target.scope === "task" ? { taskId: target.taskId } : {}), roleName: target.roleName };
}

function sameOwner(a, b) {
  return !!a && !!b && JSON.stringify(ownerOf(a)) === JSON.stringify(ownerOf(b));
}

function open(page, target, options) {
  const ownerChanged = !sameOwner(target, page.owner);
  const mode = SESSION_MODES.includes(options.mode) ? options.mode : page.mode;
  if (ownerChanged || options.current) page.session = null;
  page.owner = ownerOf(target);
  page.active = true;
  if (ownerChanged || options.current || mode !== page.mode || !page.view) {
    page.mode = mode;
    build(page, { materials: options.materials });
    page.onChange();
  } else page.view.start();
}

// Why the terminal cannot attach to the selected identity, or null when it
// may try (the terminal checks again against the newest facts).
function terminalBlock(page) {
  const session = page.session;
  if (!session || session.currentId === undefined) return null;
  if (!session.currentId) return "terminal.noSession";
  if (session.id && session.id !== session.currentId) return "terminal.notCurrent";
  return null;
}

function setMode(page, mode) {
  if (!SESSION_MODES.includes(mode) || mode === page.mode || !page.owner) return false;
  const block = mode === "terminal" ? terminalBlock(page) : null;
  if (block) { page.notify(page.t(block + "Text")); return false; }
  const focused = page.host.contains(document.activeElement);
  page.mode = mode;
  build(page, { discard: true });
  if (focused && page.switcher) page.switcher.focus(mode);
  page.onChange();
  return true;
}

function build(page, options) {
  const previous = page.view;
  page.view = null;
  if (previous) previous.destroy(!!options.discard);
  const root = h("div.session-view.is-" + page.mode);
  page.host.replaceChildren(root);
  page.switcher = modeSwitch(page);
  const view = page.mode === "terminal" ? terminalView(page, root, page.switcher.node)
    : chatView(page, root, page.switcher.node, options.materials);
  page.view = view;
  syncSwitch(page);
  if (page.active) view.start();
}

// Chat | Terminal for the same owner and Session: a small radio group in the
// view's own header row, not another navigation layer.
function modeSwitch(page) {
  const t = page.t;
  const buttons = {};
  const node = h("div.seg.seg-sm.sp-modes", { role: "radiogroup", "aria-label": t("session.mode"), "data-i18n-aria-label": "session.mode" });
  [["chat", "sparkle", "session.modeChat"], ["terminal", "terminal", "session.modeTerminal"]].forEach(function (entry) {
    const button = h("button.seg-btn", { type: "button", role: "radio", dataset: { mode: entry[0] },
      "aria-label": t(entry[2]), "data-i18n-aria-label": entry[2] },
      icon(entry[1]), h("span", { dataset: { i18n: entry[2] } }, t(entry[2])));
    button.addEventListener("click", function () { setMode(page, entry[0]); });
    buttons[entry[0]] = button;
    node.append(button);
  });
  node.addEventListener("keydown", function (event) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const next = page.mode === "chat" ? "terminal" : "chat";
    if (!setMode(page, next)) buttons[next].focus();
  });
  return { node: node, buttons: buttons, focus: function (mode) { buttons[mode].focus(); } };
}

function syncSwitch(page) {
  const switcher = page.switcher;
  if (!switcher) return;
  const block = terminalBlock(page);
  Object.keys(switcher.buttons).forEach(function (mode) {
    const button = switcher.buttons[mode];
    const chosen = mode === page.mode;
    button.setAttribute("aria-checked", String(chosen));
    button.tabIndex = chosen ? 0 : -1;
  });
  const terminal = switcher.buttons.terminal;
  // Blocked stays focusable and explains itself on use instead of going silent.
  terminal.setAttribute("aria-disabled", String(!!block && page.mode !== "terminal"));
  terminal.title = block && page.mode !== "terminal" ? page.t(block + "Text") : page.t("session.modeTerminal");
}

// The chat reports its selected Session so the terminal can follow it.
function chatView(page, root, tools, materials) {
  let view = null, opened = false;
  const ctl = createConversationController(root, page.t, page.locale, {
    tools: tools,
    onSelection: function (id, currentId) {
      if (page.view !== view) return;
      page.session = { id: id || null, currentId: currentId };
      syncSwitch(page);
    }
  });
  view = {
    kind: "chat",
    start: function () {
      if (opened) { ctl.reconnect(); return; }
      opened = true;
      ctl.open(page.owner, { session: page.session && page.session.id, materials: materials });
    },
    stop: function () { ctl.close(); },
    destroy: function (discard) { ctl.close(); if (discard) ctl.discardDraft(); },
    selection: ctl.selection,
    connected: function () { return false; },
    captureDraftTarget: ctl.captureDraftTarget,
    insertReference: ctl.insertReference,
    relabel: function () {},
    retheme: function () {}
  };
  return view;
}

function sessionName(page, info) {
  const t = page.t;
  const current = !!info.id && info.id === info.currentSessionId;
  const s = info.session;
  const when = s ? formatShort(s.createdAt, page.locale()) : "";
  return (current ? t("conversation.current") : t("conversation.previous")) + ((s && s.title) || when ? " · " + ((s && s.title) || when) : "");
}

function terminalView(page, root, tools) {
  const t = page.t;
  let view = null;
  const name = h("span.sp-term-name", null, t("conversation.sessions"));
  const state = h("span.conn", { dataset: { state: "idle" } }, h("i", { "aria-hidden": "true" }), h("span", null, t("terminal.idle")));
  const host = h("div.terminal-host");
  const emptyTitle = h("p.terminal-empty-title");
  const emptyText = h("p.terminal-empty-text");
  const toCurrent = h("button.btn", { type: "button", hidden: true }, t("conversation.backCurrent"));
  const empty = h("div.terminal-empty", { hidden: true }, icon("terminal", "icon icon-xl"), emptyTitle, emptyText, toCurrent);
  const cli = h("code");
  root.classList.add("dock-session");
  root.append(h("div.session-bar", null, icon("terminal", "icon-sm sp-term-icon"), name, h("span.spacer"), state, tools),
    host, empty,
    h("footer.session-foot", null, h("span", { dataset: { i18n: "terminal.cliHint" } }, t("terminal.cliHint")), cli));
  const ctl = createTerminalController({ host: host, empty: empty, emptyTitle: emptyTitle, emptyText: emptyText, state: state, cli: cli },
    t, page.locale, page.notify, {
      onSession: function (info) {
        if (page.view !== view) return;
        page.session = { id: info.id, currentId: info.currentSessionId };
        name.textContent = info.id ? sessionName(page, info) : t("conversation.noSessionShort");
        name.title = name.textContent;
        toCurrent.hidden = !(info.id && info.currentSessionId && info.id !== info.currentSessionId);
        syncSwitch(page);
      }
    });
  // An explicit choice, like the chat's "Back to current Session".
  toCurrent.addEventListener("click", function () {
    if (!page.session || !page.session.currentId) return;
    page.session = { id: page.session.currentId, currentId: page.session.currentId };
    toCurrent.hidden = true;
    view.start();
  });
  function target() {
    return { ...page.owner, ...(page.session && page.session.id ? { nativeSessionId: page.session.id } : {}) };
  }
  view = {
    kind: "terminal",
    start: function () { ctl.open(target()); },
    stop: function () { ctl.close(); },
    destroy: function () { ctl.close(); },
    selection: function () {
      const session = page.session;
      return session && session.id && session.id === session.currentId ? { ...page.owner, nativeSessionId: session.id } : null;
    },
    connected: ctl.connected,
    captureDraftTarget: function () { return null; },
    insertReference: function () { throw new Error(t("bodySearch.targetChanged")); },
    relabel: function () { ctl.relabel(); },
    retheme: function () { ctl.retheme(); }
  };
  return view;
}
`;
