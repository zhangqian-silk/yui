export const RUNS_SCRIPT = String.raw`
// Execution records, review rounds and Roles.
import { h } from "/assets/js/lib/dom.js";
import { formatDateTime } from "/assets/js/lib/format.js";
import { button, chip, dot, kv, mono, note, timeTag } from "/assets/js/ui/primitives.js";
import { richText } from "/assets/js/ui/text.js";
import { agentChips, label, statusBadge, tone } from "/assets/js/domain/vocab.js";

export function runCard(run, t, locale) {
  const element = h("article.run-card");
  element.dataset.status = run.status;
  element.append(h("header.run-head", null,
    dot(tone("run", run.status)),
    h("span.run-role", null, run.roleName),
    mono(run.id),
    run.purpose ? chip(label(t, "run.purpose", run.purpose)) : null,
    run.workItemId ? chip(run.workItemId) : null,
    h("span.spacer"),
    statusBadge(t, "run", "run", run.status)), runBody(run, t, locale));
  return element;
}

// What one execution record says: delivery, instruction, report, failure.
export function runBody(run, t, locale) {
  const parts = [];
  const input = run.inputs && run.inputs.length ? run.inputs[0].input : null;
  parts.push(h("div.meta-line", null,
    h("span", null, t("run.delivery") + ": " + label(t, "run.delivery", (run.execution && run.execution.delivery) || "unobserved")),
    run.mode ? h("span", null, label(t, "mode", run.mode)) : null,
    timeTag((run.result && run.result.completedAt) || run.updatedAt, locale, t),
    agentChips(run.effective || (run.agentId ? run : null))));
  const directive = input && (input.directive || input.action);
  if (directive) parts.push(richText(t("run.instruction"), directive, t, { threshold: 320 }));
  if (run.result && run.result.output) parts.push(richText(t("run.output"), run.result.output, t, { threshold: 320, className: "callout" }));
  if (run.result && run.result.diagnostic) parts.push(richText(t("run.failure"), run.result.diagnostic, t, { threshold: 320, className: "callout.tone-bad" }));
  if (run.executionGroupId) {
    parts.push(h("p.faint.mono-line", null, t("run.lineage") + " " + run.executionGroupId + (run.executionLaneId ? "/" + run.executionLaneId : "")));
  }
  parts.push(skillPackageDetails(run.effective && run.effective.skillPackages, t));
  return parts.filter(Boolean);
}

function skillPackageDetails(packages, t) {
  const details = h("details", null, h("summary", null, t("role.skills") + " · " + (packages ? packages.length : t("skills.unrecorded"))));
  if (!packages) {
    details.append(note(t("skills.legacyNote")));
    return details;
  }
  packages.forEach(function (skill) {
    details.append(h("div.record", null, h("strong", null, skill.id),
      h("p.small.mono-line", null, skill.digest),
      h("p.small", null, skill.source.kind + " · " + skill.fileCount + " " + t("skills.files") + " · " + skill.byteSize + " B"),
      h("p.small.mono-line", null, t("skills.source") + ": " + skill.source.path),
      h("p.small.mono-line", null, t("skills.snapshot") + ": " + skill.path),
      h("p.small.mono-line", null, t("skills.inventory") + ": " + skill.manifestPath)));
  });
  return details;
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
    round.taskCandidate && round.taskCandidate.projects ? round.taskCandidate.projects.map(function (project) {
      return mono(project.projectId + " @ " + String(project.commit).slice(0, 12));
    }) : null,
    round.reviewBaseCommit ? h("span", null, t("review.base") + " ", mono(String(round.reviewBaseCommit).slice(0, 12))) : null,
    round.reviewerRunId ? h("span", null, t("review.run") + " ", mono(round.reviewerRunId)) : null,
    timeTag(round.createdAt, locale, t)));
  if (round.failure) element.append(note(round.failure.kind + ": " + round.failure.message, "bad"));
  return element;
}

export function roleCard(role, t, locale, options) {
  const opts = options || {};
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
  element.append(kv(roleFacts(role, t, locale, opts)));
  if (opts.runtimeRole && opts.runtimeRole.runtimeSession) {
    element.append(skillPackageDetails(opts.runtimeRole.runtimeSession.skillPackages, t));
  }
  if (opts.onOpen) {
    element.append(h("div.role-actions", null, button(t("role.openSession"), {
      icon: "terminal", variant: "ghost", onClick: function () { opts.onOpen(role.name); }
    })));
  }
  return element;
}

function roleFacts(role, t, locale, opts) {
  const session = opts.runtimeRole && opts.runtimeRole.runtimeSession;
  const rows = [];
  rows.push([t("role.session"), session && session.nativeSessionId ? mono(session.nativeSessionId) : t("role.noSession")]);
  if (role.launchRevision !== undefined) rows.push([t("role.desired"), "r" + role.launchRevision + (opts.launchDrift ? " · " + t("role.drift") : "")]);
  if (role.defaultAccess !== undefined) rows.push([t("role.access"), role.defaultAccess]);
  if (opts.retry) rows.push([t("role.providerRetry"), label(t, "retry", opts.retry.status) + " · "
    + opts.retry.attempts + "/" + opts.retry.limit
    + (opts.retry.status === "waiting" && opts.retry.nextEligibleAt ? " · " + formatDateTime(opts.retry.nextEligibleAt, locale) : "")]);
  if (role.skills && role.skills.length) rows.push([t("role.skills"), h("span.chip-row", null, role.skills.map(function (s) { return chip(s); }))]);
  return rows;
}
`;
