export const CONVERSATION_SCRIPT = String.raw`
import { h, clear } from "/assets/js/lib/dom.js";
import { requestJson, submitMutation } from "/assets/js/lib/api.js";
import { richText } from "/assets/js/ui/text.js";

export function createConversationController(host, t) {
  let owner = null, selected = null, facts = null, cursor = null, next = null;
  let generation = 0, busy = false, timer = null, pending = null, historyOk = false;
  let rendered = new Map();
  const select = h("select", { "aria-label": t("conversation.sessions") });
  const status = h("p.feed-note", { role: "status" });
  const identity = h("p.feed-note");
  const feed = h("div.feed", { tabIndex: 0, "aria-label": t("conversation.history") });
  const text = h("textarea.composer-input", { rows: 3, "aria-label": t("conversation.input"), maxLength: 12000 });
  const receipt = h("p.feed-note", { role: "status" });
  const send = h("button.btn.btn-primary", { type: "button" }, t("conversation.send"));
  const stop = h("button.btn", { type: "button" }, t("conversation.stop"));
  const check = h("button.btn", { type: "button" }, t("conversation.receipt"));
  const older = h("button.btn", { type: "button" }, t("conversation.older"));
  const latest = h("button.btn", { type: "button" }, t("conversation.latest"));
  const current = h("button.btn", { type: "button" }, t("conversation.current"));
  const moreSessions = h("button.btn", { type: "button", hidden: true }, t("conversation.moreSessions"));
  host.append(h("div.dock-sub", null, select, current, moreSessions), identity, status, feed,
    h("div.composer-bar", null, older, latest),
    h("div.composer-wrap", null, text, h("div.composer-bar", null, send, stop, check), receipt,
      h("p.feed-note", null, t("conversation.boundary"))));

  function key() { return "yui.conversation." + JSON.stringify(owner) + "." + selected; }
  function saved(suffix, value) {
    try {
      if (value === undefined) return sessionStorage.getItem(key() + suffix);
      if (value === null) sessionStorage.removeItem(key() + suffix);
      else sessionStorage.setItem(key() + suffix, value);
    } catch {}
    return null;
  }
  function url(extra) {
    const q = new URLSearchParams({ scope: owner.scope, role: owner.roleName });
    if (owner.scope === "task") q.set("task", owner.taskId);
    Object.entries(extra || {}).forEach(function (entry) { if (entry[1] != null) q.set(entry[0], String(entry[1])); });
    return "/api/conversation?" + q;
  }
  function controls() {
    const active = facts && facts.sessions.find(function (s) { return s.nativeSessionId === selected; });
    const writable = historyOk && active && active.current && active.status === "active" && active.adapterId === "codex"
      && facts.authority && facts.authority.owner === "controller";
    const turn = facts && facts.turn;
    send.disabled = busy || !!pending || !writable || (turn && ["submitting", "delivery-unknown"].includes(turn.status));
    stop.disabled = busy || !!pending || !writable || !turn || turn.status !== "accepted" || !turn.nativeTurnId;
    check.disabled = busy || !pending;
    older.disabled = busy || !next;
  }
  function choose(id) {
    if (selected) saved(".draft", text.value);
    generation++; selected = id; cursor = null; next = null; historyOk = false;
    text.value = saved(".draft") || "";
    try { pending = JSON.parse(saved(".pending") || "null"); } catch { pending = null; }
    receipt.textContent = pending ? t("conversation.unknown") + " " + pending.requestId : "";
    clear(feed); rendered.clear();
    controls();
  }
  function finish(own) {
    busy = false; controls();
    // A read for the old owner may have prevented the new selection's read.
    // Only refresh view state; never repeat a mutation or receipt submission.
    if (own !== generation && timer !== null) refresh();
  }
  function renderItems(items) {
    const nodes = [], updated = new Map();
    items.slice().reverse().forEach(function (item) {
      const key = JSON.stringify([item.turnId, item.id]), signature = JSON.stringify(item);
      const previous = rendered.get(key);
      let node = previous && previous.signature === signature ? previous.node : null;
      if (!node) {
        const content = richText(null, item.text, t, { threshold: 1800 });
        const meta = (item.source === "yui-input" ? t("conversation.linkedInput") + " " + item.messageId : item.kind)
          + " · " + item.turnId + (item.status ? " · " + item.status : "");
        node = item.kind === "activity" ? h("details", null, h("summary", null, meta), content)
          : h("article.msg.from-" + (item.kind === "user" ? "user" : "role"), null,
            h("div.msg-main", null, h("header.msg-head", null, meta), h("div.msg-bubble", null, content),
              item.truncated ? h("p.feed-note", null, t("conversation.truncated")) : null));
        if (previous) {
          if (item.kind === "activity") node.open = previous.node.open;
          const oldProse = previous.node.querySelectorAll(".prose-block");
          node.querySelectorAll(".prose-block").forEach(function (prose, index) {
            if (oldProse[index] && !oldProse[index].classList.contains("is-collapsed")
              && prose.classList.contains("is-collapsed")) prose.querySelector("button.link-btn")?.click();
          });
        }
      }
      updated.set(key, { signature: signature, node: node }); nodes.push(node);
    });
    rendered = updated;
    if (!nodes.length) nodes.push(h("p.feed-note", null, t("conversation.empty")));
    if (feed.children.length !== nodes.length || nodes.some(function (n, i) { return feed.children[i] !== n; })) {
      feed.replaceChildren(...nodes);
    }
  }
  function drawSessions(rows, append) {
    if (!append) clear(select);
    rows.forEach(function (s) {
      if ([...select.options].some(function (o) { return o.value === s.nativeSessionId; })) return;
      select.append(h("option", { value: s.nativeSessionId },
        (s.current ? t("conversation.current") : t("conversation.previous")) + " · " + s.executionAuthority + " · " + s.nativeSessionId));
    });
    select.value = selected || "";
    moreSessions.hidden = !facts.nextOffset;
  }
  async function refresh() {
    if (!owner || busy || host.hidden || host.closest("[hidden]") || document.hidden) return;
    busy = true; controls();
    let own = generation;
    try {
      const result = await requestJson(url());
      if (own !== generation) return;
      const previous = facts;
      facts = result;
      if (previous && previous.total === facts.total) facts.nextOffset = previous.nextOffset;
      // Previously discovered old Sessions remain view metadata, not current
      // authority. Refresh current flags from the newest canonical selection.
      if (previous) previous.sessions.forEach(function (s) {
        if (!facts.sessions.some(function (n) { return n.nativeSessionId === s.nativeSessionId; })) {
          facts.sessions.push({ ...s, current: s.nativeSessionId === facts.currentSessionId });
        }
      });
      if (!selected) {
        choose(facts.currentSessionId);
        own = generation;
      }
      if (!selected) { status.textContent = t("conversation.noSession"); return; }
      // Preserve a historical choice even if it is outside the newest page.
      drawSessions(facts.sessions, false);
      const page = await requestJson(url({ session: selected, cursor: cursor }));
      if (own !== generation) return;
      historyOk = true; next = page.nextCursor;
      const turn = selected === facts.currentSessionId ? facts.turn : null;
      let state = page.status === "waiting-user" ? "waiting" : page.status === "active" ? "active"
        : page.status === "systemError" ? "failed" : page.status === "idle" ? "waiting" : "unknown";
      const session = facts.sessions.find(function (s) { return s.nativeSessionId === selected; });
      if (session && session.status === "ended") state = session.endReason === "failed" ? "failed" : "ended";
      if (turn && turn.status === "delivery-unknown") state = "unknown";
      status.textContent = t("conversation." + state) + " · " + page.observedAt;
      if (page.live === "unavailable" && !cursor) status.textContent += " · " + t("conversation.liveUnavailable");
      if (page.linkedInputsOmitted) status.textContent += " · " + t("conversation.linkedOmitted");
      identity.textContent = (owner.taskId || "Global") + " / " + owner.roleName + " / " + selected
        + (turn ? " / " + (turn.nativeTurnId || turn.attemptId) + (turn.runId ? " / " + turn.runId : "") : "");
      const scroll = feed.scrollTop, atEnd = feed.scrollHeight - feed.clientHeight - scroll < 40;
      renderItems(page.items);
      feed.scrollTop = atEnd ? feed.scrollHeight : scroll;
    } catch (error) {
      if (own === generation) { historyOk = false; status.textContent = t("conversation.disconnected") + " · " + error.message; }
    } finally { finish(own); }
  }
  async function inspectReceipt() {
    if (!pending || busy) return;
    const own = generation;
    busy = true; controls();
    try {
      const result = await requestJson(url({ requestId: pending.requestId }));
      if (own !== generation) return;
      receipt.textContent = JSON.stringify(result);
      if (["accepted", "failed"].includes(result.state)) {
        const submitted = pending;
        pending = null; saved(".pending", null);
        if (result.state === "accepted" && submitted.action !== "interrupt" && text.value === submitted.body) {
          text.value = ""; saved(".draft", null);
        }
      }
    } catch (error) { if (own === generation) receipt.textContent = t("conversation.unknown") + " " + error.message; }
    finally { finish(own); }
  }
  async function submit(interrupt) {
    if (busy || pending || (interrupt ? stop.disabled : send.disabled)) return;
    if (!interrupt && !text.value.trim()) return;
    const turn = facts.turn;
    const action = interrupt ? "interrupt" : turn && turn.status === "accepted" ? "steer" : "queue";
    const payload = { action: action, requestId: crypto.randomUUID() };
    if (!interrupt) payload.body = text.value;
    if (action !== "queue") payload.expectedTarget = turn.nativeTurnId || turn.attemptId;
    pending = { requestId: payload.requestId, action: action, body: payload.body };
    saved(".pending", JSON.stringify(pending)); saved(".draft", text.value);
    const own = generation, endpoint = url({ session: selected });
    busy = true; controls();
    try {
      const result = await submitMutation(endpoint + "/" + payload.requestId, endpoint, payload);
      if (own !== generation) return;
      receipt.textContent = JSON.stringify(result);
      // Saved/queued is not accepted. Only an exact receipt lookup settles it.
    } catch (error) {
      if (own !== generation) return;
      receipt.textContent = t("conversation.unknown") + " " + error.message;
      if (error.disposition === "not-submitted") { pending = null; saved(".pending", null); }
    } finally { finish(own); }
    if (own === generation) await inspectReceipt();
  }
  text.addEventListener("input", function () { if (selected) saved(".draft", text.value); });
  select.addEventListener("change", function () { choose(select.value); refresh(); });
  current.addEventListener("click", function () { if (facts) { choose(facts.currentSessionId); refresh(); } });
  older.addEventListener("click", function () { cursor = next; refresh(); });
  latest.addEventListener("click", function () { cursor = null; refresh(); });
  send.addEventListener("click", function () { submit(false); });
  stop.addEventListener("click", function () { submit(true); });
  check.addEventListener("click", inspectReceipt);
  moreSessions.addEventListener("click", async function () {
    if (busy || !facts.nextOffset) return;
    const own = generation;
    busy = true;
    try {
      const page = await requestJson(url({ offset: facts.nextOffset }));
      if (own !== generation) return;
      facts.sessions = facts.sessions.concat(page.sessions); facts.nextOffset = page.nextOffset;
      drawSessions(page.sessions, true);
    } catch (error) { status.textContent = error.message; }
    finally { finish(own); }
  });
  controls();
  return {
    current: function () { return owner; },
    reconnect: function () {
      if (!timer) timer = window.setInterval(function () { if (!cursor) refresh(); }, 2000);
      refresh();
    },
    open: function (target) {
      if (JSON.stringify(target) !== JSON.stringify(owner)) {
        if (selected) saved(".draft", text.value);
        generation++; owner = target; selected = null; facts = null; pending = null; clear(select); clear(feed);
        cursor = null; next = null; historyOk = false; rendered.clear();
        text.value = ""; receipt.textContent = ""; identity.textContent = ""; controls();
      }
      if (!timer) timer = window.setInterval(function () { if (!cursor) refresh(); }, 2000);
      refresh();
    },
    close: function () { if (timer) window.clearInterval(timer); timer = null; generation++; }
  };
}
`;
