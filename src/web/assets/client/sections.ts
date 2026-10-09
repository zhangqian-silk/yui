export const SECTIONS_SCRIPT = String.raw`
// The Runtime and Records tabs. Runtime is what is live now (Roles and their
// Sessions, open execution, open operations, usage, diagnostics); Records is
// what happened (a paged timeline of decisions, milestones, executions and
// questions) plus Task facts. Every #detail-* anchor stays addressable via
// ?section=.
import { h, icon, clear } from "/assets/js/dom.js";
import { formatDateTime } from "/assets/js/format.js";
import {
  card, listCard, filterChips, disclosure, emptyState, note, button, statusBadge, label, tone, dot, chip, mono,
  kv, richText, runCard, runBody, roleCard, timeTag, observabilityMetricCard
} from "/assets/js/components.js";
import {
  entriesOf, totalOf, summaryFields, exactRow, lazyRow, recordCard, familyState, loadFamily
} from "/assets/js/records.js";
import { controlForm, titleForm } from "/assets/js/forms.js";

// --- Runtime ----------------------------------------------------------------------
export function renderRuntime(panel, data, t, locale, ctx) {
  const core = data.core;
  const task = data.task;
  const view = data.viewState;
  view.exact = view.exact || {};
  const runtimeRoles = (data.runtime && data.runtime.roles) || [];
  // Active runs already read exactly (this view or an earlier render).
  const knownRuns = entriesOf(core, "run").map(function (entry) {
    const hit = view.exact["run/" + entry.ref.refId];
    return hit && hit.digest === entry.ref.digest && hit.result ? hit.result.value : null;
  }).filter(Boolean);

  const roleEntries = entriesOf(core, "role");
  const roles = listCard({
    id: "detail-roles", title: t("roles.title"), icon: "user", count: totalOf(core, "role"), hint: t("roles.hint"),
    actions: h("div.chip-row", { dataset: { slot: "session-counts" } })
  });
  roleEntries.forEach(function (entry) {
    if (entry.omitted) { roles.list.append(recordCard(entry, task.id, t, ctx)); return; }
    const role = entry.value;
    const active = knownRuns.find(function (run) { return run.roleName === role.name && run.status === "active"; });
    const runtimeRole = runtimeRoles.find(function (item) { return item.name === role.name; });
    const element = roleCard(role, t, locale, {
      runtimeRole: runtimeRole,
      retry: entry.providerRetry,
      launchDrift: active && active.effective && active.effective.sourceDesiredRevision !== role.launchRevision,
      onOpen: task.status === "archived" ? null : ctx.openSession
    });
    const head = element.querySelector(".role-head");
    head.append(h("span", { dataset: { roleStatus: role.name } }));
    head.after(h("div.role-session", { dataset: { roleSession: role.name } }));
    roles.list.append(element);
  });
  if (!roleEntries.length) roles.list.append(emptyState(t("records.none")));
  panel.append(roles);

  const redirect = disclosure(t("control.title"), "control", { className: "card-disclosure", meta: t("control.meta") });
  redirect.id = "detail-control";
  redirect.body.append(note(t("control.help")), controlForm(task, t, ctx, roleEntries.map(function (entry) { return entry.ref.refId; })));
  panel.append(redirect);

  const runEntries = entriesOf(core, "run");
  const runTotal = totalOf(core, "run");
  const runList = listCard({ id: "detail-exec", title: t("runs.title"), icon: "pulse", count: runTotal || null, hint: t("runs.hint") });
  if (!runEntries.length) runList.list.append(emptyState(t("runs.none"), "pulse"));
  runEntries.forEach(function (entry) {
    runList.list.append(exactRow(entry, task.id, t, ctx, view.exact, function (value, result) {
      return runCard({ ...value, execution: (result && result.execution) || entry.execution }, t, locale);
    }));
  });
  if (runTotal > runEntries.length) runList.list.append(note(t("runs.more").replace("{count}", String(runTotal - runEntries.length))));
  panel.append(runList);

  const jobs = entriesOf(core, "job");
  const jobTotal = totalOf(core, "job");
  const jobList = listCard({
    id: "detail-operations", title: t("jobs.title"), icon: "refresh", count: jobTotal || null,
    hint: jobTotal ? t("jobs.hint") : null
  });
  if (!jobs.length) jobList.list.append(emptyState(t("jobs.none")));
  jobs.forEach(function (entry) {
    jobList.list.append(exactRow(entry, task.id, t, ctx, view.exact, function (job) {
      return h("article.record", null,
        h("header.record-head", null, dot(tone("job", job.status)), mono(task.id + "/" + job.id), h("span.spacer"),
          statusBadge(t, "job", "job", job.status)),
        h("p.small", null, t("job." + job.status + ".note", t("job.terminal.note"))),
        h("p.faint.small", null, (job.steps || []).map(function (step) { return step.name; }).join(" → ")),
        timeTag(job.terminalAt || job.startedAt || job.createdAt, locale, t));
    }));
  });
  panel.append(jobList);

  const usage = card({ id: "detail-usage", title: t("usage.title"), icon: "clock" });
  const usageBody = h("div", { dataset: { slot: "usage" } });
  const metrics = data.runtime && observabilityMetricCard(data.runtime.observability, t);
  usageBody.append(metrics || emptyState(t("usage.unavailable")));
  usage.body.append(usageBody);
  panel.append(usage);

  const diagnostics = disclosure(t("diagnostics.title"), "diagnostics", { className: "card-disclosure", meta: t("diagnostics.meta") });
  diagnostics.id = "detail-diagnostics";
  diagnostics.body.append(note(t("observation.help")));
  (core.observations || []).forEach(function (observation) {
    diagnostics.body.append(h("p.small.mono-line", null,
      observation.source + " · " + observation.status + " · " + observation.coverage + " · " + observation.observedAt));
  });
  diagnostics.body.append(h("div.stack", { dataset: { slot: "session-facts" } }),
    h("p.faint.small", { dataset: { slot: "runtime-status" } }), h("pre.code-block", { dataset: { slot: "runtime-raw" } }));
  panel.append(diagnostics);
}

// --- Records ----------------------------------------------------------------------
// One timeline over four Context families, read as paged summaries. Messages
// live in the Discussion dock. Ascending families are read in full (bounded);
// descending runs page on request, and older rows of other families are held
// back until the run pages reach them so the merged order stays honest.
const TIMELINE = [
  { kind: "decision", store: "task-decision", icon: "check", ascending: true },
  { kind: "milestone", store: "task-milestone", icon: "flag", ascending: true },
  { kind: "run", store: "run", icon: "pulse", ascending: false },
  { kind: "question", store: "input-request", icon: "inbox", ascending: true }
];
const FULL_PAGES = 5;

function at(item) { return Date.parse(item.createdAt || 0) || 0; }

export function renderRecords(panel, data, t, locale, ctx) {
  const core = data.core;
  const task = data.task;
  const view = data.viewState;
  view.panels = view.panels || {};
  view.panels.records = panel;
  view.exact = view.exact || {};
  view.openRows = view.openRows || {};
  if (!TIMELINE.some(function (family) { return family.kind === view.recordsFilter; })) view.recordsFilter = "all";
  // Values the current snapshot already carries need no read.
  const known = {};
  core.records.forEach(function (entry) { if (!entry.omitted) known[entry.ref.store + "/" + entry.ref.refId] = entry; });

  const history = card({
    id: "detail-history", title: t("history.title"), icon: "history", hint: t("history.hint"),
    actions: filterChips(t("history.filter"), [{ value: "all", label: t("history.all") }].concat(TIMELINE.map(function (family) {
      return { value: family.kind, label: t("history." + family.kind) };
    })), view.recordsFilter, function (value) { view.recordsFilter = value; draw(); })
  });
  const list = h("ol.timeline");
  const foot = h("div.list-foot");
  history.body.append(list, foot);

  function families() {
    return TIMELINE.filter(function (family) { return view.recordsFilter === "all" || view.recordsFilter === family.kind; });
  }
  function draw() {
    clear(list);
    clear(foot);
    history.querySelectorAll(".chip-tab").forEach(function (chipButton) {
      chipButton.setAttribute("aria-pressed", String(chipButton.dataset.filter === view.recordsFilter));
    });
    const selected = families();
    const states = selected.map(function (family) { return { family: family, state: familyState(view, family.store) }; });
    let horizon = -Infinity;
    states.forEach(function (row) {
      if (row.state.nextCursor && !row.family.ascending && row.state.items.length) {
        horizon = Math.max(horizon, Math.min.apply(null, row.state.items.map(at)));
      }
    });
    const items = [];
    states.forEach(function (row) {
      row.state.items.forEach(function (item) { if (at(item) >= horizon) items.push({ family: row.family, item: item }); });
    });
    items.sort(function (a, b) { return at(b.item) - at(a.item); });
    const loading = states.some(function (row) { return row.state.pending && !row.state.pages; });
    const loaded = states.every(function (row) { return row.state.pages || row.state.error; });
    states.forEach(function (row) {
      if (row.state.error) list.append(h("li.timeline-empty", null, note(t("history." + row.family.kind) + " · " + t("records.unavailable") + " " + row.state.error, "bad")));
    });
    if (!items.length) {
      list.append(h("li.timeline-empty", null, emptyState(loading || !loaded ? t("history.loading") : t("records.none"), "history")));
    }
    items.forEach(function (row) { list.append(timelineItem(row.family, row.item)); });
    const total = states.reduce(function (sum, row) { return sum + (row.state.total || 0); }, 0);
    if (!loaded) return;
    foot.append(h("span.faint.small", null, t("history.loaded").replace("{shown}", String(items.length)).replace("{total}", String(total))));
    const stale = states.some(function (row) { return row.state.key && row.state.key !== core.coreCursor; });
    if (stale) {
      foot.append(button(t("history.stale"), { icon: "refresh", variant: "ghost", onClick: function () { show(true); } }));
    }
    if (states.some(function (row) { return row.state.nextCursor; })) {
      const more = button(t("history.more"), { icon: "chevron", variant: "ghost" });
      more.addEventListener("click", function () {
        more.disabled = true;
        Promise.all(states.filter(function (row) { return row.state.nextCursor; }).map(function (row) {
          return loadFamily(view, task.id, row.family.store, row.state.key, ctx, { more: true, limit: 40 });
        })).then(refresh);
      });
      foot.append(more);
    }
  }

  function timelineItem(family, item) {
    const fields = summaryFields(item.summary);
    const entry = known[item.ref.store + "/" + item.ref.refId];
    const value = entry && entry.ref.digest === item.ref.digest ? entry.value : null;
    const element = h("li.timeline-item.kind-" + family.kind);
    element.append(h("span.timeline-mark", { "aria-hidden": "true" }, icon(family.icon, "icon-sm")));
    const body = h("div.timeline-body");
    let title;
    if (family.kind === "run") title = [item.roleName || t("store.run"), item.purpose ? label(t, "run.purpose", item.purpose) : null].filter(Boolean).join(" · ");
    else if (family.kind === "question") title = fields.question || fields.title || item.ref.refId;
    else title = fields.title || item.ref.refId;
    const status = family.kind === "decision" ? statusBadge(t, "decision", "decision", item.status)
      : family.kind === "run" ? statusBadge(t, "run", "run", item.status)
        : family.kind === "question" ? statusBadge(t, "input", "inputStatus", item.status) : null;
    const head = h("div.timeline-summary", null, h("header.timeline-head", null, h("strong.timeline-title", null, title),
      family.kind === "run" ? mono(item.ref.refId) : null,
      item.workItemId ? chip(item.workItemId) : null,
      item.history === "retired" ? chip(t("history.retired")) : null,
      item.status ? status : null, h("span.spacer"), timeTag(item.createdAt, locale, t)));
    const preview = value && family.kind === "decision" ? value.rationale : fields.summary !== title ? fields.summary : null;
    if (preview) head.append(h("p.small.muted.timeline-preview", null, preview));
    // The row opens in place; its exact record is read on first open.
    body.append(lazyRow(item, task.id, t, ctx, { cache: view.exact, openRows: view.openRows, head: head, render: function (exact, result) {
      if (family.kind === "run") return h("div.stack", null, runBody({ ...exact, execution: result && result.execution }, t, locale));
      if (family.kind === "decision") return h("div.stack", null,
        exact.rationale ? richText(t("record.rationale"), exact.rationale, t, { muted: true }) : null,
        exact.supersededReason ? richText(t("history.superseded"), exact.supersededReason, t, { muted: true }) : null);
      if (family.kind === "milestone") return h("div.stack", null, exact.summary ? richText(null, exact.summary, t) : null);
      if (family.kind === "question") {
        const answer = exact.resolution && exact.resolution.answer;
        return h("div.stack", null, exact.question ? richText(null, exact.question, t) : null,
          answer ? richText(t("history.answer") + " · " + label(t, "answeredBy", exact.resolution.answeredBy),
            answer.text || answer.choiceKey, t, { muted: true }) : null,
          exact.cancellation ? note(exact.cancellation.reason) : null);
      }
      return null;
    } }));
    element.append(body);
    return element;
  }

  // Reads redraw whichever Records panel is current.
  function refresh() {
    const current = view.panels.records;
    if (current && current.isConnected) current.redraw();
  }
  function loadFull(family, key) {
    return loadFamily(view, task.id, family.store, key, ctx, { limit: 40 }).then(function (state) {
      if (!family.ascending || !state.nextCursor || state.pages >= FULL_PAGES || state.error) return state;
      return loadFamily(view, task.id, family.store, key, ctx, { more: true, limit: 40 }).then(function () { return loadFull(family, key); });
    });
  }
  // A stale first page re-reads silently; once the user paged further, the
  // read waits for an explicit refresh so their position is kept.
  function show(force) {
    const key = core.coreCursor;
    TIMELINE.forEach(function (family) {
      const state = familyState(view, family.store);
      if (state.pending || state.key === key || (!force && state.errorKey === key)) return;
      if (!force && state.key && !family.ascending && state.pages > 1) return;
      loadFull(family, key).then(refresh);
    });
    refresh();
  }
  panel.redraw = draw;
  panel.onShow = function () { show(false); };
  draw();
  panel.append(history);

  // --- Task information --------------------------------------------------------
  const facts = card({ id: "detail-facts", title: t("details.facts"), icon: "info" });
  facts.body.append(kv([
    [t("details.id"), mono(task.id)],
    [t("details.status"), statusBadge(t, "task", "status", task.status)],
    [t("details.priority"), task.priority ? label(t, "priority", task.priority) : null],
    [t("details.tags"), (task.tags || []).length ? h("span.chip-row", null, task.tags.map(function (tag) { return chip(tag); })) : null],
    [t("details.projects"), (task.projectBindings || []).length ? h("span.chip-row", null, task.projectBindings.map(function (b) { return chip(b.projectId); })) : null],
    [t("details.created"), formatDateTime(task.createdAt, locale)],
    [t("details.updated"), formatDateTime(task.updatedAt, locale)],
    [t("details.workspace"), task.cwd ? mono(task.cwd) : null]
  ]));
  facts.body.append(h("div.prose-block", null, h("h4.prose-label", null, t("details.title")), titleForm(task, t, ctx)));
  panel.append(facts);

  // --- Advanced -------------------------------------------------------------------
  const advanced = disclosure(t("advanced.title"), "advanced", { className: "card-disclosure", meta: t("advanced.meta") });
  advanced.id = "detail-advanced";
  advanced.body.append(h("h4.sub-head", null, t("details.context")), h("pre.code-block", null, JSON.stringify({
    coreCursor: core.coreCursor, throughCursor: core.throughCursor, count: core.count, collections: core.collections, omitted: core.omitted
  }, null, 2)), note(t("details.contextHelp")));
  const panels = h("div.stack");
  advanced.body.append(h("h4.sub-head", null, t("panels.title")), panels);
  let loading = false;
  let loadedPanels = false;
  advanced.addEventListener("toggle", async function () {
    if (!advanced.open || loading || loadedPanels) return;
    loading = true;
    clear(panels);
    panels.append(h("p.faint", null, t("panels.reading")));
    try {
      const current = await ctx.panels(task.id);
      clear(panels);
      panels.append(h("p.faint.small", null, t("panels.observed") + " " + formatDateTime(current.observedAt, locale)));
      if (!current.panels.length) panels.append(emptyState(t("panels.none")));
      current.panels.forEach(function (item) { panels.append(panelCard(item, task, t, ctx)); });
      loadedPanels = true;
    } catch (error) {
      clear(panels);
      panels.append(note(t("panels.unavailable") + " " + error.message, "bad"));
    } finally { loading = false; }
  });
  panel.append(advanced);
}

function panelCard(item, task, t, ctx) {
  const panel = item.panel;
  const element = h("article.record", null,
    h("header.record-head", null, h("strong", null, panel.title), h("span.spacer"), h("span.faint.small", null, item.capability + " · " + item.provider.id)));
  if (item.unavailable) { element.append(note(item.unavailable, "warn")); return element; }
  if (panel.kind === "text") element.append(h("p.small", null, panel.text));
  else if (panel.kind === "link") {
    try {
      const url = new URL(panel.href);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
        element.append(h("a.link", { href: url.href, rel: "noopener noreferrer", target: "_blank" }, panel.title));
      }
    } catch {}
  } else if (panel.kind === "data" && panel.renderer === "json") {
    const input = h("textarea.mono", { rows: 3 });
    input.value = JSON.stringify({ taskId: task.id });
    const schema = disclosure(t("panels.schema"), null);
    schema.body.append(h("pre.code-block", null, JSON.stringify(item.inputSchema, null, 2)));
    const output = h("pre.code-block");
    output.hidden = true;
    const read = button(t("panels.read"), { icon: "eye", variant: "ghost" });
    read.addEventListener("click", async function () {
      if (read.disabled) return;
      read.disabled = true;
      output.hidden = false;
      try {
        const result = await ctx.readPanel(task.id, {
          capability: item.capability, contractVersion: item.contractVersion, provider: item.provider
        }, JSON.parse(input.value));
        output.textContent = JSON.stringify(result, null, 2);
      } catch (error) { output.textContent = t("panels.unavailable") + " " + error.message; }
      finally { read.disabled = false; }
    });
    element.append(h("label.field", null, h("span", null, t("panels.input")), input), schema, h("div.form-actions", null, read), output);
  }
  return element;
}
`;
