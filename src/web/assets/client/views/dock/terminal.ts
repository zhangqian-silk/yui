export const TERMINAL_SCRIPT = String.raw`
// The live native Session terminal in the dock: target chips, the xterm view
// and its WebSocket. One session is open at a time; opening another target
// disposes the previous one first.
import { Terminal } from "/assets/vendor/xterm.mjs";
import { FitAddon } from "/assets/vendor/addon-fit.mjs";
import { h, icon, clear } from "/assets/js/lib/dom.js";
import { fill } from "/assets/js/lib/format.js";
import { pageToken } from "/assets/js/lib/api.js";
import { dot } from "/assets/js/ui/primitives.js";

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

// elements: { host, empty, state, cli, targets }; locale() reads the current
// locale; notify(message) shows a toast.
export function createTerminalController(elements, t, locale, notify) {
  const ctl = { elements: elements, t: t, locale: locale, notify: notify, session: null, current: null, stateKey: "terminal.idle", targets: [] };
  drawTargets(ctl);
  return {
    open: function (target) { open(ctl, target); },
    close: function () { close(ctl); },
    current: function () { return ctl.current; },
    connected: function () { return !!ctl.session; },
    setTargets: function (next) { ctl.targets = next; drawTargets(ctl); },
    relabel: function () { setState(ctl, ctl.stateKey, elements.state.dataset.state); drawTargets(ctl); },
    retheme: function () { if (ctl.session) ctl.session.terminal.options.theme = terminalTheme(); }
  };
}

function setState(ctl, key, state) {
  ctl.stateKey = key;
  ctl.elements.state.dataset.state = state;
  ctl.elements.state.lastChild.textContent = ctl.t(key);
}

function drawTargets(ctl) {
  const t = ctl.t;
  const list = ctl.elements.targets;
  clear(list);
  ctl.targets.forEach(function (target) {
    list.append(h("button.target-chip", {
      type: "button",
      "aria-pressed": String(sameTarget(target, ctl.current)),
      title: target.scope === "task" ? target.taskId + " / " + target.roleName : t("terminal.global") + " / " + target.roleName,
      onclick: function () { open(ctl, target); }
    }, target.scope === "task" ? dot(target.live ? "ok" : "idle") : icon("broadcast", "icon-sm"), h("span", null, target.roleName)));
  });
  if (!ctl.targets.length) list.append(h("span.faint.small", null, t("terminal.noTargets")));
}

function dispose(ctl) {
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
  ctl.elements.empty.hidden = false;
  ctl.elements.cli.textContent = "yui operator enter";
  setState(ctl, "terminal.idle", "idle");
  drawTargets(ctl);
}

function open(ctl, target) {
  dispose(ctl);
  ctl.current = target;
  ctl.elements.empty.hidden = true;
  ctl.elements.cli.textContent = cliFor(target);
  setState(ctl, "terminal.connecting", "connecting");
  drawTargets(ctl);
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
  bindSocket(ctl, socket, terminal, link);
  ctl.session = { terminal, socket, input, resizeObserver };
}

function mountTerminal(host) {
  const terminal = new Terminal({
    cursorBlink: true,
    scrollback: 0,
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
  return new WebSocket(protocol + "//" + window.location.host + "/api/terminal?" + parameters.toString());
}

function bindSocket(ctl, socket, terminal, link) {
  socket.addEventListener("message", function (event) {
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
  socket.addEventListener("close", function () {
    link.writable = false;
    if (ctl.stateKey !== "terminal.error") setState(ctl, "terminal.closed", "closed");
  });
  socket.addEventListener("error", function () {
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
  terminal.focus();
}
`;
