import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { saveArtifactCapability } from "../../dist/artifacts/artifactCapability.js";
import { readTextArtifactPage, compareTextArtifacts, saveTextMaterial, materialInputBody } from "../../dist/web/webMaterials.js";
import { TASK_FILES_SCRIPT } from "../../dist/web/assets/client/views/task/files.js";

test("materials use the existing repository; pinned pages and feedback survive newer versions", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-materials-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const content = "版本🙂\n".repeat(5000);
  const ref = await saveTextMaterial(home, "task-1", "session-a", {
    requestId: "upload-1", name: "notes.md", content
  });
  const first = await readTextArtifactPage(home, "task-1", ref);
  assert.ok(first.content.length <= 12000);
  assert.ok(first.nextOffset);
  let text = first.content;
  let page = first;
  while (page.nextOffset !== null) {
    page = await readTextArtifactPage(home, "task-1", ref, page.nextOffset);
    text += page.content;
  }
  assert.equal(text, content);
  const newer = await saveArtifactCapability(home, "task-1", { relativePath: ref.relativePath, content: "new\n" });
  assert.equal((await readTextArtifactPage(home, "task-1", ref)).digest, ref.digest);
  const diff = await compareTextArtifacts(home, "task-1", ref, newer);
  assert.equal(diff.before.commit, ref.commit);
  assert.equal(diff.after.commit, newer.commit);
  assert.match(diff.content, /^diff --git/m);
  const body = await materialInputBody(home, "task-1", "Please revise", [ref, newer]);
  assert.match(body, /untrusted/i);
  assert.ok(body.includes(ref.commit) && body.includes(newer.commit) && body.includes(ref.digest));
  assert.ok(!body.includes(content), "persist references, not copied material bodies");
  await assert.rejects(materialInputBody(home, "task-2", "Read", [ref]), /same Task/);
  await assert.rejects(readTextArtifactPage(home, "task-1", { ...ref, digest: "0".repeat(64) }), /digest/);
  await assert.rejects(readTextArtifactPage(home, "task-1", { ...ref, commit: "0".repeat(40) }), /unavailable/);
  await assert.rejects(readTextArtifactPage(home, "task-1", { ...ref, relativePath: "../other.md" }), /forbidden/);
  for (const input of [
    { name: "../notes.md", content: "bad" },
    { name: "notes.pdf", content: "not supported" },
    { name: "notes.txt", content: "\0binary" },
    { name: "notes.txt", content: "x".repeat(256 * 1024 + 1) }
  ]) {
    await assert.rejects(saveTextMaterial(home, "task-1", "session-a", { requestId: "bad", ...input }));
  }
});

test("file actions page, download and discuss the displayed diff pair without floating to HEAD", async () => {
  const buttons = [], reads = [], feedback = [];
  let downloaded, link;
  const h = (spec, attrs, ...children) => ({
    spec, ...attrs, children, handlers: {},
    append(...items) { this.children.push(...items); },
    addEventListener(name, fn) { this.handlers[name] = fn; },
    click() { link = this; }
  });
  const context = vm.createContext({
    h, clear: element => { element.children = []; }, icon: () => null, mono: text => text, note: text => text,
    button: text => { const element = h("button", { textContent: text }); buttons.push(element); return element; },
    Blob, URL: { createObjectURL: blob => { downloaded = blob; return "blob:fixture"; }, revokeObjectURL() {} },
    window: { setTimeout: fn => fn() }, navigator: { clipboard: { writeText: async () => {} } }
  });
  vm.runInContext(TASK_FILES_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const before = { taskId: "task-1", relativePath: "code.ts", commit: "a".repeat(40), digest: "b".repeat(64) };
  const after = { ...before, commit: "c".repeat(40), digest: "d".repeat(64) };
  const actions = {
    openConversation: refs => feedback.push(refs),
    readArtifact: async (...args) => {
      reads.push(args);
      return { content: args[3] === 0 ? "first" : "second", nextOffset: args[3] === 0 ? 5 : null };
    }
  };
  const pages = [];
  context.drawArtifact(h("viewer"), { before, after, content: "first", offset: 0, nextOffset: 5, totalCharacters: 11 },
    "task-1", key => key, actions, (...args) => pages.push(args));
  const button = key => buttons.find(b => b.textContent === "materials." + key);
  button("nextPage").handlers.click();
  assert.deepEqual(pages[0], ["code.ts", after.commit, 5, before.commit]);
  button("feedback").handlers.click();
  assert.deepEqual(JSON.parse(JSON.stringify(feedback[0])), [before, after]);
  assert.equal(reads.length, 0, "feedback only stages context");
  await button("download").handlers.click();
  assert.deepEqual(reads, [
    ["task-1", "code.ts", after.commit, 0, before.commit],
    ["task-1", "code.ts", after.commit, 5, before.commit]
  ]);
  assert.equal(await downloaded.text(), "firstsecond");
  assert.equal(downloaded.type, "text/plain;charset=utf-8");
  assert.equal(link.download, "code.ts.diff");
});

test("image controls zoom, download exact bytes, and stage only the frozen reference", async () => {
  const elements = [], feedback = [];
  let downloaded, link;
  const h = (spec, attrs, ...children) => {
    const element = { spec, ...attrs, children, handlers: {}, classList: { toggle() {} },
      append(...items) { this.children.push(...items); },
      removeAttribute(name) { delete this[name]; },
      addEventListener(name, fn) { this.handlers[name] = fn; }, click() { link = this; } };
    elements.push(element); return element;
  };
  const context = vm.createContext({
    h, clear: e => { e.children = []; }, icon: () => null, mono: text => text, note: text => text,
    formatBytes: size => String(size), button: text => h("button", { textContent: text }),
    Blob, atob, Uint8Array, URL: { createObjectURL: blob => { downloaded = blob; return "blob:fixture"; }, revokeObjectURL() {} },
    window: { setTimeout: fn => fn() }
  });
  vm.runInContext(TASK_FILES_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const image = { taskId: "task-1", relativePath: "plot.png", commit: "a".repeat(40), digest: "b".repeat(64),
    kind: "image", mime: "image/png", base64: "AAECA/8=", width: 20, height: 10, byteSize: 5 };
  context.drawArtifact(h("viewer"), image, "task-1", key => key, {
    openConversation: refs => feedback.push(refs),
    readArtifact() { throw new Error("Already pinned image must not be reread."); }
  });
  const picture = elements.find(e => e.spec === "img.artifact-image");
  const scale = elements.find(e => e.spec === "select");
  scale.value = "200"; scale.handlers.change();
  assert.equal(picture.width, 40);
  scale.value = "fit"; scale.handlers.change();
  assert.equal(picture.width, undefined);
  await elements.find(e => e.textContent === "materials.download").handlers.click();
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), Buffer.from([0, 1, 2, 3, 255]));
  assert.equal(link.download, "plot.png");
  elements.find(e => e.textContent === "materials.feedback").handlers.click();
  assert.deepEqual(JSON.parse(JSON.stringify(feedback)), [[{
    taskId: image.taskId, relativePath: image.relativePath, commit: image.commit, digest: image.digest
  }]], "no bytes or rendering fields in the draft; no send action");
  picture.handlers.error();
  assert.equal(picture.hidden, true);
  assert.equal(scale.disabled, true);
});

