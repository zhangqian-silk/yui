export const MARKDOWN_SCRIPT = `
// Minimal, safe Markdown renderer.
//
// Agent-authored prose (focus, outcomes, reviews, messages) arrives as plain
// text with informal Markdown. Rendering structure (headings, lists, code)
// runs walls of text into scannable blocks.
//
// Safety rule: every byte of user text is HTML-escaped BEFORE any tag is
// introduced; the transforms below only ever add our own elements. Links are
// limited to http(s) URLs taken from already-escaped text, so no attribute
// breakout is possible.
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Inline spans: code, bold, auto-links. Expects HTML-escaped input.
export function inlineMarkdown(escaped) {
  const codes = [];
  let out = escaped.replace(/\`([^\`\\n]+)\`/g, function (_match, code) {
    codes.push(code);
    return "\\u0000" + (codes.length - 1) + "\\u0000";
  });
  out = out.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
  out = out.replace(/(https?:\\/\\/[^\\s<]+)/g, function (url) {
    return '<a href="' + url + '" target="_blank" rel="noreferrer">' + url + "</a>";
  });
  out = out.replace(/\\u0000(\\d+)\\u0000/g, function (_match, index) {
    return "<code>" + codes[Number(index)] + "</code>";
  });
  return out;
}

// Block structure: fenced code, ATX headings, unordered / ordered lists,
// paragraphs with soft line breaks. Each line advances one block state: the
// finished html, the open paragraph lines, the open list and code fence.
const FENCE = /^\\s*\`\`\`/;

export function renderMarkdown(text) {
  const lines = String(text).replace(/\\u0000/g, "").replace(/\\r\\n?/g, "\\n").split("\\n");
  const blocks = { html: [], paragraph: [], list: null, code: null };
  lines.forEach(function (line) { markdownLine(blocks, line); });
  flushBlocks(blocks);
  if (blocks.code !== null) flushCode(blocks);
  return blocks.html.join("");
}

function markdownLine(blocks, line) {
  if (blocks.code !== null) {
    if (FENCE.test(line)) flushCode(blocks);
    else blocks.code.push(escapeHtml(line));
    return;
  }
  if (FENCE.test(line)) { flushBlocks(blocks); blocks.code = []; return; }
  const heading = line.match(/^\\s{0,3}(#{1,4})\\s+(.*)$/);
  if (heading) {
    flushBlocks(blocks);
    const level = Math.min(heading[1].length + 3, 6);
    blocks.html.push("<h" + level + ">" + inlineMarkdown(escapeHtml(heading[2].trim())) + "</h" + level + ">");
    return;
  }
  const unordered = line.match(/^\\s*[-*•]\\s+(.*)$/);
  if (unordered) { listItem(blocks, "ul", unordered[1]); return; }
  const ordered = line.match(/^\\s*\\d+[.)]\\s+(.*)$/);
  if (ordered) { listItem(blocks, "ol", ordered[1]); return; }
  if (/^\\s*$/.test(line)) { flushBlocks(blocks); return; }
  flushList(blocks);
  blocks.paragraph.push(escapeHtml(line));
}

function listItem(blocks, type, item) {
  flushParagraph(blocks);
  if (!blocks.list || blocks.list.type !== type) {
    flushList(blocks);
    blocks.list = { type: type, items: [] };
  }
  blocks.list.items.push(escapeHtml(item));
}

function flushParagraph(blocks) {
  if (!blocks.paragraph.length) return;
  blocks.html.push("<p>" + blocks.paragraph.map(inlineMarkdown).join("<br>") + "</p>");
  blocks.paragraph = [];
}

function flushList(blocks) {
  const list = blocks.list;
  if (!list) return;
  blocks.html.push("<" + list.type + ">" + list.items.map(function (item) {
    return "<li>" + inlineMarkdown(item) + "</li>";
  }).join("") + "</" + list.type + ">");
  blocks.list = null;
}

// Close the open paragraph, then the open list.
function flushBlocks(blocks) {
  flushParagraph(blocks);
  flushList(blocks);
}

// Code lines are escaped like all other text; they get no inline spans.
function flushCode(blocks) {
  blocks.html.push("<pre><code>" + blocks.code.join("\\n") + "</code></pre>");
  blocks.code = null;
}
`;
