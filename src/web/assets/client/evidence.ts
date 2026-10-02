export const EVIDENCE_SCRIPT = String.raw`
// Results and evidence. Files are read on request at a fixed revision; the
// selected revision survives refreshes. Reading never accepts, publishes or
// executes a result.
import { h, icon, clear } from "/assets/js/dom.js";
import { formatBytes } from "/assets/js/format.js";
import { card, button, note, mono, emptyState, richText, badge, observabilityMetricCard } from "/assets/js/components.js";

export function renderEvidence(container, data, t, locale, actions) {
  const state = data.viewState;
  const files = card({ title: t("evidence.files"), icon: "file", hint: t("evidence.filesHint") });
  const list = h("div.file-list");
  const viewer = h("div.file-viewer");
  const load = button(state.artifactList ? t("evidence.reload") : t("evidence.load"), { icon: "refresh", variant: "ghost" });
  files.querySelector(".card-head").append(h("div.card-actions", null, load));
  let readSequence = 0;
  async function read(path, commit) {
    const sequence = ++readSequence;
    viewer.dataset.reading = "true";
    clear(viewer);
    viewer.append(h("p.faint", null, t("evidence.reading")));
    try {
      const result = await actions.readArtifact(data.task.id, path, commit);
      if (sequence !== readSequence) return;
      state.artifact = result;
      drawViewer();
    } catch (error) {
      if (sequence === readSequence) { clear(viewer); viewer.append(note(t("evidence.unavailable") + " " + error.message, "bad")); }
    } finally { if (sequence === readSequence) viewer.dataset.reading = "false"; }
  }
  function drawViewer() {
    clear(viewer);
    const value = state.artifact;
    if (!value) return;
    const ref = "git:" + value.commit + ":" + value.relativePath;
    const copy = button(t("evidence.copy"), { icon: "copy", variant: "ghost" });
    copy.addEventListener("click", async function () {
      try { await navigator.clipboard.writeText(data.task.id + " " + ref); copy.lastChild.textContent = t("evidence.copied"); }
      catch { copy.lastChild.textContent = t("evidence.copyManual"); }
    });
    viewer.append(h("header.viewer-head", null, icon("file"), h("strong", null, value.relativePath), h("span.spacer"), copy));
    viewer.append(h("p.viewer-ref", null, mono(ref)));
    viewer.append(h("p.faint.small", null, t("evidence.fixedNote")));
    const content = h("pre.code-block.artifact-text", { tabIndex: 0, "aria-label": t("evidence.fixedText") }, value.content);
    viewer.append(content);
  }
  function drawList() {
    clear(list);
    const current = state.artifactList;
    if (!current) return;
    if (state.artifact && current.commit !== state.artifact.commit) list.append(note(t("evidence.differentRevision")));
    if (!current.entries.length) { list.append(emptyState(t("evidence.noFiles"), "file")); return; }
    current.entries.forEach(function (entry) {
      list.append(h("button.file-row", {
        type: "button",
        "aria-current": String(!!state.artifact && state.artifact.relativePath === entry.relativePath && state.artifact.commit === current.commit),
        onclick: function () { read(entry.relativePath, current.commit); }
      }, icon("file", "icon-sm"), h("span.file-name", null, entry.relativePath), h("span.faint.small", null, formatBytes(entry.size))));
    });
  }
  load.addEventListener("click", async function () {
    load.disabled = true;
    list.dataset.reading = "true";
    try {
      state.artifactList = await actions.artifacts(data.task.id);
      drawList();
    } catch (error) {
      clear(list);
      list.append(note(t("evidence.listUnavailable") + " " + error.message, "bad"));
    } finally { load.disabled = false; list.dataset.reading = "false"; }
  });
  // Explicit frozen references stay attached to their original revision.
  const sources = [data.task.completionArtifactRefs || [],
    data.core.records.filter(function (entry) { return !entry.omitted && ["task-brief", "task-decision"].includes(entry.ref.store); })
      .map(function (entry) { return JSON.stringify(entry.value); })].flat().join(" ");
  const refs = Array.from(sources.matchAll(/git:([0-9a-f]{40}):([^\s"\\]+?)(?=[\s"\\]|$)/g));
  const seen = new Set();
  const referenced = h("div.file-list");
  refs.forEach(function (match) {
    if (seen.has(match[0])) return;
    seen.add(match[0]);
    referenced.append(h("button.file-row", { type: "button", onclick: function () { read(match[2], match[1]); } },
      icon("flag", "icon-sm"), h("span.file-name", null, match[2]), badge(t("evidence.referenced"), "accent")));
  });
  if (!state.artifactList && !seen.size) files.body.append(emptyState(t("evidence.notLoaded"), "file"));
  files.body.append(referenced, list, viewer);
  drawList();
  drawViewer();
  container.append(files);

  const delivery = card({ title: t("evidence.delivery"), icon: "layers", hint: t("evidence.deliveryHint") });
  const output = h("div.stack");
  const open = button(t("evidence.readDelivery"), { icon: "eye", variant: "ghost" });
  delivery.querySelector(".card-head").append(h("div.card-actions", null, open));
  delivery.body.append(output);
  open.addEventListener("click", function () {
    open.disabled = true;
    drawDelivery(output, data, t, actions).finally(function () { open.disabled = false; });
  });
  container.append(delivery);
}

async function drawDelivery(output, data, t, actions) {
  clear(output);
  const runtime = data.runtimeStatus === "available" ? data.runtime : null;
  if (!runtime) output.append(note(t("evidence.observationUnavailable")));
  const remote = runtime && runtime.remoteDelivery;
  if (remote) {
    output.append(h("h4.sub-head", null, t("evidence.remote"), badge(t("remoteDelivery." + remote.status, remote.status), remote.status === "merged" ? "ok" : "idle")));
    remote.projects.forEach(function (project) {
      output.append(h("article.record", null,
        h("header.record-head", null, h("strong", null, project.directory), h("span.faint.small", null, project.coverage)),
        h("p.small", null, project.reason),
        h("p.faint.small", null, t("evidence.expectedCommit") + " ", mono(project.expectedLocalCommit || t("common.unknown"))),
        h("p.faint.small", null, "PR/MR · " + (project.state || "none") + " · " + t("evidence.verification") + " " + (project.verification || "unverified")),
        project.adoption ? h("p.faint.small", null, t("evidence.adoption") + " ", mono(project.adoption.id)) : null));
    });
  }
  const original = h("div.stack", null, h("p.faint", null, t("evidence.readingOriginal")));
  output.append(original);
  try {
    const evidence = await actions.evidence(data.task.id);
    clear(original);
    original.append(h("h4.sub-head", null, t("evidence.integrations")));
    if (!evidence.integrations.length) original.append(note(t("evidence.noIntegrations")));
    evidence.integrations.forEach(function (attempt) {
      const element = h("article.record", null,
        h("header.record-head", null, mono(attempt.id), h("span.spacer"), badge(attempt.status, attempt.status === "succeeded" ? "ok" : "idle")),
        h("p.faint.small", null, t("evidence.candidate") + " ", mono(attempt.candidateCommit || t("evidence.noCandidate"))));
      if (!attempt.checks || !attempt.checks.length) element.append(h("p.faint.small", null, t("evidence.noChecks")));
      (attempt.checks || []).forEach(function (check) {
        element.append(h("p.small", null, check.name + " · " + check.outcome));
        if (check.details) element.append(h("p.faint.small", null, check.details));
      });
      original.append(element);
    });
    original.append(h("h4.sub-head", null, t("evidence.reviews")));
    if (!evidence.reviews.length) original.append(note(t("evidence.noReviews")));
    evidence.reviews.forEach(function (round) {
      const element = h("article.record", null,
        h("header.record-head", null, mono(round.id), h("span.spacer"), badge(round.status, round.status === "completed" ? "ok" : "idle")),
        h("p.faint.small.mono-line", null, round.taskCandidate
          ? round.taskCandidate.projects.map(function (p) { return p.projectId + " · " + p.commit; }).join("  ")
          : [round.workItemId, round.candidateId, round.reviewBaseCommit].filter(Boolean).join(" · ")));
      if (round.reviewerRunId) {
        const report = button(t("evidence.readReport"), { icon: "eye", variant: "link" });
        report.addEventListener("click", async function () {
          report.disabled = true;
          try {
            const source = await actions.inspect(data.task.id, { store: "run", refId: round.reviewerRunId });
            element.append(richText(round.reviewerRunId, (source.value.result && source.value.result.output) || t("evidence.noReport"), t));
            report.remove();
          } catch (error) { element.append(note(error.message, "bad")); report.disabled = false; }
        });
        element.append(report);
      }
      original.append(element);
    });
    original.append(h("h4.sub-head", null, t("evidence.workspaces")));
    if (!evidence.workspaces.length) original.append(note(t("evidence.noWorkspaces")));
    evidence.workspaces.forEach(function (workspace) {
      original.append(h("p.small.mono-line", null, workspace.owner.type + " · " + workspace.root));
    });
    original.append(note(t("evidence.cleanupNote")), h("pre.code-block", null, "yui task archive-preflight " + data.task.id + " --integrated"));
  } catch (error) {
    clear(original);
    original.append(note(t("evidence.originalUnavailable") + " " + error.message, "bad"));
  }
  const metrics = runtime && observabilityMetricCard(runtime.observability, t);
  if (metrics) output.append(h("h4.sub-head", null, t("evidence.usage")), metrics);
}
`;
