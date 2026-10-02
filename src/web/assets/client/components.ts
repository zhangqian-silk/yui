import { AGENT_ADAPTER_CATALOG } from "../../../agent/adapterCatalog.js";
import { AGENT_EXECUTION_COMPONENT_CATALOG } from "../../../agent/executionComponents.js";

export const COMPONENTS_SCRIPT = String.raw`
// Pure builders: data + translator in, DOM out. Views compose these; nothing
// here reads application state or performs a request.
import { h, icon, node } from "/assets/js/dom.js";
import { formatDateTime, relativeTime } from "/assets/js/format.js";
import { renderMarkdown } from "/assets/js/markdown.js";

// Generated from the server catalogs, not a second product registry.
const adapterLabels = ${JSON.stringify(Object.fromEntries(AGENT_ADAPTER_CATALOG.map(({ id, label }) => [id, label])))};
const componentLabels = ${JSON.stringify(Object.fromEntries(AGENT_EXECUTION_COMPONENT_CATALOG.map(({ id, label }) => [id, label])))};
export function agentLabel(component, adapterId) {
  return component ? componentLabels[component] || component : adapterLabels[adapterId] || adapterId;
}

// --- Vocabulary ----------------------------------------------------------------
// A translated label for a domain value; unknown values stay visible verbatim
// instead of being hidden or guessed.
export function label(t, prefix, value) {
  if (value === undefined || value === null || value === "") return "—";
  return t(prefix + "." + value, String(value).replace(/[-_]/g, " "));
}

const TONES = {
  task: { draft: "warn", active: "info", completed: "ok", cancelled: "idle", archived: "idle" },
  exec: {
    "needs-leader-action": "accent", "waiting-on-agents": "info", "waiting-user": "warn",
    recovering: "warn", attention: "bad", "progressing-with-attention": "warn", blocked: "bad",
    conflicted: "warn", working: "info", completed: "ok", retired: "idle", cancelled: "idle",
    accepted: "ok", open: "info", archived: "idle"
  },
  run: { active: "info", completed: "ok", failed: "bad" },
  work: { open: "info", accepted: "ok", retired: "idle" },
  review: { pending: "idle", running: "info", completed: "ok", failed: "bad" },
  job: { queued: "idle", running: "info", succeeded: "ok", failed: "bad", "timed-out": "bad",
    cancelled: "idle", "unknown-needs-attention": "warn" },
  session: { active: "ok", waiting: "warn", quiet: "idle", diagnostic: "bad", unknown: "idle",
    stopped: "bad", idle: "idle", background: "warn" },
  role: { running: "ok", waiting: "warn", idle: "idle", unknown: "idle", failed: "bad", exited: "idle", detached: "idle" },
  decision: { active: "ok", superseded: "idle" },
  input: { open: "warn", answered: "ok", cancelled: "idle", "auto-resolved": "ok" }
};
export function tone(kind, value) {
  return (TONES[kind] && TONES[kind][value]) || "idle";
}

export function badge(text, toneName, options) {
  const element = h("span.badge.tone-" + (toneName || "idle"), null,
    options && options.dot ? h("i.badge-dot", { "aria-hidden": "true" }) : null, text);
  if (options && options.title) element.title = options.title;
  return element;
}

export function statusBadge(t, kind, prefix, value) {
  const element = badge(label(t, prefix, value), tone(kind, value), { dot: true });
  element.dataset.status = value;
  return element;
}

export function dot(toneName, title) {
  const element = h("span.dot.tone-" + (toneName || "idle"), { "aria-hidden": title ? null : "true" });
  if (title) { element.title = title; element.setAttribute("role", "img"); element.setAttribute("aria-label", title); }
  return element;
}

export function chip(text, extraClass) {
  return h("span.chip" + (extraClass ? "." + extraClass : ""), null, text);
}

export function mono(text, extraClass) {
  return h("code.id" + (extraClass ? "." + extraClass : ""), null, text);
}

export function timeTag(iso, locale, t, options) {
  if (!iso) return null;
  const element = h("time.when", { dateTime: iso }, options && options.absolute
    ? formatDateTime(iso, locale) : relativeTime(iso, locale, t));
  element.title = formatDateTime(iso, locale);
  return element;
}

// --- Containers -------------------------------------------------------------------
export function card(options) {
  const opts = options || {};
  const element = h("section.card" + (opts.className ? "." + opts.className.split(" ").join(".") : ""));
  if (opts.id) element.id = opts.id;
  if (opts.title || opts.actions) {
    const head = h("header.card-head", null,
      h("h3.card-title", null, opts.icon ? icon(opts.icon) : null, h("span", null, opts.title),
        opts.count !== undefined && opts.count !== null ? h("span.count", null, String(opts.count)) : null),
      opts.actions ? h("div.card-actions", null, opts.actions) : null);
    if (opts.hint) head.append(h("p.card-hint", null, opts.hint));
    element.append(head);
  }
  const body = h("div.card-body");
  element.append(body);
  element.body = body;
  return element;
}

export function disclosure(title, viewKey, options) {
  const opts = options || {};
  const element = h("details.disclosure" + (opts.className ? "." + opts.className : ""));
  if (viewKey) element.dataset.viewKey = viewKey;
  const summary = h("summary", null, icon("chevron", "disclosure-chevron"), h("span.disclosure-title", null, title));
  if (opts.meta) summary.append(h("span.disclosure-meta", null, opts.meta));
  element.append(summary);
  const body = h("div.disclosure-body");
  element.append(body);
  element.body = body;
  return element;
}

export function sectionTitle(text, count, actions) {
  return h("div.section-title", null, h("h2", null, text,
    count !== undefined && count !== null ? h("span.count", null, String(count)) : null),
  actions ? h("div.section-actions", null, actions) : null);
}

export function kv(rows) {
  const list = h("dl.kv");
  rows.forEach(function (row) {
    if (!row || row[1] === undefined || row[1] === null || row[1] === "") return;
    list.append(h("dt", null, row[0]), h("dd", null, row[1]));
  });
  return list;
}

export function emptyState(text, iconName, extra) {
  return h("div.empty", null, iconName ? icon(iconName) : null, h("p", null, text), extra || null);
}

export function note(text, toneName) {
  return h("p.note" + (toneName ? ".tone-" + toneName : ""), null, text);
}

export function button(text, options) {
  const opts = options || {};
  const element = h("button.btn" + (opts.variant ? ".btn-" + opts.variant : ""), {
    type: opts.type || "button", onclick: opts.onClick, disabled: !!opts.disabled, title: opts.title
  }, opts.icon ? icon(opts.icon) : null, text ? h("span", null, text) : null);
  if (opts.dataset) Object.assign(element.dataset, opts.dataset);
  return element;
}

// --- Rich text ---------------------------------------------------------------------
function shouldCollapse(text, threshold) {
  const value = String(text);
  if (value.length > (threshold || 700)) return true;
  let lines = 0;
  for (let index = 0; index < value.length; index += 1) if (value[index] === "\n") lines += 1;
  return lines > 12;
}

export function richText(title, text, t, options) {
  if (!text) return null;
  const opts = options || {};
  const block = h("div.prose-block" + (opts.className ? "." + opts.className : ""));
  if (title) block.append(h("h4.prose-label", null, title));
  const body = h("div.md" + (opts.muted ? ".muted" : ""));
  body.innerHTML = renderMarkdown(text);
  block.append(body);
  if (shouldCollapse(text, opts.threshold)) {
    block.classList.add("is-collapsed");
    const toggle = h("button.link-btn", { type: "button" }, t("actions.showMore"));
    toggle.addEventListener("click", function () {
      const collapsed = block.classList.toggle("is-collapsed");
      toggle.textContent = t(collapsed ? "actions.showMore" : "actions.showLess");
    });
    block.append(toggle);
  }
  return block;
}

export function bulletList(items, className) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  return h("ul.bullets" + (className ? "." + className : ""), null, list.map(function (item) { return h("li", null, item); }));
}

// First page of a long list plus an in-place "show more".
export function pagedList(container, items, pageSize, renderItem, t) {
  let shown = 0;
  let more = null;
  function renderChunk() {
    items.slice(shown, shown + pageSize).forEach(function (item) { container.insertBefore(renderItem(item), more); });
    shown = Math.min(items.length, shown + pageSize);
    if (!more) return;
    const remaining = items.length - shown;
    if (remaining <= 0) { more.remove(); more = null; }
    else more.textContent = t("actions.showRemaining").replace("{count}", String(remaining));
  }
  if (items.length > pageSize) {
    more = h("button.show-more", { type: "button", onclick: renderChunk });
    container.append(more);
  }
  renderChunk();
}

// --- Metrics (DOM built with node() only; executed by the usage test) -------------
export function metricTile(labelText, value, options) {
  const variant = options && options.tone ? " tone-" + options.tone : "";
  const tile = node("div", "metric" + variant);
  tile.append(node("span", "metric-label", labelText), node("strong", "metric-value", String(value)));
  return tile;
}

export function usageMetricText(metric, t, suffix) {
  if (!metric || metric.value == null) return t("detail.unobserved");
  return metric.value + (suffix || "") + (metric.status === "partial" ? " · " + t("detail.partial") : "");
}

function usageTile(labelText, metric, t, suffix) {
  const tile = metricTile(labelText, usageMetricText(metric, t, suffix));
  if (metric && metric.reasons && metric.reasons.length) {
    tile.append(node("small", "metric-note", metric.reasons.map(function (reason) {
      return t("usage.reason." + reason);
    }).join("; ")));
  }
  return tile;
}

export function observabilityMetricCard(observability, t) {
  if (!observability) return null;
  const wrap = node("div", "usage");
  const grid = node("div", "metric-grid");
  const cost = observability.cost || {};
  const context = observability.context || {};
  grid.append(usageTile(t("usage.tokens"), cost.tokens, t));
  grid.append(usageTile(t("usage.toolCalls"), cost.toolCalls, t));
  grid.append(usageTile(t("usage.elapsed"), cost.elapsedSeconds, t, "s"));
  grid.append(usageTile(t("usage.executionSum"), cost.executionSeconds, t, "s"));
  grid.append(metricTile(t("usage.ready"), ((observability.dag && observability.dag.readyIds) || []).length));
  grid.append(metricTile(t("usage.contextSnapshots"), context.snapshotCount == null ? t("detail.unobserved") : context.snapshotCount));
  wrap.append(grid);
  const meta = node("p", "usage-meta");
  meta.append(node("span", "", t("usage.scope")));
  meta.append(node("span", "", t("usage.observedThrough") + " "
    + (cost.observedThrough ? formatDateTime(cost.observedThrough) : t("detail.unobserved"))));
  meta.append(node("span", "", t("usage.contextBytes") + " "
    + (context.totalBytes == null ? t("detail.partial") : context.totalBytes + " B")));
  wrap.append(meta);
  return wrap;
}

// --- Agent identity ------------------------------------------------------------------
export function agentChips(agent) {
  if (!agent) return null;
  const chips = [];
  if (agent.adapterId || agent.component) chips.push(chip(agentLabel(agent.component, agent.adapterId), "chip-strong"));
  if (agent.model) chips.push(chip(agent.model));
  if (agent.effort) chips.push(chip(agent.effort));
  return chips.length ? h("span.chip-row", null, chips) : null;
}

// --- Input requests ----------------------------------------------------------------
export function inputCard(input, t, locale, onAnswer) {
  const policy = input.policy && input.policy.kind;
  const element = h("article.input-card");
  element.append(h("div.input-head", null,
    h("span.input-kicker", null, icon("inbox", "icon-sm"), t("input.kicker")),
    policy ? badge(label(t, "input", policy), policy === "required" ? "bad" : "warn") : null,
    input.policy && input.policy.timeoutAt
      ? h("span.input-timeout", null, icon("clock", "icon-sm"),
        t("input.timeoutAt") + " " + relativeTime(input.policy.timeoutAt, locale, t)) : null,
    timeTag(input.createdAt, locale, t)));
  element.append(h("p.input-question", null, input.question));
  const facts = [];
  if (input.requester) facts.push(t("input.from") + " " + input.requester.roleName
    + " · " + (input.requester.runId || input.requester.nativeSessionId || ""));
  if (input.blockedRefs && input.blockedRefs.length) facts.push(t("input.blocks") + " "
    + input.blockedRefs.map(function (ref) { return ref.type + " " + ref.id; }).join(", "));
  if (facts.length) element.append(h("p.input-facts", null, facts.join("  ·  ")));
  const recommended = input.policy && input.policy.recommendedChoiceKey;
  if (input.choices && input.choices.length) {
    element.append(h("div.input-choices", null, input.choices.map(function (choice) {
      return h("button.choice" + (choice.key === recommended ? ".is-recommended" : ""), {
        type: "button",
        onclick: function (event) { onAnswer(input, { choiceKey: choice.key }, event.currentTarget); }
      }, h("span", null, choice.label), choice.key === recommended ? badge(t("input.recommended"), "accent") : null);
    })));
  } else {
    const field = h("input", { type: "text", required: true, placeholder: t("input.freeText"), maxLength: 8000 });
    const form = h("form.input-form", null, field,
      h("button.btn.btn-primary", { type: "submit" }, icon("send"), h("span", null, t("actions.answer"))));
    form.addEventListener("input", function () { form.dataset.unsent = field.value ? "true" : "false"; });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      const text = field.value.trim();
      if (text) onAnswer(input, { text: text }, form.querySelector("button"));
    });
    element.append(form);
  }
  return element;
}

// --- Records -----------------------------------------------------------------------
export function workItemCard(item, t, locale, titles) {
  const settled = item.status !== "open";
  const element = h(settled ? "details.work-card.is-settled" : "article.work-card");
  element.dataset.viewKey = "work:" + item.id;
  const head = h(settled ? "summary.work-head" : "header.work-head", null,
    settled ? icon("chevron", "disclosure-chevron") : null,
    dot(tone("work", item.status)),
    h("span.work-title", null, item.title),
    statusBadge(t, "work", "work", item.status));
  element.append(head);
  const body = h("div.work-body");
  body.append(h("div.meta-line", null,
    item.assignee ? h("span.meta-strong", null, icon("user", "icon-sm"), item.assignee) : null,
    mono(item.id), timeTag(item.updatedAt, locale, t)));
  if (item.objective && item.objective !== item.title) body.append(richText(t("work.objective"), item.objective, t));
  if (item.acceptance && item.acceptance.length) {
    body.append(h("div.prose-block", null, h("h4.prose-label", null, t("work.acceptance")),
      h("ul.checklist", null, item.acceptance.map(function (entry) {
        return h("li" + (item.status === "accepted" ? ".is-done" : ""), null, icon(item.status === "accepted" ? "check" : "target", "icon-sm"), h("span", null, entry));
      }))));
  }
  const deps = (item.dependsOn || []).map(function (id) { return (titles && titles[id]) || id; });
  if (deps.length) body.append(h("div.meta-line", null, h("span.meta-label", null, t("work.dependsOn")), deps.map(function (d) { return chip(d); })));
  if (item.writeProjectIds && item.writeProjectIds.length) {
    body.append(h("div.meta-line", null, h("span.meta-label", null, t("work.writeProjects")), item.writeProjectIds.map(function (d) { return chip(d); })));
  }
  if (item.candidates && item.candidates.length) {
    body.append(h("div.prose-block", null, h("h4.prose-label", null, t("work.candidates")),
      h("ol.candidates", null, item.candidates.slice().sort(function (a, b) { return b.sequence - a.sequence; }).map(function (candidate) {
        return h("li", null, h("span.candidate-seq", null, "#" + candidate.sequence), h("span", null, candidate.summary),
          h("span.faint", null, candidate.source && candidate.source.type === "run" ? candidate.source.runId : t("work.direct")),
          timeTag(candidate.createdAt, locale, t));
      }))));
  }
  if (item.disposition) {
    body.append(note(t("work.disposition") + ": " + item.disposition.summary
      + (item.disposition.replacementWorkItemId ? " → " + item.disposition.replacementWorkItemId : "")));
  }
  if (item.outcome) body.append(richText(t("work.outcome"), item.outcome, t, { className: "callout" }));
  element.append(body);
  return element;
}

export function runCard(run, t, locale) {
  const element = h("article.run-card");
  element.dataset.status = run.status;
  const input = run.inputs && run.inputs.length ? run.inputs[0].input : null;
  element.append(h("header.run-head", null,
    dot(tone("run", run.status)),
    h("span.run-role", null, run.roleName),
    mono(run.id),
    run.purpose ? chip(label(t, "run.purpose", run.purpose)) : null,
    run.workItemId ? chip(run.workItemId) : null,
    h("span.spacer"),
    statusBadge(t, "run", "run", run.status)));
  element.append(h("div.meta-line", null,
    h("span", null, t("run.delivery") + ": " + label(t, "run.delivery", (run.execution && run.execution.delivery) || "unobserved")),
    run.mode ? h("span", null, label(t, "mode", run.mode)) : null,
    timeTag((run.result && run.result.completedAt) || run.updatedAt, locale, t),
    agentChips(run.effective || (run.agentId ? run : null))));
  const directive = input && (input.directive || input.action);
  if (directive) element.append(richText(t("run.instruction"), directive, t, { threshold: 320 }));
  if (run.result && run.result.output) element.append(richText(t("run.output"), run.result.output, t, { threshold: 320, className: "callout" }));
  if (run.result && run.result.diagnostic) element.append(richText(t("run.failure"), run.result.diagnostic, t, { threshold: 320, className: "callout.tone-bad" }));
  if (run.executionGroupId) {
    element.append(h("p.faint.mono-line", null, t("run.lineage") + " " + run.executionGroupId + (run.executionLaneId ? "/" + run.executionLaneId : "")));
  }
  return element;
}

export function reviewCard(round, t, locale) {
  const element = h("article.review-card");
  element.append(h("header.run-head", null,
    dot(tone("review", round.status)),
    h("span.run-role", null, round.reviewerRoleName || t("review.reviewer")),
    mono(round.id),
    round.scope ? chip(label(t, "review.scope", round.scope)) : null,
    h("span.spacer"),
    statusBadge(t, "review", "review", round.status)));
  element.append(h("div.meta-line", null,
    round.workItemId ? mono(round.workItemId + (round.candidateId ? " · " + round.candidateId : "")) : null,
    round.reviewBaseCommit ? h("span", null, t("review.base") + " ", mono(String(round.reviewBaseCommit).slice(0, 12))) : null,
    round.reviewerRunId ? h("span", null, t("review.run") + " ", mono(round.reviewerRunId)) : null,
    timeTag(round.createdAt, locale, t)));
  if (round.failure) element.append(note(round.failure.kind + ": " + round.failure.message, "bad"));
  return element;
}

export function roleCard(role, t, locale, options) {
  const opts = options || {};
  const session = opts.runtimeRole && opts.runtimeRole.runtimeSession;
  const element = h("article.role-card");
  const binding = role.agentBindings && role.agentBindings[role.activeAgentId];
  element.append(h("header.role-head", null,
    h("span.avatar", { "aria-hidden": "true" }, String(role.name || "?").slice(0, 1).toUpperCase()),
    h("div.role-title", null, h("strong", null, role.name),
      h("span.faint", null, role.activeAgentId || "")),
    opts.status ? statusBadge(t, "role", "role", opts.status) : null));
  if (binding) element.append(agentChips({
    adapterId: binding.adapterId, component: binding.component,
    model: binding.config && binding.config.model, effort: binding.config && binding.config.effort
  }));
  if (role.description) element.append(richText(null, role.description, t, { muted: true, threshold: 280 }));
  const rows = [];
  rows.push([t("role.session"), session && session.nativeSessionId ? mono(session.nativeSessionId) : t("role.noSession")]);
  if (role.launchRevision !== undefined) rows.push([t("role.desired"), "r" + role.launchRevision + (opts.launchDrift ? " · " + t("role.drift") : "")]);
  if (role.defaultAccess !== undefined) rows.push([t("role.access"), role.defaultAccess]);
  if (opts.retry) rows.push([t("role.providerRetry"), label(t, "retry", opts.retry.status) + " · "
    + opts.retry.attempts + "/" + opts.retry.limit
    + (opts.retry.status === "waiting" && opts.retry.nextEligibleAt ? " · " + formatDateTime(opts.retry.nextEligibleAt, locale) : "")]);
  if (role.skills && role.skills.length) rows.push([t("role.skills"), h("span.chip-row", null, role.skills.map(function (s) { return chip(s); }))]);
  element.append(kv(rows));
  if (opts.onOpen) {
    element.append(h("div.role-actions", null, button(t("role.openSession"), {
      icon: "terminal", variant: "ghost", onClick: function () { opts.onOpen(role.name); }
    })));
  }
  return element;
}
`;
