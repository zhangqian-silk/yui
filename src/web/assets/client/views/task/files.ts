export const TASK_FILES_SCRIPT = String.raw`
// Task › Delivery › Saved files. Files are read on request at a fixed
// revision and the selected revision survives refreshes; explicit frozen
// references (git:<commit>:<path>) stay attached to their original revision.
import { h, icon, clear } from "/assets/js/lib/dom.js";
import { formatBytes } from "/assets/js/lib/format.js";
import { badge, button, emptyState, mono, note } from "/assets/js/ui/primitives.js";
import { card } from "/assets/js/ui/containers.js";

export function filesCard(data, t, locale, actions) {
  const state = data.viewState;
  const load = button(state.artifactList ? t("evidence.reload") : t("evidence.load"), { icon: "refresh", variant: "ghost" });
  const files = card({ id: "detail-files", title: t("evidence.files"), icon: "file", hint: t("evidence.filesHint"), actions: load });
  const list = h("div.file-list");
  const viewer = artifactViewer(h("div.file-viewer"), data, t, actions);
  const referenced = referencedFiles(data, t, viewer.read);
  let placeholder = !state.artifactList && !referenced.childNodes.length ? emptyState(t("evidence.notLoaded"), "file") : null;
  load.addEventListener("click", async function () {
    load.disabled = true;
    list.dataset.reading = "true";
    try {
      state.artifactList = await actions.artifacts(data.task.id);
      if (placeholder) { placeholder.remove(); placeholder = null; }
      drawFileList(list, state, t, viewer.read);
    } catch (error) {
      clear(list);
      list.append(note(t("evidence.listUnavailable") + " " + error.message, "bad"));
    } finally { load.disabled = false; list.dataset.reading = "false"; }
  });
  if (placeholder) files.body.append(placeholder);
  files.body.append(referenced, list, viewer.element);
  drawFileList(list, state, t, viewer.read);
  viewer.draw();
  return files;
}

// One viewer per card; a newer read supersedes one still in flight.
function artifactViewer(viewer, data, t, actions) {
  const state = data.viewState;
  let readSequence = 0;
  function draw() { drawArtifact(viewer, state.artifact, data.task.id, t); }
  async function read(path, commit) {
    const sequence = ++readSequence;
    viewer.dataset.reading = "true";
    clear(viewer);
    viewer.append(h("p.faint", null, t("evidence.reading")));
    try {
      const result = await actions.readArtifact(data.task.id, path, commit);
      if (sequence !== readSequence) return;
      state.artifact = result;
      draw();
    } catch (error) {
      if (sequence === readSequence) { clear(viewer); viewer.append(note(t("evidence.unavailable") + " " + error.message, "bad")); }
    } finally { if (sequence === readSequence) viewer.dataset.reading = "false"; }
  }
  return { element: viewer, read: read, draw: draw };
}

function drawArtifact(viewer, value, taskId, t) {
  clear(viewer);
  if (!value) return;
  const ref = "git:" + value.commit + ":" + value.relativePath;
  const copy = button(t("evidence.copy"), { icon: "copy", variant: "ghost" });
  copy.addEventListener("click", async function () {
    try { await navigator.clipboard.writeText(taskId + " " + ref); copy.lastChild.textContent = t("evidence.copied"); }
    catch { copy.lastChild.textContent = t("evidence.copyManual"); }
  });
  viewer.append(h("header.viewer-head", null, icon("file"), h("strong", null, value.relativePath), h("span.spacer"), copy));
  viewer.append(h("p.viewer-ref", null, mono(ref)));
  viewer.append(h("p.faint.small", null, t("evidence.fixedNote")));
  viewer.append(h("pre.code-block.artifact-text", { tabIndex: 0, "aria-label": t("evidence.fixedText") }, value.content));
}

function drawFileList(list, state, t, read) {
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

// Frozen references named by the completion, the Brief or a decision.
function referencedFiles(data, t, read) {
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
  return referenced;
}
`;
