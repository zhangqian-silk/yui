export const EVIDENCE_SCRIPT = String.raw`
// The Delivery tab: work items, reviews, integration and remote delivery,
// saved files and retained workspaces. Opening the tab reads the original
// evidence once per Context cursor; reading never accepts, publishes,
// executes or cleans anything.
import { h, icon, clear } from "/assets/js/dom.js";
import { formatBytes, formatClock } from "/assets/js/format.js";
import {
  card, listCard, setCardCount, button, note, mono, chip, emptyState, richText, badge, statusBadge, label, tone, dot,
  timeTag, disclosure, workItemCard, workItemBody, reviewCard
} from "/assets/js/components.js";
import { entriesOf, valuesOf, totalOf, summaryFields, readExact, exactRow, lazyRow, familyState, loadFamily } from "/assets/js/records.js";

const DELIVERY_TONES = { merged: "ok", partial: "warn", unverified: "warn", uncovered: "warn", pending: "info", none: "idle", unavailable: "idle" };

function newest(left, right) {
  return Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0);
}

// Only http(s) links without credentials leave the page.
function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function renderDelivery(panel, data, t, locale, ctx) {
  const view = data.viewState;
  const core = data.core;
  const task = data.task;
  view.exact = view.exact || {};
  view.openRows = view.openRows || {};
  view.reports = view.reports || {};
  view.panels = view.panels || {};
  view.panels.delivery = panel;

  // --- Work items ------------------------------------------------------------
  const work = listCard({ id: "detail-work", title: t("work.title"), icon: "layers", count: totalOf(core, "work-item") || null, hint: t("work.openHint") });
  function drawWork() {
    clear(work.list);
    const family = familyState(view, "work-item");
    const entries = entriesOf(core, "work-item");
    const titles = {};
    family.items.forEach(function (item) { const fields = summaryFields(item.summary); if (fields.title) titles[item.ref.refId] = fields.title; });
    valuesOf(core, "work-item").forEach(function (item) { titles[item.id] = item.title; });
    const shown = new Set(entries.map(function (entry) { return entry.ref.refId; }));
    const extraOpen = family.items.filter(function (item) { return item.status === "open" && !shown.has(item.ref.refId); });
    const finished = family.items.filter(function (item) { return item.status !== "open"; });
    entries.forEach(function (entry) {
      work.list.append(exactRow(entry, task.id, t, ctx, view.exact, function (value) { return workItemCard(value, t, locale, titles); }));
    });
    extraOpen.forEach(function (item) { work.list.append(workRow(item, titles)); });
    const loaded = family.key && family.pages;
    if (loaded) setCardCount(work, family.total || null);
    if (!entries.length && !extraOpen.length) {
      work.list.append(emptyState(loaded && family.total === 0 ? t("work.none") : t("work.noneOpen"), "layers"));
    }
    if (family.error) work.list.append(note(t("records.unavailable") + " " + family.error, "bad"));
    if (!loaded) {
      if (family.pending) work.list.append(h("p.row-label", null, t("work.reading")));
      return;
    }
    const finishedTotal = Math.max(finished.length, (family.total || 0) - totalOf(core, "work-item"));
    if (!finishedTotal) return;
    const group = h("div.row-stack.is-finished", null, h("p.row-label", null, t("work.finished") + " · " + finishedTotal));
    finished.forEach(function (item) { group.append(workRow(item, titles)); });
    work.list.append(group);
    if (family.nextCursor) work.list.append(listFoot(family, function () {
      return loadFamily(view, task.id, "work-item", family.key, ctx, { more: true, limit: 40 });
    }));
  }
  function workRow(item, titles) {
    const fields = summaryFields(item.summary);
    return lazyRow(item, task.id, t, ctx, {
      cache: view.exact, openRows: view.openRows,
      head: [dot(tone("work", item.status)), h("span.lazy-title", null, fields.title || item.ref.refId),
        item.assignee ? h("span.faint.small.lazy-meta", null, item.assignee) : null,
        statusBadge(t, "work", "work", item.status)],
      render: function (value) { return workItemBody(value, t, locale, titles); }
    });
  }
  function listFoot(family, more) {
    const next = button(t("history.more"), { icon: "chevron", variant: "ghost" });
    next.addEventListener("click", function () {
      next.disabled = true;
      more().then(refresh);
    });
    return h("div.list-foot", null,
      h("span.faint.small", null, t("history.loaded").replace("{shown}", String(family.items.length)).replace("{total}", String(family.total))),
      next);
  }

  // --- Reviews ---------------------------------------------------------------
  const reviews = listCard({ id: "detail-reviews", title: t("reviews.title"), icon: "eye", hint: t("reviews.hint") });
  function drawReviews() {
    clear(reviews.list);
    const evidence = view.evidence && view.evidence.key && view.evidence.value;
    if (evidence) {
      const rounds = evidence.reviews.slice().sort(newest);
      setCardCount(reviews, rounds.length || null);
      if (!rounds.length) reviews.list.append(emptyState(t("reviews.none"), "eye"));
      rounds.forEach(function (round) { reviews.list.append(reviewRow(round)); });
      return;
    }
    const entries = entriesOf(core, "review-round");
    setCardCount(reviews, entries.length || null);
    entries.forEach(function (entry) {
      reviews.list.append(exactRow(entry, task.id, t, ctx, view.exact, function (value) { return reviewRow(value); }));
    });
    if (view.evidence && view.evidence.error) reviews.list.append(note(t("records.unavailable") + " " + view.evidence.error, "bad"));
    else reviews.list.append(h("p.row-label", null, t("evidence.loading")));
  }
  function reviewRow(round) {
    const element = reviewCard(round, t, locale);
    if (!round.reviewerRunId) return element;
    const holder = h("div.stack");
    const cached = view.reports[round.id];
    if (cached) { holder.append(richText(t("evidence.report"), cached, t, { threshold: 480 })); element.append(holder); return element; }
    const report = button(t("evidence.readReport"), { icon: "eye", variant: "link" });
    report.addEventListener("click", async function () {
      report.disabled = true;
      try {
        const source = await ctx.inspect(task.id, { store: "run", refId: round.reviewerRunId });
        const output = (source.result && source.result.output) || (source.value && source.value.result && source.value.result.output) || t("evidence.noReport");
        view.reports[round.id] = output;
        holder.append(richText(t("evidence.report"), output, t, { threshold: 480 }));
        report.remove();
      } catch (error) { holder.append(note(error.message, "bad")); report.disabled = false; }
    });
    element.append(h("div.record-actions", null, report), holder);
    return element;
  }

  // --- Integration and remote delivery ------------------------------------------
  const delivery = card({ id: "detail-results", title: t("delivery.title"), icon: "merge", hint: t("delivery.hint") });
  const deliveryBody = h("div.stack.delivery-stack");
  delivery.body.append(deliveryBody);
  function remoteDelivery() {
    const entry = entriesOf(core, "remote-delivery")[0];
    if (entry && !entry.omitted) return entry.value;
    const cached = entry && view.exact["remote-delivery/" + entry.ref.refId];
    if (cached && cached.digest === entry.ref.digest && cached.result) return cached.result.value;
    return (data.runtime && data.runtime.remoteDelivery) || null;
  }
  function drawDelivery() {
    clear(deliveryBody);
    const remote = remoteDelivery();
    if (remote) {
      deliveryBody.append(h("h4.sub-head", null, icon("package", "icon-sm"), h("span", null, t("evidence.remote")),
        badge(t("remoteDelivery." + remote.status, remote.status), DELIVERY_TONES[remote.status] || "idle", { dot: true })));
      if (remote.codeProjectCount) {
        deliveryBody.append(h("p.faint.small", null, t("delivery.counts")
          .replace("{merged}", String(remote.mergedProjectCount)).replace("{verified}", String(remote.verifiedProjectCount))
          .split("{total}").join(String(remote.codeProjectCount))));
      }
      (remote.projects || []).forEach(function (project) { deliveryBody.append(projectRow(project)); });
      if (!(remote.projects || []).length) deliveryBody.append(note(t("delivery.noProjects")));
    } else deliveryBody.append(note(t("evidence.observationUnavailable")));

    const state = view.evidence || {};
    const evidence = state.key && state.value;
    deliveryBody.append(h("h4.sub-head", null, icon("merge", "icon-sm"), h("span", null, t("evidence.integrations")),
      evidence ? h("span.count", null, String(evidence.integrations.length)) : null));
    if (!evidence) {
      deliveryBody.append(state.error ? note(t("evidence.originalUnavailable") + " " + state.error, "bad") : h("p.faint.small", null, t("evidence.loading")));
      return;
    }
    if (!evidence.integrations.length) deliveryBody.append(note(t("evidence.noIntegrations")));
    const rows = h("div.row-stack.boxed");
    evidence.integrations.slice().sort(newest).forEach(function (attempt) { rows.append(integrationRow(attempt)); });
    if (rows.childNodes.length) deliveryBody.append(rows);
    deliveryBody.append(h("p.faint.small", null, t("delivery.readAt") + " " + formatClock(state.readAt, locale)
      + (state.pending ? " · " + t("evidence.loading") : "")));
  }
  function projectRow(project) {
    const publication = project.publication;
    const href = publication && publication.externalUrl && safeUrl(publication.externalUrl);
    const element = h("article.record.delivery-project");
    element.append(h("header.record-head", null, icon("folder", "icon-sm"), h("strong", null, project.directory || project.projectId),
      project.coverage ? chip(label(t, "coverage", project.coverage)) : null,
      h("span.spacer"),
      publication ? (href
        ? h("a.link", { href: href, rel: "noopener noreferrer", target: "_blank" }, label(t, "publication", publication.externalKind) + " #" + publication.externalId)
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
  function integrationRow(attempt) {
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
    if (attempt.checks && attempt.checks.length) {
      element.append(h("ul.check-list", null, attempt.checks.map(function (check) {
        return h("li", null, dot(check.outcome === "passed" ? "ok" : check.outcome === "failed" ? "bad" : "idle"),
          h("span.mono-line", null, check.name), h("span.faint", null, label(t, "check", check.outcome)),
          check.details ? h("span.faint.small.check-details", null, check.details) : null);
      })));
    } else element.append(h("p.faint.small", null, t("evidence.noChecks")));
    return element;
  }

  // --- Workspaces and cleanup --------------------------------------------------
  const workspaces = disclosure(t("workspaces.title"), "workspaces", { className: "card-disclosure", meta: String(totalOf(core, "managed-workspace")) });
  workspaces.id = "detail-workspaces";
  function drawWorkspaces() {
    clear(workspaces.body);
    const evidence = view.evidence && view.evidence.key && view.evidence.value;
    const list = evidence ? evidence.workspaces : valuesOf(core, "managed-workspace");
    if (!list.length) workspaces.body.append(note(t("evidence.noWorkspaces")));
    const rows = h("div.row-stack.boxed");
    list.forEach(function (workspace) {
      const owner = workspace.owner || {};
      const ownerId = owner.workItemId || owner.reviewRoundId || owner.integrationAttemptId
        || (owner.executionGroupId ? owner.executionGroupId + (owner.executionLaneId ? "/" + owner.executionLaneId : "") : "") || owner.taskId || "";
      rows.append(h("article.record.is-compact", null,
        h("header.record-head", null, chip(label(t, "workspace.owner", owner.type)), mono(ownerId), h("span.spacer"), timeTag(workspace.updatedAt, locale, t)),
        h("p.small.mono-line", null, workspace.root),
        (workspace.entries || []).length ? h("div.meta-line", null, workspace.entries.map(function (entry) {
          return h("span", null, entry.directory + " · ", mono(entry.branch || entry.baseRef || ""));
        })) : null));
    });
    if (rows.childNodes.length) workspaces.body.append(rows);
    workspaces.body.append(note(t("evidence.cleanupNote")), h("pre.code-block", null, "yui task archive-preflight " + task.id + " --integrated"));
  }

  panel.append(work, reviews, delivery, filesCard(data, t, locale, ctx), workspaces);
  panel.redraw = function () { drawWork(); drawReviews(); drawDelivery(); drawWorkspaces(); };
  panel.redraw();

  // Reads outlive one render: they redraw whichever Delivery panel is current
  // and re-read when the Context cursor moved while they were in flight.
  function refresh() {
    const current = view.panels.delivery;
    if (!current || !current.isConnected) return;
    current.redraw();
    if (!current.hidden) current.onShow();
  }
  panel.onShow = function () {
    const key = core.coreCursor;
    const previous = view.evidence || {};
    if (previous.key !== key && previous.errorKey !== key && !previous.pending) {
      view.evidence = { key: previous.key, value: previous.value, readAt: previous.readAt, error: null, pending: true };
      ctx.evidence(task.id).then(function (value) {
        view.evidence = { key: key, value: value, readAt: new Date().toISOString(), error: null, pending: false };
      }, function (error) {
        view.evidence = { key: previous.key, value: previous.value, readAt: previous.readAt, error: error.message, errorKey: key, pending: false };
      }).then(refresh);
    }
    const entry = entriesOf(core, "remote-delivery")[0];
    if (entry && entry.omitted && !(data.runtime && data.runtime.remoteDelivery)) {
      const hit = view.exact["remote-delivery/" + entry.ref.refId];
      if (!(hit && hit.digest === entry.ref.digest && hit.result)) {
        readExact(entry, task.id, ctx, view.exact).then(refresh, function () {});
      }
    }
    const family = familyState(view, "work-item");
    if (family.key !== key && family.errorKey !== key && !family.pending) loadFamily(view, task.id, "work-item", key, ctx, { limit: 40 }).then(refresh);
  };
}

// --- Saved files ------------------------------------------------------------------
// Files are read on request at a fixed revision; the selected revision
// survives refreshes.
function filesCard(data, t, locale, actions) {
  const state = data.viewState;
  const load = button(state.artifactList ? t("evidence.reload") : t("evidence.load"), { icon: "refresh", variant: "ghost" });
  const files = card({ id: "detail-files", title: t("evidence.files"), icon: "file", hint: t("evidence.filesHint"), actions: load });
  const list = h("div.file-list");
  const viewer = h("div.file-viewer");
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
    viewer.append(h("pre.code-block.artifact-text", { tabIndex: 0, "aria-label": t("evidence.fixedText") }, value.content));
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
      if (placeholder) { placeholder.remove(); placeholder = null; }
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
  let placeholder = !state.artifactList && !seen.size ? emptyState(t("evidence.notLoaded"), "file") : null;
  if (placeholder) files.body.append(placeholder);
  files.body.append(referenced, list, viewer);
  drawList();
  drawViewer();
  return files;
}
`;
