export const DOCK_SCRIPT = String.raw`
// The session dock: the Task discussion (recorded Task messages plus the
// composer) and the live native Session terminal. The feed is a read-only
// projection and redraws on every refresh; the composer is kept per Task so a
// refresh can never discard an unsent draft or a pending receipt.
import { Terminal } from "/assets/vendor/xterm.mjs";
import { FitAddon } from "/assets/vendor/addon-fit.mjs";
import { h, icon, clear } from "/assets/js/dom.js";
import { formatShort } from "/assets/js/format.js";
import { label, chip, emptyState, richText, dot } from "/assets/js/components.js";
import { entriesOf, recordCard, recordReader } from "/assets/js/records.js";
import { messageComposer } from "/assets/js/forms.js";
import { pageToken } from "/assets/js/api.js";

export function renderDiscussion(host, data, t, locale, actions) {
  const task = data.task;
  const composerKey = task.id + "|" + task.status + "|" + locale;
  let feed = host.querySelector(".feed");
  const composerWrap = host.querySelector(".composer-wrap");
  const composer = composerWrap && composerWrap.firstChild;
  const keepComposer = host.dataset.taskId === task.id && composer
    && (composer.dataset.key === composerKey || composer.dataset.unsent === "true" || composer.contains(document.activeElement));
  const previousScroll = feed ? feed.scrollTop : 0;
  const atEnd = !feed || host.dataset.taskId !== task.id || feed.scrollHeight - feed.clientHeight - feed.scrollTop < 40;
  if (host.dataset.taskId !== task.id || !feed) {
    clear(host);
    host.append(
      h("div.dock-sub", null, h("span.dock-sub-title", null, t("discussion.title")), h("span.dock-sub-note", null, t("discussion.source"))),
      h("div.feed", { "aria-label": t("discussion.feed"), tabIndex: 0 }),
      h("div.composer-wrap"));
    feed = host.querySelector(".feed");
  }
  host.dataset.taskId = task.id;
  if (!feed.querySelector('[data-reading="true"]')) drawFeed(feed, data, t, locale, actions);
  feed.scrollTop = atEnd ? feed.scrollHeight : previousScroll;
  if (!keepComposer) {
    const next = messageComposer(task, t, actions);
    next.dataset.key = composerKey;
    host.querySelector(".composer-wrap").replaceChildren(next);
  }
}

export function discussionHasUnsent(host) {
  return !!host.querySelector('[data-unsent="true"]');
}

function drawFeed(feed, data, t, locale, actions) {
  clear(feed);
  const core = data.core;
  const entries = entriesOf(core, "task-message").slice().sort(function (a, b) {
    return Date.parse((a.value && a.value.createdAt) || 0) - Date.parse((b.value && b.value.createdAt) || 0);
  });
  if (core.omitted.records) feed.append(h("p.feed-note", null, t("discussion.omitted")));
  if (!entries.length) {
    feed.append(emptyState(t("discussion.empty"), "chat"));
    return;
  }
  let lastDay = "";
  entries.forEach(function (entry) {
    if (entry.omitted) { feed.append(recordCard(entry, data.task.id, t, actions, { compact: true })); return; }
    const value = entry.value;
    const day = value.createdAt ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value.createdAt)) : "";
    if (day && day !== lastDay) { feed.append(h("div.feed-day", null, h("span", null, day))); lastDay = day; }
    const type = (value.author && value.author.type) || "system";
    const author = (value.author && value.author.roleName) || label(t, "author", type);
    const message = h("article.msg.from-" + (type === "user" || type === "operator" ? "user" : type === "role" ? "role" : "system"));
    message.append(h("span.msg-avatar", { "aria-hidden": "true" }, String(author).slice(0, 1).toUpperCase()));
    const main = h("div.msg-main", null,
      h("header.msg-head", null, h("strong", null, author),
        value.intent ? chip(label(t, "intent", value.intent)) : null,
        value.kind === "role-result" ? chip(label(t, "messageKind", value.kind)) : null,
        h("time", { dateTime: value.createdAt || "" }, formatShort(value.createdAt, locale))),
      h("div.msg-bubble", null, richText(null, value.body || "", t, { threshold: 900 })));
    main.append(recordReader(entry, data.task.id, t, actions));
    message.append(main);
    feed.append(message);
  });
}

// --- Live native Session ----------------------------------------------------------
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

export function createTerminalController(elements, t, locale, notify) {
  let session = null;
  let current = null;
  let stateKey = "terminal.idle";
  let targets = [];

  function setState(key, state) {
    stateKey = key;
    elements.state.dataset.state = state;
    elements.state.lastChild.textContent = t(key);
  }
  function drawTargets() {
    clear(elements.targets);
    targets.forEach(function (target) {
      elements.targets.append(h("button.target-chip", {
        type: "button",
        "aria-pressed": String(sameTarget(target, current)),
        title: target.scope === "task" ? target.taskId + " / " + target.roleName : t("terminal.global") + " / " + target.roleName,
        onclick: function () { open(target); }
      }, target.scope === "task" ? dot(target.live ? "ok" : "idle") : icon("broadcast", "icon-sm"), h("span", null, target.roleName)));
    });
    if (!targets.length) elements.targets.append(h("span.faint.small", null, t("terminal.noTargets")));
  }
  function dispose() {
    if (!session) return;
    const owned = session;
    session = null;
    owned.resizeObserver.disconnect();
    owned.input.dispose();
    owned.socket.close();
    owned.terminal.dispose();
    clear(elements.host);
  }
  function close() {
    dispose();
    current = null;
    elements.empty.hidden = false;
    elements.cli.textContent = "yui operator enter";
    setState("terminal.idle", "idle");
    drawTargets();
  }
  function open(target) {
    dispose();
    current = target;
    elements.empty.hidden = true;
    elements.cli.textContent = cliFor(target);
    setState("terminal.connecting", "connecting");
    drawTargets();
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
    terminal.open(elements.host);
    try { fit.fit(); } catch {}
    let writable = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const parameters = new URLSearchParams({
      scope: target.scope, role: target.roleName, cols: String(terminal.cols), rows: String(terminal.rows), token: pageToken()
    });
    if (target.scope === "task") parameters.set("task", target.taskId);
    const socket = new WebSocket(protocol + "//" + window.location.host + "/api/terminal?" + parameters.toString());
    const input = terminal.onData(function (data) {
      if (writable && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data: data }));
    });
    const resizeObserver = new ResizeObserver(function () {
      if (!session || session.terminal !== terminal || !elements.host.offsetWidth) return;
      try { fit.fit(); } catch { return; }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", columns: terminal.cols, rows: terminal.rows }));
      }
    });
    resizeObserver.observe(elements.host);
    socket.addEventListener("message", function (event) {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "ready") {
        writable = !message.readOnly;
        setState(writable ? "terminal.writable" : "terminal.readOnly", writable ? "writable" : "readonly");
        if (message.history && message.history.limit < message.history.target) {
          const number = new Intl.NumberFormat(locale());
          notify(t("terminal.historyLimited").replace("{current}", number.format(message.history.limit))
            .replace("{target}", number.format(message.history.target)));
        }
        terminal.focus();
      } else if (message.type === "data") terminal.write(message.data);
      else if (message.type === "exit") setState("terminal.closed", "closed");
      else if (message.type === "error") {
        setState("terminal.error", "error");
        terminal.writeln("\r\n" + message.message);
      }
    });
    socket.addEventListener("close", function () {
      writable = false;
      if (stateKey !== "terminal.error") setState("terminal.closed", "closed");
    });
    socket.addEventListener("error", function () {
      writable = false;
      setState("terminal.error", "error");
      terminal.writeln(t("terminal.errorDetail"));
    });
    session = { terminal, socket, input, resizeObserver };
  }
  drawTargets();
  return {
    open: open,
    close: close,
    current: function () { return current; },
    connected: function () { return !!session; },
    setTargets: function (next) { targets = next; drawTargets(); },
    relabel: function () { setState(stateKey, elements.state.dataset.state); drawTargets(); },
    retheme: function () { if (session) session.terminal.options.theme = terminalTheme(); }
  };
}
`;
