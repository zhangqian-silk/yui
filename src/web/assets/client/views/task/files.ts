export const TASK_FILES_SCRIPT = String.raw`
// Task › Delivery › Saved files. Files are read on request at a fixed
// revision and the selected revision survives refreshes; explicit frozen
// references (git:<commit>:<path>) stay attached to their original revision.
import { h, icon, clear } from "/assets/js/lib/dom.js";
import { formatBytes } from "/assets/js/lib/format.js";
import { badge, button, emptyState, mono, note } from "/assets/js/ui/primitives.js";
import { card } from "/assets/js/ui/containers.js";
import { richText } from "/assets/js/ui/text.js";

export function filesCard(data, t, locale, actions) {
  const state = data.viewState;
  const load = button(state.artifactList ? t("evidence.reload") : t("evidence.load"), { icon: "refresh", variant: "ghost" });
  const files = card({ id: "detail-files", title: t("evidence.files"), icon: "file", hint: t("evidence.filesHint"), actions: load });
  const list = h("div.file-list");
  const viewer = artifactViewer(h("div.file-viewer"), data, t, actions);
  const referenced = referencedFiles(data, t, viewer.read);
  const pathInput = h("input", { placeholder: t("materials.path"), "aria-label": t("materials.path"), maxLength: 512 });
  const commitInput = h("input", { placeholder: t("materials.commit"), "aria-label": t("materials.commit"), maxLength: 64 });
  const open = button(t("materials.open"), { variant: "ghost" });
  open.addEventListener("click", function () { viewer.read(pathInput.value, commitInput.value); });
  const more = button(t("materials.moreFiles"), { variant: "ghost" });
  more.hidden = !state.artifactList?.nextOffset;
  more.addEventListener("click", async function () {
    more.disabled = true; load.disabled = true;
    try {
      const previous = state.artifactList;
      const page = await actions.artifacts(data.task.id, previous.commit, previous.nextOffset);
      state.artifactList = { ...page, entries: previous.entries.concat(page.entries) };
      drawFileList(list, state, t, viewer.read); more.hidden = page.nextOffset === null;
    } catch (error) { list.append(note(error.message, "bad")); }
    finally { more.disabled = false; load.disabled = false; }
  });
  let placeholder = !state.artifactList && !referenced.childNodes.length ? emptyState(t("evidence.notLoaded"), "file") : null;
  load.addEventListener("click", async function () {
    load.disabled = true; more.disabled = true;
    list.dataset.reading = "true";
    try {
      state.artifactList = await actions.artifacts(data.task.id);
      if (placeholder) { placeholder.remove(); placeholder = null; }
      drawFileList(list, state, t, viewer.read);
      more.hidden = state.artifactList.nextOffset === null;
    } catch (error) {
      clear(list);
      list.append(note(t("evidence.listUnavailable") + " " + error.message, "bad"));
    } finally { load.disabled = false; more.disabled = false; list.dataset.reading = "false"; }
  });
  if (placeholder) files.body.append(placeholder);
  files.body.append(h("div.record-actions", null, pathInput, commitInput, open), referenced, list, more, viewer.element);
  drawFileList(list, state, t, viewer.read);
  viewer.draw();
  return files;
}

// One viewer per card; a newer read supersedes one still in flight.
function artifactViewer(viewer, data, t, actions) {
  const state = data.viewState;
  let readSequence = 0;
  function draw() { drawArtifact(viewer, state.artifact, data.task.id, t, actions, read); }
  async function read(path, commit, offset, before) {
    const sequence = ++readSequence;
    viewer.dataset.reading = "true";
    clear(viewer);
    viewer.append(h("p.faint", null, t("evidence.reading")));
    try {
      const result = await actions.readArtifact(data.task.id, path, commit, offset, before);
      if (sequence !== readSequence) return;
      state.artifact = result;
      draw();
    } catch (error) {
      if (sequence === readSequence) { clear(viewer); viewer.append(note(t("evidence.unavailable") + " " + error.message, "bad")); }
    } finally { if (sequence === readSequence) viewer.dataset.reading = "false"; }
  }
  return { element: viewer, read: read, draw: draw };
}

function drawArtifact(viewer, value, taskId, t, actions, read) {
  clear(viewer);
  if (!value) return;
  const selected = value.after || value;
  const ref = "git:" + selected.commit + ":" + selected.relativePath;
  const copy = button(t("evidence.copy"), { icon: "copy", variant: "ghost" });
  copy.addEventListener("click", async function () {
    try { await navigator.clipboard.writeText(taskId + " " + ref); copy.lastChild.textContent = t("evidence.copied"); }
    catch { copy.lastChild.textContent = t("evidence.copyManual"); }
  });
  const copyText = button(t("materials.copyPage"), { variant: "ghost" });
  copyText.addEventListener("click", async function () {
    try { await navigator.clipboard.writeText(value.content); copyText.textContent = t("evidence.copied"); }
    catch { copyText.textContent = t("evidence.copyManual"); }
  });
  const feedback = button(t("materials.feedback"), { variant: "ghost" });
  feedback.addEventListener("click", function () {
    actions.openConversation(value.before ? [value.before, value.after] : [selected]);
  });
  const download = button(t("materials.download"), { variant: "ghost" });
  download.addEventListener("click", async function () {
    download.disabled = true;
    try {
      const parts = [];
      let offset = 0, page;
      do {
        page = await actions.readArtifact(taskId, selected.relativePath, selected.commit, offset, value.before?.commit);
        parts.push(page.content); offset = page.nextOffset;
      } while (offset !== null);
      const url = URL.createObjectURL(new Blob(parts, { type: "text/plain;charset=utf-8" }));
      const link = h("a", { href: url, download: selected.relativePath.split("/").pop() + (value.before ? ".diff" : ".txt") });
      link.click(); window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (error) { viewer.append(note(error.message, "bad")); }
    finally { download.disabled = false; }
  });
  viewer.append(h("header.viewer-head", null, icon("file"), h("strong", null, selected.relativePath), h("span.spacer"), copy));
  viewer.append(h("p.viewer-ref", null, mono(ref)));
  viewer.append(h("p.viewer-ref", null, mono("sha256:" + selected.digest)));
  if (value.before) viewer.append(h("p.viewer-ref", null, mono("← git:" + value.before.commit + ":" + value.before.relativePath + " · sha256:" + value.before.digest)));
  viewer.append(h("p.faint.small", null, t("evidence.fixedNote")));
  viewer.append(h("div.record-actions", null, copyText, download, feedback));
  const before = h("input", { placeholder: t("materials.before"), "aria-label": t("materials.before"), maxLength: 64 });
  const compare = button(t("materials.compare"), { variant: "ghost" });
  compare.addEventListener("click", function () { read(selected.relativePath, selected.commit, 0, before.value); });
  viewer.append(h("div.record-actions", null, before, compare));
  viewer.append(h("pre.code-block.artifact-text", { tabIndex: 0, "aria-label": t("evidence.fixedText") }, value.content));
  if (!value.before && /\.md$|\.markdown$/i.test(selected.relativePath)) {
    viewer.append(h("details", null, h("summary", null, t("materials.markdown")),
      richText(null, value.content, t)));
  }
  viewer.append(note((value.content.length ? value.offset + 1 : 0) + "–" + (value.offset + value.content.length) + " / " + value.totalCharacters));
  const first = button(t("materials.firstPage"), { variant: "ghost" });
  first.disabled = value.offset === 0;
  first.addEventListener("click", function () { read(selected.relativePath, selected.commit, 0, value.before?.commit); });
  const next = button(t("materials.nextPage"), { variant: "ghost" });
  next.disabled = value.nextOffset === null;
  next.addEventListener("click", function () { read(selected.relativePath, selected.commit, value.nextOffset, value.before?.commit); });
  viewer.append(h("div.record-actions", null, first, next));
}

function drawFileList(list, state, t, read) {
  clear(list);
  const current = state.artifactList;
  if (!current) return;
  const selected = state.artifact && (state.artifact.after || state.artifact);
  if (selected && current.commit !== selected.commit) list.append(note(t("evidence.differentRevision")));
  if (!current.entries.length) { list.append(emptyState(t("evidence.noFiles"), "file")); return; }
  current.entries.forEach(function (entry) {
    list.append(h("button.file-row", {
      type: "button",
      "aria-current": String(!!selected && selected.relativePath === entry.relativePath && selected.commit === current.commit),
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
