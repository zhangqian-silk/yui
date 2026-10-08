export const DETAIL_SCRIPT = String.raw`
// Task detail: header, section tabs and the Overview section. The runtime
// observation arrives separately from the Context snapshot, so every fact it
// feeds lives in a [data-slot] that updateObservation() can redraw in place.
import { h, icon, clear } from "/assets/js/dom.js";
import { formatDateTime, formatClock, relativeTime } from "/assets/js/format.js";
import {
  badge, statusBadge, label, tone, card, disclosure, richText, bulletList, emptyState,
  note, button, chip, mono, inputCard, kv, dot, timeTag
} from "/assets/js/components.js";
import { entriesOf, valuesOf, recordCard } from "/assets/js/records.js";
import { renderWork, renderExecution, renderHistory, renderDetails } from "/assets/js/sections.js";

export const TABS = ["overview", "work", "execution", "history", "details"];
const TAB_ICONS = { overview: "target", work: "layers", execution: "pulse", history: "history", details: "dots" };
const SESSION_GROUPS = ["active", "waiting", "background", "quiet", "diagnostic", "stopped", "unknown", "idle"];

export function renderTaskDetail(container, data, t, locale, ctx) {
  clear(container);
  const task = data.task;
  const core = data.core;
  container.dataset.taskId = task.id;
  const page = h("div.page.task-page");

  // --- Header ----------------------------------------------------------------
  const bar = h("div.task-bar", null,
    h("button.icon-btn.back-btn", { type: "button", "aria-label": t("actions.back"), title: t("actions.back"), onclick: ctx.onBack }, icon("back")),
    h("nav.crumbs", { "aria-label": t("crumbs.label") },
      h("button.crumb", { type: "button", onclick: ctx.onBack }, t("crumbs.tasks")),
      h("span.crumb-sep", { "aria-hidden": "true" }, "/"),
      h("code.crumb-current", null, task.id)),
    h("span.spacer"),
    h("button.btn.btn-ghost.dock-toggle", {
      type: "button", dataset: { dockToggle: "discussion" }, title: t("dock.discussion") + " · D",
      onclick: function () { ctx.showDock("discussion"); }
    }, icon("chat"), h("span", null, t("dock.discussion"))),
    h("button.btn.btn-ghost.dock-toggle", {
      type: "button", dataset: { dockToggle: "session" }, title: t("dock.session"),
      onclick: function () { ctx.showDock("session"); }
    }, icon("terminal"), h("span", null, t("dock.session"))));

  const meta = h("div.task-meta", null,
    statusBadge(t, "task", "status", task.status),
    h("span", { dataset: { slot: "exec-badge" } }),
    task.priority ? badge(label(t, "priority", task.priority), task.priority === "urgent" || task.priority === "high" ? "accent" : "idle") : null,
    (task.tags || []).map(function (tag) { return chip("#" + tag); }),
    h("span.meta-item", null, icon("clock", "icon-sm"), t("task.updated") + " ", timeTag(task.updatedAt, locale, t)),
    (task.projectBindings || []).length ? h("span.meta-item", null, icon("layers", "icon-sm"),
      task.projectBindings.map(function (binding) { return binding.projectId; }).join(", ")) : null);

  const counts = {
    work: entriesOf(core, "work-item").length,
    execution: entriesOf(core, "run").length,
    history: entriesOf(core, "task-decision").length + entriesOf(core, "task-milestone").length + entriesOf(core, "task-message").length
  };
  const tabs = h("nav.tabs", { role: "tablist", "aria-label": t("tabs.label") }, TABS.map(function (tab, index) {
    return h("button.tab", {
      type: "button", role: "tab", id: "tab-" + tab,
      "aria-controls": "panel-" + tab,
      "aria-selected": String(ctx.activeTab === tab),
      tabIndex: ctx.activeTab === tab ? 0 : -1,
      title: t("tabs." + tab) + " · " + (index + 1),
      dataset: { tab: tab },
      onclick: function () { ctx.onTab(tab); }
    }, icon(TAB_ICONS[tab], "icon-sm"), h("span", null, t("tabs." + tab)),
    counts[tab] ? h("span.count", null, String(counts[tab])) : null);
  }));
  tabs.addEventListener("keydown", function (event) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const selected = tabs.querySelector('[aria-selected="true"]');
    const index = TABS.indexOf(selected.dataset.tab);
    const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    ctx.onTab(next);
    const button = tabs.querySelector('[data-tab="' + next + '"]');
    if (button) button.focus();
  });

  page.append(h("header.task-header", null, bar),
    h("div.task-hero", null, h("h1.task-title", null, task.title), meta),
    h("div.tabs-wrap", null, tabs));

  // --- Panels ------------------------------------------------------------------
  const panels = {};
  TABS.forEach(function (tab) {
    panels[tab] = h("section.tab-panel", { id: "panel-" + tab, role: "tabpanel", "aria-labelledby": "tab-" + tab, hidden: ctx.activeTab !== tab });
    page.append(panels[tab]);
  });
  renderOverviewPanel(panels.overview, data, t, locale, ctx);
  renderWork(panels.work, data, t, locale, ctx);
  renderExecution(panels.execution, data, t, locale, ctx);
  renderHistory(panels.history, data, t, locale, ctx);
  renderDetails(panels.details, data, t, locale, ctx);
  container.append(page);
  updateObservation(container, data, t, locale, ctx);
}

export function selectTab(container, tab) {
  container.querySelectorAll(".tab").forEach(function (button) {
    const active = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  container.querySelectorAll(".tab-panel").forEach(function (panel) { panel.hidden = panel.id !== "panel-" + tab; });
}

function renderOverviewPanel(panel, data, t, locale, ctx) {
  const task = data.task;
  const core = data.core;
  // Now: the derived execution status (observation) plus the open questions.
  const now = card({ className: "now-card" });
  now.body.append(h("div", { dataset: { slot: "now" } }));
  panel.append(now);

  // Needs you: open InputRequests with their answer controls.
  const inputs = entriesOf(core, "input-request").filter(function (entry) { return !entry.omitted && entry.value.status === "open"; });
  const missing = core.attention.openInputs.refs.filter(function (ref) {
    return !inputs.some(function (entry) { return entry.ref.refId === ref.refId; });
  });
  const inputCount = core.attention.openInputs.count;
  if (inputCount) {
    const needs = card({ title: t("overview.needsYou"), icon: "inbox", count: inputCount, className: "needs-card" });
    needs.id = "detail-attention";
    inputs.forEach(function (entry) { needs.body.append(inputCard(entry.value, t, locale, ctx.answerInput)); });
    missing.forEach(function (ref) { needs.body.append(recordCard({ ref: ref, omitted: true }, task.id, t, ctx)); });
    if (inputCount > inputs.length + missing.length) {
      needs.body.append(note(t("overview.moreInputs"), "warn"), h("pre.code-block", null, "yui task input list " + task.id));
    }
    panel.append(needs);
  }

  // Independent column stacks, not paired rows: a long progress card must not
  // push the next row down and leave a gap under the shorter Session card.
  // Main column: what the Task is and where it stands. Rail: live and decided facts.
  const sessions = card({ title: t("sessions.title"), icon: "terminal", hint: t("sessions.hint") });
  sessions.body.append(h("div", { dataset: { slot: "sessions" } }));
  panel.append(h("div.card-columns", null,
    h("div.card-column", null, progressCard(data, t, locale, ctx), goalCard(data, t, ctx)),
    h("div.card-column", null, sessions, decisionsCard(data, t, locale, ctx))));
  if (task.status === "draft") panel.append(planningCard(data, t, locale));
}

function progressCard(data, t, locale, ctx) {
  const task = data.task;
  const element = card({ title: t("progress.title"), icon: "flag" });
  const working = task.status === "draft" || task.status === "active";
  if (task.completionSummary) element.body.append(richText(t("progress.completion"), task.completionSummary, t, { className: "callout.tone-ok" }));
  if (task.retirementSummary) element.body.append(richText(t("progress.retirement"), task.retirementSummary, t, { className: "callout" }));
  if (task.archiveSummary || task.archiveReason) element.body.append(richText(t("progress.archive"), [task.archiveSummary, task.archiveReason].filter(Boolean).join("\n\n"), t, { className: "callout" }));
  const briefEntry = entriesOf(data.core, "task-brief")[0];
  const brief = valuesOf(data.core, "task-brief")[0];
  if (brief) {
    element.body.append(richText(t(working ? "progress.focus" : "progress.lastFocus"), brief.currentFocus, t));
    element.body.append(richText(t(working ? "progress.report" : "progress.lastReport"), brief.leaderSummary, t, { muted: true }));
    element.body.append(h("p.faint.small", null, t("progress.briefUpdated") + " " + formatDateTime(brief.updatedAt, locale)));
  } else if (briefEntry) element.body.append(recordCard(briefEntry, task.id, t, ctx, { compact: true }));
  else element.body.append(emptyState(t("progress.none")));
  element.body.append(h("p.next-line", { dataset: { slot: "next" } }));
  return element;
}

function goalCard(data, t, ctx) {
  const task = data.task;
  const brief = valuesOf(data.core, "task-brief")[0];
  const element = card({ title: t("goal.title"), icon: "target" });
  if (brief && brief.objective) element.body.append(richText(null, brief.objective, t));
  if (brief && brief.boundaries && brief.boundaries.length) {
    element.body.append(h("div.prose-block", null, h("h4.prose-label", null, t("goal.boundaries")), bulletList(brief.boundaries)));
  }
  if (brief && brief.technicalApproach) {
    const approach = disclosure(t("goal.approach"), "approach");
    approach.body.append(richText(null, brief.technicalApproach, t));
    element.body.append(approach);
  }
  if (task.description) {
    const requirements = disclosure(t("goal.requirements"), "requirements");
    requirements.body.append(richText(null, task.description, t));
    element.body.append(requirements);
  }
  if (!element.body.childNodes.length) element.body.append(emptyState(t("goal.none")));
  return element;
}

function decisionsCard(data, t, locale, ctx) {
  const entries = entriesOf(data.core, "task-decision");
  const active = entries.filter(function (entry) { return !entry.omitted && entry.value.status === "active"; });
  const element = card({ title: t("decisions.title"), icon: "check", count: active.length || null, hint: t("decisions.hint") });
  active.slice(0, 3).forEach(function (entry) {
    const value = entry.value;
    element.body.append(h("article.decision", null,
      h("header.decision-head", null, dot("ok"), h("strong", null, value.title), timeTag(value.createdAt, locale, t)),
      value.rationale ? richText(null, value.rationale, t, { muted: true, threshold: 260 }) : null));
  });
  if (!active.length) element.body.append(emptyState(t("decisions.none")));
  if (active.length > 3 || data.core.omitted.records || entries.some(function (entry) { return entry.omitted; })) {
    element.body.append(button(t("decisions.more"), { variant: "link", icon: "chevron", onClick: function () { ctx.onTab("history"); } }));
  }
  return element;
}

// A Draft's Leader conversation is its planning Turn. Report the snapshot's
// real planning facts; a withheld value is reported as withheld, never as
// "not dispatched".
function planningCard(data, t, locale) {
  const runEntries = entriesOf(data.core, "run");
  const planning = valuesOf(data.core, "run").filter(function (run) { return run.roleName === "leader" && run.purpose === "planning"; });
  const turn = planning[planning.length - 1] || null;
  const withheld = turn === null && runEntries.some(function (entry) { return entry.omitted; });
  const live = ((data.runtime && data.runtime.roles) || []).find(function (role) { return role.name === "leader"; }) || null;
  const element = card({ title: t("planning.title"), icon: "sparkle", className: "planning-card" });
  element.dataset.planning = turn ? turn.status : withheld ? "withheld" : "not-dispatched";
  element.body.append(note(withheld ? t("planning.withheld") : turn === null ? t("planning.none")
    : turn.status === "active" ? t("planning.open") : t("planning.settled").replace("{status}", turn.status)));
  const environment = turn && turn.effective && turn.effective.executionEnvironment;
  element.body.append(kv([
    [t("planning.run"), turn ? mono(turn.id + " (" + turn.status + ")") : withheld ? t("planning.withheldValue") : t("common.none")],
    [t("planning.providerTerminal"), (turn && turn.result && turn.result.provider && turn.result.provider.status) || t("common.notReported")],
    [t("planning.conversation"), (turn && turn.result && turn.result.provider && turn.result.provider.conversationId) || t("common.notReported")],
    [t("planning.liveSession"), (live && live.runtimeSession && live.runtimeSession.nativeSessionId) || t("planning.notRunning")],
    [t("planning.environment"), (environment && environment.environmentRef) || t("planning.emptyEnvironment")],
    [t("planning.updated"), turn ? formatDateTime((turn.result && turn.result.completedAt) || turn.updatedAt, locale) : t("common.unknown")]
  ]));
  return element;
}

// --- Observation slots -------------------------------------------------------
export function updateObservation(container, data, t, locale, ctx) {
  const available = data.runtimeStatus === "available" && data.runtime;
  const execution = available ? data.runtime.execution : null;
  const execBadge = container.querySelector('[data-slot="exec-badge"]');
  if (execBadge) {
    clear(execBadge);
    if (execution && execution.status !== data.task.status) execBadge.append(statusBadge(t, "exec", "exec.status", execution.status));
  }
  const now = container.querySelector('[data-slot="now"]');
  if (now && !now.contains(document.activeElement)) drawNow(now, data, execution, t, locale);
  const next = container.querySelector('[data-slot="next"]');
  if (next) {
    clear(next);
    if (execution && !(execution.next.owner === "none" && execution.next.action === "none")) next.append(icon("flag", "icon-sm"), h("span", null, t("now.nextOwner") + " "),
      h("strong", null, label(t, "exec.owner", execution.next.owner)), h("span", null, " · " + label(t, "exec.action", execution.next.action)));
  }
  const sessions = container.querySelector('[data-slot="sessions"]');
  if (sessions && !sessions.contains(document.activeElement)) {
    const open = sessions.querySelector("details") && sessions.querySelector("details").open;
    drawSessions(sessions, available ? data.runtime.sessions : null, t, locale);
    if (open && sessions.querySelector("details")) sessions.querySelector("details").open = true;
  }
  const raw = container.querySelector('[data-slot="runtime-raw"]');
  if (raw) raw.textContent = available ? JSON.stringify({ roles: data.runtime.roles, runtimeHealth: data.runtime.runtimeHealth }, null, 2) : "";
  const rawStatus = container.querySelector('[data-slot="runtime-status"]');
  if (rawStatus) rawStatus.textContent = t("observation." + data.runtimeStatus) + " · " + formatDateTime(data.runtimeObservedAt, locale);
  container.querySelectorAll("[data-role-status]").forEach(function (slot) {
    const role = available ? (data.runtime.roles || []).find(function (item) { return item.name === slot.dataset.roleStatus; }) : null;
    clear(slot);
    if (role) slot.append(statusBadge(t, "role", "role", role.status));
  });
}

function drawNow(slot, data, execution, t, locale) {
  clear(slot);
  const inputCount = data.core.attention.openInputs.count;
  if (!execution) {
    slot.append(h("div.now-head", null,
      badge(t("observation." + data.runtimeStatus), data.runtimeStatus === "unavailable" ? "bad" : "idle", { dot: true }),
      h("span.now-owner", null, inputCount ? t("now.inputs").replace("{count}", String(inputCount)) : t("now.noInputs"))));
    slot.append(h("p.now-note", null, data.runtimeStatus === "waiting" ? t("now.reading") : t("now.unavailable")));
    return;
  }
  const head = h("div.now-head", null,
    statusBadge(t, "exec", "exec.status", execution.status),
    execution.owner === "none" && execution.action === "none" ? null
      : h("span.now-owner", null, label(t, "exec.owner", execution.owner) + " · " + label(t, "exec.action", execution.action)));
  if (execution.activeRuns && execution.activeRuns.length) head.append(badge(execution.activeRuns.length + " " + t("now.activeRuns"), "info"));
  if (execution.monitoring === "stopped") head.append(badge(t("now.monitoringStopped"), "warn"));
  if (execution.failClosed) head.append(badge(t("now.failClosed"), "bad"));
  head.append(h("span.spacer"), h("span.faint.small", { title: formatDateTime(data.runtimeObservedAt, locale) },
    t("now.observed") + " " + formatClock(data.runtimeObservedAt, locale)));
  slot.append(head);
  if (execution.summary) slot.append(h("p.now-summary", null, execution.summary));
  if (execution.reason) slot.append(h("p.now-reason", null, execution.reason));
  const signals = [];
  (execution.attention || []).forEach(function (item) {
    signals.push(h("li.signal-row.tone-warn", null, icon("alert", "icon-sm"),
      h("span.signal-kind", null, label(t, "exec.attention", item.kind)), h("span", null, item.summary),
      item.owner ? h("span.faint.small", null, label(t, "exec.owner", item.owner)) : null));
  });
  (execution.blockers || []).forEach(function (item) {
    signals.push(h("li.signal-row.tone-bad", null, icon("alert", "icon-sm"),
      h("span.signal-kind", null, label(t, "exec.blocker", item.kind)), h("span", null, item.summary),
      h("span.faint.small", null, label(t, "exec.owner", item.owner))));
  });
  const sessions = (data.runtime.sessions && data.runtime.sessions.sessions) || [];
  sessions.filter(function (session) { return session.group === "waiting" && ["user", "permission"].includes(session.waitingReason); })
    .forEach(function (session) {
      signals.push(h("li.signal-row.tone-warn", null, icon("user", "icon-sm"),
        h("span.signal-kind", null, session.roleName), h("span", null, t("now.nativeWait"))));
    });
  if (signals.length) slot.append(h("ul.signal-list", null, signals));
  else slot.append(h("p.now-note", null, inputCount ? t("now.inputs").replace("{count}", String(inputCount)) : t("now.clear")));
}

function drawSessions(slot, observation, t, locale) {
  clear(slot);
  if (!observation) { slot.append(emptyState(t("sessions.unavailable"))); return; }
  const chips = SESSION_GROUPS.filter(function (group) { return observation.counts[group]; }).map(function (group) {
    return badge(observation.counts[group] + " " + t("session." + group), tone("session", group), { dot: true });
  });
  if (chips.length) slot.append(h("div.chip-row", null, chips));
  if (!observation.sessions.length) { slot.append(note(t("sessions.none"))); return; }
  slot.append(h("ul.session-list", null, observation.sessions.map(function (session) {
    return h("li.session-row", null,
      h("div.session-row-head", null, dot(tone("session", session.group)), h("strong", null, session.roleName),
        h("span.faint", null, t("session." + session.group)), h("span.spacer"),
        h("span.faint.small", null, session.lastActivityAt ? relativeTime(session.lastActivityAt, locale, t) : t("sessions.unobserved"))),
      h("p.small", null, session.reason),
      session.waitingReason ? h("p.small", null, t("sessions.waitingFor") + " " + session.waitingReason) : null);
  })));
  const facts = disclosure(t("sessions.facts"), "sessions");
  observation.sessions.forEach(function (session) {
    facts.body.append(kv([
      [t("sessions.role"), session.roleName],
      [t("sessions.lastActivity"), session.lastActivityAt ? formatDateTime(session.lastActivityAt, locale) : t("sessions.unobserved")],
      [t("sessions.inputUpdated"), formatDateTime(session.sourceUpdatedAt, locale)],
      [t("sessions.operations"), session.operations.length ? session.operations.join(", ") : null],
      [t("sessions.background"), session.background.length ? session.background.map(function (item) { return item.id + " · " + item.execution; }).join(", ") : null],
      [t("sessions.identity"), mono([session.nativeSessionId, session.nativeTurnId, session.attemptId].filter(Boolean).join(" / "))]
    ]));
  });
  facts.body.append(h("p.faint.small", null, t("sessions.scope") + " " + formatDateTime(observation.readAt, locale)));
  slot.append(facts);
}
`;
