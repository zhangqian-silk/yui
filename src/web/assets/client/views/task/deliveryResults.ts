export const TASK_DELIVERY_RESULTS_SCRIPT = String.raw`
// Task › Delivery results: remote delivery per project, integration attempts
// with their checks, and retained workspaces with the cleanup command. The
// original evidence (view.evidence) replaces snapshot samples once read.
import { h, icon, clear } from "/assets/js/lib/dom.js";
import { fill, formatClock } from "/assets/js/lib/format.js";
import { badge, chip, codeBlock, dot, externalLink, mono, note, safeUrl, timeTag } from "/assets/js/ui/primitives.js";
import { card, cardDisclosure } from "/assets/js/ui/containers.js";
import { label, statusBadge, tone } from "/assets/js/domain/vocab.js";
import { cachedExact, entriesOf, readExact, totalOf, valuesOf } from "/assets/js/domain/context.js";

const DELIVERY_TONES = { merged: "ok", partial: "warn", unverified: "warn", uncovered: "warn", pending: "info", none: "idle", unavailable: "idle" };

export function newest(left, right) {
  return Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0);
}

// --- Integration and remote delivery ------------------------------------------
export function resultsSection(scope) {
  const t = scope.t;
  const delivery = card({ id: "detail-results", title: t("delivery.title"), icon: "merge", hint: t("delivery.hint") });
  const body = h("div.stack.delivery-stack");
  delivery.body.append(body);
  return { element: delivery, draw: function () { drawResults(body, scope); } };
}

// The remote delivery fact: the snapshot value, its exact read, or else the
// runtime observation.
function remoteDelivery(scope) {
  const entry = entriesOf(scope.core, "remote-delivery")[0];
  if (entry && !entry.omitted) return entry.value;
  const hit = entry && cachedExact(scope.view.exact, entry);
  if (hit) return hit.value;
  return (scope.data.runtime && scope.data.runtime.remoteDelivery) || null;
}

// Read a withheld remote delivery value once per digest, unless the
// observation already reports it.
export function readRemoteDelivery(scope) {
  const entry = entriesOf(scope.core, "remote-delivery")[0];
  if (!entry || !entry.omitted || (scope.data.runtime && scope.data.runtime.remoteDelivery)) return;
  if (!cachedExact(scope.view.exact, entry)) readExact(entry, scope.task.id, scope.ctx, scope.view.exact).then(scope.refresh, function () {});
}

function drawResults(body, scope) {
  clear(body);
  const remote = remoteDelivery(scope);
  if (remote) drawRemote(body, remote, scope.t);
  else body.append(note(scope.t("evidence.observationUnavailable")));
  drawIntegrations(body, scope);
}

function drawRemote(body, remote, t) {
  body.append(h("h4.sub-head", null, icon("package", "icon-sm"), h("span", null, t("evidence.remote")),
    badge(t("remoteDelivery." + remote.status, remote.status), DELIVERY_TONES[remote.status] || "idle", { dot: true })));
  if (remote.codeProjectCount) {
    body.append(h("p.faint.small", null, fill(t("delivery.counts"), {
      merged: remote.mergedProjectCount, verified: remote.verifiedProjectCount, total: remote.codeProjectCount
    })));
  }
  (remote.projects || []).forEach(function (project) { body.append(projectRow(project, t)); });
  if (!(remote.projects || []).length) body.append(note(t("delivery.noProjects")));
}

function drawIntegrations(body, scope) {
  const t = scope.t;
  const state = scope.view.evidence || {};
  const evidence = state.key && state.value;
  body.append(h("h4.sub-head", null, icon("merge", "icon-sm"), h("span", null, t("evidence.integrations")),
    evidence ? h("span.count", null, String(evidence.integrations.length)) : null));
  if (!evidence) {
    body.append(state.error ? note(t("evidence.originalUnavailable") + " " + state.error, "bad") : h("p.faint.small", null, t("evidence.loading")));
    return;
  }
  if (!evidence.integrations.length) body.append(note(t("evidence.noIntegrations")));
  const rows = h("div.row-stack.boxed");
  evidence.integrations.slice().sort(newest).forEach(function (attempt) { rows.append(integrationRow(attempt, t, scope.locale)); });
  if (rows.childNodes.length) body.append(rows);
  body.append(h("p.faint.small", null, t("delivery.readAt") + " " + formatClock(state.readAt, scope.locale)
    + (state.pending ? " · " + t("evidence.loading") : "")));
}

function projectRow(project, t) {
  const publication = project.publication;
  const href = publication && publication.externalUrl && safeUrl(publication.externalUrl);
  const element = h("article.record.delivery-project");
  element.append(h("header.record-head", null, icon("folder", "icon-sm"), h("strong", null, project.directory || project.projectId),
    project.coverage ? chip(label(t, "coverage", project.coverage)) : null,
    h("span.spacer"),
    publication ? (href
      ? externalLink(href, label(t, "publication", publication.externalKind) + " #" + publication.externalId)
      : mono(publication.externalKind + " " + publication.externalId)) : null));
  if (publication && publication.title) element.append(h("p.small", null, publication.title));
  if (project.reason) element.append(h("p.faint.small", null, project.reason));
  element.append(h("div.meta-line", null,
    h("span", null, t("evidence.expectedCommit") + " "), mono(project.expectedLocalCommit ? project.expectedLocalCommit.slice(0, 12) : t("common.unknown")),
    project.state ? chip(label(t, "publicationState", project.state)) : null,
    project.verification ? chip(t("evidence.verification") + " · " + label(t, "verification", project.verification)) : null,
    project.adoption ? h("span", null, t("evidence.adoption") + " ", mono(project.adoption.id)) : null));
  return element;
}

function integrationRow(attempt, t, locale) {
  const source = attempt.source || {};
  const element = h("article.record.integration-row");
  element.dataset.status = attempt.status;
  element.append(h("header.record-head", null, dot(tone("integration", attempt.status)), mono(attempt.id),
    chip(label(t, "integration.source", source.kind) + (source.workItemId ? " · " + source.workItemId : "")),
    source.strategy ? chip(source.strategy) : null,
    h("span.spacer"),
    statusBadge(t, "integration", "integration", attempt.status)));
  if (attempt.summary) element.append(h("p.small", null, attempt.summary));
  element.append(h("div.meta-line", null,
    attempt.projectId ? h("span", null, attempt.projectId) : null,
    attempt.targetRef ? mono(attempt.targetRef) : null,
    h("span", null, t("evidence.candidate") + " "), mono(attempt.candidateCommit ? attempt.candidateCommit.slice(0, 12) : t("evidence.noCandidate")),
    timeTag(attempt.createdAt, locale, t)));
  element.append(attempt.checks && attempt.checks.length ? checkList(attempt.checks, t) : h("p.faint.small", null, t("evidence.noChecks")));
  return element;
}

function checkList(checks, t) {
  return h("ul.check-list", null, checks.map(function (check) {
    return h("li", null, dot(check.outcome === "passed" ? "ok" : check.outcome === "failed" ? "bad" : "idle"),
      h("span.mono-line", null, check.name), h("span.faint", null, label(t, "check", check.outcome)),
      check.details ? h("span.faint.small.check-details", null, check.details) : null);
  }));
}

// --- Workspaces and cleanup --------------------------------------------------
export function workspacesSection(scope) {
  const workspaces = cardDisclosure("detail-workspaces", scope.t("workspaces.title"), "workspaces", String(totalOf(scope.core, "managed-workspace")));
  return { element: workspaces, draw: function () { drawWorkspaces(workspaces, scope); } };
}

function drawWorkspaces(workspaces, scope) {
  const t = scope.t;
  clear(workspaces.body);
  const evidence = scope.view.evidence && scope.view.evidence.key && scope.view.evidence.value;
  const list = evidence ? evidence.workspaces : valuesOf(scope.core, "managed-workspace");
  if (!list.length) workspaces.body.append(note(t("evidence.noWorkspaces")));
  const rows = h("div.row-stack.boxed");
  list.forEach(function (workspace) { rows.append(workspaceRow(workspace, t, scope.locale)); });
  if (rows.childNodes.length) workspaces.body.append(rows);
  workspaces.body.append(note(t("evidence.cleanupNote")), codeBlock("yui task archive-preflight " + scope.task.id + " --integrated"));
}

function workspaceRow(workspace, t, locale) {
  const owner = workspace.owner || {};
  const ownerId = owner.workItemId || owner.reviewRoundId || owner.integrationAttemptId
    || (owner.executionGroupId ? owner.executionGroupId + (owner.executionLaneId ? "/" + owner.executionLaneId : "") : "") || owner.taskId || "";
  return h("article.record.is-compact", null,
    h("header.record-head", null, chip(label(t, "workspace.owner", owner.type)), mono(ownerId), h("span.spacer"), timeTag(workspace.updatedAt, locale, t)),
    h("p.small.mono-line", null, workspace.root),
    (workspace.entries || []).length ? h("div.meta-line", null, workspace.entries.map(function (entry) {
      return h("span", null, entry.directory + " · ", mono(entry.branch || entry.baseRef || ""));
    })) : null);
}
`;
