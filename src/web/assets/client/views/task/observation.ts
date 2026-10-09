export const TASK_OBSERVATION_SCRIPT = String.raw`
// Runtime observation slots. The observation arrives separately from the
// Context snapshot, so updateObservation() redraws only the [data-slot]
// elements the panels left for it: the execution badge, the Now banner and
// next owner, Role statuses and Sessions, and the Diagnostics facts.
import { h, icon, clear } from "/assets/js/lib/dom.js";
import { fill, formatClock, formatDateTime, relativeTime } from "/assets/js/lib/format.js";
import { badge, dot, kv, mono, note } from "/assets/js/ui/primitives.js";
import { label, sessionBadges, statusBadge, tone } from "/assets/js/domain/vocab.js";

export function updateObservation(container, data, t, locale) {
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
  if (next) drawNext(next, execution, t);
  drawSessions(container, available ? data.runtime.sessions : null, t, locale);
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

function drawNext(slot, execution, t) {
  clear(slot);
  if (!execution || (execution.next.owner === "none" && execution.next.action === "none")) return;
  slot.append(icon("flag", "icon-sm"), h("span", null, t("now.nextOwner") + " "),
    h("strong", null, label(t, "exec.owner", execution.next.owner)), h("span", null, " · " + label(t, "exec.action", execution.next.action)));
}

// --- Now banner --------------------------------------------------------------
const BANNER_TONES = ["tone-info", "tone-ok", "tone-warn", "tone-bad", "tone-idle", "tone-accent"];

function drawNow(slot, data, execution, t, locale) {
  clear(slot);
  const inputCount = data.core.attention.openInputs.count;
  const waiting = inputCount ? fill(t("now.inputs"), { count: inputCount }) : null;
  const banner = slot.closest(".now-card");
  if (banner) {
    banner.classList.remove.apply(banner.classList, BANNER_TONES);
    banner.classList.add("tone-" + (execution ? tone("exec", execution.status) : data.runtimeStatus === "unavailable" ? "bad" : "idle"));
  }
  if (!execution) {
    slot.append(h("div.now-head", null,
      badge(t("observation." + data.runtimeStatus), data.runtimeStatus === "unavailable" ? "bad" : "idle", { dot: true }),
      h("span.now-owner", null, waiting || t("now.noInputs"))));
    slot.append(h("p.now-note", null, data.runtimeStatus === "waiting" ? t("now.reading") : t("now.unavailable")));
    return;
  }
  slot.append(nowHead(data, execution, t, locale));
  if (execution.summary) slot.append(h("p.now-summary", null, execution.summary));
  if (execution.reason) slot.append(h("p.now-reason", null, execution.reason));
  const signals = nowSignals(data, execution, t);
  if (signals.length) slot.append(h("ul.signal-list", null, signals));
  else slot.append(h("p.now-note", null, waiting || t("now.clear")));
}

function nowHead(data, execution, t, locale) {
  const head = h("div.now-head", null,
    statusBadge(t, "exec", "exec.status", execution.status),
    execution.owner === "none" && execution.action === "none" ? null
      : h("span.now-owner", null, label(t, "exec.owner", execution.owner) + " · " + label(t, "exec.action", execution.action)));
  if (execution.activeRuns && execution.activeRuns.length) head.append(badge(execution.activeRuns.length + " " + t("now.activeRuns"), "info"));
  if (execution.monitoring === "stopped") head.append(badge(t("now.monitoringStopped"), "warn"));
  if (execution.failClosed) head.append(badge(t("now.failClosed"), "bad"));
  head.append(h("span.spacer"), h("span.faint.small", { title: formatDateTime(data.runtimeObservedAt, locale) },
    t("now.observed") + " " + formatClock(data.runtimeObservedAt, locale)));
  return head;
}

// Attention, blockers and native Sessions waiting on the user, in that order.
function nowSignals(data, execution, t) {
  const signals = [];
  (execution.attention || []).forEach(function (item) {
    signals.push(signalRow("warn", "alert", label(t, "exec.attention", item.kind), item.summary,
      item.owner ? label(t, "exec.owner", item.owner) : null));
  });
  (execution.blockers || []).forEach(function (item) {
    signals.push(signalRow("bad", "alert", label(t, "exec.blocker", item.kind), item.summary, label(t, "exec.owner", item.owner)));
  });
  const sessions = (data.runtime.sessions && data.runtime.sessions.sessions) || [];
  sessions.filter(function (session) { return session.group === "waiting" && ["user", "permission"].includes(session.waitingReason); })
    .forEach(function (session) { signals.push(signalRow("warn", "user", session.roleName, t("now.nativeWait"), null)); });
  return signals;
}

function signalRow(toneName, iconName, kind, text, owner) {
  return h("li.signal-row.tone-" + toneName, null, icon(iconName, "icon-sm"),
    h("span.signal-kind", null, kind), h("span", null, text), owner ? h("span.faint.small", null, owner) : null);
}

// --- Sessions ----------------------------------------------------------------
// Native Session observation, drawn into the Runtime tab: one line per Role,
// the group counts beside the Roles heading, and the timestamps under
// Diagnostics. Activity is never delivery progress.
function drawSessions(container, observation, t, locale) {
  const sessions = observation ? observation.sessions : [];
  container.querySelectorAll("[data-role-session]").forEach(function (slot) {
    const session = sessions.find(function (item) { return item.roleName === slot.dataset.roleSession; });
    drawRoleSession(slot, session, observation, t, locale);
  });
  const counts = container.querySelector('[data-slot="session-counts"]');
  if (counts) {
    clear(counts);
    if (observation) counts.append(...sessionBadges(observation.counts, t));
  }
  const facts = container.querySelector('[data-slot="session-facts"]');
  if (facts) drawSessionFacts(facts, observation, sessions, t, locale);
}

function drawRoleSession(slot, session, observation, t, locale) {
  clear(slot);
  if (!session) {
    slot.append(h("span.faint.small", null, observation ? t("session.noneRecorded") : t("sessions.unavailable")));
    return;
  }
  slot.append(h("div.role-session-head", null, dot(tone("session", session.group)),
    h("strong", null, t("session." + session.group)),
    h("span.faint.small", null, session.lastActivityAt ? relativeTime(session.lastActivityAt, locale, t) : t("sessions.unobserved"))));
  if (session.reason) slot.append(h("p.small", null, session.reason));
  if (session.waitingReason) slot.append(h("p.small", null, t("sessions.waitingFor") + " " + session.waitingReason));
}

function drawSessionFacts(facts, observation, sessions, t, locale) {
  clear(facts);
  if (!observation) return;
  facts.append(h("h4.sub-head", null, t("sessions.facts")));
  if (!sessions.length) facts.append(note(t("sessions.none")));
  sessions.forEach(function (session) {
    facts.append(kv([
      [t("sessions.role"), session.roleName],
      [t("sessions.lastActivity"), session.lastActivityAt ? formatDateTime(session.lastActivityAt, locale) : t("sessions.unobserved")],
      [t("sessions.inputUpdated"), formatDateTime(session.sourceUpdatedAt, locale)],
      [t("sessions.operations"), session.operations.length ? session.operations.join(", ") : null],
      [t("sessions.background"), session.background.length ? session.background.map(function (item) { return item.id + " · " + item.execution; }).join(", ") : null],
      [t("sessions.identity"), mono([session.nativeSessionId, session.nativeTurnId, session.attemptId].filter(Boolean).join(" / "))]
    ]));
  });
  facts.append(h("p.faint.small", null, t("sessions.scope") + " " + formatDateTime(observation.readAt, locale)));
}
`;
