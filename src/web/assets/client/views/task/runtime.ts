export const TASK_RUNTIME_SCRIPT = String.raw`
// Task › Runtime: what is live now — Roles and their Sessions, the redirect
// control, open execution, open operations, usage and diagnostics. Session
// lines, counts and raw facts are [data-slot]s the observation fills in.
import { h } from "/assets/js/lib/dom.js";
import { fill } from "/assets/js/lib/format.js";
import { dot, emptyState, mono, note, timeTag } from "/assets/js/ui/primitives.js";
import { card, cardDisclosure, listCard } from "/assets/js/ui/containers.js";
import { observabilityMetricCard } from "/assets/js/ui/metrics.js";
import { statusBadge, tone } from "/assets/js/domain/vocab.js";
import { cachedExact, entriesOf, exactCache, totalOf } from "/assets/js/domain/context.js";
import { exactRow, recordCard } from "/assets/js/domain/records.js";
import { roleCard, runCard } from "/assets/js/domain/runs.js";
import { controlForm } from "/assets/js/domain/taskForms.js";

export function renderRuntime(panel, data, t, locale, ctx) {
  exactCache(data.viewState);
  const roleEntries = entriesOf(data.core, "role");
  panel.append(rolesCard(data, roleEntries, t, locale, ctx));
  panel.append(controlCard(data.task, roleEntries, t, ctx));
  panel.append(runsCard(data, t, locale, ctx));
  panel.append(jobsCard(data, t, locale, ctx));
  panel.append(usageCard(data, t));
  panel.append(diagnosticsCard(data.core, t));
}

// --- Roles -------------------------------------------------------------------
function rolesCard(data, roleEntries, t, locale, ctx) {
  const runs = knownRuns(data);
  const roles = listCard({
    id: "detail-roles", title: t("roles.title"), icon: "user", count: totalOf(data.core, "role"), hint: t("roles.hint"),
    actions: h("div.chip-row", { dataset: { slot: "session-counts" } })
  });
  roleEntries.forEach(function (entry) {
    roles.list.append(entry.omitted ? recordCard(entry, data.task.id, t, ctx) : roleRow(entry, data, runs, t, locale, ctx));
  });
  if (!roleEntries.length) roles.list.append(emptyState(t("records.none")));
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
  const runEntries = entriesOf(data.core, "run");
  const runTotal = totalOf(data.core, "run");
  const runList = listCard({ id: "detail-exec", title: t("runs.title"), icon: "pulse", count: runTotal || null, hint: t("runs.hint") });
  if (!runEntries.length) runList.list.append(emptyState(t("runs.none"), "pulse"));
  runEntries.forEach(function (entry) {
    runList.list.append(exactRow(entry, data.task.id, t, ctx, data.viewState.exact, function (value, result) {
      return runCard({ ...value, execution: (result && result.execution) || entry.execution }, t, locale);
    }));
  });
  if (runTotal > runEntries.length) runList.list.append(note(fill(t("runs.more"), { count: runTotal - runEntries.length })));
  return runList;
}

function jobsCard(data, t, locale, ctx) {
  const jobs = entriesOf(data.core, "job");
  const jobTotal = totalOf(data.core, "job");
  const jobList = listCard({
    id: "detail-operations", title: t("jobs.title"), icon: "refresh", count: jobTotal || null,
    hint: jobTotal ? t("jobs.hint") : null
  });
  if (!jobs.length) jobList.list.append(emptyState(t("jobs.none")));
  jobs.forEach(function (entry) {
    jobList.list.append(exactRow(entry, data.task.id, t, ctx, data.viewState.exact, function (job) { return jobRecord(job, data.task, t, locale); }));
  });
  return jobList;
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
  const metrics = data.runtime && observabilityMetricCard(data.runtime.observability, t);
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
