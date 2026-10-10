import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { openTaskArtifactRepository } from "../../dist/artifacts/taskArtifactRepository.js";
import { readArtifactPreview, materialInputBody } from "../../dist/web/webMaterials.js";
import { MARKDOWN_SCRIPT } from "../../dist/web/assets/client/lib/markdown.js";
import { saveArtifactCapability, readArtifactCapability } from "../../dist/artifacts/artifactCapability.js";
import { rasterMetadata } from "../../dist/artifacts/imageMetadata.js";

test("raster metadata uses image bytes, rejects truncated frames and bounds decoded dimensions", () => {
  // Static 2x3 browser-encoded fixtures, with optional ICC metadata removed.
  const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJVAA//Z", "base64");
  const webp = Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAMAAUAmJaQAA3AA/v02aAA=", "base64");
  assert.deepEqual(rasterMetadata(jpeg), { mime: "image/jpeg", width: 2, height: 3 });
  assert.deepEqual(rasterMetadata(webp), { mime: "image/webp", width: 2, height: 3 });
  for (const image of [jpeg, webp]) assert.throws(() => rasterMetadata(image.subarray(0, image.length - 3)), /image/i);
  const huge = Buffer.from(webp);
  huge.writeUInt16LE(16000, 26);
  assert.throws(() => rasterMetadata(huge), /dimensions/);
  assert.throws(() => rasterMetadata(Buffer.from("<svg onload='alert(1)'></svg>")), /Unsupported/);
});

test("fixed image and whole Markdown previews retain source and reject unsafe content", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-preview-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = openTaskArtifactRepository(home, "task-1");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const markdown = "# Result\n\n" + "long paragraph\n".repeat(1000) + "\n![plot](../plot.png)";
  const saved = await repo.save({ message: "fixture", files: [
    { relativePath: "plot.png", bytes: png },
    { relativePath: "docs/result.md", bytes: Buffer.from(markdown) },
    { relativePath: "fake.png", bytes: Buffer.from("<script>alert(1)</script>") }
  ] });
  const ref = { taskId: "task-1", commit: saved.commit, relativePath: "plot.png" };
  const image = await readArtifactPreview(home, "task-1", ref);
  assert.equal(image.kind, "image");
  assert.equal(image.mime, "image/png");
  assert.equal(image.width, 1);
  assert.equal(image.height, 1);
  assert.deepEqual(Buffer.from(image.base64, "base64"), png);
  const cliImage = await readArtifactCapability(home, "task-1", ref);
  assert.equal(cliImage.encoding, "base64");
  assert.equal(cliImage.content, image.base64);
  assert.equal(cliImage.digest, image.digest);
  const savedImage = await saveArtifactCapability(home, "task-1", {
    relativePath: "saved.png", content: png.toString("base64"), encoding: "base64"
  });
  assert.equal((await readArtifactPreview(home, "task-1", savedImage)).base64, image.base64);
  await assert.rejects(saveArtifactCapability(home, "task-1", {
    relativePath: "not-image.html", content: png.toString("base64"), encoding: "base64"
  }), /PNG/);
  await assert.rejects(saveArtifactCapability(home, "task-1", {
    relativePath: "saved.png", content: "not base64!", encoding: "base64"
  }), /canonical/);
  const page = await readArtifactPreview(home, "task-1", { ...ref, relativePath: "docs/result.md" });
  assert.equal(page.content, markdown, "Markdown fences and references must not break at text page boundaries");
  assert.equal(page.nextOffset, null);
  await repo.save({ message: "new image", files: [{ relativePath: "plot.png", bytes: Buffer.from("different") }] });
  assert.equal((await readArtifactPreview(home, "task-1", ref)).digest, image.digest);
  assert.match(await materialInputBody(home, "task-1", "Discuss", [{ ...ref, digest: image.digest }]), new RegExp(image.digest));
  await assert.rejects(readArtifactPreview(home, "task-2", ref), /same Task/);
  await assert.rejects(readArtifactPreview(home, "task-1", { ...ref, relativePath: "../plot.png" }));
  await assert.rejects(readArtifactPreview(home, "task-1", { ...ref, relativePath: "fake.png" }), /image|Image/);
  await assert.rejects(readArtifactPreview(home, "task-1", { ...ref, digest: "0".repeat(64) }), /digest/);
  const huge = Buffer.from(png);
  huge.writeUInt32BE(100000, 16);
  const oversized = await repo.save({ message: "oversized", files: [
    { relativePath: "huge.png", bytes: huge },
    { relativePath: "huge.md", bytes: Buffer.alloc(256 * 1024 + 1, 97) }
  ] });
  await assert.rejects(readArtifactPreview(home, "task-1", { ...ref, commit: oversized.commit, relativePath: "huge.png" }), /dimensions/);
  await assert.rejects(readArtifactPreview(home, "task-1", { ...ref, commit: oversized.commit, relativePath: "huge.md" }), /256|262144/);
});

test("shared Markdown renders common structure without executing HTML or fetching image URLs", () => {
  const context = vm.createContext({});
  vm.runInContext(MARKDOWN_SCRIPT.replace(/^export /gm, ""), context);
  const images = [];
  const html = context.renderMarkdown(`# Title

> quoted *emphasis*

| Name | Value |
| --- | --- |
| safe | **bold** |

- [x] done
  - nested

[reference](https://example.com/a?q="x") and ~~removed~~

![plot](../plot.png)

\`\`\`html
<script>alert(1)</script>
\`\`\`

<img src=x onerror=alert(1)>
[bad](javascript:alert)
![external](https://example.com/tracker.png)`, { image: (alt, path) => { images.push([alt, path]); return "<span>image placeholder</span>"; } });
  for (const tag of ["<blockquote>", "<table>", "<em>", "<strong>", "<del>", "<pre>"]) assert.ok(html.includes(tag), tag);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>") && !html.includes("<img") && !html.includes('href="javascript:'));
  assert.equal(images.length, 2);
  assert.equal(context.resolveMarkdownImage("docs/result.md", "../plot.png"), "plot.png");
  assert.equal(context.resolveMarkdownImage("docs/result.md", "./plot%20one.png"), "docs/plot one.png");
  for (const path of ["../../escape.png", "/absolute.png", "//host/a.png", "https://host/a.png", "data:image/png;base64,a", "%2e%2e/%2e%2e/a.png", "..\\a.png"]) {
    assert.throws(() => context.resolveMarkdownImage("docs/result.md", path));
  }
  // Untrusted, bounded prose must not trigger quadratic delimiter backtracking.
  context.delimiters = "prefix " + "[".repeat(65000) + "\n\nprefix " + "`".repeat(65000);
  assert.ok(vm.runInContext("renderMarkdown(delimiters)", context, { timeout: 1000 }).length >= 65000);
});
