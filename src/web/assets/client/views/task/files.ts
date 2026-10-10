export const TASK_FILES_SCRIPT = String.raw`
// Task › Delivery › Saved files. Files are read on request at a fixed
// revision and the selected revision survives refreshes; explicit frozen
// references (git:<commit>:<path>) stay attached to their original revision.
import { h, icon, clear } from "/assets/js/lib/dom.js";
import { formatBytes } from "/assets/js/lib/format.js";
import { badge, button, emptyState, mono, note } from "/assets/js/ui/primitives.js";
import { card } from "/assets/js/ui/containers.js";
import { renderMarkdown, resolveMarkdownImage, escapeHtml } from "/assets/js/lib/markdown.js";

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
  function draw() { drawArtifact(viewer, state.artifact, data.task.id, t, actions, read, state); }
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

function drawArtifact(viewer, value, taskId, t, actions, read, state = {}) {
  clear(viewer);
  if (!value) return;
  const selected = value.after || value;
  const previewKey = JSON.stringify([taskId, selected.commit, selected.relativePath, selected.digest, value.before?.commit]);
  if (state.artifactPreview?.key !== previewKey) {
    // Only the selected fixed version owns cached bytes; changing it releases the old bounded cache.
    state.artifactPreview = { key: previewKey, images: [], pending: 0, totalBytes: 0, totalPixels: 0 };
  }
  const preview = state.artifactPreview;
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
    actions.openConversation((value.before ? [value.before, value.after] : [selected]).map(artifactRef));
  });
  const download = button(t("materials.download"), { variant: "ghost" });
  download.addEventListener("click", async function () {
    download.disabled = true;
    try {
      if (value.kind === "image") { downloadImage(value); return; }
      const parts = [];
      let offset = 0, page;
      do {
        page = await actions.readArtifact(taskId, selected.relativePath, selected.commit, offset, value.before?.commit);
        parts.push(page.content); offset = page.nextOffset;
      } while (offset !== null);
      const url = URL.createObjectURL(new Blob(parts, { type: "text/plain;charset=utf-8" }));
      const link = h("a", { href: url, download: selected.relativePath.split("/").pop() + (value.before ? ".diff" : "") });
      link.click(); window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (error) { viewer.append(note(error.message, "bad")); }
    finally { download.disabled = false; }
  });
  viewer.append(h("header.viewer-head", null, icon("file"), h("strong", null, selected.relativePath), h("span.spacer"), copy));
  viewer.append(h("p.viewer-ref", null, mono(ref)));
  viewer.append(h("p.viewer-ref", null, mono("sha256:" + selected.digest)));
  if (value.before) viewer.append(h("p.viewer-ref", null, mono("← git:" + value.before.commit + ":" + value.before.relativePath + " · sha256:" + value.before.digest)));
  viewer.append(h("p.faint.small", null, t("evidence.fixedNote")));
  viewer.append(h("div.record-actions", null, value.kind === "image" ? null : copyText, download, feedback));
  if (value.kind === "image") { viewer.append(imagePreview(value, t, undefined, preview)); return; }
  const before = h("input", { placeholder: t("materials.before"), "aria-label": t("materials.before"), maxLength: 64 });
  const compare = button(t("materials.compare"), { variant: "ghost" });
  compare.addEventListener("click", function () { read(selected.relativePath, selected.commit, 0, before.value); });
  viewer.append(h("div.record-actions", null, before, compare));
  const source = h("pre.code-block.artifact-text", { tabIndex: 0, "aria-label": t("evidence.fixedText") }, value.content);
  if (!value.before && /\.md$|\.markdown$/i.test(selected.relativePath)) {
    viewer.append(markdownPreview(value, taskId, t, actions, preview));
    viewer.append(h("details", null, h("summary", null, t("materials.source")), source));
  } else viewer.append(source);
  viewer.append(note((value.content.length ? value.offset + 1 : 0) + "–" + (value.offset + value.content.length) + " / " + value.totalCharacters));
  const first = button(t("materials.firstPage"), { variant: "ghost" });
  first.disabled = value.offset === 0;
  first.addEventListener("click", function () { read(selected.relativePath, selected.commit, 0, value.before?.commit); });
  const next = button(t("materials.nextPage"), { variant: "ghost" });
  next.disabled = value.nextOffset === null;
  next.addEventListener("click", function () { read(selected.relativePath, selected.commit, value.nextOffset, value.before?.commit); });
  viewer.append(h("div.record-actions", null, first, next));
}

function artifactRef(value) {
  return { taskId: value.taskId, commit: value.commit, relativePath: value.relativePath, digest: value.digest };
}

function downloadImage(value) {
  const bytes = Uint8Array.from(atob(value.base64), function (char) { return char.charCodeAt(0); });
  const url = URL.createObjectURL(new Blob([bytes], { type: value.mime }));
  h("a", { href: url, download: value.relativePath.split("/").pop() }).click();
  window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function imagePreview(value, t, alt, state = {}) {
  const image = h("img.artifact-image", { alt: alt || value.relativePath, decoding: "async" });
  const viewport = h("span.image-viewport", { tabIndex: 0, "aria-label": t("materials.image") }, image);
  const status = h("span.feed-note", { role: "status" }, value.width + " × " + value.height + " · " + formatBytes(value.byteSize));
  const scale = h("select", { "aria-label": t("materials.zoom") },
    h("option", { value: "fit" }, t("materials.fit")),
    ...[50, 100, 200, 400].map(function (percent) { return h("option", { value: String(percent) }, percent + "%"); }));
  function applyScale() {
    image.classList.toggle("is-zoomed", scale.value !== "fit");
    if (scale.value === "fit") image.removeAttribute("width");
    else image.width = Math.round((image.naturalWidth || value.width) * Number(scale.value) / 100);
  }
  scale.value = state.zoom || "fit";
  applyScale();
  scale.addEventListener("change", function () {
    state.zoom = scale.value;
    applyScale();
  });
  image.addEventListener("error", function () {
    image.removeAttribute("src"); image.hidden = true; scale.disabled = true;
    status.textContent = t("materials.imageError");
  }, { once: true });
  image.src = "data:" + value.mime + ";base64," + value.base64;
  return h("span.image-preview", null, h("span.record-actions", null, scale, status), viewport);
}

function markdownPreview(value, taskId, t, actions, preview) {
  const body = h("div.md.artifact-markdown");
  const images = [];
  body.innerHTML = renderMarkdown(value.content, { image: function (alt, target) {
    if (images.length >= 12) return '<span class="feed-note">' + escapeHtml(t("materials.imageLimit")) + "</span>";
    const index = images.push({ alt, target }) - 1;
    return '<span class="md-image-slot" data-image-index="' + index + '"></span>';
  } });
  body.querySelectorAll("[data-image-index]").forEach(function (slot) {
    const index = Number(slot.dataset.imageIndex);
    const entry = images[index];
    const saved = preview.images[index] || (preview.images[index] = {});
    let path;
    try { path = resolveMarkdownImage(value.relativePath, entry.target); }
    catch (error) { slot.append(note(entry.alt + ": " + error.message, "bad")); return; }
    const load = button(t("materials.loadImage") + " · " + (entry.alt || path), { variant: "ghost" });
    const status = h("span.feed-note", { role: "status" });
    slot.append(load, status);
    function showImage() {
      if (slot.isConnected === false) return;
      const image = saved.image;
      clear(slot);
      const download = button(t("materials.download"), { variant: "ghost" });
      download.addEventListener("click", function () { downloadImage(image); });
      const feedback = button(t("materials.feedback"), { variant: "ghost" });
      feedback.addEventListener("click", function () { actions.openConversation([artifactRef(value), artifactRef(image)]); });
      slot.append(imagePreview(image, t, entry.alt, saved), h("span.viewer-ref", null,
        path + " · git:" + image.commit + " · sha256:" + image.digest),
        h("span.record-actions", null, download, feedback));
    }
    async function observeRead() {
      load.disabled = true; body.dataset.reading = "true"; status.textContent = t("evidence.reading");
      try { await saved.pending; showImage(); }
      catch (error) { status.textContent = error.message; load.disabled = false; }
      finally { body.dataset.reading = String(preview.pending > 0); }
    }
    load.addEventListener("click", function () {
      if (saved.pending) return saved.pending;
      if (preview.pending >= 2) { status.textContent = t("materials.imageBusy"); return; }
      if (preview.totalBytes >= 16 * 1024 * 1024 || preview.totalPixels >= 32_000_000) { status.textContent = t("materials.imageLimit"); return; }
      preview.pending++;
      saved.pending = (async function () {
        const image = await actions.readArtifact(taskId, path, value.commit, 0);
        if (image.kind !== "image") throw new Error(t("materials.imageUnsupported"));
        if (preview.totalBytes + image.byteSize > 16 * 1024 * 1024 || preview.totalPixels + image.width * image.height > 32_000_000) {
          throw new Error(t("materials.imageLimit"));
        }
        preview.totalBytes += image.byteSize; preview.totalPixels += image.width * image.height;
        saved.image = image;
      })().finally(function () { preview.pending--; delete saved.pending; });
      return observeRead();
    });
    if (saved.image) showImage();
    else if (saved.pending) void observeRead();
  });
  return body;
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
