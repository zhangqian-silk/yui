export const TERMINAL_SCRIPT = String.raw`
// The live native terminal of the session page (views/dock/session): the xterm
// view and its WebSocket for one owner's current Session. The session page
// builds the surrounding chrome and destroys this controller with its view;
// opening another target disposes the previous connection first.
import { Terminal } from "/assets/vendor/xterm.mjs";
import { FitAddon } from "/assets/vendor/addon-fit.mjs";
import { clear } from "/assets/js/lib/dom.js";
import { fill } from "/assets/js/lib/format.js";
import { pageToken, requestJson } from "/assets/js/lib/api.js";
import { sessionExpired } from "/assets/js/lib/session.js";

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function terminalTheme() {
  return {
    background: cssVar("--term-bg", "#0b0c0d"),
    foreground: cssVar("--term-fg", "#e6e6e8"),
    cursor: cssVar("--term-cursor", "#ff7a52"),
    selectionBackground: cssVar("--term-sel", "#3a2a24")
  };
}

function cliFor(target) {
  if (target.scope === "task") return "yui task role session inspect " + target.taskId + " " + target.roleName;
  return target.roleName === "operator" ? "yui operator enter" : "yui session enter " + target.roleName;
}

export function sameTarget(left, right) {
  return !!left && !!right && left.scope === right.scope && left.roleName === right.roleName
    && (left.scope !== "task" || left.taskId === right.taskId);
}

// elements: { host, empty, emptyTitle, emptyText, state, cli }; locale() reads
// the current locale; notify(message) shows a toast.
// hooks.onSession({ id, currentSessionId, session }) reports which Session the
// open target resolved to (or that it has none), before any connection.
export function createTerminalController(elements, t, locale, notify, hooks) {
  const ctl = { elements: elements, t: t, locale: locale, notify: notify, hooks: hooks || {}, session: null, current: null,
    generation: 0, stateKey: "terminal.idle", emptyKey: null };
  return {
    open: function (target) { return open(ctl, target); },
    close: function () { close(ctl); },
    current: function () { return ctl.current; },
    connected: function () { return !!ctl.session; },
    relabel: function () { setState(ctl, ctl.stateKey, elements.state.dataset.state); showEmpty(ctl, ctl.emptyKey); },
    retheme: function () { if (ctl.session) ctl.session.terminal.options.theme = terminalTheme(); }
  };
}

function setState(ctl, key, state) {
  ctl.stateKey = key;
  ctl.elements.state.dataset.state = state;
  ctl.elements.state.lastChild.textContent = ctl.t(key);
}

// Why nothing is attached, in place of the terminal: no Session yet, or the
// selected Session is no longer the current one. Null hides the message.
function showEmpty(ctl, key) {
  ctl.emptyKey = key;
  const elements = ctl.elements;
  if (!elements.empty) return;
  elements.empty.hidden = !key;
  if (!key) return;
  if (elements.emptyTitle) elements.emptyTitle.textContent = ctl.t(key + "Title");
  if (elements.emptyText) elements.emptyText.textContent = ctl.t(key + "Text");
}

function dispose(ctl) {
  ctl.generation++;
  if (!ctl.session) return;
  const owned = ctl.session;
  ctl.session = null;
  owned.resizeObserver.disconnect();
  owned.input.dispose();
  owned.socket.close();
  owned.terminal.dispose();
  clear(ctl.elements.host);
}

function close(ctl) {
  dispose(ctl);
  ctl.current = null;
  showEmpty(ctl, null);
  ctl.elements.cli.textContent = "yui operator enter";
  setState(ctl, "terminal.idle", "idle");
}

// A target without nativeSessionId attaches to the owner's current Session; a
// target naming one attaches only while it is still current. A replaced
// Session is reported, never silently exchanged for the new current one.
async function open(ctl, target) {
  dispose(ctl);
  const generation = ctl.generation;
  ctl.current = target;
  showEmpty(ctl, null);
  ctl.elements.cli.textContent = cliFor(target);
  setState(ctl, "terminal.connecting", "connecting");
  try {
    const query = new URLSearchParams({ scope: target.scope, role: target.roleName });
    if (target.scope === "task") query.set("task", target.taskId);
    const facts = await requestJson("/api/conversation?" + query);
    if (generation !== ctl.generation) return;
    const currentId = facts.currentSessionId || null;
    const id = target.nativeSessionId || currentId;
    const session = (facts.sessions || []).find(function (s) { return s.nativeSessionId === id; }) || null;
    if (ctl.hooks.onSession) ctl.hooks.onSession({ id: id, currentSessionId: currentId, session: session });
    if (generation !== ctl.generation) return;
    if (!id || id !== currentId) {
      setState(ctl, "terminal.unavailable", "idle");
      showEmpty(ctl, id ? "terminal.notCurrent" : "terminal.noSession");
      return;
    }
    target = { ...target, nativeSessionId: id };
    ctl.current = target;
  } catch (error) {
    if (generation === ctl.generation) { setState(ctl, "terminal.error", "error"); ctl.notify(error.message); }
    return;
  }
  const view = mountTerminal(ctl.elements.host);
  const terminal = view.terminal;
  const socket = connect(target, terminal);
  const link = { writable: false };
  const input = terminal.onData(function (data) {
    if (link.writable && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data: data }));
  });
  const resizeObserver = new ResizeObserver(function () {
    if (!ctl.session || ctl.session.terminal !== terminal || !ctl.elements.host.offsetWidth) return;
    try { view.fit.fit(); } catch { return; }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "resize", columns: terminal.cols, rows: terminal.rows }));
    }
  });
  resizeObserver.observe(ctl.elements.host);
  bindSocket(ctl, socket, terminal, link, generation);
  ctl.session = { terminal, socket, input, resizeObserver };
}

function mountTerminal(host) {
  const terminal = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    convertEol: false,
    fontFamily: '"JetBrains Mono","SFMono-Regular",Menlo,Consolas,monospace',
    fontSize: 12.5,
    lineHeight: 1.15,
    theme: terminalTheme()
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);
  try { fit.fit(); } catch {}
  return { terminal: terminal, fit: fit };
}

function connect(target, terminal) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const parameters = new URLSearchParams({
    scope: target.scope, role: target.roleName, cols: String(terminal.cols), rows: String(terminal.rows), token: pageToken()
  });
  if (target.scope === "task") parameters.set("task", target.taskId);
  if (target.nativeSessionId) parameters.set("session", target.nativeSessionId);
  return new WebSocket(protocol + "//" + window.location.host + "/api/terminal?" + parameters.toString());
}

function bindSocket(ctl, socket, terminal, link, generation) {
  socket.addEventListener("message", function (event) {
    if (generation !== ctl.generation) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "ready") ready(ctl, message, terminal, link);
    else if (message.type === "data") terminal.write(message.data);
    else if (message.type === "exit") setState(ctl, "terminal.closed", "closed");
    else if (message.type === "error") {
      setState(ctl, "terminal.error", "error");
      terminal.writeln("\r\n" + message.message);
    }
  });
  socket.addEventListener("close", function (event) {
    if (generation !== ctl.generation) return;
    link.writable = false;
    // 1008: the server closed this terminal because its browser session ended.
    if (event && event.code === 1008) { sessionExpired(); return; }
    if (ctl.stateKey !== "terminal.error") setState(ctl, "terminal.closed", "closed");
  });
  socket.addEventListener("error", function () {
    if (generation !== ctl.generation) return;
    link.writable = false;
    setState(ctl, "terminal.error", "error");
    terminal.writeln(ctl.t("terminal.errorDetail"));
  });
}

function ready(ctl, message, terminal, link) {
  link.writable = !message.readOnly;
  setState(ctl, link.writable ? "terminal.writable" : "terminal.readOnly", link.writable ? "writable" : "readonly");
  if (message.history && message.history.limit < message.history.target) {
    const number = new Intl.NumberFormat(ctl.locale());
    ctl.notify(fill(ctl.t("terminal.historyLimited"), {
      current: number.format(message.history.limit), target: number.format(message.history.target)
    }));
  }
  // A keyboard user moving through the session page's Chat | Terminal switch
  // keeps focus there (arrow keys must not become terminal input).
  const active = document.activeElement;
  if (!(active && active.closest && active.closest(".sp-modes"))) terminal.focus();
}
`;
