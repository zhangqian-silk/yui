export const CONVERSATION_SCRIPT = String.raw`
import { h, clear, icon } from "/assets/js/lib/dom.js";
import { api, releaseMutation, requestJson, submitMutation } from "/assets/js/lib/api.js";
import { richText } from "/assets/js/ui/text.js";
import { readSessionAccessMode, writeSessionAccessMode } from "/assets/js/lib/prefs.js";
import { inputCard } from "/assets/js/domain/work.js";

export function createConversationController(host, t, locale = function () { return "en"; }) {
  let owner = null, selected = null, facts = null, next = null, latestItems = [], olderItems = [];
  let generation = 0, busy = false, timer = null, pending = null, historyOk = false;
  let recoveryUnavailable = false;
  let rendered = new Map();
  let materials = [], incomingMaterials = null;
  let requestSignature = "";
  let modelPending = null, modelCatalog = null, lastModelObservation = null;
  const requests = h("div.cv-requests");
  const questions = h("div.cv-requests");
  let questionSignature = "";
  let confirmedModel = null, modelRowMap = new Map();
  const defaultMode = h("select", { "aria-label": t("conversation.defaultMode") },
    h("option", { value: "structured" }, t("conversation.title")),
    h("option", { value: "native" }, t("dock.session")));
  defaultMode.value = readSessionAccessMode();
  defaultMode.addEventListener("change", function () {
    const saved = writeSessionAccessMode(defaultMode.value);
    receipt.textContent = t(saved ? "conversation.defaultSaved" : "settings.storageFailed");
    defaultMode.value = readSessionAccessMode();
  });
  const select = h("select.cv-session", { "aria-label": t("conversation.sessions") });
  const status = h("p.cv-status", { role: "status" });
  const identity = h("p.cv-identity");
  const feed = h("div.feed", { tabIndex: 0, "aria-label": t("conversation.history") });
  const text = h("textarea.cv-input", { rows: 2, placeholder: t("conversation.placeholder"), "aria-label": t("conversation.input"), maxLength: 12000 });
  const receipt = h("p.cv-note", { role: "status" });
  const draftStatus = h("p.cv-note", { role: "status" });
  const receiptDetail = h("pre.cv-code");
  const modelStatus = h("p.cv-note", { role: "status" });
  const modelResult = h("p.cv-note", { role: "status" });
  const modelSelect = h("select", { "aria-label": t("conversation.model"), hidden: true });
  const modelRows = h("div.cv-options", { role: "listbox", "aria-label": t("conversation.selectModel") });
  const modelLabel = h("span.cv-model-label", null, t("conversation.model"));
  const modelLoad = h("button.cv-link", { type: "button" }, t("conversation.modelsLoad"));
  const modelApply = h("button.btn.btn-primary", { type: "button" }, t("conversation.modelApply"));
  const modelMenu = h("details.cv-pop.cv-model", null,
    h("summary.cv-pill", null, modelLabel, icon("down")),
    h("div.cv-popbody", null, h("p.cv-pop-title", null, t("conversation.selectModel")),
      modelRows, modelSelect, modelStatus, modelResult,
      h("div.cv-pop-actions", null, modelLoad, modelApply),
      h("p.cv-note", null, t("conversation.modelBoundary"))));
  const slash = h("div.conversation-slash", { "aria-label": t("conversation.commands") });
  const literal = h("button.cv-link", { type: "button", hidden: true }, t("conversation.literal"));
  const send = h("button.cv-send", { type: "button", "aria-label": t("conversation.send"), title: t("conversation.send") }, icon("up"));
  const stop = h("button.cv-stop", { type: "button", hidden: true, "aria-label": t("conversation.stop"), title: t("conversation.stop") }, icon("stop"));
  const check = h("button.cv-link", { type: "button", hidden: true }, t("conversation.receipt"));
  const older = h("button.cv-link", { type: "button", hidden: true }, t("conversation.older"));
  const latest = h("button.cv-jump", { type: "button", hidden: true, "aria-label": t("conversation.jump"), title: t("conversation.latest") }, icon("down"));
  const current = h("button.cv-link", { type: "button", hidden: true }, t("conversation.current"));
  const moreSessions = h("button.cv-link", { type: "button", hidden: true }, t("conversation.moreSessions"));
  const writerChip = h("span.cv-chip.tone-warn", { hidden: true }, icon("alert"), h("span", null, t("conversation.terminalWriter")));
  const file = h("input", { type: "file", "aria-label": t("materials.attach") });
  const materialList = h("div.row-stack");
  const materialAlert = h("p.cv-note", { role: "alert" });
  const attachMenu = h("details.cv-pop.cv-attach", null,
    h("summary.cv-iconbtn", { "aria-label": t("materials.attach"), title: t("materials.attach") }, icon("plus")),
    h("div.cv-popbody", null, h("p.cv-pop-title", null, t("materials.attach")), file,
      h("p.cv-note", null, t("materials.boundary"))));
  const menu = h("details.cv-pop.cv-menu", null,
    h("summary.cv-iconbtn", { "aria-label": t("conversation.more"), title: t("conversation.more") }, icon("dots")),
    h("div.cv-popbody", null,
      h("label.cv-field", null, h("span", null, t("conversation.defaultMode")), defaultMode),
      moreSessions, identity,
      h("details.cv-sub", null, h("summary", null, t("conversation.receiptDetails")), receiptDetail),
      h("p.cv-note", null, t("conversation.boundary"))));
  const pops = [menu, attachMenu, modelMenu];
  pops.forEach(function (pop) {
    pop.addEventListener("toggle", function () {
      if (!pop.open) return;
      pops.forEach(function (other) { if (other !== pop) other.open = false; });
      if (pop === modelMenu && !modelCatalog && !modelLoad.disabled) loadModels();
    });
  });
  host.addEventListener("click", function (event) {
    pops.forEach(function (pop) { if (pop.open && !pop.contains(event.target)) pop.open = false; });
  });
  host.addEventListener("keydown", function (event) {
    if (event.key === "Escape") pops.forEach(function (pop) { pop.open = false; });
  });
  feed.addEventListener("scroll", function () {
    syncJump();
    // Reaching the top loads the next older page in place; the view keeps its position.
    if (feed.scrollTop < 120 && next && historyOk && !busy) refresh(true);
  });
  host.append(
    h("div.cv-head", null, h("div.cv-picker", null, select, current), menu), status,
    h("div.cv-older", null, older),
    h("div.cv-stage", null, feed, latest),
    questions, requests,
    h("div.cv-composer", null, slash,
      h("div.cv-box", null, materialList, materialAlert, text,
        h("div.cv-tools", null, attachMenu, writerChip, h("span.spacer"), modelMenu, stop, send)),
      h("div.cv-hint", null, draftStatus, literal, check, receipt)));

  function key() { return "yui.conversation." + JSON.stringify(owner) + "." + selected; }
  function saved(suffix, value, expectedRequestId) {
    try {
      if (suffix === ".pending") {
        const shared = localStorage.getItem(key() + suffix);
        const identity = shared ? JSON.parse(shared) : null;
        const tab = sessionStorage.getItem(key() + suffix);
        recoveryUnavailable = false;
        if (value === undefined) {
          // Share only the unresolved identity, never another tab's draft.
          return identity && (!tab || JSON.parse(tab).requestId !== identity.requestId) ? shared : tab;
        }
        if (value === null) {
          if (!identity || identity.requestId === expectedRequestId) localStorage.removeItem(key() + suffix);
        } else {
          const record = JSON.parse(value);
          localStorage.setItem(key() + suffix, JSON.stringify({ requestId: record.requestId, action: record.action }));
        }
      }
      if (value === undefined) return sessionStorage.getItem(key() + suffix);
      if (value === null) sessionStorage.removeItem(key() + suffix);
      else sessionStorage.setItem(key() + suffix, value);
    } catch {
      if (suffix === ".pending") recoveryUnavailable = true;
      draftStatus.textContent = t("conversation.storageFailed");
    }
    return null;
  }
  function url(extra) {
    const q = new URLSearchParams({ scope: owner.scope, role: owner.roleName });
    if (owner.scope === "task") q.set("task", owner.taskId);
    Object.entries(extra || {}).forEach(function (entry) { if (entry[1] != null) q.set(entry[0], String(entry[1])); });
    return "/api/conversation?" + q;
  }
  function syncJump() {
    latest.hidden = !((selected && !historyOk) || feed.scrollHeight - feed.clientHeight - feed.scrollTop > 80);
  }
  function controls() {
    if (owner && selected) {
      try { pending = JSON.parse(saved(".pending") || "null"); }
      catch { recoveryUnavailable = true; }
    }
    defaultMode.value = readSessionAccessMode();
    const active = facts && facts.sessions.find(function (s) { return s.nativeSessionId === selected; });
    const writable = historyOk && active && active.current && active.status === "active" && active.adapterId === "codex"
      && facts.authority && facts.authority.owner === "controller" && !facts.terminalWriter;
    const turn = facts && facts.turn;
    send.disabled = busy || recoveryUnavailable || !!pending || !!modelPending || !writable || (turn && ["submitting", "delivery-unknown"].includes(turn.status));
    stop.disabled = busy || recoveryUnavailable || !!pending || !writable || !turn || turn.status !== "accepted" || !turn.nativeTurnId;
    check.disabled = busy || !pending;
    older.disabled = busy || !next;
    older.hidden = !next;
    check.hidden = !pending;
    stop.hidden = !turn || turn.status !== "accepted";
    current.hidden = !facts || !selected || selected === facts.currentSessionId;
    writerChip.hidden = !(facts && facts.terminalWriter);
    literal.disabled = send.disabled;
    syncJump();
    modelLoad.disabled = busy || !active || active.adapterId !== "codex";
    modelApply.disabled = busy || !!pending || !!modelPending || !writable || !modelSelect.value
      || !modelCatalog || modelCatalog.source === "fallback" || !!modelCatalog.failure
      || turn && ["submitting", "accepted", "delivery-unknown"].includes(turn.status);
    attachMenu.hidden = !owner || owner.scope !== "task";
    file.disabled = busy || !!pending || !writable || materials.length >= 8;
    materialList.querySelectorAll("button").forEach(function (control) { control.disabled = busy || !!pending; });
  }
  function showReceipt(result) {
    const refused = result.interrupt && result.interrupt.state === "not-interrupted";
    const state = refused ? result.interrupt.code === "DELIVERY_UNKNOWN" ? "unknown" : "failed" : result.state || "submitted";
    receipt.textContent = t("conversation.receipt." + state)
      + (refused ? " · " + result.interrupt.code : "")
      + (result.messageId ? " · " + result.messageId : "")
      + (result.notDelivered ? " · " + (typeof result.notDelivered === "string" ? result.notDelivered : JSON.stringify(result.notDelivered)) : "");
    receiptDetail.textContent = JSON.stringify(result, null, 2);
  }
  function showModel(observation) {
    const axis = observation && observation.status === "observed"
      && observation.axes.find(function (a) { return a.key === "model"; });
    const value = axis && axis.current.status === "observed" ? axis.current.value : null;
    const session = facts && facts.sessions.find(function (s) { return s.nativeSessionId === selected; });
    confirmedModel = value;
    modelLabel.textContent = value || (session && session.launchModel) || t("conversation.model");
    modelStatus.textContent = t("conversation.launchModel") + ": " + (session && session.launchModel || "—")
      + " · " + t("conversation.confirmedModel") + ": " + (value || t("conversation.unknown"))
      + (value ? " · " + observation.observedAt : "");
    if (modelPending) {
      if (value === modelPending.model && observation.observedAt !== modelPending.previousObservation) {
        modelPending = null; saved(".modelPending", null);
        releaseMutation(url({ session: selected }).replace("/api/conversation?", "/api/conversation/model?"));
      } else modelStatus.textContent += " · " + t("conversation.modelUnknown");
    }
    lastModelObservation = value ? observation.observedAt : null;
  }
  function pickModel(value) {
    modelSelect.value = value;
    modelRowMap.forEach(function (row, key) {
      row.className = "cv-option" + (key === value ? " is-selected" : "");
      row.ariaSelected = key === value ? "true" : "false";
    });
    controls();
  }
  async function loadModels() {
    if (modelLoad.disabled) return;
    const own = generation;
    busy = true; controls();
    try {
      const result = await requestJson(url({ session: selected }).replace("/api/conversation?", "/api/conversation/model?"));
      if (own !== generation) return;
      modelCatalog = result; clear(modelSelect); clear(modelRows); modelRowMap = new Map();
      (result.catalog.models || []).forEach(function (m) {
        modelSelect.append(h("option", { value: m.value }, m.label + " · " + m.value));
        const row = h("button.cv-option", { type: "button", role: "option" },
          h("span.cv-option-name", null, m.label), h("span.cv-option-id", null, m.value), icon("check"));
        row.addEventListener("click", function () { pickModel(m.value); });
        modelRowMap.set(m.value, row); modelRows.append(row);
      });
      pickModel(modelRowMap.has(confirmedModel) ? confirmedModel : "");
      modelResult.textContent = result.source + " · " + (result.fetchedAt || result.attemptedAt)
        + (result.failure ? " · " + result.failure.message : "");
    } catch (error) { if (own === generation) modelResult.textContent = error.message; }
    finally { finish(own); }
  }
  async function applyModel() {
    if (modelApply.disabled) return;
    const own = generation;
    const endpoint = url({ session: selected }).replace("/api/conversation?", "/api/conversation/model?");
    modelPending = { model: modelSelect.value, previousObservation: lastModelObservation };
    saved(".modelPending", JSON.stringify(modelPending));
    busy = true; controls();
    modelResult.textContent = t("conversation.modelApplying");
    try {
      const result = await submitMutation(endpoint, endpoint, { model: modelPending.model });
      if (own !== generation) return;
      modelPending = null; saved(".modelPending", null);
      showModel(result.runConfiguration);
      modelResult.textContent = t("conversation.modelConfirmed");
    } catch (error) {
      if (own !== generation) return;
      modelResult.textContent = error.message + " · " + t(error.disposition === "not-submitted" ? "conversation.modelFailed" : "conversation.modelUnknown");
      if (error.disposition === "not-submitted") { modelPending = null; saved(".modelPending", null); }
    } finally { finish(own); }
  }
  const commands = ["help", "status", "model", "stop", "latest"];
  function drawCommands() {
    clear(slash);
    const value = text.value.trim();
    literal.hidden = !value.startsWith("/");
    if (!value.startsWith("/") || /\s/.test(value)) return;
    commands.filter(function (name) { return ("/" + name).startsWith(value); }).forEach(function (name) {
      const button = h("button.cv-cmd", { type: "button" }, "/" + name + " · " + t("conversation.command." + name));
      button.addEventListener("click", function () {
        text.value = "/" + name; saved(".draft", text.value); drawCommands(); text.focus?.();
      });
      slash.append(button);
    });
  }
  function runCommand() {
    const name = text.value.trim().slice(1);
    if (!commands.includes(name)) { receipt.textContent = t("conversation.commandUnknown"); return; }
    if (name === "stop") {
      if (stop.disabled) receipt.textContent = t("conversation.stopUnavailable");
      else submit(true);
      return;
    }
    if (name === "model") { modelMenu.open = true; loadModels(); }
    else if (name === "status") refresh();
    else if (name === "latest") refresh();
    receipt.textContent = name === "help" ? t("conversation.commandHelp") : t("conversation.command." + name);
    text.value = ""; saved(".draft", null); drawCommands();
  }
  function saveMaterials() { saved(".materials", JSON.stringify(materials)); }
  function drawMaterials() {
    clear(materialList);
    materials.forEach(function (ref, index) {
      const remove = h("button.cv-x", { type: "button", "aria-label": t("materials.remove"), title: t("materials.remove") }, icon("close"));
      remove.disabled = busy || !!pending;
      remove.addEventListener("click", function () { materials.splice(index, 1); saveMaterials(); drawMaterials(); controls(); });
      materialList.append(h("div.cv-file", null, h("span.small", null,
        ref.relativePath + " · " + ref.commit + " · sha256:" + ref.digest), remove));
    });
  }
  function renderRequests(rows) {
    const signature = JSON.stringify([selected, rows, !!facts.terminalWriter]);
    if (signature === requestSignature) return;
    requestSignature = signature; clear(requests);
    rows.forEach(function (request) {
      const card = h("section.cv-card", null, h("h3.cv-card-title", null, t("conversation.nativeRequest")),
        h("p.cv-note", null, request.method + " · " + request.turnId));
      const params = request.params, answers = {};
      const pendingKey = ".nativePending." + request.turnId + "." + request.id;
      if (request.method === "item/tool/requestUserInput") {
        (params.questions || []).forEach(function (question) {
          const field = h("input", { type: question.isSecret ? "password" : "text", "aria-label": question.question });
          const draftKey = ".nativeDraft." + request.turnId + "." + request.id + "." + question.id;
          if (!question.isSecret) {
            field.value = saved(draftKey) || "";
            field.addEventListener("input", function () { saved(draftKey, field.value); });
          }
          card.append(h("label", null, question.question, field));
          if (question.options) card.append(h("p.cv-note", null, question.options.map(function (o) { return o.label + ": " + o.description; }).join(" · ")));
          answers[question.id] = field;
        });
      } else {
        card.append(h("p", null, params.reason || params.command || t("conversation.nativeApproval")));
      }
      const outcome = h("p.cv-note", { role: "status" });
      const buttons = [];
      function button(label, result) {
        const node = h("button.btn", { type: "button", disabled: !!facts.terminalWriter || !!saved(pendingKey) }, label);
        buttons.push(node);
        node.addEventListener("click", async function () {
          const own = generation;
          buttons.forEach(function (b) { b.disabled = true; });
          saved(pendingKey, "pending");
          // An answer is sent once. Unknown transport state is inspected by the
          // next read, never retried automatically under a new request id.
          try {
            const endpoint = url({ session: selected });
            await submitMutation(endpoint + "/native/" + request.id, endpoint, {
              action: "native-respond", requestId: crypto.randomUUID(), nativeRequestId: request.id,
              expectedTarget: request.turnId, result: result()
            });
            outcome.textContent = t("conversation.nativeAnswered");
          } catch (error) {
            if (own !== generation) return;
            outcome.textContent = t("conversation.unknown") + " " + error.message;
            if (error.disposition === "not-submitted") {
              saved(pendingKey, null); buttons.forEach(function (b) { b.disabled = !!facts.terminalWriter; });
            }
          }
        });
        card.append(node);
      }
      if (request.method === "item/tool/requestUserInput") button(t("conversation.send"), function () {
        return { answers: Object.fromEntries(Object.entries(answers).map(function (entry) { return [entry[0], { answers: [entry[1].value] }]; })) };
      });
      else if (request.method === "item/permissions/requestApproval") button(t("conversation.decline"), function () { return { permissions: {}, scope: "turn" }; });
      else if (request.method === "mcpServer/elicitation/request") {
        card.append(h("p.cv-note", null, request.params.message || ""));
        card.append(h("p.cv-note", null, t("conversation.nativeForm")));
        button(t("conversation.decline"), function () { return { action: "decline", content: null }; });
      }
      else {
        button(t("conversation.approve"), function () { return { decision: "accept" }; });
        button(t("conversation.decline"), function () { return { decision: "decline" }; });
      }
      card.append(outcome); requests.append(card);
    });
  }
  function renderQuestions() {
    const rows = selected === facts.currentSessionId ? facts.leaderQuestions || [] : [];
    const signature = JSON.stringify([owner, rows, facts.questionsOmitted]);
    if (signature === questionSignature) return;
    questionSignature = signature; clear(questions);
    const taskId = owner.taskId;
    if (rows.length) questions.append(h("h3.cv-card-title", null, t("conversation.leaderQuestions")));
    rows.forEach(function (input) {
      questions.append(inputCard(input, t, locale(), async function (original, answer, control) {
        const own = generation;
        control.disabled = true;
        try {
          await api.answerInput(taskId, original.id, answer);
          releaseMutation(taskId + "/input/" + original.id);
          if (own !== generation) return;
          receipt.textContent = t("input.answered");
          refresh();
        } catch (error) {
          if (own !== generation) return;
          control.disabled = error.disposition !== "not-submitted";
          receipt.textContent = error.disposition === "not-submitted" ? error.message : t("input.unknown");
        }
      }));
    });
    if (facts.questionsOmitted) questions.append(h("p.cv-note", null, t("overview.moreInputs")));
  }
  function choose(id) {
    if (selected) saved(".draft", text.value);
    generation++; selected = id; next = null; latestItems = []; olderItems = []; historyOk = false;
    text.value = saved(".draft") || "";
    try { pending = JSON.parse(saved(".pending") || "null"); } catch { pending = null; }
    try { materials = JSON.parse(saved(".materials") || "[]"); } catch { materials = []; }
    try { modelPending = JSON.parse(saved(".modelPending") || "null"); } catch { modelPending = null; }
    modelCatalog = null; lastModelObservation = null; clear(modelSelect); clear(modelRows); modelRowMap = new Map(); confirmedModel = null;
    modelLabel.textContent = t("conversation.model"); modelStatus.textContent = ""; modelResult.textContent = ""; receiptDetail.textContent = "";
    drawCommands();
    materialAlert.textContent = "";
    if (incomingMaterials) {
      const combined = materials.concat(incomingMaterials).filter(function (ref, index, all) {
        return all.findIndex(function (other) { return other.commit === ref.commit && other.relativePath === ref.relativePath; }) === index;
      });
      if (combined.length > 8) materialAlert.textContent = t("materials.capacity");
      else { materials = combined; saveMaterials(); }
      incomingMaterials = null;
    }
    drawMaterials();
    receipt.textContent = pending ? t("conversation.unknown") + " " + pending.requestId : "";
    clear(feed); rendered.clear();
    clear(requests); requestSignature = "";
    clear(questions); questionSignature = "";
    controls();
  }
  function finish(own) {
    busy = false; controls();
    // A read for the old owner may have prevented the new selection's read.
    // Only refresh view state; never repeat a mutation or receipt submission.
    if (own !== generation && timer !== null) refresh();
  }
  const GLYPHS = { commandExecution: "terminal", fileChange: "file", webSearch: "search", collabAgentToolCall: "user" };
  function itemKey(item) { return JSON.stringify([item.turnId, item.id]); }
  function itemMeta(item) {
    return (item.source === "yui-input" ? t("conversation.linkedInput") + " " + item.messageId : item.kind)
      + " · " + item.turnId + (item.status ? " · " + item.status : "");
  }
  function activityRow(item) {
    const parts = item.text.split(" · ");
    return h("details.cv-activity", { title: itemMeta(item) },
      h("summary", null, icon(GLYPHS[parts[0]] || "sparkle"), h("span.cv-act-label", null, t("conversation.activity." + parts[0], parts[0])),
        h("span.cv-act-detail", null, parts.slice(1).join(" · "))),
      h("pre.cv-code", null, item.text));
  }
  // Everything a turn did before its final reply (commentary and tool calls)
  // folds into one collapsed line, like the Codex app's "Worked" row.
  function processGroup(group) {
    const counts = new Map();
    group.forEach(function (item) {
      const kind = item.kind === "activity" ? item.text.split(" · ")[0] : "message";
      counts.set(kind, (counts.get(kind) || 0) + 1);
    });
    const parts = [...counts].filter(function (entry) { return entry[0] !== "message"; }).map(function (entry) {
      return t("conversation.activity." + entry[0], entry[0]) + (entry[1] > 1 ? " ×" + entry[1] : "");
    });
    const label = t("conversation.worked") + (parts.length ? " · " + parts.join(" · ") : "");
    return h("details.cv-activity.cv-group", { title: group.length + " · " + itemMeta(group[0]) },
      h("summary", null, h("span.cv-act-label", null, label), icon("down", "cv-chevron")),
      h("div.cv-group-body", null, ...group.map(function (item) {
        return item.kind === "activity" ? activityRow(item) : h("div.cv-step", null, richText(null, item.text, t, { threshold: 1800 }));
      })));
  }
  function messageNode(item) {
    const meta = itemMeta(item);
    if (item.kind === "user") {
      return h("article.cv-msg.cv-user", { title: meta },
        item.source === "yui-input" ? h("span.cv-tag", null, t("conversation.linkedInput") + " " + item.messageId) : null,
        h("div.cv-bubble", null, richText(null, item.text, t, { threshold: 1800 })),
        item.truncated ? h("p.cv-note", null, t("conversation.truncated")) : null);
    }
    const copy = h("button.cv-iconbtn", { type: "button", "aria-label": t("conversation.copy"), title: t("conversation.copy") }, icon("copy"));
    copy.addEventListener("click", function () {
      navigator.clipboard.writeText(item.text).then(function () { copy.title = t("conversation.copied"); });
    });
    return h("article.cv-msg.cv-assistant", { title: meta },
      richText(null, item.text, t, { threshold: 1800 }),
      item.truncated ? h("p.cv-note", null, t("conversation.truncated")) : null,
      h("div.cv-actions", null, copy));
  }
  function allItems() {
    const seen = new Set();
    return latestItems.concat(olderItems).filter(function (item) {
      const k = itemKey(item);
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }
  function renderItems(items) {
    const nodes = [], updated = new Map();
    function place(key, signature, make, keepOpen) {
      const previous = rendered.get(key);
      let node = previous && previous.signature === signature ? previous.node : null;
      if (!node) {
        node = make();
        if (previous) {
          if (keepOpen) node.open = previous.node.open;
          const oldProse = previous.node.querySelectorAll(".prose-block");
          node.querySelectorAll(".prose-block").forEach(function (prose, index) {
            if (oldProse[index] && !oldProse[index].classList.contains("is-collapsed")
              && prose.classList.contains("is-collapsed")) prose.querySelector("button.link-btn")?.click();
          });
        }
      }
      updated.set(key, { signature: signature, node: node }); nodes.push(node);
    }
    const chronological = items.slice().reverse();
    let index = 0;
    while (index < chronological.length) {
      let end = index;
      while (end < chronological.length && chronological[end].turnId === chronological[index].turnId) end++;
      const segment = chronological.slice(index, end);
      index = end;
      const last = segment[segment.length - 1];
      const final = last.kind === "assistant" ? last : null;
      const process = segment.filter(function (item) { return item.kind !== "user" && item !== final; });
      let emitted = false;
      segment.forEach(function (item) {
        if (item.kind === "user" || item === final) {
          place(itemKey(item), JSON.stringify(item), function () { return messageNode(item); }, false);
        } else if (!emitted) {
          emitted = true;
          if (process.length === 1 && process[0].kind === "activity") {
            place(itemKey(process[0]), JSON.stringify(process[0]), function () { return activityRow(process[0]); }, true);
          } else {
            place("turn:" + segment[0].turnId, JSON.stringify(process), function () { return processGroup(process); }, true);
          }
        }
      });
    }
    rendered = updated;
    if (!nodes.length) nodes.push(h("p.cv-note", null, t("conversation.empty")));
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
  async function refresh(older) {
    if (!owner || busy || host.hidden || host.closest("[hidden]") || document.hidden) return;
    if (older && (!next || !selected || !facts || !historyOk)) return;
    busy = true; controls();
    let own = generation;
    try {
      if (older) {
        const earlier = await requestJson(url({ session: selected, cursor: next }));
        if (own !== generation) return;
        olderItems = olderItems.concat(earlier.items); next = earlier.nextCursor;
        const before = feed.scrollHeight, top = feed.scrollTop;
        renderItems(allItems());
        feed.scrollTop = top + (feed.scrollHeight - before);
        syncJump();
        return;
      }
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
      renderQuestions();
      const page = await requestJson(url({ session: selected }));
      if (own !== generation) return;
      historyOk = true; latestItems = page.items;
      if (!olderItems.length) next = page.nextCursor;
      const turn = selected === facts.currentSessionId ? facts.turn : null;
      let state = page.status === "waiting-user" ? "waiting" : page.status === "active" ? "active"
        : page.status === "systemError" ? "failed" : page.status === "idle" ? "waiting" : "unknown";
      const session = facts.sessions.find(function (s) { return s.nativeSessionId === selected; });
      if (session && session.status === "ended") state = session.endReason === "failed" ? "failed" : "ended";
      if (turn && turn.status === "delivery-unknown") state = "unknown";
      status.textContent = t("conversation." + state);
      status.title = page.observedAt + " · " + t(facts.terminalWriter ? "conversation.terminalWriter" : "conversation.structuredWriter");
      status.className = "cv-status is-" + state;
      if (page.live === "unavailable") status.textContent += " · " + t("conversation.liveUnavailable");
      if (page.linkedInputsOmitted) status.textContent += " · " + t("conversation.linkedOmitted");
      if (page.nativeRequestsOmitted) status.textContent += " · " + t("conversation.nativeOmitted");
      renderRequests(page.nativeRequests || []);
      showModel(page.runConfiguration);
      identity.textContent = (owner.taskId || "Global") + " / " + owner.roleName + " / " + selected
        + (turn ? " / " + (turn.nativeTurnId || turn.attemptId) + (turn.runId ? " / " + turn.runId : "") : "");
      const scroll = feed.scrollTop, atEnd = feed.scrollHeight - feed.clientHeight - scroll < 40;
      renderItems(allItems());
      feed.scrollTop = atEnd ? feed.scrollHeight : scroll;
      syncJump();
    } catch (error) {
      if (own === generation) { historyOk = false; status.textContent = t("conversation.disconnected") + " · " + error.message; }
    } finally { finish(own); }
    if (own === generation && pending && historyOk) await inspectReceipt();
  }
  async function inspectReceipt() {
    if (!pending || busy) return;
    const own = generation;
    const inspected = pending;
    busy = true; controls();
    try {
      const result = await requestJson(url({ requestId: inspected.requestId }));
      if (own !== generation) return;
      showReceipt(result);
      if (["accepted", "failed"].includes(result.state)) {
        const submitted = inspected;
        pending = null; saved(".pending", null, submitted.requestId);
        if (result.state === "accepted" && submitted.action !== "interrupt" && text.value === submitted.body) {
          text.value = ""; saved(".draft", null);
          drawCommands();
          materials = materials.filter(function (ref) {
            return !(submitted.materials || []).some(function (sent) {
              return sent.commit === ref.commit && sent.relativePath === ref.relativePath;
            });
          });
          saveMaterials(); drawMaterials();
        }
      }
    } catch (error) { if (own === generation) receipt.textContent = t("conversation.unknown") + " " + error.message; }
    finally { finish(own); }
  }
  async function submit(interrupt, asLiteral) {
    controls(); // Another tab may have acquired an unresolved input since refresh.
    if (busy || pending || (interrupt ? stop.disabled : send.disabled)) return;
    if (!interrupt && !text.value.trim()) return;
    if (!interrupt && !asLiteral && text.value.trim().startsWith("/")) { runCommand(); return; }
    const turn = facts.turn;
    const action = interrupt ? "interrupt" : turn && turn.status === "accepted" ? "steer" : "queue";
    const payload = { action: action, requestId: crypto.randomUUID() };
    if (!interrupt) payload.body = text.value;
    if (!interrupt && materials.length) payload.materials = materials.map(function (ref) {
      return { taskId: ref.taskId, relativePath: ref.relativePath, commit: ref.commit, digest: ref.digest };
    });
    if (action !== "queue") payload.expectedTarget = turn.nativeTurnId || turn.attemptId;
    pending = { requestId: payload.requestId, action: action, body: payload.body, materials: payload.materials };
    saved(".pending", JSON.stringify(pending)); saved(".draft", text.value);
    if (recoveryUnavailable) { controls(); return; }
    const own = generation, endpoint = url({ session: selected });
    busy = true; controls();
    receipt.textContent = t("conversation.receipt.sending");
    try {
      const result = await submitMutation(endpoint + "/" + payload.requestId, endpoint, payload);
      if (own !== generation) return;
      showReceipt(result);
      if (action === "interrupt" && result.interrupt?.state === "not-interrupted"
        && ["NO_ACTIVE_TURN", "TARGET_CHANGED", "INTERRUPT_UNSUPPORTED"].includes(result.interrupt.code)) {
        // Preflight proved no native cancel was submitted, so no durable
        // interrupt receipt exists. DELIVERY_UNKNOWN must stay unresolved.
        pending = null; saved(".pending", null, payload.requestId);
      }
      // Saved/queued is not accepted. Only an exact receipt lookup settles it.
    } catch (error) {
      if (own !== generation) return;
      receipt.textContent = t(error.disposition === "not-submitted" ? "conversation.receipt.failed" : "conversation.unknown") + " " + error.message;
      if (error.disposition === "not-submitted") { pending = null; saved(".pending", null, payload.requestId); }
    } finally { finish(own); }
    if (own === generation) await inspectReceipt();
  }
  text.addEventListener("input", function () {
    if (selected) { draftStatus.textContent = t("conversation.draftSaved"); saved(".draft", text.value); }
    drawCommands();
  });
  text.addEventListener("keydown", function (event) {
    if (event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submit(false); }
    if (event.key === "Tab" && text.value.startsWith("/")) {
      const matches = commands.filter(function (name) { return ("/" + name).startsWith(text.value); });
      if (matches.length === 1) {
        event.preventDefault(); text.value = "/" + matches[0]; saved(".draft", text.value); drawCommands();
      }
    }
  });
  modelLoad.addEventListener("click", loadModels);
  modelSelect.addEventListener("change", controls);
  modelApply.addEventListener("click", applyModel);
  literal.addEventListener("click", function () { submit(false, true); });
  file.addEventListener("change", async function () {
    const chosen = file.files[0];
    if (!chosen || file.disabled) return;
    const own = generation;
    const endpoint = url({ session: selected }).replace("/api/conversation?", "/api/conversation/material?");
    const requestId = crypto.randomUUID();
    busy = true; controls();
    try {
      if (chosen.size > 256 * 1024) throw Object.assign(new Error(t("materials.tooLarge")), { disposition: "not-submitted" });
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await chosen.arrayBuffer());
      if (own !== generation) return;
      const ref = await submitMutation(endpoint + "/" + requestId, endpoint,
        { requestId: requestId, name: chosen.name, content: content });
      if (own !== generation) return;
      materials.push(ref); saveMaterials(); drawMaterials();
      receipt.textContent = t("materials.saved");
    } catch (error) {
      if (own === generation) receipt.textContent = error.message + " · " + t("materials.inspectUpload")
        + " materials/" + requestId + "/" + chosen.name;
    } finally { file.value = ""; finish(own); drawMaterials(); }
  });
  select.addEventListener("change", function () { choose(select.value); refresh(); });
  current.addEventListener("click", function () { if (facts) { choose(facts.currentSessionId); refresh(); } });
  older.addEventListener("click", function () { refresh(true); });
  latest.addEventListener("click", function () {
    refresh().then(function () { feed.scrollTop = feed.scrollHeight; syncJump(); });
  });
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
    captureDraftTarget: function () {
      controls();
      return send.disabled || timer === null || host.hidden || host.closest("[hidden]")
        ? null : JSON.stringify([owner, selected]);
    },
    insertReference: function (target, citation) {
      controls();
      if (!target || target !== JSON.stringify([owner, selected]) || send.disabled
        || timer === null || host.hidden || host.closest("[hidden]")) {
        throw new Error(t("bodySearch.targetChanged"));
      }
      const combined = text.value + (text.value ? "\n\n" : "") + citation;
      if (combined.length > text.maxLength) throw new Error(t("bodySearch.capacity"));
      text.value = combined;
      saved(".draft", text.value);
      drawCommands();
    },
    current: function () { return owner; },
    selection: function () {
      if (!owner || (selected && facts && selected !== facts.currentSessionId)) return null;
      return { ...owner, ...(selected ? { nativeSessionId: selected } : {}) };
    },
    reconnect: function () {
      if (!timer) timer = window.setInterval(function () { refresh(); }, 2000);
      refresh();
    },
    open: function (target, options) {
      // Explicit workbench continuation must resolve today's current Session
      // from the shared endpoint, not retain a historical selection or stale ID.
      if (JSON.stringify(target) !== JSON.stringify(owner) || options && options.current) {
        if (selected) saved(".draft", text.value);
        generation++; owner = target; selected = null; facts = null; pending = null; clear(select); clear(feed);
        next = null; latestItems = []; olderItems = []; historyOk = false; rendered.clear();
        text.value = ""; receipt.textContent = ""; identity.textContent = ""; controls();
        modelPending = null; modelCatalog = null; clear(modelSelect); clear(modelRows); modelRowMap = new Map(); confirmedModel = null;
        modelLabel.textContent = t("conversation.model"); modelStatus.textContent = "";
        modelResult.textContent = "";
        receiptDetail.textContent = ""; draftStatus.textContent = ""; drawCommands();
        materials = []; incomingMaterials = null; clear(materialList); materialAlert.textContent = "";
        clear(requests); requestSignature = "";
        clear(questions); questionSignature = "";
      }
      if (options && options.materials) incomingMaterials = options.materials;
      if (!timer) timer = window.setInterval(function () { refresh(); }, 2000);
      refresh();
    },
    close: function () { if (timer) window.clearInterval(timer); timer = null; generation++; }
  };
}
`;
