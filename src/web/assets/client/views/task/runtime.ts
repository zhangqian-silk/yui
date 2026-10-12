export const TASK_RUNTIME_SCRIPT = String.raw`
// Task › Runtime: what is live now — Roles and their Sessions, the redirect
// control, open execution, open operations, usage and diagnostics. Session
// lines, counts and raw facts are [data-slot]s the observation fills in.
import { h } from "/assets/js/lib/dom.js";
import { dot, button, emptyState, mono, note, timeTag } from "/assets/js/ui/primitives.js";
import { card, cardDisclosure } from "/assets/js/ui/containers.js";
import { observabilityMetricCard } from "/assets/js/ui/metrics.js";
import { statusBadge, tone } from "/assets/js/domain/vocab.js";
import { cachedExact, entriesOf, exactCache } from "/assets/js/domain/context.js";
import { currentRecordCard } from "/assets/js/domain/records.js";
import { roleCard, runCard } from "/assets/js/domain/runs.js";
import { controlForm } from "/assets/js/domain/taskForms.js";

export function renderRuntime(panel, data, t, locale, ctx) {
  exactCache(data.viewState);
  const roleEntries = entriesOf(data.core, "role");
  panel.append(rolesCard(data, t, locale, ctx));
  panel.append(controlCard(data.task, roleEntries, t, ctx));
  panel.append(runsCard(data, t, locale, ctx));
  panel.append(jobsCard(data, t, locale, ctx));
  panel.append(currentRecordCard(data, "review-round", t, ctx, { id: "detail-reviews", title: t("activity.reviews") }));
  panel.append(nativeCard(data, t, ctx));
  panel.append(usageCard(data, t));
  panel.append(diagnosticsCard(data.core, t));
}

// --- Roles -------------------------------------------------------------------
function rolesCard(data, t, locale, ctx) {
  const runs = knownRuns(data);
  const roles = currentRecordCard(data, "role", t, ctx, {
    id: "detail-roles", title: t("roles.title"), icon: "user",
    render: function (role, result, entry) { return roleRow({ ...entry, value: role }, data, runs, t, locale, ctx); }
  });
  roles.list.prepend(h("div.chip-row", { dataset: { slot: "session-counts" } }));
  return roles;
}

// Active runs already read exactly (this view or an earlier render).
function knownRuns(data) {
  return entriesOf(data.core, "run").map(function (entry) {
    const hit = cachedExact(data.viewState.exact, entry);
    return hit ? hit.value : null;
  }).filter(Boolean);
}

// A Role card with the slots the observation fills: its live status in the
// head and its native Session line below it.
function roleRow(entry, data, runs, t, locale, ctx) {
  const role = entry.value;
  const active = runs.find(function (run) { return run.roleName === role.name && run.status === "active"; });
  const runtimeRole = ((data.runtime && data.runtime.roles) || []).find(function (item) { return item.name === role.name; });
  const element = roleCard(role, t, locale, {
    runtimeRole: runtimeRole,
    retry: entry.providerRetry,
    launchDrift: active && active.effective && active.effective.sourceDesiredRevision !== role.launchRevision,
    onOpen: data.task.status === "archived" ? null : ctx.openSession
  });
  const head = element.querySelector(".role-head");
  head.append(h("span", { dataset: { roleStatus: role.name } }));
  head.after(h("div.role-session", { dataset: { roleSession: role.name } }));
  return element;
}

function controlCard(task, roleEntries, t, ctx) {
  const redirect = cardDisclosure("detail-control", t("control.title"), "control", t("control.meta"));
  redirect.body.append(note(t("control.help")), controlForm(task, t, ctx, roleEntries.map(function (entry) { return entry.ref.refId; })));
  return redirect;
}

// --- Execution and operations --------------------------------------------------
function runsCard(data, t, locale, ctx) {
  return currentRecordCard(data, "run", t, ctx, {
    id: "detail-exec", title: t("runs.title"),
    render: function (value, result) { return runCard({ ...value, execution: result && result.execution }, t, locale); }
  });
}

function jobsCard(data, t, locale, ctx) {
  return currentRecordCard(data, "job", t, ctx, {
    id: "detail-operations", title: t("jobs.title"), icon: "refresh",
    render: function (job) { return jobRecord(job, data.task, t, locale); }
  });
}

function nativeCard(data, t, ctx) {
  const element = card({ id: "detail-native-activity", title: t("activity.native"), icon: "pulse" });
  let state = data.viewState.nativeActivity;
  if (!state || state.key !== data.core.coreCursor) {
    state = data.viewState.nativeActivity = { key: data.core.coreCursor, items: [], page: null, pending: false, error: null };
  }
  function draw() {
    element.body.replaceChildren(note(t("activity.scope")));
    if (!state.page) element.body.append(note(t("activity.notLoaded")));
    else {
      element.body.append(note(t("activity.loaded") + " " + state.items.length + " / " + state.page.total
        + " · " + state.page.coverage + " · " + state.page.readAt));
      if (!state.page.total) element.body.append(note(t("activity.none")));
    }
    state.items.forEach(function (item) {
      element.body.append(h("article.record", null,
        h("header.record-head", null, mono(item.roleName + " / " + item.kind), h("span.spacer"), item.status),
        h("p.small", null, item.summary),
        h("p.faint.small.mono-line", null, [item.nativeSessionId, item.runId, item.sourceUpdatedAt].filter(Boolean).join(" · ")),
        button(t("activity.openSession"), { onClick: function () { ctx.openSession(item.roleName); } })));
    });
    if (state.error) element.body.append(note(state.error + " · " + t("activity.refreshHint"), "bad"));
    const controls = h("div.chip-row");
    if (!state.page || state.page.nextCursor) controls.append(button(t("activity.more"), {
      disabled: state.pending, onClick: function () { load(!!state.page); }
    }));
    controls.append(button(t("activity.refresh"), { disabled: state.pending, onClick: function () { load(false); } }));
    element.body.append(controls);
    element.dataset.reading = String(state.pending);
  }
  async function load(more) {
    if (state.pending) return;
    state.pending = true; draw();
    try {
      const page = await ctx.activity(data.task.id, { limit: 20, ...(more ? { cursor: state.page.nextCursor } : {}) });
      state.items = more ? state.items.concat(page.items) : page.items;
      state.page = page; state.error = null;
    } catch (error) { state.error = error.message; }
    finally { state.pending = false; draw(); }
  }
  draw();
  return element;
}

function jobRecord(job, task, t, locale) {
  return h("article.record", null,
    h("header.record-head", null, dot(tone("job", job.status)), mono(task.id + "/" + job.id), h("span.spacer"),
      statusBadge(t, "job", "job", job.status)),
    h("p.small", null, t("job." + job.status + ".note", t("job.terminal.note"))),
    h("p.faint.small", null, (job.steps || []).map(function (step) { return step.name; }).join(" → ")),
    timeTag(job.terminalAt || job.startedAt || job.createdAt, locale, t));
}

// --- Usage and diagnostics -------------------------------------------------------
function usageCard(data, t) {
  const usage = card({ id: "detail-usage", title: t("usage.title"), icon: "clock" });
  const metrics = data.runtime && observabilityMetricCard(data.runtime.observability, t, data.viewState);
  usage.body.append(h("div", { dataset: { slot: "usage" } }, metrics || emptyState(t("usage.unavailable"))));
  return usage;
}

function diagnosticsCard(core, t) {
  const diagnostics = cardDisclosure("detail-diagnostics", t("diagnostics.title"), "diagnostics", t("diagnostics.meta"));
  diagnostics.body.append(note(t("observation.help")));
  (core.observations || []).forEach(function (observation) {
    diagnostics.body.append(h("p.small.mono-line", null,
      observation.source + " · " + observation.status + " · " + observation.coverage + " · " + observation.observedAt));
  });
  diagnostics.body.append(h("div.stack", { dataset: { slot: "session-facts" } }),
    h("p.faint.small", { dataset: { slot: "runtime-status" } }), h("pre.code-block", { dataset: { slot: "runtime-raw" } }));
  return diagnostics;
}
`;
