export const CONVERSATION_SCRIPT = String.raw`
import { h, clear, icon } from "/assets/js/lib/dom.js";
import { api, releaseMutation, requestJson, submitMutation } from "/assets/js/lib/api.js";
import { richText } from "/assets/js/ui/text.js";
import { formatDateTime, formatShort, fill } from "/assets/js/lib/format.js";
import { inputCard } from "/assets/js/domain/work.js";

// options.tools: a node placed in the header row (the session page's mode
// switch). options.onSelection(sessionId, currentSessionId) reports the chosen
// Session; currentSessionId is undefined until the owner's facts are read.
export function createConversationController(host, t, locale = function () { return "en"; }, options = {}) {
  let owner = null, selected = null, facts = null, next = null, latestItems = [], olderItems = [];
  let generation = 0, busy = false, timer = null, pending = null, historyOk = false;
  let recoveryUnavailable = false;
  // A background read (the poll) holds busy only to serialize requests. It
  // never disables controls, so an open picker or a typed draft does not grey
  // out every cycle; an action started meanwhile waits for the read to finish
  // and then revalidates instead of being dropped or racing it.
  let reading = false, readWaiters = [];
  let rendered = new Map();
  let materials = [], incomingMaterials = null;
  let requestSignature = "", sessionSignature = "", detailSignature = "";
  let modelPending = null, modelCatalog = null, lastModelObservation = null;
  // The selected Session's own native confirmation (or its stated absence).
  let modelObservation = null;
  let pageFacts = null;
  const requests = h("div.cv-requests");
  const questions = h("div.cv-requests");
  let questionSignature = "";
  // Native answer drafts typed in this view (discarded with it on a mode switch).
  const nativeDraftKeys = new Set();
  let confirmedModel = null, modelRowMap = new Map();
  // Who/which Session: one row. The picker lists current and previous Sessions
  // by readable name and time; exact identities live in the details menu.
  const pickerName = h("span.cv-picker-name", null, t("conversation.sessions"));
  const sessionList = h("div.cv-session-list", { role: "listbox", "aria-label": t("conversation.sessions") });
  const moreSessions = h("button.cv-link.cv-more-sessions", { type: "button", hidden: true }, t("conversation.moreSessions"));
  const picker = h("details.cv-pop.cv-picker", null,
    h("summary.cv-picker-btn", { "aria-label": t("conversation.sessions"), title: t("conversation.sessions") },
      pickerName, icon("down", "cv-picker-chevron")),
    h("div.cv-popbody", null, sessionList, moreSessions));
  const status = h("span.cv-status", { role: "status" });
  const detailFacts = h("dl.cv-facts");
  const identity = h("p.cv-identity");
  const copyIdentity = h("button.cv-link", { type: "button" }, icon("copy"), h("span", null, t("conversation.copyIdentity")));
  const liveNote = h("p.cv-note");
  const feed = h("div.feed", { tabIndex: 0, "aria-label": t("conversation.history") });
  const text = h("textarea.cv-input", { rows: 2, placeholder: t("conversation.placeholder"), "aria-label": t("conversation.input"), maxLength: 12000 });
  const receipt = h("p.cv-note", { role: "status" });
  const draftStatus = h("p.cv-note", { role: "status" });
  const receiptDetail = h("pre.cv-code");
  const receiptBlock = h("details.cv-sub", { hidden: true }, h("summary", null, t("conversation.receiptDetails")), receiptDetail);
  // Two facts only: what the Session last confirmed, and what is selected.
  // Their nodes are built once and updated in place on each poll.
  const modelFactNodes = [0, 1].map(function () {
    const value = h("span.cv-mf-value"), note = h("small.cv-mf-note");
    return { term: h("dt"), value: value, note: note, detail: h("dd", null, value, note) };
  });
  const modelFacts = h("dl.cv-facts.cv-model-facts", null,
    modelFactNodes[0].term, modelFactNodes[0].detail, modelFactNodes[1].term, modelFactNodes[1].detail);
  const modelStatus = h("p.cv-note", { role: "status" });
  const modelResult = h("p.cv-note", { role: "status" });
  const modelSelect = h("select", { "aria-label": t("conversation.model"), hidden: true });
  const modelRows = h("div.cv-options", { role: "listbox", "aria-label": t("conversation.selectModel") });
  // The pill names its state in words (not only the dot's colour) so the
  // source reads without hovering: last confirmed, applying, or unconfirmed.
  const modelState = h("span.cv-model-state");
  const modelLabel = h("span.cv-model-label", null, t("conversation.modelUnconfirmed"));
  const modelSummary = h("summary.cv-pill", { "aria-label": t("conversation.model"), title: t("conversation.model") },
    h("i.cv-model-dot", { "aria-hidden": "true" }), modelState, modelLabel, icon("down"));
  const modelLoad = h("button.cv-link", { type: "button", hidden: true }, t("conversation.modelsLoad"));
  const modelApply = h("button.btn.btn-primary.cv-apply", { type: "button" }, t("conversation.modelApply"));
  const modelMenu = h("details.cv-pop.cv-model", null, modelSummary,
    h("div.cv-popbody", null, modelFacts, modelRows, modelSelect,
      h("div.cv-pop-actions", null, h("div.cv-model-notes", null, modelStatus, modelResult), modelLoad, modelApply)));
  const slash = h("div.conversation-slash", { "aria-label": t("conversation.commands") });
  const literal = h("button.cv-link", { type: "button", hidden: true }, t("conversation.literal"));
  const send = h("button.cv-send", { type: "button", "aria-label": t("conversation.send"), title: t("conversation.sendHint") }, icon("up"));
  const stop = h("button.cv-stop", { type: "button", hidden: true, "aria-label": t("conversation.stop"), title: t("conversation.stop") }, icon("stop"));
  const check = h("button.cv-link", { type: "button", hidden: true }, t("conversation.receipt"));
  const older = h("button.cv-link.cv-older", { type: "button", hidden: true }, t("conversation.older"));
  const latest = h("button.cv-jump", { type: "button", hidden: true, "aria-label": t("conversation.jump"), title: t("conversation.latest") }, icon("down"));
  const current = h("button.cv-link.cv-back", { type: "button", hidden: true, title: t("conversation.backCurrent") }, icon("back"), h("span", null, t("conversation.backCurrentShort")));
  // Why input is unavailable, in one line above the composer, instead of a
  // silently disabled send button and stacked engineering notes.
  const noticeText = h("span");
  const noticeCurrent = h("button.cv-link", { type: "button", hidden: true }, t("conversation.backCurrent"));
  const notice = h("p.cv-notice", { role: "status", hidden: true }, icon("info"), noticeText, noticeCurrent);
  const file = h("input", { type: "file", "aria-label": t("materials.attach") });
  const materialList = h("div.row-stack");
  const materialAlert = h("p.cv-note", { role: "alert" });
  const attachMenu = h("details.cv-pop.cv-attach", null,
    h("summary.cv-iconbtn", { "aria-label": t("materials.attach"), title: t("materials.attach") }, icon("plus")),
    h("div.cv-popbody", null, h("p.cv-pop-title", null, t("materials.attach")), file,
      h("p.cv-note", null, t("materials.boundary"))));
  const menu = h("details.cv-pop.cv-menu", null,
    h("summary.cv-iconbtn", { "aria-label": t("conversation.details"), title: t("conversation.details") }, icon("dots")),
    h("div.cv-popbody", null,
      h("p.cv-pop-title", null, t("conversation.details")), detailFacts,
      h("div.cv-identity-row", null, identity, copyIdentity), liveNote, receiptBlock,
      h("p.cv-note", null, t("conversation.boundary"))));
  const pops = [menu, attachMenu, modelMenu, picker];
  pops.forEach(function (pop) {
    pop.addEventListener("toggle", function () {
      if (!pop.open) return;
      pops.forEach(function (other) { if (other !== pop) other.open = false; });
      if (pop === modelMenu && !modelCatalog && !modelLoad.disabled) loadModels();
      else if (pop === modelMenu) focusOption(modelRowMap.get(modelSelect.value) || modelRows.querySelector("button"));
      if (pop === picker) focusOption(sessionList.querySelector("[aria-selected=true]") || sessionList.querySelector("button"));
    });
  });
  host.addEventListener("click", function (event) {
    pops.forEach(function (pop) { if (pop.open && !pop.contains(event.target)) pop.open = false; });
  });
  // Escape closes only the open popover; the dock-level Escape (hide the
  // dock) must not also fire for the same key press.
  host.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    pops.forEach(function (pop) {
      if (!pop.open) return;
      event.stopPropagation();
      pop.open = false;
      pop.querySelector("summary")?.focus?.();
    });
  });
  sessionList.addEventListener("keydown", function (event) {
    const options = [...sessionList.querySelectorAll("button")];
    const index = options.indexOf(document.activeElement);
    const target = event.key === "ArrowDown" ? options[Math.min(options.length - 1, index + 1)]
      : event.key === "ArrowUp" ? options[Math.max(0, index - 1)]
        : event.key === "Home" ? options[0] : event.key === "End" ? options[options.length - 1] : null;
    if (!target) return;
    event.preventDefault(); focusOption(target);
  });
  modelRows.addEventListener("keydown", function (event) {
    const rows = [...modelRowMap.values()];
    const index = rows.indexOf(document.activeElement);
    const target = event.key === "ArrowDown" ? rows[Math.min(rows.length - 1, index + 1)]
      : event.key === "ArrowUp" ? rows[Math.max(0, index - 1)]
        : event.key === "Home" ? rows[0] : event.key === "End" ? rows[rows.length - 1] : null;
    if (target) { event.preventDefault(); focusOption(target); }
  });
  feed.addEventListener("scroll", function () {
    syncJump();
    // Reaching the top loads the next older page in place; the view keeps its position.
    if (feed.scrollTop < 120 && next && historyOk && !busy) refresh(true);
  });
  host.append(
    h("div.cv-head", null, picker, current, h("span.spacer"), status, options.tools || null, menu),
    h("div.cv-stage", null, older, feed, latest),
    questions, requests,
    h("div.cv-composer", null, slash, notice,
      h("div.cv-box", null, materialList, materialAlert, text,
        h("div.cv-tools", null, attachMenu, h("span.spacer"), modelMenu, stop, send)),
      h("div.cv-hint", null, draftStatus, literal, check, receipt)));

  function focusOption(option) { if (option && typeof option.focus === "function") option.focus(); }
  // Write only real changes so an unchanged poll leaves the DOM untouched.
  function setText(node, value) { if (node.textContent !== value) node.textContent = value; }
  function setChildren(node, value) { if (node.textContent !== value) node.replaceChildren(value); }
  function setProp(node, name, value) { if (node[name] !== value) node[name] = value; }
  function setAttr(node, name, value) {
    if ((node.getAttribute ? node.getAttribute(name) : node[name]) !== value) node.setAttribute(name, value);
  }
  async function afterRead() {
    const own = generation;
    while (reading) await new Promise(function (resolve) { readWaiters.push(resolve); });
    return own === generation;
  }
  function endRead() {
    reading = false;
    const waiting = readWaiters; readWaiters = [];
    waiting.forEach(function (resolve) { resolve(); });
  }
  function report() {
    if (options.onSelection) options.onSelection(selected, facts ? facts.currentSessionId || null : undefined);
  }
  function selectedSession() {
    return facts && facts.sessions.find(function (s) { return s.nativeSessionId === selected; }) || null;
  }
  function ownerLabel() {
    if (!owner) return "";
    return owner.scope === "global" ? owner.roleName === "operator" ? t("actions.operator") : owner.roleName
      : owner.roleName + " · " + owner.taskId;
  }
  function sessionWhen(s) { return formatShort(s.createdAt, locale()) || "—"; }
  function sessionLifecycle(s) {
    return t(s.status === "active" ? "conversation.sessionActive"
      : s.endReason === "failed" ? "conversation.sessionFailed" : "conversation.sessionEnded");
  }
  function sessionName(s) {
    return (s.current ? t("conversation.current") : t("conversation.previous")) + " · " + (s.title || sessionWhen(s));
  }
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
    setProp(latest, "hidden", !((selected && !historyOk) || feed.scrollHeight - feed.clientHeight - feed.scrollTop > 80));
    setProp(older, "hidden", !next || !historyOk || feed.scrollTop > 160);
  }
  function controls() {
    if (owner && selected) {
      try { pending = JSON.parse(saved(".pending") || "null"); }
      catch { recoveryUnavailable = true; }
    }
    const active = selectedSession();
    // Task Roles other than the Leader keep their assignment controls; here they are read only.
    const roleReadOnly = !!owner && owner.scope === "task" && owner.roleName !== "leader";
    const writable = historyOk && active && active.current && active.status === "active" && active.adapterId === "codex"
      && facts.authority && facts.authority.owner === "controller" && !facts.terminalWriter && !roleReadOnly;
    const turn = facts && facts.turn;
    const unsettled = turn && ["submitting", "delivery-unknown"].includes(turn.status);
    const locked = busy && !reading;
    setProp(send, "disabled", !!(locked || recoveryUnavailable || !!pending || !!modelPending || !writable || unsettled));
    setProp(stop, "disabled", !!(locked || recoveryUnavailable || !!pending || !writable || !turn || turn.status !== "accepted" || !turn.nativeTurnId));
    setProp(check, "disabled", !!(locked || !pending));
    setProp(older, "disabled", !!(locked || !next));
    setProp(check, "hidden", !pending);
    setProp(stop, "hidden", !turn || turn.status !== "accepted");
    setProp(current, "hidden", !facts || !selected || selected === facts.currentSessionId);
    setProp(literal, "disabled", !!send.disabled);
    syncJump();
    setProp(modelLoad, "disabled", !!(locked || !active || active.adapterId !== "codex"));
    setProp(modelApply, "disabled", !!(locked || !!pending || !!modelPending || !writable || !modelSelect.value
      || modelSelect.value === confirmedModel
      || !modelCatalog || modelCatalog.source === "fallback" || !!modelCatalog.failure
      || turn && ["submitting", "accepted", "delivery-unknown"].includes(turn.status)));
    modelRowMap.forEach(function (row) { setProp(row, "disabled", locked || !!modelPending); });
    const modelReason = modelPending ? (locked ? "" : "conversation.modelUnknown")
      : active && !active.current ? "conversation.readOnlyHistory"
        : facts && facts.terminalWriter ? "conversation.modelTerminalBusy"
          : turn && ["submitting", "accepted", "delivery-unknown"].includes(turn.status) ? "conversation.modelBusy"
            : active && (!writable || roleReadOnly) ? "conversation.inputUnavailable" : "";
    setText(modelStatus, modelReason ? t(modelReason) : "");
    setProp(attachMenu, "hidden", !owner || owner.scope !== "task");
    setProp(file, "disabled", !!(locked || !!pending || !writable || materials.length >= 8));
    materialList.querySelectorAll("button").forEach(function (control) { setProp(control, "disabled", locked || !!pending); });
    // One plain reason for unavailable input; ordered by what the user can act on.
    const reason = !facts || !selected || !historyOk || !active ? ""
      : !active.current ? "conversation.readOnlyHistory"
        : facts.terminalWriter ? "conversation.terminalWriter"
          : roleReadOnly ? "conversation.roleReadOnly"
          : recoveryUnavailable ? "conversation.storageFailed"
            : pending ? "conversation.pendingInput"
              : unsettled ? "conversation.turnUnsettled"
                : modelPending ? "conversation.modelApplying"
                  : !writable ? "conversation.inputUnavailable" : "";
    setProp(notice, "hidden", !reason);
    setProp(notice, "className", "cv-notice" + (["conversation.terminalWriter", "conversation.readOnlyHistory", "conversation.roleReadOnly"].includes(reason) ? "" : " is-warn"));
    setText(noticeText, reason ? t(reason) : "");
    setProp(noticeCurrent, "hidden", reason !== "conversation.readOnlyHistory");
    setProp(text, "placeholder", t(reason === "conversation.readOnlyHistory" ? "conversation.placeholderHistory" : "conversation.placeholder"));
  }
  function showReceipt(result) {
    const refused = result.interrupt && result.interrupt.state === "not-interrupted";
    const state = refused ? result.interrupt.code === "DELIVERY_UNKNOWN" ? "unknown" : "failed" : result.state || "submitted";
    receipt.textContent = t("conversation.receipt." + state)
      + (refused ? " · " + result.interrupt.code : "")
      + (result.messageId ? " · " + result.messageId : "")
      + (result.notDelivered ? " · " + (typeof result.notDelivered === "string" ? result.notDelivered : JSON.stringify(result.notDelivered)) : "");
    receiptDetail.textContent = JSON.stringify(result, null, 2);
    receiptBlock.hidden = false;
  }
  // Keep execution evidence and the user's selected target apart. A Codex observation is the
  // most recent native confirmation (start, resume or an adopted switch) with
  // its time, not a live reading of the current Turn or of Desktop changes, so
  // it is labelled that way. A pending switch is shown as pending. An absent, unknown or unreadable confirmation
  // is shown as unconfirmed: never filled from launch, Role or poll time.
  function observedAxis(observation, category) {
    if (!observation || observation.status !== "observed" || !Array.isArray(observation.axes)) return null;
    const axis = observation.axes.find(function (a) { return a.category === category; });
    return axis && axis.current && axis.current.status === "observed" ? axis.current.value : null;
  }
  function modelText(model, effort) { return model + (effort ? " · " + effort : ""); }
  function showModel(observation) {
    const value = observedAxis(observation, "model");
    confirmedModel = value;
    modelObservation = observation || null;
    // An unresolved switch keeps its pending record; controls() owns the note.
    if (modelPending && value === modelPending.model && observation.observedAt !== modelPending.previousObservation) {
      modelPending = null; saved(".modelPending", null);
      releaseMutation(url({ session: selected }).replace("/api/conversation?", "/api/conversation/model?"));
    }
    lastModelObservation = value ? observation.observedAt : null;
    // A catalog read before the first confirmation leaves nothing chosen;
    // default that untouched choice to the confirmed model, as a load does.
    if (value && !modelPending && !modelSelect.value && modelRowMap.has(value)) { pickModel(value); return; }
    drawModel();
  }
  function fact(list, label, value, note) {
    list.append(h("dt", null, label), h("dd", null, h("span", null, value), note ? h("small", null, note) : null));
  }
  function modelName(value) {
    const known = modelCatalog && (modelCatalog.catalog.models || []).find(function (m) { return m.value === value; });
    return known && known.label && known.label !== value ? known.label : value;
  }
  function drawModel() {
    const observation = modelObservation;
    const value = confirmedModel;
    const effort = value ? observedAxis(observation, "effort") : null;
    // Dated, so a confirmation from yesterday is not read as today's.
    const at = value ? formatDateTime(observation.observedAt, locale()) : "";
    let state, tag, label, title;
    if (modelPending) {
      state = "pending"; tag = t("conversation.modelStatePending"); label = modelPending.model; title = t("conversation.modelApplying");
    } else if (value) {
      state = "confirmed"; tag = t("conversation.modelStateConfirmed"); label = modelText(value, effort);
      title = fill(t("conversation.modelConfirmedShort"), { time: at });
    } else {
      state = "unknown"; tag = ""; label = t("conversation.modelUnconfirmed"); title = t("conversation.modelUnconfirmedHint");
    }
    if (modelMenu.dataset.state !== state) modelMenu.dataset.state = state;
    setText(modelState, tag);
    setProp(modelState, "hidden", !tag);
    setText(modelLabel, label);
    setAttr(modelSummary, "title", t("conversation.model") + " · " + title);
    setAttr(modelSummary, "aria-label", t("conversation.model") + " · " + (tag ? tag + " " : "") + label);
    const selection = modelPending ? modelPending.model : modelSelect.value;
    const rows = [
      [t("conversation.confirmedModel"), value ? modelText(modelName(value), effort) : t("conversation.modelUnconfirmed"),
        value ? t("conversation.modelStateConfirmed") : "", value ? title : t("conversation.modelUnconfirmedHint"), !value],
      [t("conversation.selectedModel"), selection ? modelName(selection) : t("conversation.modelNotSelected"),
        modelPending ? t("conversation.modelStatePending") : "", selection || "", !selection]];
    rows.forEach(function (row, index) {
      const node = modelFactNodes[index];
      setChildren(node.term, row[0]);
      setChildren(node.value, row[1]);
      setChildren(node.note, row[2]);
      setProp(node.note, "hidden", !row[2]);
      setAttr(node.detail, "title", row[3]);
      const kind = "cv-mf-value" + (row[4] ? " is-empty" : "");
      if (node.value.className !== kind) node.value.className = kind;
    });
    modelRowMap.forEach(function (row, key) {
      const kind = "cv-option" + (key === modelSelect.value ? " is-selected" : "") + (key === value ? " is-current" : "");
      if (row.className !== kind) row.className = kind;
    });
  }
  function pickModel(value) {
    modelSelect.value = value;
    modelRowMap.forEach(function (row, key) { setAttr(row, "aria-selected", key === value ? "true" : "false"); });
    modelResult.textContent = "";
    modelResult.title = "";
    drawModel();
    controls();
  }
  async function loadModels() {
    if (!await afterRead()) return;
    controls();
    if (modelLoad.disabled || busy) return;
    const own = generation;
    busy = true; modelResult.textContent = t("conversation.modelsLoading"); controls();
    try {
      const result = await requestJson(url({ session: selected }).replace("/api/conversation?", "/api/conversation/model?"));
      if (own !== generation) return;
      const previousChoice = modelSelect.value;
      modelCatalog = result; clear(modelSelect); clear(modelRows); modelRowMap = new Map();
      (result.catalog.models || []).forEach(function (m) {
        modelSelect.append(h("option", { value: m.value }, m.label + " · " + m.value));
        // The native id is shown beside a differing label (it is what the
        // pill and facts name), not in a hover tooltip.
        const row = h("button.cv-option", { type: "button", role: "option", "aria-selected": "false" },
          h("i.cv-option-mark", { "aria-hidden": "true" }), h("span.cv-option-name", null, m.label || m.value),
          m.label && m.label !== m.value ? h("span.cv-option-id", null, m.value) : null, icon("check"));
        row.addEventListener("click", function () { pickModel(m.value); });
        modelRowMap.set(m.value, row); modelRows.append(row);
      });
      pickModel(modelRowMap.has(previousChoice) ? previousChoice : modelRowMap.has(confirmedModel) ? confirmedModel : "");
      modelLoad.hidden = !result.failure && result.source !== "fallback" && modelRowMap.size > 0;
      modelResult.textContent = result.failure || result.source === "fallback" ? t("conversation.modelsFailed")
        : !modelRowMap.size ? t("conversation.modelsEmpty") : "";
      modelResult.title = result.failure?.message || "";
    } catch (error) {
      if (own === generation) {
        modelCatalog = null; modelLoad.hidden = false;
        modelResult.textContent = t("conversation.modelsFailed"); modelResult.title = error.message;
      }
    }
    finally {
      finish(own);
      if (own === generation && modelMenu.open) focusOption(modelRowMap.get(modelSelect.value) || modelRows.querySelector("button"));
    }
  }
  async function applyModel() {
    const choice = modelSelect.value;
    if (!await afterRead() || choice !== modelSelect.value) return;
    controls();
    if (modelApply.disabled || busy) return;
    const own = generation;
    const endpoint = url({ session: selected }).replace("/api/conversation?", "/api/conversation/model?");
    modelPending = { model: modelSelect.value, previousObservation: lastModelObservation };
    saved(".modelPending", JSON.stringify(modelPending));
    // The Host drops its own confirmation before adopting; so does this view.
    confirmedModel = null; drawModel();
    busy = true; controls();
    modelResult.textContent = t("conversation.modelApplying");
    try {
      const result = await submitMutation(endpoint, endpoint, { model: modelPending.model });
      if (own !== generation) return;
      showModel(result.runConfiguration);
      modelResult.textContent = modelPending ? "" : t("conversation.modelConfirmed");
      if (!modelPending && confirmedModel === modelSelect.value) {
        modelResult.textContent = ""; modelMenu.open = false; modelSummary.focus?.();
      }
    } catch (error) {
      if (own !== generation) return;
      modelResult.textContent = error.disposition !== "not-submitted" ? ""
        : t(error.message.includes("Exit the native TUI") ? "conversation.modelTerminalBusy" : "conversation.modelFailed");
      modelResult.title = error.message;
      if (error.disposition === "not-submitted") { modelPending = null; saved(".modelPending", null); }
      drawModel();
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
  function renderRequests(rows, omitted) {
    const signature = JSON.stringify([selected, rows, !!facts.terminalWriter, !!omitted]);
    if (signature === requestSignature) return;
    requestSignature = signature; clear(requests);
    if (omitted) requests.append(h("p.cv-note", null, t("conversation.nativeOmitted")));
    rows.forEach(function (request) {
      const card = h("section.cv-card", null, h("h3.cv-card-title", null, t("conversation.nativeRequest")),
        h("p.cv-note", null, request.method + " · " + request.turnId));
      const params = request.params, answers = {};
      const pendingKey = ".nativePending." + request.turnId + "." + request.id;
      if (request.method === "item/tool/requestUserInput") {
        (params.questions || []).forEach(function (question) {
          const field = h("input", { type: question.isSecret ? "password" : "text", "aria-label": question.question });
          const draftKey = ".nativeDraft." + request.turnId + "." + request.id + "." + question.id;
          nativeDraftKeys.add(draftKey);
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
    // A historical Session never borrows another Session's model confirmation.
    modelObservation = null; pageFacts = null;
    modelStatus.textContent = ""; modelResult.textContent = ""; receiptDetail.textContent = ""; receiptBlock.hidden = true;
    status.textContent = ""; detailSignature = ""; sessionSignature = "";
    drawModel();
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
    report();
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
      // User text is shown exactly as sent: tags in it are the user's words,
      // never guessed to be attached context.
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
  function chooseSession(id) {
    picker.open = false;
    picker.querySelector("summary")?.focus?.();
    if (id === selected) return;
    choose(id); refresh();
  }
  function drawSessions() {
    const session = selectedSession();
    pickerName.textContent = session ? sessionName(session)
      : selected ? t(selected === (facts && facts.currentSessionId) ? "conversation.current" : "conversation.previous") : t("conversation.noSessionShort");
    picker.querySelector("summary").title = pickerName.textContent;
    const rows = facts.sessions.slice().sort(function (a, b) {
      return Number(b.current) - Number(a.current) || String(b.createdAt).localeCompare(String(a.createdAt));
    });
    const signature = JSON.stringify([selected, facts.nextOffset, locale(), rows.map(function (s) {
      return [s.nativeSessionId, s.current, s.status, s.endReason, s.title, s.createdAt];
    })]);
    moreSessions.hidden = !facts.nextOffset;
    if (signature === sessionSignature) return;
    sessionSignature = signature;
    clear(sessionList);
    let historyHeading = false;
    rows.forEach(function (s) {
      if (!s.current && !historyHeading) {
        historyHeading = true;
        sessionList.append(h("p.cv-pop-title", { role: "presentation" }, t("conversation.previousSessions")));
      }
      const chosen = s.nativeSessionId === selected;
      const option = h("button.cv-session-opt", { type: "button", role: "option", "aria-selected": String(chosen),
        title: s.title || sessionWhen(s), dataset: { session: s.nativeSessionId } },
        h("span.cv-so-dot.is-" + (s.status === "active" ? "active" : s.endReason === "failed" ? "failed" : "ended"), { "aria-hidden": "true" }),
        h("span.cv-so-text", null,
          h("span.cv-so-main", null, s.title || (s.current ? t("conversation.current") : sessionWhen(s))),
          h("span.cv-so-meta", null, (s.title || s.current ? sessionWhen(s) + " · " : "") + sessionLifecycle(s))),
        chosen ? icon("check", "cv-so-check") : null);
      option.addEventListener("click", function () { chooseSession(s.nativeSessionId); });
      sessionList.append(option);
    });
  }
  // Low-frequency identity and diagnostics: readable first, exact values copyable.
  function drawDetails() {
    const session = selectedSession();
    const turn = facts && selected === facts.currentSessionId ? facts.turn : null;
    const exact = (owner.taskId || "Global") + " / " + owner.roleName + " / " + selected
      + (turn ? " / " + (turn.nativeTurnId || turn.attemptId) + (turn.runId ? " / " + turn.runId : "") : "");
    const live = pageFacts && pageFacts.live === "unavailable";
    const signature = JSON.stringify([exact, session, pageFacts && [pageFacts.live, pageFacts.linkedInputsOmitted],
      !!(facts && facts.terminalWriter), locale()]);
    if (signature === detailSignature) return;
    detailSignature = signature;
    clear(detailFacts);
    fact(detailFacts, t("dock.target"), ownerLabel());
    if (session) {
      fact(detailFacts, t("conversation.sessionLabel"), sessionName(session), sessionLifecycle(session));
      fact(detailFacts, t("conversation.sessionId"), session.nativeSessionId);
      if (session.executionAuthority) fact(detailFacts, t("conversation.authority"), session.executionAuthority);
      if (session.agentId) fact(detailFacts, t("conversation.agent"), session.agentId + (session.adapterId ? " · " + session.adapterId : ""));
    }
    if (turn) fact(detailFacts, t("conversation.turn"), String(turn.nativeTurnId || turn.attemptId), turn.status);
    fact(detailFacts, t("conversation.writer"), t(facts && facts.terminalWriter ? "conversation.terminalWriter" : "conversation.structuredWriter"));
    identity.textContent = exact;
    liveNote.textContent = [live ? t("conversation.liveUnavailable") : "",
      pageFacts && pageFacts.linkedInputsOmitted ? t("conversation.linkedOmitted") : ""].filter(Boolean).join(" · ");
  }
  async function refresh(older) {
    if (!owner || busy || host.hidden || host.closest("[hidden]") || document.hidden) return;
    if (older && (!next || !selected || !facts || !historyOk)) return;
    busy = true; reading = true; controls();
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
      report();
      if (!selected) {
        status.textContent = t("conversation.noSession"); status.className = "cv-status is-unknown";
        pickerName.textContent = t("conversation.noSessionShort"); return;
      }
      // Preserve a historical choice even if it is outside the newest page.
      drawSessions(); drawDetails();
      renderQuestions();
      const page = await requestJson(url({ session: selected }));
      if (own !== generation) return;
      historyOk = true; latestItems = page.items; pageFacts = page;
      if (!olderItems.length) next = page.nextCursor;
      const turn = selected === facts.currentSessionId ? facts.turn : null;
      let state = page.status === "waiting-user" ? "waiting" : page.status === "active" ? "active"
        : page.status === "systemError" ? "failed" : page.status === "idle" ? "waiting" : "unknown";
      const session = facts.sessions.find(function (s) { return s.nativeSessionId === selected; });
      if (session && session.status === "ended") state = session.endReason === "failed" ? "failed" : "ended";
      if (turn && turn.status === "delivery-unknown") state = "unknown";
      status.textContent = t(state === "unknown" ? "conversation.stateUnknown" : "conversation." + state);
      status.title = page.observedAt + " · " + t(facts.terminalWriter ? "conversation.terminalWriter" : "conversation.structuredWriter");
      status.className = "cv-status is-" + state;
      renderRequests(page.nativeRequests || [], !!page.nativeRequestsOmitted);
      showModel(page.runConfiguration);
      drawDetails();
      const scroll = feed.scrollTop, atEnd = feed.scrollHeight - feed.clientHeight - scroll < 40;
      renderItems(allItems());
      feed.scrollTop = atEnd ? feed.scrollHeight : scroll;
      syncJump();
    } catch (error) {
      if (own === generation) {
        historyOk = false; status.textContent = t("conversation.disconnectedShort");
        status.title = t("conversation.disconnected") + " · " + error.message; status.className = "cv-status is-failed";
        // An unreadable confirmation is unconfirmed, not the earlier value.
        if (confirmedModel) { confirmedModel = null; modelObservation = null; drawModel(); }
      }
    } finally { endRead(); finish(own); }
    if (own === generation && pending && historyOk) await inspectReceipt();
  }
  async function inspectReceipt() {
    if (!await afterRead()) return;
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
    const body = text.value;
    const target = facts && facts.turn && (facts.turn.nativeTurnId || facts.turn.attemptId);
    if (!await afterRead() || body !== text.value
      || target !== (facts && facts.turn && (facts.turn.nativeTurnId || facts.turn.attemptId))) return;
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
    if (selected) saved(".draft", text.value);
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
  modelSelect.addEventListener("change", function () { pickModel(modelSelect.value); });
  modelApply.addEventListener("click", applyModel);
  literal.addEventListener("click", function () { submit(false, true); });
  file.addEventListener("change", async function () {
    if (!await afterRead()) return;
    controls();
    const chosen = file.files[0];
    if (!chosen || file.disabled || busy) return;
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
  function backToCurrent() { if (facts && facts.currentSessionId) chooseSession(facts.currentSessionId); }
  current.addEventListener("click", backToCurrent);
  noticeCurrent.addEventListener("click", backToCurrent);
  copyIdentity.addEventListener("click", function () {
    navigator.clipboard.writeText(identity.textContent).then(function () {
      copyIdentity.title = t("conversation.copied");
    }, function () { copyIdentity.title = t("conversation.copyFailed"); });
  });
  older.addEventListener("click", function () {
    if (reading) afterRead().then(function (same) { if (same) refresh(true); }); else refresh(true);
  });
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
      drawSessions();
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
        generation++; owner = target; selected = null; facts = null; pending = null; clear(feed);
        clear(sessionList); sessionSignature = ""; detailSignature = ""; clear(detailFacts); pageFacts = null;
        pickerName.textContent = t("conversation.sessions"); status.textContent = ""; status.className = "cv-status";
        next = null; latestItems = []; olderItems = []; historyOk = false; rendered.clear();
        text.value = ""; receipt.textContent = ""; identity.textContent = ""; liveNote.textContent = "";
        receiptBlock.hidden = true; controls();
        modelPending = null; modelCatalog = null; clear(modelSelect); clear(modelRows); modelRowMap = new Map(); confirmedModel = null;
        modelObservation = null; drawModel(); modelStatus.textContent = "";
        modelResult.textContent = "";
        receiptDetail.textContent = ""; draftStatus.textContent = ""; drawCommands();
        materials = []; incomingMaterials = null; clear(materialList); materialAlert.textContent = "";
        clear(requests); requestSignature = "";
        clear(questions); questionSignature = "";
      }
      if (options && options.materials) incomingMaterials = options.materials;
      // A named Session (carried from another mode) is kept even when it is no
      // longer current: never silently exchanged for today's current Session.
      if (options && options.session && options.session !== selected) choose(options.session);
      if (!timer) timer = window.setInterval(function () { refresh(); }, 2000);
      refresh();
    },
    close: function () { if (timer) window.clearInterval(timer); timer = null; generation++; },
    // The session page left this view: forget its unsent text. A draft that
    // is the body of an unresolved submission stays with that receipt.
    discardDraft: function () {
      if (!owner || !selected) return;
      let held = null;
      try { held = JSON.parse(saved(".pending") || "null"); } catch { held = null; }
      if (!held) saved(".draft", null);
      nativeDraftKeys.forEach(function (draftKey) { saved(draftKey, null); });
    }
  };
}
`;