test("pinned inline images survive context redraws without rereads or cross-version reuse", async () => {
  const h = (spec, attrs, ...children) => ({
    spec, ...attrs, children, dataset: {}, handlers: {}, classList: { toggle() {} },
    append(...items) { this.children.push(...items); },
    removeAttribute(name) { delete this[name]; },
    addEventListener(name, fn) { this.handlers[name] = fn; },
    set innerHTML(value) { this.children = [h("slot")]; this.children[0].dataset.imageIndex = "0"; },
    querySelectorAll() { return this.children; }
  });
  const context = vm.createContext({
    h, clear: e => { e.children = []; }, icon: () => null, mono: text => text, note: text => text,
    formatBytes: String, button: text => h("button", { textContent: text }),
    renderMarkdown: (_, options) => options.image("plot", "plot.png"),
    resolveMarkdownImage: () => "plot.png", escapeHtml: text => text
  });
  vm.runInContext(TASK_FILES_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const value = { taskId: "task-1", relativePath: "report.md", commit: "a".repeat(40), digest: "b".repeat(64),
    kind: "markdown", content: "![plot](plot.png)", offset: 0, nextOffset: null, totalCharacters: 17 };
  const state = { artifact: value }, reads = [];
  let resolveRead;
  const actions = { readArtifact: (...args) => {
    reads.push(args);
    return new Promise(resolve => { resolveRead = resolve; });
  } };
  const draw = () => {
    const root = h("viewer");
    context.artifactViewer(root, { viewState: state, task: { id: "task-1" } }, key => key, actions).draw();
    return root;
  };
  const all = root => [root, ...(root.children || []).flat(Infinity).filter(x => x && typeof x === "object").flatMap(all)];
  const find = (root, spec) => all(root).find(e => e.spec === spec);
  const first = draw();
  const pending = all(first).find(e => e.textContent?.startsWith("materials.loadImage")).handlers.click();
  assert.ok(all(first).some(e => e.dataset.reading === "true"), "polling must defer while reading");
  // A navigation/redraw can still disconnect the old DOM: completion belongs to the pinned state.
  find(first, "slot").isConnected = false;
  const second = draw();
  resolveRead({ ...value, relativePath: "plot.png", digest: "c".repeat(64),
    kind: "image", mime: "image/png", base64: "AA==", width: 20, height: 10, byteSize: 1 });
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(find(second, "img.artifact-image"));
  assert.ok(!all(second).some(e => e.dataset.reading === "true"));
  const scale = find(second, "select");
  scale.value = "200"; scale.handlers.change();
  const third = draw();
  assert.equal(find(third, "img.artifact-image").width, 40);
  assert.equal(find(third, "select").value, "200");
  assert.deepEqual(reads, [["task-1", "plot.png", value.commit, 0]]);
  state.artifact = { ...value, commit: "d".repeat(40) };
  assert.equal(find(draw(), "img.artifact-image"), undefined, "new fixed version must require its own image read");
});
